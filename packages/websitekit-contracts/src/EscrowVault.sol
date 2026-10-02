// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { Attestor } from "./Attestor.sol";
import { SlotSite } from "./SlotSite.sol";

/// @notice Holds one board's publisher revenue for a window, and hands it to the board's slot
/// holders instead if the page goes dark inside it. `docs/escrow_contract.md` §10 is the
/// specification; this file follows its order and names.
///
/// **One vault per board, and that decision carries the rest.** `SlotSite.sweepTreasury()` sends a
/// lump sum with no message attached, so a shared vault could not tell whose money arrived. A vault
/// whose whole balance belongs to one board can book by BALANCE DELTA — `balance − bookedTotal −
/// pendingTotal − reserve` is always exactly the unbooked inbound — with nothing for a caller to
/// assert and therefore nothing to forge. Any value that reaches this address in the settlement
/// token becomes a deposit to the board's owner, ERC-2981 royalties paid in that token included.
///
/// **The bytecode this needs from `SlotSite` is the pin and nothing else.** `treasury` is frozen at
/// `createSite` to this vault's address, so the publisher's cut has exactly one door out of the
/// site and it opens here. Everything the vault decides — the clock, the cap, who claims, who is
/// paid — is read off the site's public accessors, and every rule in this file is revisable for
/// the NEXT board, because a vault is a clone of a replaceable implementation and a site is not.
///
/// **Money leaves through `withdrawFor` and nowhere else.** `release` and `claim` credit a pull
/// ledger; that is what makes a zero beneficiary a revert rather than a burn, a holder that is a
/// contract without `receive()` payable at all, and reentrancy a non-question on the money paths.
/// It is the shape `pendingWithdrawals` already has on the site.
///
/// **What the privileged key can do, exactly.** `markDark`/`clearDark` are the attestor's and
/// nothing else is. Marking moves money from the board's owner to its slot holders — after
/// `claimDelaySecs`, only against a slot the holder surrenders, only for a slot bought before the
/// mark, at most once per `minTransitionSecs` per board, and reversibly inside the delay. It cannot
/// pay the attestor, cannot pay the factory, cannot pay an address anybody names. The one thing
/// the factory's owner can withdraw is the `reserve` it funded itself, and never while dark.
contract EscrowVault is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice Policy, copied onto the vault at `bind` and immutable for that board from then on.
    struct Params {
        /// How long a deposit has to be served in the light before it is the publisher's.
        uint64 windowSecs;
        /// How long after `markDark` before any holder may claim. Measured in crawls: it is the
        /// window in which `clearDark` corrects a mistake before money moves on it.
        uint64 claimDelaySecs;
        /// Minimum spacing between `markDark`/`clearDark`, so oscillation is bounded on chain.
        uint64 minTransitionSecs;
        /// Below this, inbound stays unbooked and accumulates. The deposit array is what `claim`
        /// walks, and anyone can send one unit and call `book()`.
        uint128 minBooking;
    }

    /// @notice One booking. Two words.
    struct Deposit {
        /// Remaining, undrained.
        uint128 amount;
        uint64 bookedAt;
        /// Snapshot of `darkAccrued` INCLUDING any episode running at booking time. Without the
        /// running episode a deposit booked inside a blackout would mature `windowSecs` after the
        /// blackout BEGAN rather than after it ended.
        uint64 darkAtBooking;
        /// `site.owner()` when the money was booked — §6 option 3. Money earned before a handover
        /// pays the owner who earned it, and a handover needs no extra call.
        address beneficiary;
    }

    // ---------------------------------------------------------------------
    // Immutables — shared by every clone
    // ---------------------------------------------------------------------

    /// @dev The only address that may `bind`, and the only one that ever deploys a clone of this.
    address public immutable factory;
    /// @dev Where `attestor()` is read from on every privileged call. See `Attestor.sol`.
    Attestor public immutable registry;

    // ---------------------------------------------------------------------
    // State — set once at bind
    // ---------------------------------------------------------------------

    SlotSite public site;
    address public settlementToken;
    uint64 public windowSecs;
    uint64 public claimDelaySecs;
    uint64 public minTransitionSecs;
    uint128 public minBooking;

    // ---------------------------------------------------------------------
    // State — the clock
    // ---------------------------------------------------------------------

    /// @dev Zero when live. While non-zero, maturity is evaluated AS OF this moment, not now.
    uint64 public darkSince;
    /// @dev Total seconds of COMPLETED dark episodes. A running episode is not in here until
    /// `clearDark` closes it.
    uint64 public darkAccrued;
    uint64 public lastTransitionAt;

    // ---------------------------------------------------------------------
    // State — the ledger
    // ---------------------------------------------------------------------

    /// @dev Sum of `Deposit.amount` over every deposit.
    uint256 public bookedTotal;
    /// @dev Sum of `pending` over every account. Credited money waits in this contract's balance
    /// until withdrawn, and `book()` must not see it as fresh inbound.
    uint256 public pendingTotal;
    /// @dev Money the factory's owner put up so a claim can pay a holder the FULL price they paid
    /// rather than the publisher's 95% of it. Spent by `claim` after the pool; never released to
    /// the publisher; withdrawable by its funder only while the board is live.
    uint256 public reserve;
    mapping(address => uint256) public pending;
    /// @dev The `darkSince` a key last claimed against. A claim is refused while they are equal,
    /// which makes the ledger per EPISODE at the cost of one word and nothing to reset.
    mapping(bytes32 => uint64) public claimedEpoch;

    Deposit[] internal _deposits;
    /// @dev Index of the oldest deposit that may still hold money. Advanced past fully-drained
    /// prefixes so a long-lived vault's walks stay short.
    uint256 internal _head;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotFactory();
    error AlreadyBound();
    error NotBound();
    error NotPinnedHere();
    error InvalidParams();
    error NotAttestor();
    error AlreadyDark();
    error NotDark();
    error TransitionTooSoon();
    error NothingToRelease();
    error NotMature();
    error ZeroBeneficiary();
    error NotClaimable();
    error BoughtDuringBlackout();
    error AlreadyClaimedThisEpisode();
    error NotHolder();
    error NothingToClaim();
    error BelowMinimum();
    error NothingToWithdraw();
    error NotForeign();
    error NothingToSweep();
    error NotReserveOwner();
    error ReserveLocked();
    error TransferFailed();
    error NativeNotAccepted();
    error ZeroAddress();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event Bound(
        address indexed site, uint64 windowSecs, uint64 claimDelaySecs, uint64 minTransitionSecs, uint128 minBooking
    );
    event Booked(uint256 indexed id, address indexed beneficiary, uint256 amount, uint64 darkAtBooking);
    event Released(uint256 indexed id, address indexed beneficiary, uint256 amount);
    event Claimed(bytes32 indexed key, address indexed holder, uint256 amount, uint256 fromReserve);
    event Withdrawn(address indexed account, uint256 amount);
    event MarkedDark(uint64 at);
    event ClearedDark(uint64 at, uint64 darkAccrued);
    event ForeignSwept(address indexed token, address indexed to, uint256 amount);
    event ReserveFunded(address indexed from, uint256 amount);
    event ReserveWithdrawn(address indexed to, uint256 amount);

    // ---------------------------------------------------------------------

    constructor(address factory_, address registry_) {
        if (factory_ == address(0) || registry_ == address(0)) revert ZeroAddress();
        factory = factory_;
        registry = Attestor(registry_);
    }

    /// @dev Native inbound: a sweep from a native site, a royalty, a top-up. Booked on the next
    /// `book()`. On a TOKEN site native value is foreign and `sweepForeign(address(0))` returns it
    /// to the board's owner — it is not refused here, because a marketplace paying a royalty in
    /// native currency to `royaltyInfo`'s receiver would otherwise revert the sale it rode on.
    receive() external payable { }

    /// @dev A zero attestor is NOBODY, checked explicitly rather than left to the fact that no
    /// externally-owned account has that address: the registry's empty state is the fail-open
    /// state, and it must not be an address anybody can be.
    modifier onlyAttestor() {
        address a = registry.attestor();
        if (a == address(0) || msg.sender != a) revert NotAttestor();
        _;
    }

    modifier bound() {
        if (address(site) == address(0)) revert NotBound();
        _;
    }

    // ---------------------------------------------------------------------
    // Bind — the guarantee, made checkable by a stranger
    // ---------------------------------------------------------------------

    /// @notice Ties this vault to the board whose `treasury` is pinned to it.
    ///
    /// Callable by the factory alone, and the factory calls it in the same transaction that created
    /// the board — so there is no window in which a bound-looking vault points at a site that is
    /// not pinned to it, and no way to bind a contract that merely answers `treasury()` and
    /// `treasuryPinned()` the way a site would. `SlotFactory` keeps no registry of the sites it
    /// created, so provenance is the factory's own memory and this restriction is what enforces it.
    ///
    /// The check a stranger runs is BOTH directions: `site.treasury() == vault` and `vault.site()
    /// == site`. `createSite` is public, so anyone can create a second real board whose treasury
    /// is an existing vault; its money would be a donation to this board's owner, and its buyers
    /// would see a pinned treasury pointing at a vault that owes them nothing.
    function bind(address site_, Params calldata p) external {
        if (msg.sender != factory) revert NotFactory();
        if (address(site) != address(0)) revert AlreadyBound();
        if (site_ == address(0)) revert ZeroAddress();
        if (p.windowSecs == 0) revert InvalidParams();

        SlotSite s = SlotSite(payable(site_));
        if (s.treasury() != address(this) || !s.treasuryPinned()) revert NotPinnedHere();

        site = s;
        settlementToken = s.settlementToken();
        windowSecs = p.windowSecs;
        claimDelaySecs = p.claimDelaySecs;
        minTransitionSecs = p.minTransitionSecs;
        minBooking = p.minBooking;
        emit Bound(site_, p.windowSecs, p.claimDelaySecs, p.minTransitionSecs, p.minBooking);
    }

    // ---------------------------------------------------------------------
    // Book — anyone, always to the board's owner
    // ---------------------------------------------------------------------

    /// @notice Pulls whatever the site owes this vault and books the unbooked inbound as one deposit.
    ///
    /// Permissionless for the reason `sweepTreasury` and `withdrawFor` are: it pays a recorded
    /// party and never the caller, so it grants no authority and a scheduled job can do it without
    /// a signature. Two site calls precede the booking. `sweepTreasury()` moves the publisher's cut
    /// still sitting in `treasuryBalance`; `withdrawFor(vault)` collects the payout the site owes
    /// this vault when a slot it holds after a claim is taken — so a claimed slot's next sale
    /// refills the pool it drained.
    ///
    /// **Below `minBooking` nothing is booked and nothing reverts.** The money stays unbooked and
    /// is counted next time. A revert here would make `claim` — which books on entry — fail on a
    /// board that happened to hold dust.
    function book() external nonReentrant bound returns (uint256 id, uint256 amount) {
        return _book();
    }

    function _book() internal returns (uint256 id, uint256 amount) {
        if (site.treasuryBalance() > 0) site.sweepTreasury();
        if (site.pendingWithdrawals(address(this)) > 0) site.withdrawFor(address(this));

        amount = unbooked();
        if (amount < minBooking || amount == 0) return (type(uint256).max, 0);

        uint64 snapshot = _darkNow();
        address beneficiary = site.owner();
        id = _deposits.length;
        _deposits.push(
            Deposit({
                amount: uint128(amount),
                bookedAt: uint64(block.timestamp),
                darkAtBooking: snapshot,
                beneficiary: beneficiary
            })
        );
        bookedTotal += amount;
        emit Booked(id, beneficiary, amount, snapshot);
    }

    // ---------------------------------------------------------------------
    // Release — anyone, always to the deposit's beneficiary
    // ---------------------------------------------------------------------

    /// @notice Credits a mature deposit to whoever owned the board when it was booked.
    ///
    /// Accepts a deposit that matured before the CURRENT dark episode began, even while the board
    /// is dark: the maturity predicate is evaluated as of `darkSince`, so honest money is never
    /// stranded on a board that stays down, and a slow keeper never costs a publisher revenue they
    /// had already earned when the lights went out.
    function release(uint256 id) external nonReentrant bound {
        Deposit storage d = _deposits[id];
        uint256 amount = d.amount;
        if (amount == 0) revert NothingToRelease();
        if (!_mature(d)) revert NotMature();
        address beneficiary = d.beneficiary;
        // A board whose owner renounced is a board nobody owns. The pull ledger would otherwise
        // credit the zero address, and a credit nobody can withdraw is a burn with extra steps.
        if (beneficiary == address(0)) revert ZeroBeneficiary();

        d.amount = 0;
        bookedTotal -= amount;
        _credit(beneficiary, amount);
        _advanceHead();
        emit Released(id, beneficiary, amount);
    }

    // ---------------------------------------------------------------------
    // Claim — the holder, surrendering the slot
    // ---------------------------------------------------------------------

    /// @notice A holder gives up a slot on a dark board for up to what they paid for it.
    ///
    /// **A claim is a surrender, not a refund** (§5). The slot is transferred INTO this vault before
    /// a unit is credited, so nobody keeps a permanent right and collects for losing it. The vault
    /// then holds a blank position: it never writes, never lists, never edits, and when somebody
    /// takes the slot later the payout comes back through `book()`.
    ///
    /// Three refusals, each an attack this scheme was found open to:
    /// - not before `darkSince + claimDelaySecs`, so one false-positive crawl moves nothing;
    /// - not for a slot bought after the mark, so `buy` on chain while dark — which our checkout
    ///   refuses and the contract does not — cannot mint a claim, and a self-take ratchet cannot
    ///   inflate the cap against other holders' deposits;
    /// - not twice against one episode.
    ///
    /// The cap is `slotOf(key).lastPrice`, drawn first from deposits that are not yet mature —
    /// the publisher has not earned those — and then from `reserve` for the remainder, which is
    /// what lets a first buyer be made whole rather than 95% whole. Mature deposits are the
    /// publisher's and are never touched.
    ///
    /// The caller is the holder or an operator they approved, and the vault must itself be approved
    /// to move the token: `approve(vault, tokenId)` or `setApprovalForAll(vault, true)` first.
    ///
    /// `minPaid` is the least the caller will accept, and `0` means no floor — which is exactly what
    /// this call did before it took the parameter. **It exists because a surrender cannot be undone
    /// and the pool is first-come-first-served**, so a holder who is second on a contested board
    /// hands the slot in for whatever the block holds. Measured (`escrow_mainnet.md` E-4): a second
    /// claimant was paid $0.589474 against the $1.30 the vault had quoted them one block earlier,
    /// with no way to decline. `buy` takes a `maxPrice` and `rent` reverts `RateChanged` on any
    /// mismatch; this is the same protection on the one call that gives an asset away.
    ///
    /// It is checked AFTER the cap is applied, so it is a floor on what the caller will actually be
    /// credited rather than on what the pool holds — a holder whose own `lastPrice` is the binding
    /// constraint is not refused by a number they cannot influence.
    function claim(bytes32 key, uint256 minPaid) external nonReentrant bound returns (uint256 paid) {
        _book();

        uint64 since = darkSince;
        if (since == 0 || block.timestamp < uint256(since) + claimDelaySecs) revert NotClaimable();

        SlotSite.Slot memory slot = site.slotOf(key);
        if (slot.lastPurchaseTs >= since) revert BoughtDuringBlackout();
        if (claimedEpoch[key] == since) revert AlreadyClaimedThisEpisode();

        uint256 tokenId = uint256(key);
        address holder = site.ownerOfOrZero(key);
        if (holder == address(0)) revert NothingToClaim();
        if (
            msg.sender != holder && site.getApproved(tokenId) != msg.sender
                && !site.isApprovedForAll(holder, msg.sender)
        ) {
            revert NotHolder();
        }

        uint256 cap = slot.lastPrice;
        uint256 pool = immaturePool();
        uint256 available = pool + reserve;
        if (available > cap) available = cap;
        if (available == 0) revert NothingToClaim();
        // The floor the caller set. A surrender is irreversible and the pool is first-come, so
        // without this a holder hands the slot in at whatever the block happens to hold.
        if (available < minPaid) revert BelowMinimum();

        claimedEpoch[key] = since;
        // The surrender. Solady's `transferFrom` runs no receiver hook, and the site is frozen
        // bytecode this contract already trusts for every figure above.
        site.transferFrom(holder, address(this), tokenId);

        uint256 fromPool = _drain(available);
        uint256 fromReserve = available - fromPool;
        if (fromReserve > 0) reserve -= fromReserve;
        bookedTotal -= fromPool;
        _credit(holder, available);
        _advanceHead();
        emit Claimed(key, holder, available, fromReserve);
        return available;
    }

    /// @dev Oldest immature deposits first. Returns what the pool supplied.
    function _drain(uint256 want) internal returns (uint256 drained) {
        uint256 n = _deposits.length;
        for (uint256 i = _head; i < n && drained < want; i++) {
            Deposit storage d = _deposits[i];
            uint256 have = d.amount;
            if (have == 0 || _mature(d)) continue;
            uint256 take = want - drained;
            if (take > have) take = have;
            d.amount = uint128(have - take);
            drained += take;
        }
    }

    // ---------------------------------------------------------------------
    // Withdraw — the one place value leaves
    // ---------------------------------------------------------------------

    function withdraw() external nonReentrant {
        _withdrawTo(msg.sender);
    }

    /// @notice Pays `account` what it has been credited. Anyone may call it; only `account` is paid.
    function withdrawFor(address account) external nonReentrant {
        _withdrawTo(account);
    }

    function _withdrawTo(address account) internal {
        uint256 amount = pending[account];
        if (amount == 0) revert NothingToWithdraw();
        pending[account] = 0;
        pendingTotal -= amount;
        _pay(account, amount);
        emit Withdrawn(account, amount);
    }

    // ---------------------------------------------------------------------
    // The dark path — the attestor's, guarded in both directions
    // ---------------------------------------------------------------------

    /// @notice Stops every immature deposit's clock. Refused while already dark: overwriting
    /// `darkSince` would discard the accrued part of the episode, and the publisher would benefit
    /// from the attestor's mistake.
    function markDark() external onlyAttestor bound {
        if (darkSince != 0) revert AlreadyDark();
        _rateLimit();
        darkSince = uint64(block.timestamp);
        emit MarkedDark(uint64(block.timestamp));
    }

    /// @notice Closes the episode and adds it to `darkAccrued`. Refused while live: `now − 0` would
    /// add the whole of unix time to the accrual, and no deposit on this board would ever mature.
    function clearDark() external onlyAttestor bound {
        uint64 since = darkSince;
        if (since == 0) revert NotDark();
        _rateLimit();
        darkAccrued += uint64(block.timestamp) - since;
        darkSince = 0;
        emit ClearedDark(uint64(block.timestamp), darkAccrued);
    }

    function _rateLimit() internal {
        if (block.timestamp < uint256(lastTransitionAt) + minTransitionSecs) revert TransitionTooSoon();
        lastTransitionAt = uint64(block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Foreign value — returned to the owner, never booked
    // ---------------------------------------------------------------------

    /// @notice Pays the board's owner any balance that is not the settlement token.
    ///
    /// `address(0)` is native. On every board the platform issues the settlement token is a
    /// 6-decimal ERC-20 and a marketplace royalty arrives as NATIVE value — the common case, not
    /// the residue — so this is the path that money takes. It is paid outright rather than booked,
    /// because there is no honest way to book value the escrow is not denominated in.
    function sweepForeign(address token) external nonReentrant bound {
        if (token == settlementToken) revert NotForeign();
        address to = site.owner();
        if (to == address(0)) revert ZeroBeneficiary();
        uint256 amount = token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
        if (amount == 0) revert NothingToSweep();
        if (token == address(0)) {
            (bool ok,) = to.call{ value: amount }("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
        emit ForeignSwept(token, to, amount);
    }

    // ---------------------------------------------------------------------
    // The reserve — the protocol forgoing its cut, as money rather than as a sentence
    // ---------------------------------------------------------------------

    /// @notice Adds settlement-token value that only a claim may spend.
    ///
    /// Anyone may fund it. It is what makes a claim able to pay `lastPrice` in full: the pool holds
    /// the publisher's 95%, and the 5% the protocol took at sale time is never in the vault unless
    /// somebody puts it there. Accounted separately so `book()` never mistakes it for revenue.
    function fundReserve(uint256 amount) external payable nonReentrant bound {
        address token = settlementToken;
        if (token == address(0)) {
            amount = msg.value;
        } else {
            if (msg.value != 0) revert NativeNotAccepted();
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        }
        if (amount == 0) revert NothingToSweep();
        reserve += amount;
        emit ReserveFunded(msg.sender, amount);
    }

    /// @notice The factory's owner takes back reserve it funded — only while the board is live, so
    /// it cannot be pulled from under a claim that is already open.
    function withdrawReserve(uint256 amount, address to) external nonReentrant bound {
        if (msg.sender != _reserveOwner()) revert NotReserveOwner();
        if (darkSince != 0) revert ReserveLocked();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0 || amount > reserve) revert NothingToWithdraw();
        reserve -= amount;
        _pay(to, amount);
        emit ReserveWithdrawn(to, amount);
    }

    function _reserveOwner() internal view returns (address) {
        (bool ok, bytes memory data) = factory.staticcall(abi.encodeWithSignature("owner()"));
        if (!ok || data.length < 32) return address(0);
        return abi.decode(data, (address));
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function isDark() external view returns (bool) {
        return darkSince != 0;
    }

    function depositCount() external view returns (uint256) {
        return _deposits.length;
    }

    function depositAt(uint256 id) external view returns (Deposit memory) {
        return _deposits[id];
    }

    function mature(uint256 id) external view returns (bool) {
        return _mature(_deposits[id]);
    }

    /// @notice Inbound this vault holds that is neither booked, credited nor reserve.
    function unbooked() public view returns (uint256) {
        return _balance() - bookedTotal - pendingTotal - reserve;
    }

    /// @notice The sum of deposits the publisher has NOT yet earned — what a claim may drain.
    function immaturePool() public view returns (uint256 total) {
        uint256 n = _deposits.length;
        for (uint256 i = _head; i < n; i++) {
            Deposit storage d = _deposits[i];
            if (d.amount != 0 && !_mature(d)) total += d.amount;
        }
    }

    /// @notice What `claim(key)` would credit right now, or zero when it would revert for any
    /// reason. A UI's one read; the reasons are the contract's errors.
    function claimable(bytes32 key) external view returns (uint256) {
        uint64 since = darkSince;
        if (since == 0 || block.timestamp < uint256(since) + claimDelaySecs) return 0;
        SlotSite.Slot memory slot = site.slotOf(key);
        if (slot.lastPurchaseTs >= since || claimedEpoch[key] == since) return 0;
        if (site.ownerOfOrZero(key) == address(0)) return 0;
        uint256 available = immaturePool() + reserve;
        // Booked on entry to `claim`, so what still sits in `treasuryBalance` or unbooked here
        // counts — it will be a deposit, immature by construction, before the drain runs.
        available += site.treasuryBalance() + site.pendingWithdrawals(address(this)) + unbooked();
        return available > slot.lastPrice ? slot.lastPrice : available;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @dev §5's predicate, one rule for both sides. Mature means releasable and never claimable;
    /// not mature means claimable while dark and never releasable.
    ///
    /// Evaluated AS OF `darkSince` while dark, so a deposit that had matured before the lights went
    /// out is the publisher's whatever a slow keeper did — and one that had not can never reach
    /// maturity while they stay out. A deposit booked INSIDE the running episode carries a snapshot
    /// above `darkAccrued` (the episode is not yet in the accrual) and is by definition not mature
    /// until that episode closes.
    function _mature(Deposit storage d) internal view returns (bool) {
        uint64 accrued = darkAccrued;
        uint64 atBooking = d.darkAtBooking;
        if (atBooking > accrued) return false;
        uint256 asOf = darkSince == 0 ? block.timestamp : darkSince;
        return asOf >= uint256(d.bookedAt) + windowSecs + (accrued - atBooking);
    }

    /// @dev `darkAccrued` plus the running episode, which is what a deposit booked now must carry.
    function _darkNow() internal view returns (uint64) {
        uint64 since = darkSince;
        return since == 0 ? darkAccrued : darkAccrued + (uint64(block.timestamp) - since);
    }

    function _advanceHead() internal {
        uint256 n = _deposits.length;
        uint256 h = _head;
        while (h < n && _deposits[h].amount == 0) h++;
        _head = h;
    }

    function _credit(address account, uint256 amount) internal {
        pending[account] += amount;
        pendingTotal += amount;
    }

    function _balance() internal view returns (uint256) {
        address token = settlementToken;
        return token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    function _pay(address to, uint256 amount) internal {
        address token = settlementToken;
        if (token == address(0)) {
            (bool ok,) = to.call{ value: amount }("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
