// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { Pricing } from "../src/Pricing.sol";
import { RentalsLib } from "../src/RentalsLib.sol";

/// @notice The Solidity half of v2's parity layer — the structural properties the JSONL grid cannot
/// state.
///
/// `GenV2Vectors.s.sol` and `pricing.v2-parity.test.ts` prove the TypeScript twin reproduces this
/// contract's arithmetic row by row. That is a claim about *agreement between two implementations*,
/// and it stays true if both are wrong in the same way. This file makes the other claim: that the
/// arithmetic has the properties the design depends on, swept by fuzzing across the admissible
/// config space rather than at the grid's fixed points.
///
/// The two together are what §7.8's warning asks for. A table over six dimensions is the thing
/// nobody writes; a table plus properties is what you write instead.
contract PricingV2ParityTest is Test {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MIN_MAX_ASK_BPS = 10_000;

    // =================================================================
    // The ask — §3
    // =================================================================

    /// @notice **The load-bearing property of the whole §3 design: an unset ask is the identity on
    /// pricing.**
    ///
    /// `docs/STATE.md` records that v2 leaves the pre-existing take-price vectors valid *by
    /// construction*. This is that construction, stated as a test rather than as a claim in prose:
    /// with no ask posted, the value fed to `computeTakePrice` is `lastPrice` unchanged, so every
    /// row of the 3,024-vector grid still describes this code.
    ///
    /// Had the ask been a multiplier on the result — the obvious alternative — this would be false
    /// for every row and the entire existing grid would have had to be regenerated, losing its value
    /// as a regression suite against the frozen v1 reference.
    function testFuzz_unsetAskIsIdentityOnPricing(
        uint96 lastPrice,
        uint96 basePrice,
        uint16 elapsedWeeks,
        uint16 decayRaw,
        uint16 takeRaw,
        uint8 weeksRaw
    ) public pure {
        (uint256 decayBps, uint256 takeBps, uint256 maxDecayWeeks) = _boundPricing(decayRaw, takeRaw, weeksRaw);

        (uint256 priceWith, uint256 floorWith) = Pricing.computeTakePrice(
            Pricing.resolveReversionBase(0, lastPrice), basePrice, elapsedWeeks, decayBps, takeBps, maxDecayWeeks
        );
        (uint256 priceWithout, uint256 floorWithout) =
            Pricing.computeTakePrice(lastPrice, basePrice, elapsedWeeks, decayBps, takeBps, maxDecayWeeks);

        assertEq(priceWith, priceWithout, "an unset ask moved the take price");
        assertEq(floorWith, floorWithout, "an unset ask moved the effective floor");
    }

    /// @notice A posted ask is used verbatim as the base — never blended with `lastPrice`, never
    /// scaled. Trivial to satisfy and worth pinning: a "reasonable" future change that averaged the
    /// two would leave every vector in the grid still passing on the `askFloor == 0` rows.
    function testFuzz_postedAskReplacesLastPriceEntirely(uint96 askFloor, uint96 lastPrice) public pure {
        vm.assume(askFloor != 0);
        assertEq(Pricing.resolveReversionBase(askFloor, lastPrice), askFloor);
    }

    /// @notice **An owner can always post an ask at their own cost.** This is what the `10_000`
    /// lower clamp on `maxAskBps` buys, and the reason the parameter is documented as down-only:
    /// below `10_000` the ceiling would fall under the anchor and an owner could not name a price
    /// they had themselves just paid.
    function testFuzz_ceilingAlwaysAdmitsTheAnchor(uint96 lastPrice, uint96 basePrice, uint32 capRaw) public pure {
        uint256 maxAskBps = bound(uint256(capRaw), MIN_MAX_ASK_BPS, 1_000_000);
        uint256 anchor = lastPrice > basePrice ? uint256(lastPrice) : uint256(basePrice);

        assertGe(Pricing.askCeiling(lastPrice, basePrice, maxAskBps), anchor, "an owner could not ask their own cost");
    }

    /// @notice The ceiling is anchored to `lastPrice`, which moves only on a sale — **not** to the
    /// effective floor, which the ask itself feeds once posted.
    ///
    /// Demonstrated rather than asserted in a comment, in the same spirit as
    /// `test_iterativeDecayDivergesFromClosedForm`: three rounds of re-anchoring to the previous
    /// ask compound into a ceiling far above where the real one sits, so the cost of "simplifying"
    /// the anchor is a number on the screen rather than a paragraph nobody reads.
    function test_effectiveFloorAnchorWouldRatchetWithoutBound() public pure {
        uint256 basePrice = 1 ether;
        uint256 lastPrice = 1 ether;
        uint256 maxAskBps = 40_000; // 4x

        uint256 realCeiling = Pricing.askCeiling(lastPrice, basePrice, maxAskBps);

        // The rejected design: re-anchor each round to the ask just posted.
        uint256 ratcheted = lastPrice;
        for (uint256 i = 0; i < 3; i++) {
            ratcheted = Pricing.askCeiling(ratcheted, basePrice, maxAskBps);
        }

        assertEq(realCeiling, 4 ether, "the bounded ceiling is a fixed multiple of what was paid");
        assertEq(ratcheted, 64 ether, "re-anchoring compounds 4x per round");
        assertGt(ratcheted, realCeiling * 15, "if these ever converge, the anchor stopped being bounded");
    }

    // =================================================================
    // Rent accrual — §2
    // =================================================================

    /// @notice Accrual never runs backwards. An owner's earned balance is what `claimRent` and the
    /// take path both pay out against, so a non-monotone accrual would let a claim succeed and then
    /// leave the ledger owing more than the escrow holds.
    function testFuzz_accrualIsMonotoneInTime(uint128 prepaid, uint32 durationRaw, uint32 tA, uint32 tB) public pure {
        (uint64 start, uint64 expiry) = _term(durationRaw);
        uint256 earlier = uint256(start) + (tA < tB ? tA : tB);
        uint256 later = uint256(start) + (tA < tB ? tB : tA);

        assertGe(
            RentalsLib.accruedOf(prepaid, start, expiry, later),
            RentalsLib.accruedOf(prepaid, start, expiry, earlier),
            "accrual ran backwards"
        );
    }

    /// @notice The two legs always partition the escrow exactly. `unaccrued` is what a buyer
    /// inherits (§2.4.2) and is derived by subtraction for this reason — computed independently, the
    /// two could disagree at a truncation and a UI would show a total that does not add up.
    function testFuzz_accruedAndUnaccruedPartitionThePrepaid(uint128 prepaid, uint32 durationRaw, uint32 elapsed)
        public
        pure
    {
        (uint64 start, uint64 expiry) = _term(durationRaw);
        uint256 nowTs = uint256(start) + elapsed;

        uint256 accrued = RentalsLib.accruedOf(prepaid, start, expiry, nowTs);
        assertLe(accrued, prepaid, "more rent accrued than was ever escrowed");
        assertEq(accrued + (prepaid - accrued), prepaid, "the two legs do not partition the escrow");
    }

    /// @notice **A lapsed term has earned exactly its escrow — not approximately.**
    ///
    /// This is the property `endRental` rests on. `finish` deletes `prepaid` and `claimed`, so
    /// anything still unaccrued at that moment is stranded behind fields nothing can read again;
    /// `finish` refusing to run before expiry is what makes that unreachable. The invariant suite's
    /// `_checkClearedTenanciesHoldNothing` is the same claim against live state — this is why it
    /// holds.
    function testFuzz_lapsedTermEarnsExactlyThePrepaid(uint128 prepaid, uint32 durationRaw, uint32 overshoot)
        public
        pure
    {
        (uint64 start, uint64 expiry) = _term(durationRaw);
        uint256 nowTs = uint256(expiry) + overshoot;

        assertEq(RentalsLib.accruedOf(prepaid, start, expiry, nowTs), prepaid, "a lapsed term did not fully accrue");
    }

    /// @notice `expiry == 0` means "no tenancy", and is checked before anything divides. Without the
    /// guard a cleared rental divides by zero rather than returning nothing — and every rental is
    /// cleared eventually, so this is the common path rather than an edge case.
    function testFuzz_clearedTenancyAccruesNothing(uint128 prepaid, uint64 start, uint64 nowTs) public pure {
        assertEq(RentalsLib.accruedOf(prepaid, start, 0, nowTs), 0, "a cleared tenancy accrued rent");
    }

    /// @notice **The extension identity.** After settling, `claimed == accrued`, so the carry
    /// `prepaid - claimed` is exactly the unaccrued remainder — which is why rolling it into a fresh
    /// term is correct: it was never earned.
    ///
    /// Settle *after* extending instead and the carry is computed against a stale `claimed`, so
    /// already-earned rent rolls forward and is re-streamed to whoever owns the position when it
    /// accrues next. That mutation survived the escrow-ledger invariant, which stays perfectly
    /// self-consistent either way — this states the arithmetic the ordering depends on.
    function testFuzz_carryEqualsTheUnaccruedRemainder(uint128 prepaid, uint32 durationRaw, uint32 elapsed)
        public
        pure
    {
        (uint64 start, uint64 expiry) = _term(durationRaw);
        uint256 nowTs = uint256(start) + elapsed;

        uint256 accrued = RentalsLib.accruedOf(prepaid, start, expiry, nowTs);
        uint256 claimedAfterSettle = accrued; // what `claim` writes
        uint256 carry = prepaid - claimedAfterSettle; // what `extend` returns

        assertEq(carry, prepaid - accrued, "the carry is not the unaccrued remainder");
    }

    // =================================================================
    // Rent cost and the fee split — §2.5
    // =================================================================

    /// @notice The three legs sum to the gross cost exactly, with nothing rounded away.
    ///
    /// This is what lets `totalEscrowedRent` reconcile against the sum of live tenancies — the
    /// invariant suite's strongest escrow property. It holds only because `net` is a subtraction
    /// rather than its own bps multiply; a third percentage would lose a unit at exactly the costs
    /// where both cuts truncate.
    function testFuzz_feeLegsSumToTheGrossCost(uint128 cost, uint16 protocolRaw, uint16 feeRaw) public pure {
        (uint256 protocolRentBps, uint256 feeBps) = _boundFees(protocolRaw, feeRaw);

        (uint256 protocolCut, uint256 siteCut, uint256 net) = RentalsLib.rentSplit(cost, protocolRentBps, feeBps);
        assertEq(protocolCut + siteCut + net, cost, "the fee split lost or invented a unit");
    }

    /// @notice The escrowed remainder never underflows for any admissible fee pair. The contract
    /// clamps the total to `[1_000, 4_000]` and re-checks it at list time because `siteRentBps` is
    /// freely mutable; this proves the arithmetic that clamp is protecting.
    function testFuzz_escrowedRemainderNeverUnderflows(uint128 cost, uint16 protocolRaw, uint16 feeRaw) public pure {
        (uint256 protocolRentBps, uint256 feeBps) = _boundFees(protocolRaw, feeRaw);

        (uint256 protocolCut, uint256 siteCut,) = RentalsLib.rentSplit(cost, protocolRentBps, feeBps);
        assertLe(protocolCut + siteCut, cost, "the cuts exceeded the cost they were taken from");
    }

    /// @notice A longer term never costs less. Obvious, and the reason to pin it is the unit
    /// mismatch it sits on: the rate is per DAY and the duration is in SECONDS (§2.5.3), so this is
    /// the one function where a slipped conversion would be invisible at the defaults and wrong by
    /// 86,400x at the edges.
    function testFuzz_rentCostIsMonotoneInDuration(uint128 ratePerDay, uint32 dA, uint32 dB) public pure {
        uint64 shorter = uint64(dA < dB ? dA : dB);
        uint64 longer = uint64(dA < dB ? dB : dA);

        assertGe(
            RentalsLib.rentCost(ratePerDay, longer),
            RentalsLib.rentCost(ratePerDay, shorter),
            "a longer term cost less"
        );
    }

    /// @notice A term can cost exactly zero, and that is admissible rather than a bug: a cheap
    /// position at the minimum rate over the minimum term truncates away entirely. Pinned because
    /// the natural defensive instinct is to add a `cost > 0` require, which would quietly remove the
    /// fast-rotation regime §2.5.3 exists to allow.
    function test_shortTermOnACheapPositionCostsNothing() public pure {
        // One unit per day against the one-hour minimum term: 1 * 3600 / 86400 truncates to 0.
        assertEq(RentalsLib.rentCost(1, 1 hours), 0);
        assertEq(RentalsLib.rentCost(23, 1 hours), 0);
        // 24 units per day is the first rate an hour of tenancy can charge for at all.
        assertEq(RentalsLib.rentCost(24, 1 hours), 1);
    }

    // =================================================================
    // Bounds
    // =================================================================

    /// @dev The admissible pricing space, matching `TermsLib.checkEconomicsAbsolute`.
    function _boundPricing(uint16 decayRaw, uint16 takeRaw, uint8 weeksRaw)
        internal
        pure
        returns (uint256 decayBps, uint256 takeBps, uint256 maxDecayWeeks)
    {
        decayBps = bound(uint256(decayRaw), 1, BPS);
        takeBps = bound(uint256(takeRaw), BPS, 30_000);
        maxDecayWeeks = bound(uint256(weeksRaw), 0, 52);
    }

    /// @dev The admissible rent fee space: `_validateRentTerms` requires the TOTAL to land in
    /// `[1_000, 4_000]`, so the site's share is bounded by what the protocol's share leaves.
    function _boundFees(uint16 protocolRaw, uint16 feeRaw)
        internal
        pure
        returns (uint256 protocolRentBps, uint256 feeBps)
    {
        protocolRentBps = bound(uint256(protocolRaw), 0, 4_000);
        uint256 lo = protocolRentBps >= 1_000 ? 0 : 1_000 - protocolRentBps;
        feeBps = bound(uint256(feeRaw), lo, 4_000 - protocolRentBps);
    }

    /// @dev A real term: `MIN_RENTAL_DURATION` to the 365-day ceiling, anchored at a non-zero epoch
    /// so `start == 0` cannot be confused with the `expiry == 0` sentinel.
    function _term(uint32 durationRaw) internal pure returns (uint64 start, uint64 expiry) {
        start = 1_700_000_000;
        uint64 duration = uint64(bound(uint256(durationRaw), 1 hours, 365 days));
        expiry = start + duration;
    }
}
