// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Pricing } from "../../src/Pricing.sol";
import { RentalsLib } from "../../src/RentalsLib.sol";

/// @notice Generator-only tooling for v2's two new arithmetic families — the ask (spec §3) and rent
/// (spec §2). The sibling of `PricingHarness`, and it exists for exactly the same reason.
///
/// `Pricing`'s and `RentalsLib`'s helpers are `internal pure` and their call sites are inlined (no
/// new EVM call frame), so a bare `try Pricing.askCeiling(...) catch` does not compile as a catchable
/// boundary — Solidity's try/catch only wraps external and contract-creation calls. These
/// `external pure` wrappers give `GenV2Vectors.s.sol` a boundary it can catch, so the generator can
/// RECORD the rows where checked arithmetic reverts rather than dying on them.
///
/// Recording rather than skipping is the whole point: an overflow boundary is precisely where the
/// two languages can disagree, since `BigInt` is arbitrary-precision and `uint256` is not. v1's
/// harness threw those rows away, which left the one genuine difference between the twins untested.
///
/// **Only `internal` library functions are wrapped, so this contract needs no library linking.**
/// `RentalsLib`'s `public` functions are delegatecalled from a real site and take storage pointers;
/// none of them are reachable — or wanted — from here.
///
/// Never part of the production contract surface: lives under `test/harness/`, not `src/`.
contract V2MathHarness {
    // -----------------------------------------------------------------
    // The ask — §3
    // -----------------------------------------------------------------

    function reversionBase(uint256 askFloor, uint256 lastPrice) external pure returns (uint256) {
        return Pricing.resolveReversionBase(askFloor, lastPrice);
    }

    function askCeiling(uint256 lastPrice, uint256 basePrice, uint256 maxAskBps) external pure returns (uint256) {
        return Pricing.askCeiling(lastPrice, basePrice, maxAskBps);
    }

    /// @notice The composition that matters, in one call: resolve the base, then price from it.
    ///
    /// §3.1's claim is that the ask enters as the reversion BASE rather than as a multiplier on the
    /// result, which is why the pre-v2 take-price grid is still valid. That claim is about how these
    /// two functions compose, so the harness has to expose the composition — comparing them
    /// separately would let a twin that resolved correctly and then applied the base in the wrong
    /// position pass every row.
    function quoteFromAsk(
        uint256 askFloor,
        uint256 lastPrice,
        uint256 basePrice,
        uint256 elapsedWeeks,
        uint256 decayBps,
        uint256 takeBps,
        uint256 maxDecayWeeks
    ) external pure returns (uint256 price, uint256 effectiveFloor) {
        return Pricing.computeTakePrice(
            Pricing.resolveReversionBase(askFloor, lastPrice),
            basePrice,
            elapsedWeeks,
            decayBps,
            takeBps,
            maxDecayWeeks
        );
    }

    // -----------------------------------------------------------------
    // Rent — §2
    // -----------------------------------------------------------------

    /// @dev Both legs of the accrual split in one call. `unaccrued` is what a buyer inherits
    /// (§2.4.2) and is derived from `accrued`, so emitting them together is what pins the identity
    /// `accrued + unaccrued == prepaid` across the language boundary rather than inside one of them.
    function accrual(uint256 prepaid, uint64 start, uint64 expiry, uint256 nowTs)
        external
        pure
        returns (uint256 accrued, uint256 unaccrued)
    {
        accrued = RentalsLib.accruedOf(prepaid, start, expiry, nowTs);
        unaccrued = prepaid - accrued;
    }

    function rentCost(uint256 ratePerDay, uint64 durationSecs) external pure returns (uint256) {
        return RentalsLib.rentCost(ratePerDay, durationSecs);
    }

    function rentSplit(uint256 cost, uint256 protocolRentBps, uint256 feeBps)
        external
        pure
        returns (uint256 protocolCut, uint256 siteCut, uint256 net)
    {
        return RentalsLib.rentSplit(cost, protocolRentBps, feeBps);
    }
}
