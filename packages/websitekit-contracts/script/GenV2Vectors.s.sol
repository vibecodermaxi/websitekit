// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { V2MathHarness } from "../test/harness/V2MathHarness.sol";

/// @notice Deterministic JSONL vector generator for v2's two new arithmetic families — the ask
/// (spec §3) and rent (spec §2). Sibling of `GenPriceVectors.s.sol`, and deliberately a SEPARATE
/// file writing a SEPARATE grid.
///
/// **Why not extend the existing generator.** `docs/STATE.md` records that the existing take-price
/// vectors are unaffected by v2 *by construction* — the ask enters pricing as the reversion base
/// rather than as a multiplier (§3.1). Keeping the old grid literally untouched is what makes that
/// claim checkable rather than merely asserted: if `out/price-vectors.jsonl` changes, something
/// about v1 pricing moved and the claim was wrong. It also avoids a row schema where two thirds of
/// the columns are null, since rent is parameterised by `(prepaid, start, expiry, now)` and the ask
/// by `(askFloor, lastPrice, basePrice, maxAskBps)` — no shared dimensions at all.
///
/// Three families, one file, distinguished by a `kind` field:
///
///   - `ask`  — the reversion base, the ask ceiling, AND the quote that composes them. §3.1's claim
///              is about the composition, so comparing the pieces separately would let a twin that
///              resolved correctly and applied the base wrongly pass every row.
///   - `rent` — linear accrual and the unaccrued remainder a buyer inherits (§2.4.2).
///   - `fee`  — the gross cost of a term and the protocol/site/escrow split (§2.5).
///
/// No RNG: every value is a fixed literal or a fixed range, so re-running emits the same grid to
/// `out/v2-vectors.jsonl` via `vm.writeLine` — NOT stdout, which mixes compiler status, traces and
/// gas lines around any `console2.log` and is not reliably parseable.
contract GenV2Vectors is Script {
    uint256 internal constant MAXU = type(uint256).max;
    uint64 internal constant MAXU64 = type(uint64).max;
    string internal constant OUT_PATH = "out/v2-vectors.jsonl";

    /// @dev A fixed, deliberately non-zero epoch. Zero would make `start == 0` collide with the
    /// `expiry == 0` sentinel that means "no tenancy", and hide whether the guard reads the right
    /// field.
    ///
    /// **Every `uint64`-typed field below is emitted as a JSON STRING, not a bare number.** A
    /// `uint64` runs to 1.8e19 and `JSON.parse` coerces bare numbers to float64, which silently
    /// rounds anything past 2^53 — `type(uint64).max` came back as `...552000` instead of
    /// `...551615` and the twin was then compared against a value neither language ever computed.
    /// The bps fields stay bare because they are clamped to five digits; timestamps and durations
    /// are not.
    uint64 internal constant T0 = 1_700_000_000;

    V2MathHarness internal harness;
    uint256 internal rows;
    uint256 internal overflowRows;

    function run() external {
        harness = new V2MathHarness();
        vm.writeFile(OUT_PATH, ""); // clear once at script start

        _emitAskGrid();
        _emitRentGrid();
        _emitFeeGrid();

        console2.log("GenV2Vectors: rows", rows);
        console2.log("GenV2Vectors: overflow rows", overflowRows);
    }

    // =================================================================
    // The ask — §3
    // =================================================================

    /// @dev `maxAskBps` has a floor of `10_000` (down-only; below it an owner could not post an ask
    /// at their own cost) and NO ceiling in `TermsLib.checkFloorPolicy`. So the grid runs from the
    /// clamp itself out to a value large enough to overflow the anchor multiply, because an
    /// unbounded parameter is exactly where the twin's arbitrary precision diverges from uint256.
    function _emitAskGrid() internal {
        uint256[5] memory askFloors = [uint256(0), 1, 1e16, 1e18, MAXU];
        uint256[5] memory lastPrices = [uint256(0), 1, 1e15, 1e18, MAXU / 40_000];
        uint256[3] memory basePrices = [uint256(1), 1e16, 1e18];
        uint256[4] memory askCaps = [uint256(10_000), 12_500, 40_000, 1_000_000];

        for (uint256 a = 0; a < askFloors.length; a++) {
            for (uint256 l = 0; l < lastPrices.length; l++) {
                for (uint256 b = 0; b < basePrices.length; b++) {
                    for (uint256 c = 0; c < askCaps.length; c++) {
                        _emitAskRow(askFloors[a], lastPrices[l], basePrices[b], askCaps[c]);
                    }
                }
            }
        }
    }

    function _emitAskRow(uint256 askFloor, uint256 lastPrice, uint256 basePrice, uint256 maxAskBps) internal {
        // The Standard profile, held fixed. The pricing config is already swept exhaustively by
        // `GenPriceVectors`; sweeping it again here would multiply the row count to restate a result
        // the other grid already owns. What this grid varies is the ASK dimension.
        string memory head = string.concat(
            '{"kind":"ask","ask_floor":"',
            vm.toString(askFloor),
            '","last_price":"',
            vm.toString(lastPrice),
            '","base_price":"',
            vm.toString(basePrice),
            '","max_ask_bps":',
            vm.toString(maxAskBps)
        );

        uint256 base = harness.reversionBase(askFloor, lastPrice);

        try harness.askCeiling(lastPrice, basePrice, maxAskBps) returns (uint256 ceiling) {
            try harness.quoteFromAsk(askFloor, lastPrice, basePrice, 3, 9_700, 14_000, 52) returns (
                uint256 price, uint256 effectiveFloor
            ) {
                _write(
                    string.concat(
                        head,
                        ',"overflow":false,"reversion_base":"',
                        vm.toString(base),
                        '","ask_ceiling":"',
                        vm.toString(ceiling),
                        '","price":"',
                        vm.toString(price),
                        '","effective_floor":"',
                        vm.toString(effectiveFloor),
                        '"}'
                    ),
                    false
                );
            } catch {
                _write(string.concat(head, ',"overflow":true}'), true);
            }
        } catch {
            _write(string.concat(head, ',"overflow":true}'), true);
        }
    }

    // =================================================================
    // Rent accrual — §2
    // =================================================================

    /// @dev Parameterised by `(prepaid, duration, elapsed)` rather than by raw timestamps, because
    /// the shape that matters is where `elapsed` sits relative to `duration` — and a raw-timestamp
    /// grid spends most of its rows far outside the term where accrual is trivially clamped.
    ///
    /// `duration == 0` is included on purpose: it is the `expiry == 0` sentinel, "no tenancy", and
    /// the guard that catches it is the difference between returning nothing and dividing by zero.
    function _emitRentGrid() internal {
        uint256[6] memory prepaids = [uint256(0), 1, 100, 1e6, 1e18, MAXU];
        uint64[5] memory durations = [uint64(0), 1 hours, 1 days, 30 days, 365 days];

        for (uint256 p = 0; p < prepaids.length; p++) {
            for (uint256 d = 0; d < durations.length; d++) {
                uint64 duration = durations[d];
                uint64[8] memory elapsed = _elapsedPoints(duration);
                for (uint256 e = 0; e < elapsed.length; e++) {
                    _emitRentRow(prepaids[p], duration, elapsed[e]);
                }
            }
        }
    }

    /// @dev Both boundaries of the term are sampled from both sides. `duration - 1` and `duration`
    /// straddle the clamp that makes a lapsed term earn exactly `prepaid` and nothing more, which is
    /// the property `finish` relies on to drain escrow to zero.
    function _elapsedPoints(uint64 duration) internal pure returns (uint64[8] memory e) {
        e[0] = 0;
        e[1] = 1;
        e[2] = duration / 3;
        e[3] = duration / 2;
        e[4] = duration > 0 ? duration - 1 : 0;
        e[5] = duration;
        e[6] = duration + 1;
        e[7] = duration + 365 days;
    }

    function _emitRentRow(uint256 prepaid, uint64 duration, uint64 elapsed) internal {
        uint64 start = T0;
        // `expiry == 0` is the sentinel for "no tenancy"; every other duration produces a real term.
        uint64 expiry = duration == 0 ? 0 : start + duration;
        uint256 nowTs = uint256(start) + uint256(elapsed);

        string memory head = string.concat(
            '{"kind":"rent","prepaid":"',
            vm.toString(prepaid),
            '","start":"',
            vm.toString(uint256(start)),
            '","expiry":"',
            vm.toString(uint256(expiry)),
            '","now_ts":"',
            vm.toString(nowTs),
            '"'
        );

        try harness.accrual(prepaid, start, expiry, nowTs) returns (uint256 accrued, uint256 unaccrued) {
            _write(
                string.concat(
                    head,
                    ',"overflow":false,"accrued":"',
                    vm.toString(accrued),
                    '","unaccrued":"',
                    vm.toString(unaccrued),
                    '"}'
                ),
                false
            );
        } catch {
            _write(string.concat(head, ',"overflow":true}'), true);
        }
    }

    // =================================================================
    // Rent cost and the fee split — §2.5
    // =================================================================

    /// @dev The fee pairs are all admissible: `_validateRentTerms` requires
    /// `siteRentBps + protocolRentBps` to land in `[1_000, 4_000]`, and both ends of that band plus
    /// both degenerate allocations of it are swept. A pair outside the band would pad the grid
    /// without proving anything, since no site can ever hold it.
    function _emitFeeGrid() internal {
        uint256[6] memory rates = [uint256(0), 1, 1e4, 1e18, MAXU / uint256(365 days), MAXU];
        uint64[5] memory durations = [uint64(1 hours), 1 days, 30 days, 365 days, MAXU64];
        // (protocolRentBps, feeBps) — total at the 1_000 floor, the default, the 4_000 ceiling, and
        // both ends taken entirely by one side.
        uint256[2][5] memory fees = [
            [uint256(500), 500],
            [uint256(500), 2_500],
            [uint256(500), 3_500],
            [uint256(0), 1_000],
            [uint256(4_000), 0]
        ];

        for (uint256 r = 0; r < rates.length; r++) {
            for (uint256 d = 0; d < durations.length; d++) {
                for (uint256 f = 0; f < fees.length; f++) {
                    _emitFeeRow(rates[r], durations[d], fees[f][0], fees[f][1]);
                }
            }
        }
    }

    function _emitFeeRow(uint256 ratePerDay, uint64 durationSecs, uint256 protocolRentBps, uint256 feeBps) internal {
        string memory head = string.concat(
            '{"kind":"fee","rate_per_day":"',
            vm.toString(ratePerDay),
            '","duration_secs":"',
            vm.toString(uint256(durationSecs)),
            '","protocol_rent_bps":',
            vm.toString(protocolRentBps),
            ',"fee_bps":',
            vm.toString(feeBps)
        );

        try harness.rentCost(ratePerDay, durationSecs) returns (uint256 cost) {
            try harness.rentSplit(cost, protocolRentBps, feeBps) returns (
                uint256 protocolCut, uint256 siteCut, uint256 net
            ) {
                _write(
                    string.concat(
                        head,
                        ',"overflow":false,"cost":"',
                        vm.toString(cost),
                        '","protocol_cut":"',
                        vm.toString(protocolCut),
                        '","site_cut":"',
                        vm.toString(siteCut),
                        '","net":"',
                        vm.toString(net),
                        '"}'
                    ),
                    false
                );
            } catch {
                _write(string.concat(head, ',"overflow":true}'), true);
            }
        } catch {
            _write(string.concat(head, ',"overflow":true}'), true);
        }
    }

    function _write(string memory line, bool overflowed) internal {
        vm.writeLine(OUT_PATH, line);
        rows++;
        if (overflowed) overflowRows++;
    }
}
