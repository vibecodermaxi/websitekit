// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Pricing } from "../../src/Pricing.sol";

/// @notice Generator-only tooling. `Pricing`'s functions are `internal pure` and their call sites
/// are inlined (no new EVM call frame), so a bare `try Pricing.computeTakePrice(...) catch` does not
/// compile as a catchable boundary — Solidity's try/catch only wraps external and
/// contract-creation calls.
///
/// These `external pure` wrappers exist solely to give `GenPriceVectors.s.sol` a try/catch-able
/// boundary, so the generator can RECORD (not crash on) the rows where checked arithmetic reverts.
/// Recording rather than skipping is deliberate: an overflow boundary is a place the two languages
/// can disagree, since BigInt is arbitrary-precision and uint256 is not, so the TS twin has to be
/// asserted to throw there too.
///
/// Never part of the production contract surface — lives under test/harness/, not src/.
contract PricingHarness {
    function compute(
        uint256 lastPrice,
        uint256 basePrice,
        uint256 elapsedWeeks,
        uint256 decayBps,
        uint256 takeBps,
        uint256 maxDecayWeeks
    ) external pure returns (uint256 price, uint256 effectiveFloor) {
        return Pricing.computeTakePrice(lastPrice, basePrice, elapsedWeeks, decayBps, takeBps, maxDecayWeeks);
    }

    function split(uint256 effectiveFloor, uint256 price, bool isUnclaimed, uint256 payoutBps, uint256 protocolBps)
        external
        pure
        returns (uint256 charged, uint256 payout, uint256 protocolCut, uint256 siteCut)
    {
        Pricing.Split memory s = Pricing.computeSplit(effectiveFloor, price, isUnclaimed, payoutBps, protocolBps);
        return (s.charged, s.payout, s.protocolCut, s.siteCut);
    }
}
