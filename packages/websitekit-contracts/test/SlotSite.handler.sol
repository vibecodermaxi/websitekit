// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { CommonBase } from "forge-std/Base.sol";
import { StdCheats } from "forge-std/StdCheats.sol";
import { StdUtils } from "forge-std/StdUtils.sol";
import { SlotSite } from "../src/SlotSite.sol";
import { RentalsLib } from "../src/RentalsLib.sol";
import { MockToken } from "./SlotSiteBase.t.sol";

/// @notice Drives `SlotSite` through random call sequences for the v2 invariant suite.
///
/// **What this catches that the 231 unit tests structurally cannot.** v2 lands three mechanisms on
/// one release — rentals, the ask, and ERC-20 settlement — and every one of them touches `buy`.
/// The unit tests cover each mechanism; the risk the spec names (§8) is the *composition*: a take
/// landing mid-tenancy, an ask posted against a floor that then reverts underneath it, an extension
/// that rolls unaccrued escrow forward across a change of owner. Those sequences are the ones
/// nobody writes a unit test for, because nobody thought of them.
///
/// **Every assertion lives in the invariant contract, never here.** With `fail_on_revert = false`
/// — the default, and what the try/catch style below assumes — a failing `assert` inside a handler
/// action is indistinguishable from any other revert and is swallowed silently. So where a property
/// can only be observed at the moment of a transition, this file records a *violation counter* and
/// the invariant contract asserts it is zero. That indirection is not stylistic; the direct version
/// is a test that cannot fail.
///
/// Ghost state is the point of the file. The contract does not remember what anyone paid once a
/// slot moves on, and it does not remember what `maxRentalTerm` was when a listing was written.
/// The handler remembers both.
contract SlotSiteHandler is CommonBase, StdCheats, StdUtils {
    SlotSite public immutable site;
    MockToken public immutable token;
    address public immutable siteOwner;
    address public immutable siteTreasury;
    address public immutable protocolTreasury;
    bool public immutable useToken;

    uint256 internal constant BPS = 10_000;
    uint64 internal constant MIN_RENTAL_DURATION = 1 hours;
    uint64 internal constant MAX_RENTAL_TERM_CEILING = 365 days;

    address[] public actors;
    bytes32[] public keys;

    // --- ghost state ----------------------------------------------------

    /// @notice What the CURRENT owner of each slot paid for it. Deliberately does NOT move on a
    /// plain transfer — that asymmetry is what would make a laundered cost basis visible.
    mapping(bytes32 => uint256) public ghostPaidByOwner;

    /// @notice Settlement currency in and out, in whichever denomination the site uses.
    uint256 public ghostTotalIn;
    uint256 public ghostTotalOut;

    /// @notice Smallest `payout / basePrice` ever seen on a take, in bps. The invariant reads this
    /// rather than re-deriving it, so a break reports how far it missed.
    uint256 public ghostMinPayoutVsFloorBps = type(uint256).max;
    /// @notice Displaced owners credited less than they paid. Not a bug — reversion makes it
    /// reachable — but the docs once claimed otherwise, so the suite counts it.
    uint256 public ghostUnderwaterTakes;

    /// @notice The largest value `maxRentalTerm` has ever held on this site. A tenancy may outlive
    /// the *current* setting (lowering it cannot reach into a live term), but never this.
    uint64 public ghostMaxTermCap;

    // --- violation counters: transitions only observable as they happen ---

    /// @notice §2.4. A take settles rent to the OUTGOING owner before ownership moves. Incremented
    /// if a take ever credited the displaced owner less than `payout + unclaimed rent`.
    uint256 public ghostRentStolenOnTake;
    /// @notice The standing check in CLAUDE.md: change from an overpayment must credit the PAYER,
    /// never the recipient. Incremented if a `buyFor` ever credited the wrong party.
    uint256 public ghostChangeMisrouted;
    /// @notice §6.1. Incremented if `setEconomics` ever moved a locked site against the ratchet.
    uint256 public ghostRatchetViolations;
    /// @notice Incremented if a tenancy was ever opened or extended past the largest term the
    /// publisher has ever permitted.
    uint256 public ghostTermOverrun;
    /// @notice §2, rule 2. Incremented if an extension ever rolled ALREADY-EARNED rent forward into
    /// the new term instead of paying it out first.
    uint256 public ghostRentRolledForward;

    // --- coverage counters ----------------------------------------------

    uint256 public ghostClaims;
    uint256 public ghostTakes;
    uint256 public ghostTakesUnderTenancy;
    uint256 public ghostRents;
    uint256 public ghostExtends;
    uint256 public ghostRentClaims;
    uint256 public ghostEnds;
    /// @notice Every action entered, successful or not. Read by the coverage guard, which uses it
    /// to tell a real campaign apart from a shrink replay — see `afterInvariant`.
    uint256 public ghostCalls;
    uint256 public ghostLists;
    uint256 public ghostAsksSet;
    uint256 public ghostAsksPriced;
    uint256 public ghostRegistrations;
    uint256 public ghostEconomicsChanges;
    uint256 public ghostOverpays;
    uint256 public ghostAvailabilityToggles;
    uint256 public ghostUnavailableClaimAttempts;
    uint256 public ghostUnavailableClaims;

    constructor(
        SlotSite site_,
        MockToken token_,
        address siteOwner_,
        address siteTreasury_,
        address protocolTreasury_,
        bytes32[] memory keys_
    ) {
        site = site_;
        token = token_;
        siteOwner = siteOwner_;
        siteTreasury = siteTreasury_;
        protocolTreasury = protocolTreasury_;
        useToken = site_.settlementToken() != address(0);
        keys = keys_;
        ghostMaxTermCap = site_.maxRentalTerm();

        // The ACTORS hold the money, not the handler. `vm.prank` makes the pranked address the
        // CALL's caller, and a CALL's value is debited from its caller — so a pranked
        // `buy{value: x}` spends the actor's balance. Funding the handler instead produces a bare
        // `EvmError` with no custom error, which is what an out-of-funds CALL looks like and reads
        // like nothing at all through a try/catch. The token path hides this entirely, because
        // there `msg.value` is always zero — which is exactly why both paths are swept.
        for (uint256 i = 0; i < 5; i++) {
            address actor = address(uint160(uint256(keccak256(abi.encode("v2.actor", i)))));
            actors.push(actor);
            vm.deal(actor, 1_000_000 ether);
            token_.mint(actor, 1e18);
            vm.prank(actor);
            token_.approve(address(site_), type(uint256).max);
        }
    }

    // --- views used by the invariant contract ---------------------------

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function keyCount() external view returns (uint256) {
        return keys.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[bound(seed, 0, actors.length - 1)];
    }

    function _key(uint256 seed) internal view returns (bytes32) {
        return keys[bound(seed, 0, keys.length - 1)];
    }

    /// @dev State-aware key selection, and the single change that made this suite non-vacuous.
    ///
    /// With a uniform pick, a 4,000-call campaign opened **five** tenancies and claimed rent
    /// **zero** times. The reason is structural rather than statistical: a rental needs a key that
    /// is owned, currently listed, and not already rented, and `_buy` deletes the listing on every
    /// purchase — so the window where `rent` is legal is narrow and a uniform pick spends almost
    /// every attempt bouncing off `NotForRent` or `RentalActive`. A campaign that never opens a
    /// tenancy cannot test any of the escrow, encumbrance or rent-on-take properties, and would
    /// have reported green while doing so.
    ///
    /// Scanning from a seeded offset rather than picking the first match keeps the choice fuzzed —
    /// the fuzzer still decides which eligible key, in what order, with what arguments. It only
    /// stops it from spending the campaign proposing calls that cannot possibly land.
    function _scan(uint256 seed, uint8 want) internal view returns (bytes32) {
        uint256 n = keys.length;
        uint256 start = seed % n;
        for (uint256 i = 0; i < n; i++) {
            bytes32 k = keys[(start + i) % n];
            if (_matches(k, want)) return k;
        }
        // No eligible key: hand back the seeded one anyway, so the action still attempts and the
        // rejection path stays exercised rather than being silently skipped.
        return keys[start];
    }

    function _matches(bytes32 key, uint8 want) internal view returns (bool) {
        if (want == WANT_OWNED) return site.ownerOfOrZero(key) != address(0);
        if (want == WANT_CLAIMABLE) {
            return site.slotOf(key).registered && site.ownerOfOrZero(key) == address(0);
        }
        (,, uint64 expiry,,,) = site.rentals(key);
        if (want == WANT_TENANTED) return expiry != 0;
        (uint192 rate,,) = site.listings(key);
        return rate != 0 && expiry == 0; // WANT_RENTABLE
    }

    uint8 internal constant WANT_OWNED = 0;
    uint8 internal constant WANT_RENTABLE = 1;
    uint8 internal constant WANT_TENANTED = 2;
    uint8 internal constant WANT_CLAIMABLE = 3;

    /// @dev v2 dropped v1's `getSlots`, and `ownerOf` reverts for an unminted id while most slots
    /// are unowned most of the time. `ownerOfOrZero` is the read real clients use.
    function _owner(bytes32 key) internal view returns (address) {
        return site.ownerOfOrZero(key);
    }

    /// @dev Native sites take value; token sites must receive exactly zero or `_collect` reverts
    /// `NativeNotAccepted`.
    function _value(uint256 amount) internal view returns (uint256) {
        return useToken ? 0 : amount;
    }

    function _held(address who) internal view returns (uint256) {
        return useToken ? token.balanceOf(who) : who.balance;
    }

    /// @dev Rent already earned but not yet swept into the pull ledger — what a take must hand to
    /// the OUTGOING owner. Not a contract view: `accruedRent` is gross of `claimed`.
    function _unclaimedRent(bytes32 key) internal view returns (uint256) {
        (,,,, uint256 claimed,) = site.rentals(key);
        uint256 accrued = site.accruedRent(key);
        return accrued > claimed ? accrued - claimed : 0;
    }

    // =====================================================================
    // The money spine
    // =====================================================================

    /// @notice Claims an unclaimed slot or takes an owned one, whichever applies.
    ///
    /// The buyer is forced to differ from the incumbent. That is not realism — it is what keeps the
    /// payout measurement readable: if they coincided, the displaced owner's balance would move for
    /// two reasons at once (payout and change) and the ratio ghost would silently mean nothing.
    function buy(uint256 actorSeed, uint256 keySeed) public {
        ghostCalls++;
        bytes32 key = _key(keySeed);
        address previousOwner = _owner(key);
        address actor = _actor(actorSeed);
        if (actor == previousOwner) actor = _actor(actorSeed + 1);
        if (actor == previousOwner) return;

        _doBuy(actor, actor, key, 0);
    }

    /// @notice `buyFor` with a recipient who is not the payer, and a deliberate overpayment.
    ///
    /// Two things only this path reaches. First the standing check from CLAUDE.md — *if this
    /// function confers a right, could the beneficiary differ from the party paying gas?* — which
    /// `buyFor` answers by taking an explicit recipient. Second the native change ledger: the token
    /// path pulls exactly and has no change at all, so an overpayment is the only way to exercise
    /// it, and it must credit the payer.
    function buyForOverpay(uint256 payerSeed, uint256 recipientSeed, uint256 keySeed, uint256 extraSeed) public {
        ghostCalls++;
        bytes32 key = _key(keySeed);
        address previousOwner = _owner(key);
        address payer = _actor(payerSeed);
        address recipient = _actor(recipientSeed);
        if (payer == previousOwner || recipient == previousOwner) return;
        if (payer == recipient) return;

        _doBuy(payer, recipient, key, useToken ? 0 : bound(extraSeed, 1, 1 ether));
    }

    /// @dev Grouped into one struct because the natural spelling — a local per hoisted read — is
    /// stack-too-deep under the legacy pipeline, and `via_ir` is unavailable here for the reasons
    /// `foundry.toml` records. Every field is a read taken BEFORE the prank is armed.
    struct BuyState {
        uint256 charged;
        bytes32 terms;
        address previousOwner;
        bool isClaim;
        bool underTenancy;
        bool wasRegistered;
        bool availableBefore;
        uint256 owedBefore;
        uint256 payerOwedBefore;
        uint256 unclaimedRent;
    }

    function _doBuy(address payer, address recipient, bytes32 key, uint256 extra) internal {
        BuyState memory st;
        {
            SlotSite.Slot memory slotBefore = site.slotOf(key);
            st.wasRegistered = slotBefore.registered;
            st.availableBefore = slotBefore.available;
        }
        {
            // Every read hoisted into a local BEFORE the prank is armed. As inline arguments these
            // are external calls that consume it, and the buy would arrive from the handler — which
            // looks exactly like a broken access check and is not one.
            (uint256 effectiveFloor, uint256 price) = site.quote(key);
            st.previousOwner = _owner(key);
            st.isClaim = st.previousOwner == address(0);
            // `quote` on an UNREGISTERED key returns (0, 0), because it prices a slot whose floor
            // does not exist yet. `_buy` registers first and then quotes, so it charges
            // `defaultFloor` — and a `maxPrice` of 0 makes every open-registration purchase revert
            // `SlippageExceeded`. Anticipating the registration here is the only way the wild keys
            // are reachable at all; without it §7.5's squatting surface is never exercised and
            // `onlyRegisteredSlotsAreOwned` has nothing to say.
            if (!st.wasRegistered) {
                st.charged = site.openRegistration() ? site.defaultFloor() : 0;
            } else {
                st.charged = st.isClaim ? effectiveFloor : price;
            }
        }
        st.terms = site.encumbranceHash(key);

        if (!useToken && st.charged + extra > payer.balance) return;
        if (useToken && st.charged > token.balanceOf(payer)) return;

        st.owedBefore = st.isClaim ? 0 : site.pendingWithdrawals(st.previousOwner);
        st.payerOwedBefore = site.pendingWithdrawals(payer);
        st.unclaimedRent = st.isClaim ? 0 : _unclaimedRent(key);
        st.underTenancy = site.userOf(uint256(key)) != address(0);

        // The availability property lives at this call, not in state afterwards: what must never
        // happen is a CLAIM landing on a registered slot whose flag was off at the moment of
        // purchase. Auto-registered keys are exempt — `_register` just defaulted their flag on.
        bool claimWhileUnavailable = st.isClaim && st.wasRegistered && !st.availableBefore;
        if (claimWhileUnavailable) ghostUnavailableClaimAttempts++;

        vm.prank(payer);
        try site.buyFor{ value: _value(st.charged + extra) }(recipient, key, st.charged, st.terms, block.timestamp) {
            if (claimWhileUnavailable) ghostUnavailableClaims++;
            ghostTotalIn += st.charged + extra;
            if (extra > 0) ghostOverpays++;
            if (!st.wasRegistered) ghostRegistrations++;

            if (st.isClaim) {
                ghostClaims++;
            } else {
                ghostTakes++;
                if (st.underTenancy) ghostTakesUnderTenancy++;
                _recordTake(key, st.previousOwner, st.owedBefore, st.unclaimedRent);
            }

            // §2.4 and the standing recipient check, in one measurement: change is the payer's, and
            // both entry points guarantee the payer is not the displaced owner, so nothing else can
            // move that balance in this call.
            if (extra > 0 && site.pendingWithdrawals(payer) != st.payerOwedBefore + extra) {
                ghostChangeMisrouted++;
            }

            ghostPaidByOwner[key] = st.charged;
        } catch {
            // Cooldown, pause, a terms change between the quote and the call, or an ask posted in
            // between. All legitimate.
        }
    }

    /// @dev The displaced owner's balance must move by the payout AND by whatever rent the tenancy
    /// had earned under them. `_settleRent` runs before `_transfer`, so `_ownerOf` inside it is
    /// still the outgoing owner — an ordering that would be silently wrong the other way round, and
    /// wrong only for positions that happened to be rented at the moment they were taken.
    function _recordTake(bytes32 key, address previousOwner, uint256 owedBefore, uint256 unclaimedRent) internal {
        uint256 credited = site.pendingWithdrawals(previousOwner) - owedBefore;

        if (credited < unclaimedRent) {
            ghostRentStolenOnTake++;
            return;
        }
        uint256 payout = credited - unclaimedRent;

        uint256 basePrice = site.slotOf(key).basePrice;
        if (basePrice > 0) {
            uint256 ratio = (payout * BPS) / basePrice;
            if (ratio < ghostMinPayoutVsFloorBps) ghostMinPayoutVsFloorBps = ratio;
        }
        // NOT an invariant — reversion makes it reachable, and it is counted precisely because the
        // docs claimed it could not happen.
        if (credited < ghostPaidByOwner[key]) ghostUnderwaterTakes++;
    }

    // =====================================================================
    // The ask (§3)
    // =====================================================================

    /// @notice An owner-posted reversion base. Bounded to the band `setAsk` accepts most of the
    /// time, so the sequence spends its calls inside the mechanism rather than bouncing off it.
    function setAsk(uint256 keySeed, uint256 askSeed) public {
        ghostCalls++;
        bytes32 key = _scan(keySeed, WANT_OWNED);
        address owner_ = _owner(key);
        if (owner_ == address(0)) return;

        SlotSite.Slot memory slot = site.slotOf(key);
        uint256 cap = site.maxAskBps();
        uint256 anchor = slot.lastPrice > slot.basePrice ? slot.lastPrice : slot.basePrice;
        uint256 ceiling = (anchor * cap) / BPS;
        if (ceiling < slot.basePrice) return;

        // One in eight clears the ask, so the `askFloor == 0` fall-through to `lastPrice` keeps
        // being exercised after the band has been explored.
        uint256 ask = askSeed % 8 == 0 ? 0 : bound(askSeed, slot.basePrice, ceiling);

        vm.prank(owner_);
        try site.setAsk(key, ask) {
            ghostAsksSet++;
            if (ask > slot.lastPrice) ghostAsksPriced++;
        } catch { }
    }

    // =====================================================================
    // Rentals (§2)
    // =====================================================================

    function listForRent(uint256 keySeed, uint256 rateSeed, uint256 durSeed) public {
        ghostCalls++;
        bytes32 key = _scan(keySeed, WANT_OWNED);
        address owner_ = _owner(key);
        if (owner_ == address(0)) return;

        (uint256 effectiveFloor,) = site.quote(key);
        uint256 minRate = (effectiveFloor * site.minRentBps()) / BPS;
        uint64 termCap = site.maxRentalTerm();
        if (termCap < MIN_RENTAL_DURATION) return;

        // Around the fair rate of ~1.64%/day of the effective floor (§2.5.2), but never below the
        // anti-poison floor — a listing below it is rejected, and a handler that spent most of its
        // list calls being rejected would leave the rental machine barely touched.
        uint256 fair = (effectiveFloor * 164) / BPS;
        uint256 rate = bound(rateSeed, minRate, minRate + fair * 4 + 1);
        // One in nine delists, so the `ratePerDay == 0` branch and the owner's escape valve from an
        // incumbent tenant's extensions (§2, rule 3) both stay live.
        if (rateSeed % 9 == 0) rate = 0;
        uint64 maxDur = uint64(bound(durSeed, MIN_RENTAL_DURATION, termCap));

        vm.prank(owner_);
        try site.listForRent(key, rate, maxDur) {
            if (rate > 0) ghostLists++;
        } catch { }
    }

    function rent(uint256 actorSeed, uint256 keySeed, uint256 durSeed) public {
        ghostCalls++;
        bytes32 key = _scan(keySeed, WANT_RENTABLE);
        (uint192 rate, uint64 maxDur,) = site.listings(key);
        if (rate == 0 || maxDur < MIN_RENTAL_DURATION) return;

        address tenant = _actor(actorSeed);
        uint64 duration = uint64(bound(durSeed, MIN_RENTAL_DURATION, maxDur));
        uint256 cost = (uint256(rate) * duration) / 1 days;
        if (!useToken && cost > tenant.balance) return;
        if (useToken && cost > token.balanceOf(tenant)) return;

        uint64 capBefore = ghostMaxTermCap;

        vm.prank(tenant);
        try site.rent{ value: _value(cost) }(key, duration, rate) {
            ghostTotalIn += cost;
            ghostRents++;
            if (duration > capBefore) ghostTermOverrun++;
        } catch { }
    }

    /// @notice Only the sitting tenant, only a live term. The cap applies to the REMAINING window
    /// rather than the total, which is the rule that makes "no buyer inherits more than
    /// `maxRentalTerm`" true however many extensions preceded the sale.
    function extendRental(uint256 keySeed, uint256 durSeed) public {
        ghostCalls++;
        bytes32 key = _scan(keySeed, WANT_TENANTED);
        (address tenant,, uint64 expiry,,,) = site.rentals(key);
        if (tenant == address(0) || block.timestamp >= expiry) return;

        (uint192 rate,,) = site.listings(key);
        if (rate == 0) return;

        uint64 termCap = site.maxRentalTerm();
        if (termCap < MIN_RENTAL_DURATION) return;
        uint64 duration = uint64(bound(durSeed, MIN_RENTAL_DURATION, termCap));
        uint256 cost = (uint256(rate) * duration) / 1 days;
        if (!useToken && cost > tenant.balance) return;
        if (useToken && cost > token.balanceOf(tenant)) return;

        uint64 capBefore = ghostMaxTermCap;
        // The extension restarts the linear term from now, so whatever the OUTGOING term already
        // earned has to leave escrow before the carry is computed — otherwise it is re-streamed
        // over the new term and lands on whoever owns the position then, which need not be the
        // owner who earned it.
        address owner_ = _owner(key);
        uint256 earnedBefore = _unclaimedRent(key);
        uint256 ownerOwedBefore = site.pendingWithdrawals(owner_);

        vm.prank(tenant);
        try site.extendRental{ value: _value(cost) }(key, duration, rate) {
            ghostTotalIn += cost;
            ghostExtends++;
            if (duration > capBefore) ghostTermOverrun++;
            if (site.pendingWithdrawals(owner_) - ownerOwedBefore < earnedBefore) ghostRentRolledForward++;
        } catch { }
    }

    /// @notice Permissionless, and always credits the current owner rather than the caller — so it
    /// is called here from an arbitrary actor on purpose.
    function claimRent(uint256 actorSeed, uint256 keySeed) public {
        ghostCalls++;
        bytes32 key = _scan(keySeed, WANT_TENANTED);
        vm.prank(_actor(actorSeed));
        try site.claimRent(key) {
            ghostRentClaims++;
        } catch { }
    }

    /// @notice The keeper action. Load-bearing for the MECHANISM, not just hygiene: `open` reverts
    /// `RentalActive` on a lapsed-but-uncleared term, so without this the position leaves the rental
    /// market for everyone, indefinitely.
    function endRental(uint256 actorSeed, uint256 keySeed) public {
        ghostCalls++;
        bytes32 key = _scan(keySeed, WANT_TENANTED);
        vm.prank(_actor(actorSeed));
        try site.endRental(key) {
            ghostEnds++;
        } catch { }
    }

    // =====================================================================
    // Content and delegation
    // =====================================================================

    /// @notice Half the calls come from the party actually entitled to edit, half from a random
    /// actor. Random-only would spend the whole campaign being rejected and never write content —
    /// and content is what `endRental` has to restore.
    function edit(uint256 actorSeed, uint256 keySeed, bytes32 contentHash) public {
        ghostCalls++;
        bytes32 key = _key(keySeed);
        address who = _actor(actorSeed);
        if (actorSeed % 2 == 0) {
            address tenant = site.userOf(uint256(key));
            who = tenant != address(0) ? tenant : _owner(key);
        }
        if (who == address(0)) return;

        vm.prank(who);
        try site.edit(key, contentHash) { } catch { }
    }

    function setEditor(uint256 keySeed, uint256 editorSeed) public {
        ghostCalls++;
        bytes32 key = _scan(keySeed, WANT_OWNED);
        address owner_ = _owner(key);
        if (owner_ == address(0)) return;

        vm.prank(owner_);
        try site.setEditor(key, _actor(editorSeed)) { } catch { }
    }

    /// @notice A transfer must move `owner` and nothing else — no hook, by design. The ghost cost
    /// basis deliberately does not travel with it.
    function transfer(uint256 toSeed, uint256 keySeed) public {
        ghostCalls++;
        bytes32 key = _scan(keySeed, WANT_OWNED);
        address from = _owner(key);
        if (from == address(0)) return;
        address to = _actor(toSeed);
        if (to == from) return;

        vm.prank(from);
        try site.transferFrom(from, to, uint256(key)) { } catch { }
    }

    // =====================================================================
    // Publisher levers
    // =====================================================================

    function setFloor(uint256 keySeed, uint256 floorSeed) public {
        ghostCalls++;
        bytes32 key = _key(keySeed);
        uint256 current = site.slotOf(key).basePrice;
        if (current == 0) return;
        uint256 delta = site.floorDeltaBps();
        // Inside the band the call is usually accepted and the cooldown does the rejecting, which
        // is the interaction worth sampling.
        uint256 lo = current - (current * delta) / BPS;
        uint256 hi = current + (current * delta) / BPS;
        uint256 newFloor = bound(floorSeed, lo, hi);
        if (newFloor < site.minFloor()) return;

        vm.prank(siteOwner);
        try site.setFloor(key, newFloor) { } catch { }
    }

    /// @notice §6.1's ratchet, proposed only in the holder-safe direction — and then checked, which
    /// is the point. A proposal that moved the wrong way would simply revert and prove nothing; one
    /// that moves the right way and lands wrong is the failure this counts.
    function setEconomics(uint256 s) public {
        ghostCalls++;
        uint256 take = site.takeBps();
        uint256 payout = site.payoutBps();
        uint256 rev = site.reversionBps();
        uint256 revWeeks = site.maxReversionWeeks();
        uint256 cooldown = site.cooldownSecs();
        uint256 protocol = site.protocolBps();

        uint256 nextPayout = bound(s, payout, payout + 500);
        // Keep the `takeBps > payoutBps + protocolBps` clamp satisfiable, or every call reverts and
        // the ratchet is never exercised at all.
        uint256 floorTake = nextPayout + protocol + 1;
        uint256 nextTake = take > floorTake ? bound(uint256(keccak256(abi.encode(s, "t"))), floorTake, take) : take;
        uint256 nextRev = bound(uint256(keccak256(abi.encode(s, "r"))), rev, BPS);
        uint256 nextWeeks = bound(uint256(keccak256(abi.encode(s, "w"))), 0, revWeeks);
        uint256 nextCooldown = bound(uint256(keccak256(abi.encode(s, "c"))), 0, cooldown);

        bool locked = site.termsLocked();

        vm.prank(siteOwner);
        try site.setEconomics(nextTake, nextPayout, nextRev, nextWeeks, nextCooldown) {
            ghostEconomicsChanges++;
            if (locked) {
                if (
                    site.takeBps() > take || site.payoutBps() < payout || site.reversionBps() < rev
                        || site.maxReversionWeeks() > revWeeks || site.cooldownSecs() > cooldown
                ) ghostRatchetViolations++;
            }
        } catch { }
    }

    /// @notice §2.5.1. Freely mutable in BOTH directions even after the lock, which is the whole
    /// asymmetry with take economics — so this is where `maxRentalTerm` can grow, and where the
    /// ghost cap has to grow with it.
    function setRentalTerms(uint256 s) public {
        ghostCalls++;
        uint256 protocolRent = site.protocolRentBps();
        // The band is on the TOTAL fee, so the site's own share is what is left of it.
        uint256 lo = protocolRent >= 1_000 ? 0 : 1_000 - protocolRent;
        uint256 hi = protocolRent >= 4_000 ? 0 : 4_000 - protocolRent;
        if (hi < lo) return;
        uint256 siteRent = bound(s, lo, hi);
        uint64 term =
            uint64(bound(uint256(keccak256(abi.encode(s, "term"))), MIN_RENTAL_DURATION, MAX_RENTAL_TERM_CEILING));
        uint256 minRent = bound(uint256(keccak256(abi.encode(s, "min"))), 1, BPS);

        vm.prank(siteOwner);
        try site.setRentalTerms(siteRent, term, minRent) {
            if (term > ghostMaxTermCap) ghostMaxTermCap = term;
        } catch { }
    }

    function setFloorPolicy(uint256 s) public {
        ghostCalls++;
        uint256 delta = site.floorDeltaBps();
        uint256 cooldown = site.floorChangeCooldown();
        uint256 askCap = site.maxAskBps();

        // Tightening only, so the call lands and the *effect* of a tighter policy on the ask and
        // floor actions is what gets sampled.
        uint256 nextDelta = bound(s, 1, delta);
        uint256 nextCooldown = bound(uint256(keccak256(abi.encode(s, "cd"))), cooldown, cooldown + 7 days);
        uint256 nextAskCap = askCap > BPS ? bound(uint256(keccak256(abi.encode(s, "ac"))), BPS, askCap) : askCap;

        vm.prank(siteOwner);
        try site.setFloorPolicy(nextDelta, nextCooldown, nextAskCap) { } catch { }
    }

    /// @dev Scans for a CLAIMABLE key rather than picking uniformly, for the same reason `rent`
    /// does: the gate only exists on registered-and-unowned slots, and once a campaign has claimed
    /// the board a uniform pick would spend every toggle on owned keys the gate never reads —
    /// leaving the property green and vacuous. Biased toward re-enabling so the flag does not
    /// starve the claim coverage the rest of the suite needs.
    function setAvailability(uint256 keySeed, uint256 onSeed) public {
        ghostCalls++;
        bytes32 key = _scan(keySeed, WANT_CLAIMABLE);
        bytes32[] memory toggled = new bytes32[](1);
        toggled[0] = key;
        vm.prank(siteOwner);
        try site.setAvailability(toggled, onSeed % 3 != 0) {
            ghostAvailabilityToggles++;
        } catch { }
    }

    /// @dev Biased heavily toward UNpaused. A fuzzed bool leaves the site paused about half the
    /// time, which halves every buy and rent attempt for the whole campaign.
    function setPaused(uint256 seed) public {
        ghostCalls++;
        vm.prank(siteOwner);
        try site.setPaused(seed % 8 == 0) { } catch { }
    }

    /// @notice Opens the squatting surface §7.5 defends: with this on, a `buy` against an
    /// unregistered key registers it mid-purchase. The wild keys in the key set exist for it.
    function setOpenRegistration(uint256 seed, uint256 floorSeed) public {
        ghostCalls++;
        uint256 floor = bound(floorSeed, site.minFloor(), site.minFloor() * 100);
        vm.prank(siteOwner);
        try site.setOpenRegistration(seed % 3 != 0, floor) { } catch { }
    }

    // =====================================================================
    // The pull ledger
    // =====================================================================

    function withdraw(uint256 actorSeed) public {
        ghostCalls++;
        address actor = _actor(actorSeed);
        uint256 owed = site.pendingWithdrawals(actor);
        if (owed == 0) return;
        try site.withdrawFor(actor) {
            ghostTotalOut += owed;
        } catch { }
    }

    /// @notice The protocol and the site owner accrue through the same ledger as everyone else, and
    /// a suite that only drained actor balances would leave two of the three claimants untested.
    function withdrawParty(uint256 seed) public {
        ghostCalls++;
        address who = seed % 2 == 0 ? protocolTreasury : siteOwner;
        uint256 owed = site.pendingWithdrawals(who);
        if (owed == 0) return;
        try site.withdrawFor(who) {
            ghostTotalOut += owed;
        } catch { }
    }

    function withdrawTreasury(uint256 amountSeed) public {
        ghostCalls++;
        uint256 balance = site.treasuryBalance();
        if (balance == 0) return;
        uint256 amount = bound(amountSeed, 1, balance);

        vm.prank(siteOwner);
        try site.withdrawTreasury(amount) {
            ghostTotalOut += amount;
        } catch { }
    }

    /// @notice §10.4. Permissionless and always pays `treasury`, never the caller — so like
    /// `claimRent` it is deliberately called from a random actor.
    function sweepTreasury(uint256 actorSeed) public {
        ghostCalls++;
        uint256 balance = site.treasuryBalance();
        if (balance == 0) return;
        vm.prank(_actor(actorSeed));
        try site.sweepTreasury() {
            ghostTotalOut += balance;
        } catch { }
    }

    /// @notice Plain value accrues to the treasury on a native site rather than reverting, so it is
    /// a real path into the balance that solvency has to survive.
    ///
    /// **Token sites have no equivalent and deliberately get none.** `receive()` reverts there, and
    /// a stray `token.transfer` into the site credits nobody — it is unaccounted dust by design,
    /// with no sweep to recover it. Modelling it here would only assert that conservation is false,
    /// which is already known; §1.5 Finding 5 is why the ledger is not reconciled against the
    /// token balance on-chain.
    function donate(uint256 actorSeed, uint256 amountSeed) public {
        ghostCalls++;
        if (useToken) return;
        address actor = _actor(actorSeed);
        uint256 amount = bound(amountSeed, 1, 1 ether);
        if (amount > actor.balance) return;

        vm.prank(actor);
        (bool ok,) = address(site).call{ value: amount }("");
        if (ok) ghostTotalIn += amount;
    }

    // =====================================================================
    // Time
    // =====================================================================

    /// @notice Time is an input to this contract, not a background condition: reversion, both
    /// cooldowns, rent accrual and rental expiry all read it.
    ///
    /// Two regimes on purpose. Short hops keep tenancies alive across takes, extensions and claims —
    /// the composition the suite exists for. Long hops are the only way to reach the far end of a
    /// 52-week reversion horizon inside one campaign, and §8's collision only exists out there.
    function warp(uint256 secondsSeed) public {
        ghostCalls++;
        uint256 step =
            secondsSeed % 4 == 0 ? bound(secondsSeed, 1 days, 60 days) : bound(secondsSeed, 1 minutes, 2 days);
        vm.warp(block.timestamp + step);
    }
}
