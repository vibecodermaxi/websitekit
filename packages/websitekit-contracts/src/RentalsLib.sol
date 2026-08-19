// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Tenancy state machine for `SlotSite`, deployed as an EXTERNAL library and linked into
/// the implementation. Implements `docs/PROTOCOL-SPEC.md` §2.
///
/// **Why this is a separate library rather than inline.** v2 in one contract measures 24,341 bytes
/// against EIP-170's 24,576 — a 235-byte margin, which is not a fit, and `via_ir` is unavailable as
/// an escape hatch (see `foundry.toml`). Splitting was verified safe on testnet before being
/// adopted: a library-linked implementation still verifies `is_fully_verified`, and clones of it
/// still auto-detect as EIP-1167 and resolve to it, which is the property that gives every site a
/// readable contract page (§11.4).
///
/// **This library never touches money. That is the load-bearing rule of the split.**
/// It validates, mutates tenancy state, and RETURNS the amounts the caller must book. Every
/// credit, debit, escrow adjustment and transfer stays in `SlotSite`, which remains the sole
/// custodian. A delegatecalled library that could move funds would widen the audit surface for no
/// benefit; one that only computes cannot.
///
/// **Granularity is load-bearing.** Every `public` function here is a delegatecall from the site,
/// and each call site costs ~200 bytes of ABI-encode/decode stub. A first cut with twelve call sites
/// moved 2,977 B of logic out and only saved 473 B net. So only the LARGE validators are `public`;
/// small helpers are `internal` and inline, and the site writes its own storage rather than paying a
/// delegatecall to have the library write it.
///
/// **Storage.** Functions take `storage` pointers into the site's own mappings, so state lives in
/// the site and the library is pure code. `msg.sender` inside a delegatecall is the original caller,
/// so tenant attribution is correct, and emitted events are attributed to the SITE's address, so an
/// indexer watching the site sees them — both verified in `test/architecture/LibraryStorage.t.sol`.
///
/// **ABI note:** because the events are declared here, an indexer needs this library's ABI merged
/// with the site's to decode them. `sync:abi` must emit both.
library RentalsLib {
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant SECONDS_PER_DAY = 86_400;

    /// @notice §2.5.3. Duration is seconds so the fast-rotation regime is expressible at all; the
    /// RATE stays per-day because a per-second rate truncates to zero on a 6-decimal token for any
    /// cheap position ($0.001/day / 86400 -> 0 units).
    uint64 internal constant MIN_RENTAL_DURATION = 1 hours;

    struct Listing {
        uint192 ratePerDay;
        uint64 maxDurationSecs;
        /// @notice §2.5.1. The site's rent cut, SNAPSHOTTED here at `list` time. This is what lets
        /// `siteRentBps` be freely mutable without letting a publisher set 0% to attract listings
        /// and raise it before anyone rents.
        uint16 feeBps;
    }

    struct Rental {
        address tenant;
        uint64 start;
        uint64 expiry;
        /// @notice Net of the fee split — what actually streams to the owner.
        uint256 prepaid;
        uint256 claimed;
        /// @notice Restored by `finish`, so an expired tenant's content does not sit on the page
        /// indefinitely and the "content only renders against a matching on-chain hash" invariant
        /// stays literally true.
        bytes32 ownerHashSnapshot;
    }

    error NotForRent();
    error RentalActive();
    error RentalExpired();
    error NotSlotTenant();
    error TermTooLong();
    error RateChanged();
    error RateBelowFloor();

    event RentalListed(bytes32 indexed key, address indexed owner, uint256 ratePerDay, uint64 maxDurationSecs);
    event SlotRented(bytes32 indexed key, address indexed tenant, uint64 expiry, uint256 cost);
    event RentalExtended(bytes32 indexed key, address indexed tenant, uint64 expiry, uint256 cost);
    event RentalEnded(bytes32 indexed key, bytes32 restoredHash);
    /// @notice ERC-4907. Emitted here because this is where tenancy changes; attributed to the site.
    event UpdateUser(uint256 indexed tokenId, address indexed user, uint64 expires);

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Rent earned by the owner so far, claimed or not. Linear in seconds, no segment
    /// history — which is what makes `extend`'s settle-then-restart a single formula.
    function accrued(Rental storage r) internal view returns (uint256) {
        return accruedOf(r.prepaid, r.start, r.expiry, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Pure primitives
    //
    // The three functions below are the whole of v2's rent arithmetic, lifted out of the storage
    // readers and the site's booking path so the parity harness has a callable target and there is
    // exactly ONE implementation of each. Same argument that put `computeSplit` in `Pricing`:
    // inline, they were reachable only by executing a real tenancy against a deployed clone, which
    // means the admissible config space could not be swept over them at all.
    //
    // `internal`, so they inline into their callers and cost the deployed library nothing.
    // ---------------------------------------------------------------------

    /// @notice Linear accrual over the term, as a pure function of the tenancy's four numbers.
    ///
    /// `expiry == 0` is "no tenancy" rather than "a term that ended at the epoch", and it has to be
    /// checked first: without it a cleared rental would divide by zero rather than return nothing.
    ///
    /// The clamp `end = min(nowTs, expiry)` is what makes the term stop earning at expiry, and it is
    /// also what makes `accruedOf == prepaid` exactly once the term has lapsed — the property
    /// `finish` relies on to drain escrow to zero, since it refuses to run any earlier.
    function accruedOf(uint256 prepaid, uint64 start, uint64 expiry, uint256 nowTs) internal pure returns (uint256) {
        if (expiry == 0) return 0;
        uint256 end = nowTs < expiry ? nowTs : expiry;
        if (end <= start) return 0;
        return (prepaid * (end - start)) / (expiry - start);
    }

    /// @notice Gross rent for a term. §2.5.3: the RATE is per-day and the DURATION is seconds, so
    /// this is the one place those two units meet — and the place where a short term on a cheap
    /// position truncates to a cost of literally zero. That is admissible, not a bug, and the dust
    /// invariant campaign exists partly to keep it exercised.
    function rentCost(uint256 ratePerDay, uint64 durationSecs) internal pure returns (uint256) {
        return (ratePerDay * durationSecs) / SECONDS_PER_DAY;
    }

    /// @notice §2.5. The protocol's cut and the site's snapshotted cut come off the top; whatever
    /// remains is escrowed and streams to whoever owns the position as it accrues.
    ///
    /// **Both cuts are keyed to the GROSS cost, so the two truncations are independent** — `net` is
    /// what is left after both, never a third percentage of anything. Deriving `net` as a subtraction
    /// rather than as its own bps multiply is what makes the three legs sum to `cost` exactly, which
    /// is in turn what lets the escrow ledger reconcile against the sum of live tenancies.
    ///
    /// The caller guarantees `protocolRentBps + feeBps <= 10_000` (the band is `[1_000, 4_000]` and
    /// is re-checked at list time); this does not re-validate, so a caller reaching it directly with
    /// a larger total gets a revert on the subtraction rather than a silent wrap.
    function rentSplit(uint256 cost, uint256 protocolRentBps, uint256 feeBps)
        internal
        pure
        returns (uint256 protocolCut, uint256 siteCut, uint256 net)
    {
        protocolCut = (cost * protocolRentBps) / BPS_DENOMINATOR;
        siteCut = (cost * feeBps) / BPS_DENOMINATOR;
        net = cost - protocolCut - siteCut;
    }

    /// @notice What a buyer would inherit: the part of the escrow not yet earned.
    /// §2.4.2 — the buy path must show this, or an encumbered position reads as unbuyable when it is
    /// actually being sold at a discount to the income stream it carries.
    function unaccrued(Rental storage r) internal view returns (uint256) {
        return r.prepaid - accrued(r);
    }

    /// @notice The live tenant, or `address(0)`. An expired-but-uncleared term reads as absent here
    /// rather than as a live tenancy a UI would render.
    function currentTenant(Rental storage r) internal view returns (address) {
        return block.timestamp < r.expiry ? r.tenant : address(0);
    }

    // ---------------------------------------------------------------------
    // State transitions — each returns what the SITE must book
    // ---------------------------------------------------------------------

    /// @notice Marks accrued rent as claimed and returns the delta. **Moves nothing.** The caller
    /// credits `pendingWithdrawals[owner]` and decrements `totalEscrowedRent` by exactly this.
    function claim(Rental storage r) internal returns (uint256 delta) {
        uint256 a = accrued(r);
        delta = a - r.claimed;
        if (delta > 0) r.claimed = a;
    }

    /// @notice Owner-only at the call site. `ratePerDay == 0` delists.
    ///
    /// The rate floor is validated HERE ONLY and never re-checked in `open`: between listing and
    /// renting the floor can only fall, since reversion only reduces it and the one event that
    /// raises it — a purchase — clears the listing anyway. Paying for a second reversion loop on the
    /// hot path buys nothing.
    ///
    /// Anchored to the EFFECTIVE floor, not `basePrice`: a `basePrice` anchor keeps constant
    /// *absolute* headroom, which becomes negligible on exactly the expensive positions where
    /// poisoning is worth doing.
    function list(
        Listing storage l,
        bytes32 key,
        uint256 ratePerDay,
        uint64 maxDurationSecs,
        uint64 maxRentalTerm,
        uint256 effectiveFloor,
        uint256 minRentBps,
        uint256 feeBps
    ) public {
        if (ratePerDay == 0) {
            delete l.ratePerDay;
            delete l.maxDurationSecs;
            delete l.feeBps;
            emit RentalListed(key, msg.sender, 0, 0);
            return;
        }
        if (maxDurationSecs < MIN_RENTAL_DURATION || maxDurationSecs > maxRentalTerm) revert TermTooLong();
        if (ratePerDay < (effectiveFloor * minRentBps) / BPS_DENOMINATOR) revert RateBelowFloor();

        l.ratePerDay = uint192(ratePerDay);
        l.maxDurationSecs = maxDurationSecs;
        l.feeBps = uint16(feeBps);
        emit RentalListed(key, msg.sender, ratePerDay, maxDurationSecs);
    }

    /// @notice Opens a term. Requires any previous rental to have been ENDED, not merely expired —
    /// `finish` is permissionless, so a prospective tenant can clear a lapsed term themselves.
    /// Forcing it keeps the owner's content restoration honest and stops a new term inheriting stale
    /// escrow.
    ///
    /// @return cost Gross rent for the term. The caller collects it, splits it, and passes the net
    /// back through `fund`.
    function open(
        Rental storage r,
        Listing storage l,
        bytes32 key,
        uint64 durationSecs,
        uint256 expectedRatePerDay,
        bytes32 contentHash
    ) public returns (uint256 cost, uint16 feeBps) {
        if (r.expiry != 0) revert RentalActive();

        uint256 rate = l.ratePerDay;
        if (rate == 0) revert NotForRent();
        // Without this an owner front-runs a rental by raising the rate, exactly as `maxPrice`
        // guards `buy`.
        if (rate != expectedRatePerDay) revert RateChanged();
        if (durationSecs < MIN_RENTAL_DURATION || durationSecs > l.maxDurationSecs) revert TermTooLong();

        cost = rentCost(rate, durationSecs);
        feeBps = l.feeBps;

        uint64 expiry = uint64(block.timestamp) + durationSecs;
        r.tenant = msg.sender;
        r.start = uint64(block.timestamp);
        r.expiry = expiry;
        r.claimed = 0;
        r.ownerHashSnapshot = contentHash;

        emit SlotRented(key, msg.sender, expiry, cost);
        emit UpdateUser(uint256(key), msg.sender, expiry);
    }

    /// @notice Current tenant, live term only. Three rules make this safe:
    ///
    ///  1. **The cap applies to the REMAINING window, not the total.** Cap the total instead and a
    ///     tenant extends repeatedly in one block and holds a year. Expressed this way the safety
    ///     property holds exactly: no buyer ever inherits more than `maxRentalTerm` of encumbrance,
    ///     however many extensions preceded it.
    ///  2. **Settle-then-restart.** The caller flushes what is earned first; then the unaccrued
    ///     remainder rolls forward into a fresh linear term. Rolling it forward is correct — it was
    ///     never earned. One formula, no segment history.
    ///  3. **The rate is the CURRENT listing's**, not the one originally paid, or an incumbent locks
    ///     in a cheap rate forever. This is also the owner's escape valve: delist and extension
    ///     becomes impossible, so the arrangement ends cleanly at the term boundary.
    ///
    /// @return cost Gross rent for the new term.
    /// @return feeBps The site cut snapshotted on the listing.
    /// @return carry The unaccrued remainder to roll into the new term. Caller adds the new net.
    function extend(
        Rental storage r,
        Listing storage l,
        bytes32 key,
        uint64 durationSecs,
        uint256 expectedRatePerDay,
        uint64 maxRentalTerm
    ) public returns (uint256 cost, uint16 feeBps, uint256 carry) {
        if (r.expiry == 0 || block.timestamp >= r.expiry) revert RentalExpired();
        if (msg.sender != r.tenant) revert NotSlotTenant();

        uint256 rate = l.ratePerDay;
        if (rate == 0) revert NotForRent();
        if (rate != expectedRatePerDay) revert RateChanged();
        if (durationSecs < MIN_RENTAL_DURATION || durationSecs > maxRentalTerm) revert TermTooLong();

        cost = rentCost(rate, durationSecs);
        feeBps = l.feeBps;
        carry = r.prepaid - r.claimed;

        uint64 expiry = uint64(block.timestamp) + durationSecs;
        r.start = uint64(block.timestamp);
        r.expiry = expiry;
        r.claimed = 0;

        emit RentalExtended(key, msg.sender, expiry, cost);
        emit UpdateUser(uint256(key), msg.sender, expiry);
    }

    /// @notice Permissionless once the term has lapsed. Clears the tenancy and returns the owner's
    /// snapshotted content hash for the site to restore.
    ///
    /// Without this an expired tenant's content sits on the page until the owner happens to notice —
    /// the owner donates time they were not paid for — and worse, `open` reverts `RentalActive` on a
    /// lapsed-but-uncleared term, so the position leaves the rental market entirely, for everyone,
    /// indefinitely. That makes the keeper load-bearing for the MECHANISM, not just for hygiene.
    function finish(Rental storage r, bytes32 key) public returns (bytes32 restored) {
        if (r.expiry == 0) revert NotForRent();
        if (block.timestamp < r.expiry) revert RentalActive();

        restored = r.ownerHashSnapshot;
        delete r.tenant;
        delete r.start;
        delete r.expiry;
        delete r.prepaid;
        delete r.claimed;
        delete r.ownerHashSnapshot;

        emit RentalEnded(key, restored);
        emit UpdateUser(uint256(key), address(0), 0);
    }
}
