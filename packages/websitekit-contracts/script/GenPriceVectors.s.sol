// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { PricingHarness } from "../test/harness/PricingHarness.sol";

/// @notice Deterministic wide-grid JSONL vector generator — the Solidity side of the websitekit parity
/// harness (spec §7.8).
///
/// **The reason this file is not v1's generator with a rename.** v1 sweeps
/// `(basePrice × lastPrice × elapsedWeeks)` against ONE hardcoded config, because it is one site
/// with one config. websitekit sites choose their own, so the config is a swept dimension here — and
/// §7.8 names the exact failure mode of not doing that: *the existing fixed-config vectors keep
/// passing while the config space goes unswept*. A grid that only ever runs `takeBps == 14_000`
/// would look thorough and prove nothing about the other 19,999 admissible values.
///
/// The configs below are all ADMISSIBLE under `SlotSite._validateConfig`. Sweeping inadmissible
/// ones would pad the row count without proving anything, since no clone can ever hold them.
///
/// No RNG — every value is a fixed literal or a fixed range, so re-running always emits the same
/// grid to `out/price-vectors.jsonl` via `vm.writeLine` (NOT stdout: forge script's stdout mixes
/// compiler status, traces and gas lines around any `console2.log`, and is not reliably parseable).
contract GenPriceVectors is Script {
    uint256 internal constant MAXU = type(uint256).max;
    string internal constant OUT_PATH = "out/price-vectors.jsonl";

    struct Cfg {
        uint256 takeBps;
        uint256 payoutBps;
        uint256 decayBps;
        uint256 maxDecayWeeks;
        uint256 protocolBps;
    }

    function run() external {
        PricingHarness harness = new PricingHarness();

        Cfg[12] memory configs = _configs();
        uint256[3] memory basePrices = [uint256(1), uint256(1e16), uint256(1e18)];
        uint256[7] memory lastPrices = _lastPrices();
        uint256[12] memory weeksGrid = _weeksGrid();

        vm.writeFile(OUT_PATH, ""); // clear once at script start

        uint256 rows = 0;
        uint256 overflowRows = 0;
        for (uint256 c = 0; c < configs.length; c++) {
            for (uint256 b = 0; b < basePrices.length; b++) {
                for (uint256 l = 0; l < lastPrices.length; l++) {
                    for (uint256 w = 0; w < weeksGrid.length; w++) {
                        bool overflowed = _emit(harness, configs[c], basePrices[b], lastPrices[l], weeksGrid[w]);
                        rows++;
                        if (overflowed) overflowRows++;
                    }
                }
            }
        }

        console2.log("GenPriceVectors: rows", rows);
        console2.log("GenPriceVectors: overflow rows", overflowRows);
    }

    /// @dev One row per `(config, basePrice, lastPrice, elapsedWeeks)`, carrying BOTH branches of
    /// the split. The claim and take branches share an `effectiveFloor` but charge differently, and
    /// a twin that got the branch selection backwards would still pass a price-only comparison.
    function _emit(PricingHarness harness, Cfg memory cfg, uint256 basePrice, uint256 lastPrice, uint256 weeksElapsed)
        internal
        returns (bool overflowed)
    {
        string memory head = string.concat(
            '{"take_bps":',
            vm.toString(cfg.takeBps),
            ',"payout_bps":',
            vm.toString(cfg.payoutBps),
            ',"decay_bps":',
            vm.toString(cfg.decayBps),
            ',"max_decay_weeks":',
            vm.toString(cfg.maxDecayWeeks),
            ',"protocol_bps":',
            vm.toString(cfg.protocolBps),
            ',"base_price":"',
            vm.toString(basePrice),
            '","last_price":"',
            vm.toString(lastPrice),
            '","elapsed_weeks":',
            vm.toString(weeksElapsed)
        );

        try harness.compute(
            lastPrice, basePrice, weeksElapsed, cfg.decayBps, cfg.takeBps, cfg.maxDecayWeeks
        ) returns (
            uint256 price, uint256 effectiveFloor
        ) {
            string memory splits = _splits(harness, cfg, effectiveFloor, price);
            if (bytes(splits).length == 0) {
                // The price computed but a split overflowed — still an overflow row, and the twin
                // must throw at the same point rather than returning a number Solidity cannot hold.
                vm.writeLine(OUT_PATH, string.concat(head, ',"overflow":true}'));
                return true;
            }
            vm.writeLine(
                OUT_PATH,
                string.concat(
                    head,
                    ',"overflow":false,"price":"',
                    vm.toString(price),
                    '","effective_floor":"',
                    vm.toString(effectiveFloor),
                    '",',
                    splits,
                    "}"
                )
            );
            return false;
        } catch {
            vm.writeLine(OUT_PATH, string.concat(head, ',"overflow":true}'));
            return true;
        }
    }

    /// @dev Returns "" to signal that one of the two branches reverted on checked arithmetic.
    function _splits(PricingHarness harness, Cfg memory cfg, uint256 effectiveFloor, uint256 price)
        internal
        view
        returns (string memory)
    {
        try harness.split(effectiveFloor, price, true, cfg.payoutBps, cfg.protocolBps) returns (
            uint256 cCharged, uint256 cPayout, uint256 cProtocol, uint256 cSite
        ) {
            try harness.split(effectiveFloor, price, false, cfg.payoutBps, cfg.protocolBps) returns (
                uint256 tCharged, uint256 tPayout, uint256 tProtocol, uint256 tSite
            ) {
                return string.concat(
                    '"claim":{"charged":"',
                    vm.toString(cCharged),
                    '","payout":"',
                    vm.toString(cPayout),
                    '","protocol":"',
                    vm.toString(cProtocol),
                    '","site":"',
                    vm.toString(cSite),
                    '"},"take":{"charged":"',
                    vm.toString(tCharged),
                    '","payout":"',
                    vm.toString(tPayout),
                    '","protocol":"',
                    vm.toString(tProtocol),
                    '","site":"',
                    vm.toString(tSite),
                    '"}'
                );
            } catch {
                return "";
            }
        } catch {
            return "";
        }
    }

    /// @dev Each row probes a different corner of the admissible space rather than sampling near
    /// the defaults, which is what a fixed-config suite already covers.
    function _configs() internal pure returns (Cfg[12] memory c) {
        // 0 — v1's own parameters, so the shared history stays visible in the grid.
        c[0] = Cfg(14_000, 11_500, 9_000, 52, 500);
        // 1 — the narrowest legal spread: one bps of site revenue on the whole take.
        c[1] = Cfg(10_002, 10_000, 9_000, 52, 1);
        // 2 — the take ceiling.
        c[2] = Cfg(30_000, 20_000, 9_000, 52, 1_000);
        // 3 — no decay at all: `decayBps == 10_000` is a pure ratchet.
        c[3] = Cfg(14_000, 11_500, 10_000, 52, 500);
        // 4 — maximum decay: one iteration collapses the price to floor.
        c[4] = Cfg(14_000, 11_500, 1, 52, 500);
        // 5 — zero horizon: the loop never runs, so `lastPrice` carries undecayed forever.
        c[5] = Cfg(14_000, 11_500, 9_000, 0, 500);
        // 6 — one-week horizon, the smallest non-trivial loop.
        c[6] = Cfg(14_000, 11_500, 9_000, 1, 500);
        // 7 — the shorter horizon §7.7 recommends websitekit default to.
        c[7] = Cfg(14_000, 11_500, 9_000, 8, 500);
        // 8 — no protocol cut, which is the whole `protocolBps == 0` code path.
        c[8] = Cfg(14_000, 11_500, 9_000, 52, 0);
        // 9 — the largest protocol cut the take ceiling admits.
        c[9] = Cfg(30_000, 10_000, 9_000, 52, 10_000);
        // 10 — payout exactly at principal: the displaced owner breaks even and no more.
        c[10] = Cfg(12_000, 10_000, 5_000, 26, 1_000);
        // 11 — deliberately non-round bps everywhere, so every truncation point is exercised with a
        //      remainder rather than dividing cleanly.
        c[11] = Cfg(13_337, 11_111, 7_777, 13, 333);
    }

    /// @dev Straddles both overflow-triggering multiplies — the per-iteration decay multiply and
    /// the final take multiply — at the widest `takeBps`/`decayBps` the config grid uses.
    function _lastPrices() internal pure returns (uint256[7] memory p) {
        p[0] = 0;
        p[1] = 1;
        p[2] = 1e15;
        p[3] = 1e18;
        p[4] = MAXU / 30_000; // final-multiply boundary at the take ceiling
        p[5] = MAXU / 10_000; // per-iteration decay-multiply boundary at decayBps == 10_000
        p[6] = MAXU;
    }

    /// @dev 0..6 dense, then points that straddle every `maxDecayWeeks` in the config grid (0, 1,
    /// 8, 13, 26, 52) and one far past all of them.
    function _weeksGrid() internal pure returns (uint256[12] memory w) {
        for (uint256 i = 0; i <= 6; i++) {
            w[i] = i;
        }
        w[7] = 8;
        w[8] = 13;
        w[9] = 26;
        w[10] = 52;
        w[11] = 999;
    }
}
