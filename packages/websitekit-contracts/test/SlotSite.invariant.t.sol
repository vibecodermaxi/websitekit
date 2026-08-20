// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { console } from "forge-std/console.sol";
import { SlotSite } from "../src/SlotSite.sol";
import { SlotFactory } from "../src/SlotFactory.sol";
import { RentalsLib } from "../src/RentalsLib.sol";
import { MockToken } from "./SlotSiteBase.t.sol";
import { SlotSiteHandler } from "./SlotSite.handler.sol";

/// @notice Properties that must hold after ANY reachable sequence of calls against a v2 site.
///
/// The 231 unit tests each pick a sequence and assert a result. That is the wrong shape for the
/// question an auditor asks about a contract that can never be patched: not "does this path work"
/// but "is there any path that breaks the accounting". v2 makes that question sharper than v1's,
/// because three mechanisms land at once and all three touch `buy` — a take can arrive mid-tenancy,
/// an ask can be posted against a floor that then reverts underneath it, an extension can roll
/// unaccrued escrow forward across a change of owner. Spec §8 names the composition, not the
/// features, as the risk.
///
/// **This is an abstract base, and the configuration is the variable.** Spec §7 is explicit that
/// the suite must sweep admissible config *combinations* rather than one config per feature —
/// `MAX_RENTAL_TERM_CEILING` (365 days) and the Standard reversion horizon (52 weeks = 364 days)
/// were each chosen soundly and only collide together. Four concrete campaigns follow at the bottom
/// of this file; each is the same properties against a different corner of the config space.
abstract contract SlotSiteInvariantBase is Test {
    SlotSite internal implementation;
    SlotFactory internal factory;
    SlotSite internal site;
    MockToken internal token;
    SlotSiteHandler internal handler;

    address internal siteOwner = makeAddr("siteOwner");
    address internal siteTreasury = makeAddr("siteTreasury");
    address internal protocolTreasury = makeAddr("protocolTreasury");

    uint256 internal constant BPS = 10_000;
    uint256 internal constant PROTOCOL_BPS = 500;
    uint256 internal constant PROTOCOL_RENT_BPS = 500;
    uint64 internal constant MAX_RENTAL_TERM_CEILING = 365 days;

    bytes32[] internal keys;

    // -----------------------------------------------------------------
    // What each concrete campaign supplies
    // -----------------------------------------------------------------

    function _useToken() internal view virtual returns (bool);
    function _config() internal view virtual returns (SlotSite.SiteConfig memory);
    function _floors() internal view virtual returns (uint256[] memory);

    /// @notice How many standalone `claimRent` calls a campaign must land to count as covering that
    /// path. One by default. A campaign may lower it, but only for a reason that is a property of
    /// its configuration rather than an inconvenience — see the dust campaign.
    function _minRentClaims() internal pure virtual returns (uint256) {
        return 1;
    }

    /// @notice One unit of the settlement currency, so a config reads the same in both variants.
    function _unit() internal view returns (uint256) {
        return _useToken() ? 1e6 : 1e18;
    }

    function _baseConfig() internal view returns (SlotSite.SiteConfig memory) {
        return SlotSite.SiteConfig({
            name: "Invariant Site",
            symbol: "INV",
            baseTokenURI: "",
            treasury: siteTreasury,
            settlementToken: _useToken() ? address(token) : address(0),
            takeBps: 14_000,
            payoutBps: 11_500,
            reversionBps: 9_700,
            maxReversionWeeks: 52,
            cooldownSecs: 900,
            defaultFloor: 0,
            floorDeltaBps: 2_000,
            floorChangeCooldown: 24 hours,
            maxAskBps: 40_000,
            minRentBps: 25,
            siteRentBps: 2_500,
            maxRentalTerm: 30 days,
            openRegistration: false,
            royaltyBps: 500
        });
    }

    function setUp() public virtual {
        token = new MockToken();
        implementation = new SlotSite(PROTOCOL_BPS, PROTOCOL_RENT_BPS, protocolTreasury);
        // `address(RentalsLib)` resolves to the linked library, which is what a clone will
        // delegatecall — so every sequence in this file exercises the real link, not an inlined
        // copy that would never exist in production.
        factory = new SlotFactory(address(implementation), address(RentalsLib));

        // Three registered slots, then two WILD keys that start unregistered. The wild pair is what
        // makes `onlyRegisteredSlotsAreOwned` a real assertion rather than a tautology, and the only
        // way to reach `_register` from inside `_buy` once open registration is toggled on.
        keys.push(keccak256("hero.headline"));
        keys.push(keccak256("hero.image"));
        keys.push(keccak256("nav.link.1"));

        uint256[] memory floors = _floors();
        bytes32[] memory registered = new bytes32[](3);
        for (uint256 i = 0; i < 3; i++) {
            registered[i] = keys[i];
        }

        vm.prank(siteOwner);
        site = SlotSite(payable(factory.createSite(_config(), registered, floors)));

        keys.push(keccak256("wild.one"));
        keys.push(keccak256("wild.two"));

        handler = new SlotSiteHandler(site, token, siteOwner, siteTreasury, protocolTreasury, keys);
        targetContract(address(handler));
        targetSelector(FuzzSelector({ addr: address(handler), selectors: _selectors() }));
    }

    /// @notice Weighted, because Foundry samples the selector list uniformly and v1 learned what
    /// that costs: unweighted, `buy` was 1 of 11 actions and — since takes compound and most
    /// attempts hit a cooldown — a 128,000-call campaign landed about 30 purchases. The invariants
    /// passed, on a contract that had barely been touched.
    ///
    /// The weights here follow the same logic one layer up. `buy` and `warp` dominate, and the four
    /// rental transitions get real weight because they are what the take path has to compose with;
    /// the publisher levers are ratchets that mostly no-op after a few calls and need only one slot
    /// each.
    function _selectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](36);
        uint256 i;
        s[i++] = SlotSiteHandler.buy.selector;
        s[i++] = SlotSiteHandler.buy.selector;
        s[i++] = SlotSiteHandler.buy.selector;
        s[i++] = SlotSiteHandler.buy.selector;
        s[i++] = SlotSiteHandler.buyForOverpay.selector;
        s[i++] = SlotSiteHandler.buyForOverpay.selector;
        s[i++] = SlotSiteHandler.warp.selector;
        s[i++] = SlotSiteHandler.warp.selector;
        s[i++] = SlotSiteHandler.warp.selector;
        s[i++] = SlotSiteHandler.listForRent.selector;
        s[i++] = SlotSiteHandler.listForRent.selector;
        s[i++] = SlotSiteHandler.rent.selector;
        s[i++] = SlotSiteHandler.rent.selector;
        s[i++] = SlotSiteHandler.extendRental.selector;
        s[i++] = SlotSiteHandler.extendRental.selector;
        s[i++] = SlotSiteHandler.claimRent.selector;
        s[i++] = SlotSiteHandler.claimRent.selector;
        s[i++] = SlotSiteHandler.endRental.selector;
        s[i++] = SlotSiteHandler.endRental.selector;
        s[i++] = SlotSiteHandler.setAsk.selector;
        s[i++] = SlotSiteHandler.setAsk.selector;
        s[i++] = SlotSiteHandler.edit.selector;
        s[i++] = SlotSiteHandler.transfer.selector;
        s[i++] = SlotSiteHandler.setEditor.selector;
        s[i++] = SlotSiteHandler.setFloor.selector;
        s[i++] = SlotSiteHandler.withdraw.selector;
        s[i++] = SlotSiteHandler.withdrawParty.selector;
        s[i++] = SlotSiteHandler.withdrawTreasury.selector;
        s[i++] = SlotSiteHandler.sweepTreasury.selector;
        s[i++] = SlotSiteHandler.donate.selector;
        // The publisher levers. One slot each: they are ratchets, so after a handful of calls most
        // of them can only no-op, and weighting them higher would spend the campaign on settings
        // rather than on the sequences those settings make reachable.
        s[i++] = SlotSiteHandler.setEconomics.selector;
        s[i++] = SlotSiteHandler.setRentalTerms.selector;
        s[i++] = SlotSiteHandler.setFloorPolicy.selector;
        s[i++] = SlotSiteHandler.setPaused.selector;
        s[i++] = SlotSiteHandler.setOpenRegistration.selector;
        s[i++] = SlotSiteHandler.setAvailability.selector;
        require(i == s.length, "selector count");
    }

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    function _held() internal view returns (uint256) {
        return _useToken() ? token.balanceOf(address(site)) : address(site).balance;
    }

    function _rental(bytes32 key)
        internal
        view
        returns (address tenant, uint64 start, uint64 expiry, uint256 prepaid, uint256 claimed)
    {
        (tenant, start, expiry, prepaid, claimed,) = site.rentals(key);
    }

    // =================================================================
    // The properties
    //
    // Grouped into seven `invariant_` functions rather than the twenty-one checks they contain,
    // because Foundry runs a SEPARATE campaign per invariant function — twenty-one of them cost
    // 4m39s against one config, and four configs made that unusable as a pre-commit suite. The
    // checks below keep their own names and their own failure messages, so a break still reports
    // which property gave way; only the number of campaigns changed.
    // =================================================================

    /// @notice Everything the ledger has to say about where the money is.
    function invariant_solvency() public view {
        _checkNeverOwesMoreThanItHolds();
        _checkConservation();
        _checkNothingOwedToNobody();
    }

    /// @notice The contract never owes more than it holds.
    ///
    /// v1's version summed the pull ledger and the treasury. v2 adds **escrowed rent**: money the
    /// contract is holding on behalf of a tenancy that has not yet accrued. It belongs on the owed
    /// side, and leaving it out would have made every rental look like a surplus.
    ///
    /// Asserted here and never on-chain. Spec §1.5 Finding 5: the settlement token's issuer can
    /// freeze or wipe an address, which would make an on-chain equality permanently false and brick
    /// every path that checked it.
    function _checkNeverOwesMoreThanItHolds() internal view {
        uint256 owed = site.treasuryBalance() + site.totalEscrowedRent();
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            owed += site.pendingWithdrawals(handler.actors(i));
        }
        owed += site.pendingWithdrawals(protocolTreasury);
        owed += site.pendingWithdrawals(siteOwner);
        owed += site.pendingWithdrawals(siteTreasury);
        owed += site.pendingWithdrawals(address(handler));

        assertEq(owed, _held(), "site owes more than it holds");
    }

    /// @notice Every unit that entered is still here or was withdrawn by someone entitled to it.
    /// Catches a leak the balance check alone would miss — a path that credits nobody and spends the
    /// funds anyway keeps `owed == balance` true while the money vanishes.
    function _checkConservation() internal view {
        assertEq(
            handler.ghostTotalIn() - handler.ghostTotalOut(),
            _held(),
            "funds entered or left without being accounted for"
        );
    }

    /// @notice Nothing is ever credited to nobody. This is the specific shape the solvency check
    /// cannot see: a balance owed to `address(0)` keeps `owed == held` true while being permanently
    /// unwithdrawable. The path that would produce it is `_settleRent` running against an unowned
    /// slot, which is unreachable today only because `rent` requires an owner — a guard three call
    /// sites away from the credit it protects.
    function _checkNothingOwedToNobody() internal view {
        assertEq(site.pendingWithdrawals(address(0)), 0, "funds credited to the zero address");
    }

    // -----------------------------------------------------------------

    /// @notice Escrow — v2's second money path, and the one v1 has no analogue for.
    function invariant_escrowLedger() public view {
        _checkEscrowMatchesTenancies();
        _checkClaimedNeverExceedsPrepaid();
        _checkClearedTenanciesHoldNothing();
        _checkExtensionSettlesBeforeItRestarts();
    }

    /// @notice **The escrow ledger agrees with the tenancies it is supposedly holding.**
    ///
    /// `totalEscrowedRent` is a single running total maintained by the site, while `prepaid` and
    /// `claimed` are per-rental fields maintained by a delegatecalled library. Nothing in the code
    /// forces the two to agree — the site adds the net at `rent`, subtracts what `claim` returns,
    /// and rolls a carry forward at `extend`. This is the check that the hand-off never drops or
    /// double-counts a unit, and it is why `extendRental` settles before it restarts rather than
    /// after: settle second and the carry is computed against a stale `claimed`.
    function _checkEscrowMatchesTenancies() internal view {
        uint256 sum;
        for (uint256 i = 0; i < keys.length; i++) {
            (,,, uint256 prepaid, uint256 claimed) = _rental(keys[i]);
            sum += prepaid - claimed;
        }
        assertEq(sum, site.totalEscrowedRent(), "escrow total diverged from the sum of tenancies");
    }

    /// @notice An owner can never have been paid more rent than was escrowed for the term.
    function _checkClaimedNeverExceedsPrepaid() internal view {
        for (uint256 i = 0; i < keys.length; i++) {
            (,,, uint256 prepaid, uint256 claimed) = _rental(keys[i]);
            assertLe(claimed, prepaid, "more rent was claimed than was ever escrowed");
        }
    }

    /// @notice `endRental` drains a term to zero. A cleared tenancy holding residual escrow would be
    /// money nobody can ever reach — `finish` deletes the very fields the claim path reads from, so
    /// anything left behind at that moment is stranded permanently.
    ///
    /// It holds only because `finish` refuses to run before expiry, at which point `accrued` is the
    /// whole of `prepaid`. Relax that guard to allow early termination and this is the invariant
    /// that fails.
    function _checkClearedTenanciesHoldNothing() internal view {
        for (uint256 i = 0; i < keys.length; i++) {
            (address tenant,, uint64 expiry, uint256 prepaid, uint256 claimed) = _rental(keys[i]);
            if (tenant == address(0) && expiry == 0) {
                assertEq(prepaid, 0, "a cleared tenancy still holds escrow");
                assertEq(claimed, 0, "a cleared tenancy still records a claim");
            }
        }
    }

    /// @notice **An extension pays out what the outgoing term earned before it restarts.**
    ///
    /// This one was added because the suite failed to catch it. Deleting the `_settleRent` call at
    /// the top of `extendRental` leaves `totalEscrowedRent` perfectly consistent with the sum of
    /// `prepaid - claimed` — the carry absorbs exactly what the settle would have removed — so the
    /// ledger invariant above passes on the mutant. What actually breaks is economic rather than
    /// arithmetic: `extend` restarts the linear term from now, so rent the owner had ALREADY earned
    /// gets re-streamed over the new term and paid to whoever holds the position when it accrues.
    /// One take during the extension and the seller's income is the buyer's.
    ///
    /// It is visible only at the transition, so the handler measures the owner's balance across the
    /// call and this asserts the count. Worth stating plainly: a self-consistent ledger is not the
    /// same claim as money reaching the right party, and only one of the two is an accounting
    /// identity.
    function _checkExtensionSettlesBeforeItRestarts() internal view {
        assertEq(handler.ghostRentRolledForward(), 0, "an extension rolled already-earned rent into the new term");
    }

    // -----------------------------------------------------------------

    /// @notice Encumbrance — what §8's collision turns into, stated as properties.
    function invariant_encumbranceIsBounded() public view {
        _checkTenancyNeverExceedsTheTermCap();
        _checkInheritedEncumbrance();
        _checkUserOfAgreesWithExpiry();
    }

    /// @notice **No tenancy ever outlives the longest term the publisher has ever permitted.**
    ///
    /// `maxRentalTerm` is freely mutable in both directions (§2.5.1), so the *current* setting is
    /// the wrong bound — lowering it cannot reach into a live term, and asserting against it would
    /// fail on a perfectly legitimate sequence. The ghost records the high-water mark instead, which
    /// is the honest statement of what a buyer can inherit.
    ///
    /// The second bound holds unconditionally: `MAX_RENTAL_TERM_CEILING` is in the frozen
    /// implementation's bytecode, so no configuration a publisher can reach locks a position for
    /// longer than a year.
    function _checkTenancyNeverExceedsTheTermCap() internal view {
        uint64 cap = handler.ghostMaxTermCap();
        for (uint256 i = 0; i < keys.length; i++) {
            (, uint64 start, uint64 expiry,,) = _rental(keys[i]);
            if (expiry == 0) continue;
            assertLe(expiry - start, cap, "a tenancy outlived the longest permitted term");
            assertLe(expiry - start, MAX_RENTAL_TERM_CEILING, "a tenancy outlived the frozen ceiling");
        }
    }

    /// @notice What a BUYER inherits, which is not the same quantity as the term's length and is the
    /// one that actually matters. `extend` caps the REMAINING window rather than the total precisely
    /// so this holds however many extensions preceded the sale — cap the total instead and a tenant
    /// extends repeatedly inside one block and holds the position for a year.
    function _checkInheritedEncumbrance() internal view {
        uint64 cap = handler.ghostMaxTermCap();
        for (uint256 i = 0; i < keys.length; i++) {
            (,, uint64 expiry,,) = _rental(keys[i]);
            if (expiry <= block.timestamp) continue;
            assertLe(expiry - block.timestamp, cap, "a buyer could inherit more than the permitted term");
        }
    }

    /// @notice A lapsed term never reads as a live tenancy. `userOf` is what a renderer and every
    /// ERC-4907 consumer trust, so an expired-but-uncleared rental reporting a tenant would leave
    /// paid content on the page after the term ended — and `endRental` is permissionless precisely
    /// because nothing else guarantees the clear-up happens promptly.
    function _checkUserOfAgreesWithExpiry() internal view {
        for (uint256 i = 0; i < keys.length; i++) {
            (address tenant,, uint64 expiry,,) = _rental(keys[i]);
            address live = site.userOf(uint256(keys[i]));
            if (block.timestamp < expiry) {
                assertEq(live, tenant, "a live tenancy reported the wrong tenant");
            } else {
                assertEq(live, address(0), "a lapsed tenancy still reads as live");
            }
        }
    }

    // -----------------------------------------------------------------

    /// @notice What a displaced owner walks away with, and who the money follows.
    function invariant_payoutPromise() public view {
        _checkPayoutNeverBelowTheFloor();
        _checkTakeDoesNotStealAccruedRent();
        _checkChangeFollowsThePayer();
        _checkLastPriceMatchesWhatWasPaid();
    }

    /// @notice **A displaced owner is always credited at least the site's floor for that slot** —
    /// and the measurement is net of rent, which is the v2-specific part.
    ///
    /// The bound is `10_000` bps — the FLOOR — not `payoutBps`. That is not slack, it is the actual
    /// guarantee: `payout` is `payoutBps` of an effective floor that can never fall below
    /// `basePrice`, but at dust `(floor × 11_500) / 10_000` truncates and the margin rounds away
    /// entirely. v1's suite is what found that; the dust campaign below is what keeps it findable.
    ///
    /// **Net of rent** because a take settles the outgoing owner's accrued rent into the same
    /// balance. Counting that as payout would inflate the ratio and let a genuine shortfall pass on
    /// exactly the positions v2 added — the rented ones. The handler subtracts it before recording.
    function _checkPayoutNeverBelowTheFloor() internal view {
        uint256 observed = handler.ghostMinPayoutVsFloorBps();
        if (observed == type(uint256).max) return; // no takes yet this run
        assertGe(observed, BPS, "a displaced owner was credited less than the slot's floor");
    }

    /// @notice **A take settles rent to the OUTGOING owner, not the incoming one.**
    ///
    /// `_settleRent` runs before `_transfer`, so `_ownerOf` inside it still resolves to the seller.
    /// Reverse the two statements and the contract still compiles, still passes every unit test that
    /// does not rent, and quietly hands the buyer income the seller earned. It is observable only at
    /// the moment of the transition, so the handler counts it and this asserts the count.
    function _checkTakeDoesNotStealAccruedRent() internal view {
        assertEq(handler.ghostRentStolenOnTake(), 0, "a take credited the buyer with the seller's rent");
    }

    /// @notice The standing check from `CLAUDE.md`, as a property: *if this function assigns
    /// ownership, could the beneficiary ever differ from the party paying gas?* `buyFor` answers yes
    /// and takes an explicit recipient — so change from an overpayment must follow the PAYER, or a
    /// router forwarding a remainder sends it to the wrong address. That mistake has already killed
    /// one implementation in the sibling project.
    function _checkChangeFollowsThePayer() internal view {
        assertEq(handler.ghostChangeMisrouted(), 0, "overpayment change was credited to the wrong party");
    }

    /// @notice `lastPrice` is what the buyer actually paid — never the inflated take price on a
    /// claim, and never moved by a transfer. A transfer that touched it would let a wash trade
    /// launder a cost basis downward and reset the reversion clock with it.
    function _checkLastPriceMatchesWhatWasPaid() internal view {
        for (uint256 i = 0; i < keys.length; i++) {
            uint256 paid = handler.ghostPaidByOwner(keys[i]);
            if (paid == 0) continue;
            assertEq(site.slotOf(keys[i]).lastPrice, paid, "lastPrice diverged from what was paid");
        }
    }

    // -----------------------------------------------------------------

    /// @notice Pricing and issuance.
    function invariant_pricingAndOwnership() public view {
        _checkPricingRespectsTheFloor();
        _checkOnlyRegisteredSlotsAreOwned();
        _checkClaimsRespectAvailability();
    }

    /// @notice A slot's quoted price is never below its effective floor, and the effective floor is
    /// never below the configured floor. Both directions of the `max()` that stops reversion from
    /// being a slow giveaway — including when an ask is the reversion base, which is the one thing
    /// §3 changed about this path.
    function _checkPricingRespectsTheFloor() internal view {
        for (uint256 i = 0; i < keys.length; i++) {
            if (!site.slotOf(keys[i]).registered) continue;
            (uint256 effectiveFloor, uint256 price) = site.quote(keys[i]);
            assertGe(effectiveFloor, site.slotOf(keys[i]).basePrice, "effective floor fell below the floor");
            assertGe(price, effectiveFloor, "take price fell below the effective floor");
        }
    }

    /// @notice Only registered slots can ever be owned — §7.5's squatting defence as a property
    /// rather than as the one call path a unit test happens to try. The wild keys are what give it
    /// something to say: with open registration on, `_buy` registers mid-purchase, and this asserts
    /// it never mints without doing so.
    function _checkOnlyRegisteredSlotsAreOwned() internal view {
        for (uint256 i = 0; i < keys.length; i++) {
            if (site.ownerOfOrZero(keys[i]) != address(0)) {
                assertTrue(site.slotOf(keys[i]).registered, "an unregistered slot has an owner");
            }
        }
    }

    /// @notice §10.4's listing toggle, as a transition property. A state check cannot see this —
    /// the slot ends the call owned and available-or-not, both legal — so the handler measures at
    /// the buy itself: a CLAIM must never have succeeded on a registered slot whose flag was off
    /// when the purchase landed. Takes are exempt by design; the flag is not a lever over owned
    /// positions.
    function _checkClaimsRespectAvailability() internal view {
        assertEq(handler.ghostUnavailableClaims(), 0, "a claim landed on a slot the publisher had marked unavailable");
    }

    // -----------------------------------------------------------------

    /// @notice Who may write the page.
    function invariant_contentGate() public view {
        _checkTenantHoldsTheContentGate();
        _checkEditorViewsAgree();
    }

    /// @notice §2.3. During a live term the TENANT edits and the owner is locked out. Without the
    /// exclusion an owner overwrites content an advertiser paid for, and the tenancy is unsellable.
    /// A delegated editor has to be shut out by the same rule, or the grant is a way round the door.
    function _checkTenantHoldsTheContentGate() internal view {
        for (uint256 i = 0; i < keys.length; i++) {
            bytes32 key = keys[i];
            address tenant = site.userOf(uint256(key));
            if (tenant == address(0)) continue;

            address owner_ = site.ownerOfOrZero(key);
            assertTrue(site.canEdit(key, tenant), "the sitting tenant cannot edit");
            if (owner_ != tenant) {
                assertFalse(site.canEdit(key, owner_), "the owner can edit during a live tenancy");
            }
            // Not `editorOf == address(0)`: an owner may perfectly well have delegated to the same
            // address that later rented the slot, and then the effective editor IS the tenant. The
            // property is that nobody ELSE survives the tenancy.
            address effective = site.editorOf(key);
            if (effective != address(0)) {
                assertEq(effective, tenant, "a delegated editor outranked the sitting tenant");
            }
        }
    }

    /// @notice A revoked or expired delegation must never read as live. `editorOf` returns the
    /// EFFECTIVE editor, so it has to agree with `canEdit` after every sequence — including the
    /// take-then-buy-back case that `grantedAtTakes` exists to close.
    function _checkEditorViewsAgree() internal view {
        for (uint256 i = 0; i < keys.length; i++) {
            address editor = site.editorOf(keys[i]);
            if (editor != address(0)) {
                assertTrue(site.canEdit(keys[i], editor), "editorOf reported an editor who cannot edit");
            }
        }
    }

    // -----------------------------------------------------------------

    /// @notice What the configuration is allowed to become.
    function invariant_configIsHonest() public view {
        _checkEconomicsStayInsideTheClamps();
        _checkRatchetOnlyMovesTheSafeWay();
        _checkTermsLockOnceClaimed();
        _checkFrozenConfigStaysFrozen();
    }

    /// @notice The absolute clamps hold at every moment, locked or not — that is what lets a buyer
    /// trust a site without reading its config. `takeBps > payoutBps + protocolBps` is the strict
    /// one: at equality the site's cut underflows and every take on the site reverts.
    function _checkEconomicsStayInsideTheClamps() internal view {
        uint256 take = site.takeBps();
        uint256 payout = site.payoutBps();
        assertGe(payout, BPS, "payout fell below principal");
        assertLe(take, 30_000, "take exceeded the ceiling");
        assertGt(take, payout + PROTOCOL_BPS, "the site's cut would underflow");
        assertGt(site.reversionBps(), 0, "reversion reached zero");
        assertLe(site.reversionBps(), BPS, "reversion exceeded 1.0");
        assertLe(site.maxReversionWeeks(), 52, "reversion horizon exceeded the ceiling");
        assertLe(site.cooldownSecs(), 7 days, "cooldown exceeded the ceiling");
    }

    /// @notice §6.1's ratchet, counted at the transition. The handler proposes only holder-safe
    /// moves, so anything this catches is the contract letting one through rather than the fuzzer
    /// asking for it.
    function _checkRatchetOnlyMovesTheSafeWay() internal view {
        assertEq(handler.ghostRatchetViolations(), 0, "a locked site moved its economics against the ratchet");
    }

    /// @notice Once the first position is claimed the free-edit window closes forever. There is no
    /// un-mint, so this is really asserting that no reachable sequence finds a way to reopen it.
    function _checkTermsLockOnceClaimed() internal view {
        if (handler.ghostClaims() > 0 || handler.ghostTakes() > 0) {
            assertTrue(site.termsLocked(), "a site with a minted position is still unlocked");
        }
    }

    /// @notice Frozen at `initialize` and never again. `settlementToken` has no setter because
    /// changing it orphans every balance on the ledger; `minFloor` is derived from that token's
    /// decimals, so it is frozen by the same argument. The protocol trio lives in the
    /// implementation's immutables, which a clone cannot strip.
    function _checkFrozenConfigStaysFrozen() internal view {
        assertEq(site.settlementToken(), _useToken() ? address(token) : address(0), "settlement token moved");
        assertEq(site.minFloor(), _expectedMinFloor(), "minFloor moved");
        assertEq(site.protocolBps(), PROTOCOL_BPS, "protocolBps moved");
        assertEq(site.protocolRentBps(), PROTOCOL_RENT_BPS, "protocolRentBps moved");
        assertEq(site.protocolTreasury(), protocolTreasury, "protocolTreasury moved");
        assertEq(site.implementationVersion(), 2, "implementation version moved");
    }

    /// @dev 1e-4 of a unit, per §11.2 — derived from the token's decimals rather than baked in,
    /// because a constant tuned for 6 decimals is wrong by 1e12 against an 18-decimal token.
    function _expectedMinFloor() internal view returns (uint256) {
        return _unit() / 10_000;
    }

    // =================================================================
    // Coverage, so a green run cannot be a vacuous one
    // =================================================================

    /// @notice Every invariant above is trivially true if nothing happened, so a suite that stopped
    /// exercising the contract would still report green.
    ///
    /// **This has to be `afterInvariant`, not an `invariant_`.** Foundry evaluates invariants once
    /// BEFORE the first call, when nothing has happened, so as an invariant it fails every run by
    /// construction. v1's suite learned that on its first run and v2's would have repeated it.
    ///
    /// The assertion that earns its place here is `ghostTakesUnderTenancy`. Every rental × take
    /// property above — the outgoing-owner settlement, the rent-net payout ratio, the inherited
    /// encumbrance bound — is vacuous unless a take actually landed on a rented slot. That single
    /// composition is what spec §8 says the suite exists for, so a campaign that never reached it
    /// has not tested v2, only v1 with extra functions attached.
    /// @dev A campaign is this many calls or more. A shrink replay is at most one sequence long,
    /// so anything below the bar is one of those rather than a real run — see `afterInvariant`.
    uint256 internal constant COVERAGE_MIN_CALLS = 2_000;

    function afterInvariant() public view {
        // **Skip the coverage bar on a shrink replay, or it hides the failure that caused it.**
        //
        // When any property breaks, Foundry shrinks the offending sequence and replays it — and
        // `afterInvariant` runs against that replay, where almost nothing has happened. The
        // coverage assertions then fail first, and their message REPLACES the property failure in
        // the report. Two genuine-looking failures earlier in this suite's life were exactly that:
        // both reported "rent was never claimed" against an all-zero ghost dump, and both turned
        // out to be the coverage bar itself, seed-flaky, with no property broken at all. The
        // reverse — a real break reported as a coverage miss — is the same trap pointing the other
        // way, and it is the expensive one.
        if (handler.ghostCalls() < COVERAGE_MIN_CALLS) return;

        // Logged BEFORE the assertions, deliberately. A coverage assertion that fired would
        // otherwise abort the function and take the numbers with it — leaving "no take ever landed
        // on a rented slot" with no indication of whether the campaign managed one rental or two
        // hundred, which is the only thing that says how to fix it.
        console.log("claims                 ", handler.ghostClaims());
        console.log("takes                  ", handler.ghostTakes());
        console.log("takes under tenancy    ", handler.ghostTakesUnderTenancy());
        console.log("underwater takes       ", handler.ghostUnderwaterTakes());
        console.log("min payout vs floor bps", handler.ghostMinPayoutVsFloorBps());
        console.log("lists                  ", handler.ghostLists());
        console.log("rents / extends / ends ", handler.ghostRents(), handler.ghostExtends(), handler.ghostEnds());
        console.log("rent claims            ", handler.ghostRentClaims());
        console.log("asks set / above last  ", handler.ghostAsksSet(), handler.ghostAsksPriced());
        console.log("overpaid buys          ", handler.ghostOverpays());
        console.log("registrations mid-buy  ", handler.ghostRegistrations());
        console.log("economics changes      ", handler.ghostEconomicsChanges());
        console.log("max term cap (secs)    ", handler.ghostMaxTermCap());
        console.log("availability toggles   ", handler.ghostAvailabilityToggles());
        console.log("claims vs unavailable  ", handler.ghostUnavailableClaimAttempts());

        assertGt(handler.ghostClaims(), 0, "no slot was ever claimed");
        assertGt(handler.ghostTakes(), 0, "no TAKE succeeded - the payout invariants were vacuous");
        assertGt(handler.ghostRents(), 0, "no tenancy was ever opened - the escrow invariants were vacuous");
        assertGt(handler.ghostEnds(), 0, "no tenancy was ever ended - the drain invariant was vacuous");
        assertGe(
            handler.ghostRentClaims(),
            _minRentClaims(),
            "rent was never claimed - the standalone settlement path was vacuous"
        );
        assertGt(
            handler.ghostTakesUnderTenancy(),
            0,
            "no take ever landed on a rented slot - the composition this suite exists for never happened"
        );
        assertGt(
            handler.ghostUnavailableClaimAttempts(),
            0,
            "no claim was ever attempted against an unavailable slot - the availability gate was vacuous"
        );
    }
}

// =====================================================================
// The campaigns
//
// Four corners of the admissible config space, not four features. Spec §7 is explicit that
// per-feature configs cannot see the class of defect where two individually-sound parameters
// collide, and §8 names the example these were chosen around.
// =====================================================================

/// @notice The Standard profile on native settlement — the reference configuration a publisher gets
/// by default, and the one every number in §9 was chosen for.
/// forge-config: default.invariant.runs = 48
/// forge-config: default.invariant.depth = 600
contract SlotSiteInvariantStandardTest is SlotSiteInvariantBase {
    function _useToken() internal pure override returns (bool) {
        return false;
    }

    function _config() internal view override returns (SlotSite.SiteConfig memory) {
        return _baseConfig();
    }

    function _floors() internal view override returns (uint256[] memory f) {
        f = new uint256[](3);
        f[0] = _unit() / 100;
        f[1] = _unit() / 20;
        f[2] = _unit() / 50;
    }
}

/// @notice The same profile on a 6-decimal ERC-20, because the token branch rewrites collection and
/// payout on the function with the most test weight behind it (§8).
///
/// v1's suite could not have found what this one can: `_pay` returns 0 on the token path where the
/// native path performs a real CALL, and the v2 unit suite already has one failure that passed under
/// the token variant and failed under native — which is what identified it as a funding problem
/// rather than a logic error. Both settlement paths, or neither.
/// forge-config: default.invariant.runs = 48
/// forge-config: default.invariant.depth = 600
contract SlotSiteInvariantTokenTest is SlotSiteInvariantBase {
    function _useToken() internal pure override returns (bool) {
        return true;
    }

    function _config() internal view override returns (SlotSite.SiteConfig memory) {
        return _baseConfig();
    }

    function _floors() internal view override returns (uint256[] memory f) {
        f = new uint256[](3);
        f[0] = _unit() / 100;
        f[1] = _unit() / 20;
        f[2] = _unit() / 50;
    }
}

/// @notice **The §8 collision, deliberately configured.**
///
/// `maxRentalTerm` at the 365-day ceiling against a 52-week (364-day) reversion horizon. A
/// maximally-encumbered position can be locked for the entire discovery cycle, reverting to its
/// floor while its owner has no control over it. Both numbers were chosen soundly and independently;
/// the collision exists only in their product, which is precisely the class of defect a per-feature
/// config cannot see.
///
/// `maxAskBps` is at its down-only minimum here too, so the owner's one lever against reversion —
/// posting an ask above `lastPrice` — is unavailable. That is the worst case for the mechanism, and
/// the point of running it is that the invariants above must hold in it anyway.
/// forge-config: default.invariant.runs = 48
/// forge-config: default.invariant.depth = 600
contract SlotSiteInvariantLongHorizonTest is SlotSiteInvariantBase {
    function _useToken() internal pure override returns (bool) {
        return false;
    }

    function _config() internal view override returns (SlotSite.SiteConfig memory cfg) {
        cfg = _baseConfig();
        cfg.maxRentalTerm = MAX_RENTAL_TERM_CEILING;
        cfg.maxReversionWeeks = 52;
        cfg.reversionBps = 9_700;
        cfg.maxAskBps = 10_000;
        cfg.minRentBps = 1;
        cfg.openRegistration = true;
        cfg.defaultFloor = 1e14;
    }

    function _floors() internal view override returns (uint256[] memory f) {
        f = new uint256[](3);
        f[0] = _unit() / 100;
        f[1] = _unit() / 20;
        f[2] = _unit() / 50;
    }
}

/// @notice **The truncation corner.** Floors sitting exactly on `minFloor`, on the 6-decimal token
/// where `minFloor` is 100 units, with every bps multiply pushed to the edge that rounds:
/// `payoutBps` at its `10_000` minimum, `takeBps` at its `30_000` ceiling, the rent fee band at its
/// `1_000` minimum, and `minRentBps` at 1 — which admits a rate low enough that a short term costs
/// literally zero.
///
/// This is where the payout invariant is tight rather than slack: at a floor of 100 units,
/// `(100 × 10_000) / 10_000` is exactly 100, so `payout >= basePrice` holds with no margin at all
/// and any rounding error in the split is immediately visible. v1's equivalent — a one-wei floor —
/// is what proved the guarantee is the FLOOR and not `payoutBps`, and this is its v2 successor.
///
/// `cooldownSecs` is zero so takes compound without friction, which is what makes the campaign
/// reach the truncation edge often rather than once.
/// forge-config: default.invariant.runs = 48
/// forge-config: default.invariant.depth = 600
contract SlotSiteInvariantDustTest is SlotSiteInvariantBase {
    function _useToken() internal pure override returns (bool) {
        return true;
    }

    /// @notice **Zero, and the reason is the configuration rather than a shortfall in the fuzzer.**
    ///
    /// `cooldownSecs` is 0 here, so takes are unthrottled — and every take calls `_settleRent`
    /// before ownership moves. A standalone `claimRent` therefore almost never finds an unswept
    /// balance: the take path has already taken it. Add to that rent amounts that truncate toward
    /// zero at a 100-unit floor, and the *permissionless claim* is genuinely close to unreachable
    /// in this corner.
    ///
    /// That is a fact about the corner, not a hole: rent settlement itself is still exercised here
    /// on every take, and the standalone path is covered by the three campaigns above. Relaxing it
    /// is what lets this campaign keep testing what it is actually for — truncation — instead of
    /// being tuned away from it to satisfy a coverage assertion it cannot honestly meet.
    function _minRentClaims() internal pure override returns (uint256) {
        return 0;
    }

    function _config() internal view override returns (SlotSite.SiteConfig memory cfg) {
        cfg = _baseConfig();
        cfg.takeBps = 30_000;
        cfg.payoutBps = 10_000;
        cfg.reversionBps = 1;
        cfg.maxReversionWeeks = 52;
        cfg.cooldownSecs = 0;
        cfg.siteRentBps = 500; // total rent fee at the 1_000 minimum, with protocolRentBps
        cfg.minRentBps = 1;
        cfg.maxRentalTerm = MAX_RENTAL_TERM_CEILING;
    }

    function _floors() internal view override returns (uint256[] memory f) {
        uint256 dust = _unit() / 10_000; // exactly minFloor
        f = new uint256[](3);
        f[0] = dust;
        f[1] = dust;
        f[2] = dust;
    }
}
