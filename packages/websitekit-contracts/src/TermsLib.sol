// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice The tiered-mutability policy for `SlotSite`. Implements PROTOCOL-SPEC §6.1.
///
/// **`internal`, so this is inlined code organization — not a deployment.** It was tried as an
/// external delegatecalled library and rejected on measurement: that saved only 83 more bytes than
/// inlining, because the functions take two five-field structs and ABI-encoding them across the
/// delegatecall boundary costs nearly what the logic saved. 83 bytes does not justify another
/// deployment, another link reference and more audit surface.
///
/// The reason it exists is DEDUPLICATION: `initialize` and the setters share one definition of a
/// legal configuration, so `_validateConfig` grows *with* the config rather than around it (§8).
///
/// General lesson, recorded because it cost two wrong projections: extracting to an external library
/// saves `moved_bytes - stub_cost`, and stub cost scales with call-site count TIMES argument size.
/// `RentalsLib` earns its keep (4 call sites, small args). This did not.
///
/// **The rule these encode.** Take economics bind a holder who cannot exit: their only escape is
/// being taken by someone else, which they cannot force. So once the first position is claimed they
/// may move only in the direction that cannot strand one — `takeBps` down, `payoutBps` up, reversion
/// slower, cooldown shorter. Before the first claim nothing is at stake and anything goes.
///
/// The ratchet is self-limiting: `takeBps` falling and `payoutBps` rising converge on the
/// `takeBps > payoutBps + protocolBps` clamp and stop. No unbounded drift, and no timelock — notice
/// without recourse is not protection.
library TermsLib {
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant MAX_TAKE_BPS = 30_000;
    uint256 internal constant MAX_REVERSION_WEEKS_CEILING = 52;
    uint256 internal constant MAX_COOLDOWN_SECS = 7 days;
    uint256 internal constant MIN_MAX_ASK_BPS = 10_000;
    uint256 internal constant MAX_FLOOR_DELTA_BPS_CEILING = 2_000;
    uint256 internal constant MIN_FLOOR_CHANGE_COOLDOWN = 24 hours;

    error PayoutBelowPrincipal();
    error TakeTooHigh();
    error TakeBelowPayout();
    error InvalidReversion();
    error InvalidConfig();
    error RatchetDirection();

    struct Economics {
        uint256 takeBps;
        uint256 payoutBps;
        uint256 reversionBps;
        uint256 maxReversionWeeks;
        uint256 cooldownSecs;
    }

    struct FloorPolicy {
        uint256 floorDeltaBps;
        uint256 floorChangeCooldown;
        uint256 maxAskBps;
    }

    /// @notice Validates a proposed economics change against the absolute clamps and, once locked,
    /// against the holder-safe direction. Returns nothing — the caller writes storage.
    function checkEconomics(Economics memory next, Economics memory current, bool locked, uint256 protocolBps)
        internal
        pure
    {
        if (locked) {
            if (next.takeBps > current.takeBps) revert RatchetDirection();
            if (next.payoutBps < current.payoutBps) revert RatchetDirection();
            // Slower reversion protects the payout a holder is owed; faster cuts what a premium
            // buyer recovers.
            if (next.reversionBps < current.reversionBps) revert RatchetDirection();
            if (next.maxReversionWeeks > current.maxReversionWeeks) revert RatchetDirection();
            // Raising the cooldown is how an owner makes their own inventory un-takeable.
            if (next.cooldownSecs > current.cooldownSecs) revert RatchetDirection();
        }
        checkEconomicsAbsolute(next, protocolBps);
    }

    /// @notice The clamps that hold for every site at every moment, locked or not. Enforced in the
    /// implementation's bytecode so a buyer can trust a site without reading its config.
    function checkEconomicsAbsolute(Economics memory e, uint256 protocolBps) internal pure {
        // A displaced owner always recovers at least the current effective floor, so a site can only
        // ever monetize the SPREAD, never the principal.
        if (e.payoutBps < BPS_DENOMINATOR) revert PayoutBelowPrincipal();
        if (e.takeBps > MAX_TAKE_BPS) revert TakeTooHigh();
        // Strictly stronger than `takeBps > payoutBps`: the site's cut is
        // `charged - payout - protocol`, so `<=` would underflow and revert every take on the site.
        if (e.takeBps <= e.payoutBps + protocolBps) revert TakeBelowPayout();
        if (e.reversionBps == 0 || e.reversionBps > BPS_DENOMINATOR) revert InvalidReversion();
        if (e.maxReversionWeeks > MAX_REVERSION_WEEKS_CEILING) revert InvalidReversion();
        if (e.cooldownSecs > MAX_COOLDOWN_SECS) revert InvalidConfig();
    }

    /// @notice The guards on the floor lever and the ask cap. After the lock they may only tighten.
    function checkFloorPolicy(FloorPolicy memory next, FloorPolicy memory current, bool locked) internal pure {
        if (locked) {
            if (next.floorDeltaBps > current.floorDeltaBps) revert RatchetDirection();
            if (next.floorChangeCooldown < current.floorChangeCooldown) revert RatchetDirection();
            if (next.maxAskBps > current.maxAskBps) revert RatchetDirection();
        }
        if (next.floorDeltaBps == 0 || next.floorDeltaBps > MAX_FLOOR_DELTA_BPS_CEILING) revert InvalidConfig();
        if (next.floorChangeCooldown < MIN_FLOOR_CHANGE_COOLDOWN) revert InvalidConfig();
        // `10_000` is down-only; below it an owner could not post an ask at their own cost.
        if (next.maxAskBps < MIN_MAX_ASK_BPS) revert InvalidConfig();
    }
}
