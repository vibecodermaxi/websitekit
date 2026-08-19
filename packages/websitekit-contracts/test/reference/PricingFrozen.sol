// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice The frozen v1 take-price implementation, pinned byte-for-byte as the parity reference.
/// Same loop bound (elapsedWeeks clamped to MAX_DECAY_WEEKS), same multiply-then-divide order per
/// iteration, same floor comparison, same final single multiply-divide as the TypeScript twin in
/// the SDK package.
///
/// Do NOT refactor the decay loop below to a closed-form power — the TypeScript twin carries the
/// identical warning; a closed-form rewrite risks introducing rounding drift relative to the
/// iterative truncating-division semantics (T-02-08).
///
/// Solidity 0.8.30's default arithmetic is checked (reverts on overflow), which is the discipline
/// this file relies on: it uses plain `*`/`/` throughout and contains no unchecked block anywhere
/// (see D-07 / T-09-01, T-09-02).
library Pricing {
    uint256 internal constant MAX_DECAY_WEEKS = 52;
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    /// @notice Computes the take price and effective floor for a slot, mirroring
    /// compute_take_price operation-for-operation.
    /// @dev `weeks` is a reserved Solidity time-unit keyword (`1 weeks == 604800`), so the
    /// clamped local is named `clampedWeeks` instead — the one deliberate naming deviation from
    /// the Rust/TS twins; every other identifier and the operation order match exactly.
    function computeTakePrice(
        uint256 lastPrice,
        uint256 basePrice,
        uint256 elapsedWeeks,
        uint256 decayBps,
        uint256 takeBps
    ) internal pure returns (uint256 price, uint256 effectiveFloor) {
        uint256 clampedWeeks = elapsedWeeks > MAX_DECAY_WEEKS ? MAX_DECAY_WEEKS : elapsedWeeks;
        uint256 decayed = lastPrice;
        for (uint256 i = 0; i < clampedWeeks; i++) {
            decayed = (decayed * decayBps) / BPS_DENOMINATOR;
        }
        effectiveFloor = decayed > basePrice ? decayed : basePrice;
        price = (effectiveFloor * takeBps) / BPS_DENOMINATOR;
    }
}
