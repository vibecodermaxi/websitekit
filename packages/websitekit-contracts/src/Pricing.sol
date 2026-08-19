// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice websitekit's port of v1's `Pricing.sol` — itself a literal iterative
/// translation of `packages/sdk/src/pricing.ts`'s `_takeParts`. Same loop bound, same
/// multiply-then-divide order per iteration, same floor comparison, same final single
/// multiply-divide.
///
/// **The one deliberate change from the v1 twin: `maxDecayWeeks` is a parameter, not a
/// constant.** v1 hardcodes `MAX_DECAY_WEEKS = 52` because it is one site with one config;
/// websitekit sites choose their own decay horizon at `initialize()`, so the clamp has to travel with
/// the call. Pass `52` and this function is byte-identical to v1's — which is what keeps every
/// existing Rust/TS/Solidity parity vector valid as a regression suite for the port (spec §7.8).
///
/// Do NOT refactor the decay loop below to a closed-form power. `decayed * decayBps / 10_000`
/// truncates once per iteration, so `basePrice * 0.9^n` drifts from the value this returns; the
/// TS twin carries the identical warning and the chain is the one that has to be right.
///
/// Solidity 0.8.30's default arithmetic is checked (reverts on overflow) — the exact equivalent of
/// the Rust twin's `checked_mul`/`checked_div` discipline. This library uses plain `*`/`/`
/// throughout and contains no `unchecked` block anywhere.
library Pricing {
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    /// @notice Computes the take price and effective floor for a slot.
    /// @dev `weeks` is a reserved Solidity time-unit keyword (`1 weeks == 604800`), so the clamped
    /// local is named `clampedWeeks` — the one naming deviation from the TS/Rust twins; every other
    /// identifier and the operation order match exactly.
    /// @param lastPrice What the current owner paid. Zero for a never-claimed slot, which makes the
    /// decay loop a no-op and hands `basePrice` straight to the `max()`.
    /// @param basePrice The slot's floor. Per-slot and owner-settable within a ±20% band in websitekit,
    /// where v1 derived it from a frozen multiplier table.
    /// @param elapsedWeeks Whole weeks since the last purchase, unclamped; clamping happens here so
    /// callers cannot forget it.
    /// @param maxDecayWeeks The site's decay horizon. Bounded at the call site (`SlotSite` clamps it
    /// to 52 at `initialize()`); this library does not re-validate, it only bounds the loop.
    function computeTakePrice(
        uint256 lastPrice,
        uint256 basePrice,
        uint256 elapsedWeeks,
        uint256 decayBps,
        uint256 takeBps,
        uint256 maxDecayWeeks
    ) internal pure returns (uint256 price, uint256 effectiveFloor) {
        uint256 clampedWeeks = elapsedWeeks > maxDecayWeeks ? maxDecayWeeks : elapsedWeeks;
        uint256 decayed = lastPrice;
        for (uint256 i = 0; i < clampedWeeks; i++) {
            decayed = (decayed * decayBps) / BPS_DENOMINATOR;
        }
        effectiveFloor = decayed > basePrice ? decayed : basePrice;
        price = (effectiveFloor * takeBps) / BPS_DENOMINATOR;
    }

    // ---------------------------------------------------------------------
    // The ask (spec §3)
    //
    // Both pure, both extracted from `SlotSite` for the reason `computeSplit` was: inline, they were
    // only reachable by executing a real `setAsk`/`quote` against a deployed clone, so the widened
    // config space could not be swept over them at all. The parity harness needs a callable target,
    // and there must be exactly one implementation of each for it to be worth sweeping.
    // ---------------------------------------------------------------------

    /// @notice §3. The reversion base — the owner's posted ask when there is one, otherwise what
    /// they paid.
    ///
    /// **This is the whole reason every pre-v2 take-price vector is still valid.** The ask enters
    /// pricing as the BASE that `computeTakePrice` reverts from, not as a multiplier applied to the
    /// result, so with no ask posted (`askFloor == 0`) the value handed downstream is `lastPrice`
    /// unchanged and the function below behaves exactly as it did before §3 existed. A multiplier
    /// would have invalidated the entire existing grid; this is the design choice that did not.
    function resolveReversionBase(uint256 askFloor, uint256 lastPrice) internal pure returns (uint256) {
        return askFloor != 0 ? askFloor : lastPrice;
    }

    /// @notice §3.2. The highest ask an owner may post.
    ///
    /// Anchored to `lastPrice` — which moves only on a sale — or to `basePrice` when that is higher.
    /// **Never to the effective floor.** The effective floor is downstream of the ask itself once one
    /// is posted, so anchoring there would let each ask raise the ceiling for the next and compound
    /// into an unbounded ratchet. Anchoring to a value the ask cannot influence is what bounds it.
    ///
    /// `maxAskBps` has a floor of `10_000` and no ceiling, so this can exceed `type(uint256).max /
    /// maxAskBps` for a large anchor and revert on the multiply. That is the same checked-arithmetic
    /// boundary the take price has, and the twin has to throw in the same place.
    function askCeiling(uint256 lastPrice, uint256 basePrice, uint256 maxAskBps) internal pure returns (uint256) {
        uint256 anchor = lastPrice > basePrice ? lastPrice : basePrice;
        return (anchor * maxAskBps) / BPS_DENOMINATOR;
    }

    /// @notice Where each wei of a purchase goes.
    struct Split {
        /// @dev The effective floor on a claim, the take price on a take. Never the inflated take
        /// price on a claim — that is the ratchet, and it is what `lastPrice` records.
        uint256 charged;
        /// @dev To the displaced owner. Zero on a claim; there is nobody to pay.
        uint256 payout;
        /// @dev To `protocolTreasury`, on every buy including claims.
        uint256 protocolCut;
        /// @dev Whatever remains, to the site.
        uint256 siteCut;
    }

    /// @notice The payout/protocol/site split, extracted from `SlotSite._buy` so there is exactly
    /// ONE implementation of it and the parity harness can reach it without executing a purchase.
    /// Inline in `_buy`, the split was only ever testable through a full `buy` — which meant the
    /// widened config space (spec §7.8) could not be swept over it at all, since a clone's
    /// economics are fixed for its lifetime and each config would need its own deployed site.
    ///
    /// **Every leg is keyed to `effectiveFloor`, never to `charged` or the stale `lastPrice`.**
    /// That is the invariant the whole payout story rests on: a displaced owner is paid against
    /// what the slot is worth now, not against what they happened to pay for it.
    ///
    /// @dev `siteCut` is a checked subtraction and will revert rather than wrap if the caller
    /// supplies a config where `takeBps <= payoutBps + protocolBps`. `SlotSite._validateConfig`
    /// makes that unreachable on-chain; this library does not re-validate, so a caller reaching it
    /// directly gets a revert instead of a silent underflow.
    function computeSplit(
        uint256 effectiveFloor,
        uint256 price,
        bool isUnclaimed,
        uint256 payoutBps,
        uint256 protocolBps
    ) internal pure returns (Split memory split) {
        split.charged = isUnclaimed ? effectiveFloor : price;
        split.payout = isUnclaimed ? 0 : (effectiveFloor * payoutBps) / BPS_DENOMINATOR;
        split.protocolCut = (effectiveFloor * protocolBps) / BPS_DENOMINATOR;
        split.siteCut = split.charged - split.payout - split.protocolCut;
    }
}
