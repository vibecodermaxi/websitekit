// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SlotSiteBase } from "./SlotSiteBase.t.sol";
import { SlotSite } from "../src/SlotSite.sol";

/// @notice The ask (PROTOCOL-SPEC §3). It reopens v1 §10.6, which cut owner-set pricing — so the
/// tests are written against the two **load-bearing rules** that make it safe to reopen, because
/// violating either restores the holdout scenario the mechanism exists to end.
contract SlotSiteAskTest is SlotSiteBase {
    function test_askReplacesLastPriceAsTheReversionBase() public {
        _claim(alice, HERO_HEADLINE);
        vm.warp(block.timestamp + COOLDOWN_SECS);
        _take(bob, HERO_HEADLINE); // lastPrice is now 1.4x the floor

        uint256 lastPrice = site.slotOf(HERO_HEADLINE).lastPrice;
        assertEq(site.resolveReversionBase(HERO_HEADLINE), lastPrice, "unset ask falls through to lastPrice");

        // A legal markdown lives in [basePrice, cap]. Half of lastPrice is 0.7x the floor, which is
        // BELOW it — so the marked-down number has to sit between the floor and what bob paid.
        uint256 ask = (site.slotOf(HERO_HEADLINE).basePrice * 12) / 10;
        vm.prank(bob);
        site.setAsk(HERO_HEADLINE, ask);
        assertEq(site.resolveReversionBase(HERO_HEADLINE), ask, "the ask becomes the base");

        (uint256 effectiveFloor,) = site.quote(HERO_HEADLINE);
        assertEq(effectiveFloor, ask, "marking down lowers what a taker pays immediately");
    }

    /// **Load-bearing rule 1.** Reversion is measured from `lastPurchaseTs` and setting an ask must
    /// not touch it. If it did, an owner re-posts the same number every six days and the price never
    /// reverts — the holdout scenario fully restored, with extra steps.
    function test_settingAnAskDoesNotResetTheReversionClock() public {
        _claim(alice, HERO_HEADLINE);
        vm.warp(block.timestamp + COOLDOWN_SECS);
        _take(bob, HERO_HEADLINE);

        uint64 purchasedAt = site.slotOf(HERO_HEADLINE).lastPurchaseTs;
        uint256 lastPrice = site.slotOf(HERO_HEADLINE).lastPrice;

        vm.warp(block.timestamp + 10 weeks);
        vm.prank(bob);
        site.setAsk(HERO_HEADLINE, lastPrice);

        assertEq(site.slotOf(HERO_HEADLINE).lastPurchaseTs, purchasedAt, "clock untouched");

        // The posted number is a PRE-REVERSION base, so an ask posted ten weeks in is already
        // discounted. That is the counterintuitive part the UI has to show.
        (uint256 effectiveFloor,) = site.quote(HERO_HEADLINE);
        assertLt(effectiveFloor, lastPrice, "ten weeks of reversion still applies to the posted number");
    }

    /// **Load-bearing rule 2.** The cap anchors to `lastPrice`, which only moves on a sale and is
    /// therefore frozen for an owner's whole tenure. Anchoring to the effective floor instead creates
    /// an unbounded ratchet: post at 4x the floor, which raises the floor, post again at 4x the new
    /// floor, forever.
    function test_theCapAnchorsToLastPriceSoRepeatedPostsCannotRatchet() public {
        _claim(alice, HERO_HEADLINE);
        uint256 lastPrice = site.slotOf(HERO_HEADLINE).lastPrice;
        uint256 cap = (lastPrice * MAX_ASK_BPS) / 10_000;

        vm.prank(alice);
        site.setAsk(HERO_HEADLINE, cap);

        // Posting again cannot exceed the same anchor, however high the effective floor now reads.
        vm.prank(alice);
        vm.expectRevert(SlotSite.AskAboveCap.selector);
        site.setAsk(HERO_HEADLINE, cap + 1);
    }

    function test_askBelowTheFloorIsRejectedRatherThanClamped() public {
        _claim(alice, HERO_HEADLINE);
        uint256 base = site.slotOf(HERO_HEADLINE).basePrice;
        // Rejected at write time, not silently clamped by `max()` — the owner should get an error,
        // not a no-op the UI has to explain.
        uint256 tooLow = base - 1;
        vm.prank(alice);
        vm.expectRevert(SlotSite.AskBelowBase.selector);
        site.setAsk(HERO_HEADLINE, tooLow);
    }

    function test_aNewOwnerInheritsNoAsk() public {
        _claim(alice, HERO_HEADLINE);
        uint256 lastPrice = site.slotOf(HERO_HEADLINE).lastPrice;
        vm.prank(alice);
        site.setAsk(HERO_HEADLINE, lastPrice * 2);
        assertGt(site.slotOf(HERO_HEADLINE).askFloor, 0);

        vm.warp(block.timestamp + COOLDOWN_SECS);
        _take(bob, HERO_HEADLINE);
        assertEq(site.slotOf(HERO_HEADLINE).askFloor, 0, "cleared on sale");
    }

    function test_onlyTheOwnerMaySetAnAsk() public {
        _claim(alice, HERO_HEADLINE);
        uint256 base = site.slotOf(HERO_HEADLINE).basePrice; // hoisted past expectRevert
        vm.prank(bob);
        vm.expectRevert(SlotSite.NotSlotOwner.selector);
        site.setAsk(HERO_HEADLINE, base);
    }

    /// §3.3 — `maxAskBps == 10_000` collapses the cap to `lastPrice`, which IS down-only. The
    /// markup-vs-down-only question is a config choice, not two implementations.
    function test_maxAskBpsOf10000IsDownOnly() public {
        vm.prank(siteOwner);
        site.setFloorPolicy(FLOOR_DELTA_BPS, FLOOR_CHANGE_COOLDOWN, 10_000);

        _claim(alice, HERO_HEADLINE);
        uint256 lastPrice = site.slotOf(HERO_HEADLINE).lastPrice;

        vm.prank(alice);
        site.setAsk(HERO_HEADLINE, lastPrice); // at cost: allowed

        vm.prank(alice);
        vm.expectRevert(SlotSite.AskAboveCap.selector);
        site.setAsk(HERO_HEADLINE, lastPrice + 1); // any markup: refused
    }

    /// The ask feeds `effectiveFloor`, which is also what the rent floor is computed from. An owner
    /// marking down lowers their own rent floor — but a marked-down position is also cheap to TAKE,
    /// which defeats the holdout they would be poisoning to protect. The attacker cannot have both.
    function test_markingDownAlsoLowersTheRentFloorAndTheTakePrice() public {
        _claim(alice, HERO_HEADLINE);
        vm.warp(block.timestamp + COOLDOWN_SECS);
        _take(bob, HERO_HEADLINE);

        (, uint256 takeBefore) = site.quote(HERO_HEADLINE);
        uint256 rentFloorBefore = _minRate();

        uint256 down = site.slotOf(HERO_HEADLINE).basePrice; // hoisted, or it eats the prank
        vm.prank(bob);
        site.setAsk(HERO_HEADLINE, down);

        (, uint256 takeAfter) = site.quote(HERO_HEADLINE);
        assertLt(takeAfter, takeBefore, "cheaper to take");
        assertLt(_minRate(), rentFloorBefore, "and a lower rent floor -- both move together");
    }

    function _minRate() internal view returns (uint256) {
        (uint256 effectiveFloor,) = site.quote(HERO_HEADLINE);
        return (effectiveFloor * MIN_RENT_BPS) / 10_000;
    }
}

contract SlotSiteAskTokenTest is SlotSiteAskTest {
    function USE_TOKEN() internal pure override returns (bool) {
        return true;
    }
}
