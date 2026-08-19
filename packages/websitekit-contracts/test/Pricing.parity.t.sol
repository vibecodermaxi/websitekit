// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { Pricing } from "../src/Pricing.sol";
import { Pricing as TinawPricing } from "./reference/PricingFrozen.sol";

/// @notice §7.8. The port widened the config space from one fixed set of parameters to six free
/// dimensions, and the failure mode named in the spec is precise: **the existing fixed-config
/// vectors keep passing while the config space goes unswept**. This file is the first half of the
/// answer — the second is the TypeScript twin, which does not exist yet.
///
/// Two distinct claims are tested here, and conflating them is how a parity harness gets
/// comfortable without being right:
///
///   1. **The port did not drift.** At `maxDecayWeeks == 52`, websitekit's `Pricing` must be
///      indistinguishable from v1's frozen, mainnet-deployed `Pricing`. That is what makes every
///      existing Rust/TS/Solidity vector in the sibling package a valid regression suite for this
///      one, rather than a suite for a contract that no longer exists.
///   2. **The widened space is sane.** Structural properties that must hold for ANY admissible
///      config, swept by fuzzing rather than by a table — because a table over six dimensions is
///      the thing §7.8 says nobody writes.
contract PricingParityTest is Test {
    uint256 internal constant BPS = 10_000;

    // -----------------------------------------------------------------
    // 1. The port did not drift
    // -----------------------------------------------------------------

    /// @notice The load-bearing test in this file. `maxDecayWeeks` became a parameter; nothing else
    /// was allowed to change. If this fails, the sibling repo's fuzz vectors are no longer evidence
    /// about this code.
    function testFuzz_identicalToTinawAtFiftyTwoWeeks(
        uint96 lastPrice,
        uint96 basePrice,
        uint16 elapsedWeeks,
        uint16 decayBpsRaw,
        uint16 takeBpsRaw
    ) public pure {
        uint256 decayBps = bound(uint256(decayBpsRaw), 1, BPS);
        uint256 takeBps = bound(uint256(takeBpsRaw), BPS, 30_000);

        (uint256 price, uint256 floor) =
            Pricing.computeTakePrice(lastPrice, basePrice, elapsedWeeks, decayBps, takeBps, 52);
        (uint256 refPrice, uint256 refFloor) =
            TinawPricing.computeTakePrice(lastPrice, basePrice, elapsedWeeks, decayBps, takeBps);

        assertEq(price, refPrice, "take price drifted from the v1 reference");
        assertEq(floor, refFloor, "effective floor drifted from the v1 reference");
    }

    /// @notice The known-value anchors from the sibling suite, restated so a reader can see the
    /// numbers without chasing them. 0.001 ether base, 1.4x take, 0.9/week decay.
    function test_knownVectors() public pure {
        // Never claimed: `lastPrice == 0` decays to zero and the floor carries.
        (uint256 price, uint256 floor) = Pricing.computeTakePrice(0, 0.001 ether, 0, 9_000, 14_000, 52);
        assertEq(floor, 0.001 ether);
        assertEq(price, 0.0014 ether);

        // Freshly taken, no decay yet.
        (price, floor) = Pricing.computeTakePrice(0.0014 ether, 0.001 ether, 0, 9_000, 14_000, 52);
        assertEq(floor, 0.0014 ether);
        assertEq(price, 0.00196 ether);

        // One week of decay: 0.0014 * 0.9 == 0.00126, still above the 0.001 floor.
        (price, floor) = Pricing.computeTakePrice(0.0014 ether, 0.001 ether, 1, 9_000, 14_000, 52);
        assertEq(floor, 0.00126 ether);
        assertEq(price, 0.001764 ether);

        // Long enough and the floor takes over.
        (price, floor) = Pricing.computeTakePrice(0.0014 ether, 0.001 ether, 52, 9_000, 14_000, 52);
        assertEq(floor, 0.001 ether);
    }

    /// @notice The iterative loop is not `basePrice * 0.9^n` and must never be refactored into it.
    /// Truncating division once per iteration is a real, compounding difference — demonstrated here
    /// rather than asserted in a comment, so the cost of "simplifying" this is visible.
    function test_iterativeDecayDivergesFromClosedForm() public pure {
        uint256 lastPrice = 1_000_000_007; // deliberately not a round number
        (, uint256 iterative) = Pricing.computeTakePrice(lastPrice, 0, 10, 9_000, 10_000, 52);

        uint256 closedForm = lastPrice;
        for (uint256 i = 0; i < 10; i++) {
            closedForm = closedForm * 9;
        }
        for (uint256 i = 0; i < 10; i++) {
            closedForm = closedForm / 10;
        }

        assertTrue(iterative != closedForm, "if these ever agree, the vector stopped proving anything");
        assertLt(iterative, closedForm);
    }

    // -----------------------------------------------------------------
    // 2. The widened space is sane
    // -----------------------------------------------------------------

    /// @dev The admissible config space, matching `SlotSite._validateConfig`'s clamps. Fuzzing
    /// outside them proves nothing — no clone can ever hold those parameters.
    function _boundConfig(uint16 decayRaw, uint16 takeRaw, uint16 payoutRaw, uint8 weeksRaw)
        internal
        pure
        returns (uint256 decayBps, uint256 takeBps, uint256 payoutBps, uint256 maxDecayWeeks)
    {
        decayBps = bound(uint256(decayRaw), 1, BPS);
        payoutBps = bound(uint256(payoutRaw), BPS, 20_000);
        takeBps = bound(uint256(takeRaw), payoutBps + 1, 30_000);
        maxDecayWeeks = bound(uint256(weeksRaw), 0, 52);
    }

    /// @notice The floor never falls below `basePrice`, however long a slot sits. This is what stops
    /// decay from being a slow giveaway, and it is the one property a site owner is relying on when
    /// they choose a floor.
    function testFuzz_floorNeverFallsBelowBasePrice(
        uint96 lastPrice,
        uint96 basePrice,
        uint16 elapsedWeeks,
        uint16 decayRaw,
        uint16 takeRaw,
        uint16 payoutRaw,
        uint8 weeksRaw
    ) public pure {
        (uint256 decayBps, uint256 takeBps,, uint256 maxDecayWeeks) =
            _boundConfig(decayRaw, takeRaw, payoutRaw, weeksRaw);

        (, uint256 floor) =
            Pricing.computeTakePrice(lastPrice, basePrice, elapsedWeeks, decayBps, takeBps, maxDecayWeeks);
        assertGe(floor, basePrice);
    }

    /// @notice The take price is always at least the floor, so displacing an owner is never cheaper
    /// than claiming an empty slot. `takeBps >= 10_000` is what guarantees it, and truncation only
    /// ever rounds down toward — never below — the floor.
    function testFuzz_takePriceIsNeverBelowTheFloor(
        uint96 lastPrice,
        uint96 basePrice,
        uint16 elapsedWeeks,
        uint16 decayRaw,
        uint16 takeRaw,
        uint16 payoutRaw,
        uint8 weeksRaw
    ) public pure {
        (uint256 decayBps, uint256 takeBps,, uint256 maxDecayWeeks) =
            _boundConfig(decayRaw, takeRaw, payoutRaw, weeksRaw);

        (uint256 price, uint256 floor) =
            Pricing.computeTakePrice(lastPrice, basePrice, elapsedWeeks, decayBps, takeBps, maxDecayWeeks);
        assertGe(price, floor);
    }

    /// @notice The FLOOR guarantee must hold for ANY admissible config, not just the defaults.
    /// This is the clamp `payoutBps >= 10_000` doing its job across the whole widened space: the
    /// displaced owner is paid against the effective floor, and never below it.
    ///
    /// Note what this does NOT prove, because an earlier version of this comment claimed it did:
    /// that the payout beats what the owner PAID. It cannot — the effective floor reverts, so a
    /// holder who bought at a peak can be displaced below their entry. The function name is the
    /// accurate statement of the property; "being taken is a profit event" is not.
    function testFuzz_payoutNeverFallsBelowTheFloorItIsKeyedTo(
        uint96 lastPrice,
        uint96 basePrice,
        uint16 elapsedWeeks,
        uint16 decayRaw,
        uint16 takeRaw,
        uint16 payoutRaw,
        uint8 weeksRaw
    ) public pure {
        (uint256 decayBps, uint256 takeBps, uint256 payoutBps, uint256 maxDecayWeeks) =
            _boundConfig(decayRaw, takeRaw, payoutRaw, weeksRaw);

        (, uint256 floor) =
            Pricing.computeTakePrice(lastPrice, basePrice, elapsedWeeks, decayBps, takeBps, maxDecayWeeks);
        assertGe((floor * payoutBps) / BPS, floor);
    }

    /// @notice The site's own cut can never be negative. `takeBps > payoutBps + protocolBps` is
    /// enforced at `initialize()`; this proves the arithmetic that clamp is protecting, including
    /// the double-truncation that makes `>=` insufficient reasoning on its own.
    function testFuzz_siteCutIsNeverNegative(
        uint96 lastPrice,
        uint96 basePrice,
        uint16 elapsedWeeks,
        uint16 decayRaw,
        uint16 takeRaw,
        uint16 payoutRaw,
        uint8 weeksRaw,
        uint16 protocolRaw
    ) public pure {
        (uint256 decayBps, uint256 takeBps, uint256 payoutBps, uint256 maxDecayWeeks) =
            _boundConfig(decayRaw, takeRaw, payoutRaw, weeksRaw);
        uint256 protocolBps = bound(uint256(protocolRaw), 0, takeBps - payoutBps - 1);

        (uint256 price, uint256 floor) =
            Pricing.computeTakePrice(lastPrice, basePrice, elapsedWeeks, decayBps, takeBps, maxDecayWeeks);

        uint256 payout = (floor * payoutBps) / BPS;
        uint256 protocolCut = (floor * protocolBps) / BPS;
        assertGe(price, payout + protocolCut, "take would underflow the site's own cut");
    }

    /// @notice A shorter horizon can only ever leave the price HIGHER — decay is monotone in the
    /// number of iterations. §7.7 recommends websitekit default to a shorter `maxDecayWeeks` than
    /// v1's 52, and this is the property that makes that a safe knob rather than a guess.
    function testFuzz_shorterHorizonNeverPricesLower(
        uint96 lastPrice,
        uint96 basePrice,
        uint8 shortWeeks,
        uint8 longWeeks,
        uint16 decayRaw
    ) public pure {
        uint256 shortHorizon = bound(uint256(shortWeeks), 0, 52);
        uint256 longHorizon = bound(uint256(longWeeks), shortHorizon, 52);
        uint256 decayBps = bound(uint256(decayRaw), 1, BPS);

        (, uint256 shortFloor) = Pricing.computeTakePrice(lastPrice, basePrice, 52, decayBps, BPS, shortHorizon);
        (, uint256 longFloor) = Pricing.computeTakePrice(lastPrice, basePrice, 52, decayBps, BPS, longHorizon);
        assertGe(shortFloor, longFloor);
    }

    /// @notice `decayBps == 10_000` is admissible and means "no decay at all" — a site that wants a
    /// pure ratchet. Worth pinning: it is the boundary of the clamp and the one config where the
    /// loop runs to its bound and changes nothing.
    function testFuzz_fullDecayBpsIsANoOp(uint96 lastPrice, uint96 basePrice, uint8 weeksRaw) public pure {
        uint256 elapsed = bound(uint256(weeksRaw), 0, 52);
        (, uint256 floor) = Pricing.computeTakePrice(lastPrice, basePrice, elapsed, BPS, BPS, 52);
        assertEq(floor, lastPrice > basePrice ? lastPrice : basePrice);
    }
}
