// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SlotSiteBase } from "./SlotSiteBase.t.sol";
import { SlotSite } from "../src/SlotSite.sol";
import { TermsLib } from "../src/TermsLib.sol";

/// @notice Tiered mutability (PROTOCOL-SPEC §6.1) and ERC-4907 (§4).
///
/// The tier boundary is the thing to get right: terms are freely mutable until the FIRST CLAIM,
/// because until then nobody's money is in a position. After it they may only move in the direction
/// that cannot strand a holder — whose only exit is being taken by someone else, which they cannot
/// force.
contract SlotSiteTermsTest is SlotSiteBase {
    function test_freeBeforeTheFirstClaim() public {
        assertFalse(site.termsLocked());

        // Anything goes, in either direction, including changes that would be refused later.
        vm.prank(siteOwner);
        site.setEconomics(20_000, 12_000, 9_000, 8, 300);
        assertEq(site.takeBps(), 20_000, "raised");
        assertEq(site.reversionBps(), 9_000, "faster reversion");

        vm.prank(siteOwner);
        site.setEconomics(13_000, 11_000, 9_900, 52, 7 days);
        assertEq(site.takeBps(), 13_000, "and back down again");
    }

    function test_theFirstClaimLocksTerms() public {
        _claim(alice, HERO_HEADLINE);
        assertTrue(site.termsLocked(), "locked by the first mint in the site's life");
    }

    function test_onceLockedAlwaysLocked() public {
        _claim(alice, HERO_HEADLINE);
        vm.warp(block.timestamp + COOLDOWN_SECS);
        _take(bob, HERO_HEADLINE);
        assertTrue(site.termsLocked(), "a position cannot be un-minted");
    }

    // -----------------------------------------------------------------
    // The ratchet directions, one test each
    // -----------------------------------------------------------------

    function test_takeBpsIsDownOnly() public {
        _claim(alice, HERO_HEADLINE);

        vm.prank(siteOwner);
        site.setEconomics(TAKE_BPS - 1_000, PAYOUT_BPS, REVERSION_BPS, MAX_REVERSION_WEEKS, COOLDOWN_SECS);
        assertEq(site.takeBps(), TAKE_BPS - 1_000, "cheaper to displace = more liquidity");

        // Raising it freezes the market and strands holders.
        vm.prank(siteOwner);
        vm.expectRevert(TermsLib.RatchetDirection.selector);
        site.setEconomics(TAKE_BPS, PAYOUT_BPS, REVERSION_BPS, MAX_REVERSION_WEEKS, COOLDOWN_SECS);
    }

    function test_payoutBpsIsUpOnly() public {
        _claim(alice, HERO_HEADLINE);

        vm.prank(siteOwner);
        site.setEconomics(TAKE_BPS, PAYOUT_BPS + 500, REVERSION_BPS, MAX_REVERSION_WEEKS, COOLDOWN_SECS);
        assertEq(site.payoutBps(), PAYOUT_BPS + 500, "displaced holders get more");

        // Lowering it takes money directly from current holders.
        vm.prank(siteOwner);
        vm.expectRevert(TermsLib.RatchetDirection.selector);
        site.setEconomics(TAKE_BPS, PAYOUT_BPS, REVERSION_BPS, MAX_REVERSION_WEEKS, COOLDOWN_SECS);
    }

    function test_reversionIsSlowerOnly() public {
        _claim(alice, HERO_HEADLINE);

        vm.prank(siteOwner);
        site.setEconomics(TAKE_BPS, PAYOUT_BPS, REVERSION_BPS + 100, MAX_REVERSION_WEEKS, COOLDOWN_SECS);
        assertEq(site.reversionBps(), REVERSION_BPS + 100, "slower protects the payout a holder is owed");

        // Faster reversion cuts what a premium buyer recovers.
        vm.prank(siteOwner);
        vm.expectRevert(TermsLib.RatchetDirection.selector);
        site.setEconomics(TAKE_BPS, PAYOUT_BPS, REVERSION_BPS, MAX_REVERSION_WEEKS, COOLDOWN_SECS);
    }

    function test_cooldownIsDownOnly() public {
        _claim(alice, HERO_HEADLINE);

        vm.prank(siteOwner);
        site.setEconomics(TAKE_BPS, PAYOUT_BPS, REVERSION_BPS, MAX_REVERSION_WEEKS, COOLDOWN_SECS - 100);

        // Raising it is how an owner makes their own inventory permanently un-takeable.
        vm.prank(siteOwner);
        vm.expectRevert(TermsLib.RatchetDirection.selector);
        site.setEconomics(TAKE_BPS, PAYOUT_BPS, REVERSION_BPS, MAX_REVERSION_WEEKS, COOLDOWN_SECS);
    }

    /// The ratchet terminates on its own: `takeBps` falling and `payoutBps` rising converge on the
    /// `takeBps > payoutBps + protocolBps` clamp. No unbounded drift, and therefore no timelock.
    function test_theRatchetIsSelfLimiting() public {
        _claim(alice, HERO_HEADLINE);
        vm.prank(siteOwner);
        vm.expectRevert(TermsLib.TakeBelowPayout.selector);
        site.setEconomics(11_600, 11_500, REVERSION_BPS, MAX_REVERSION_WEEKS, COOLDOWN_SECS);
    }

    /// The absolute clamps hold at every moment, locked or not — that is what lets a buyer trust a
    /// site they have never heard of without reading its config.
    function test_absoluteClampsHoldEvenBeforeTheLock() public {
        vm.prank(siteOwner);
        vm.expectRevert(TermsLib.PayoutBelowPrincipal.selector);
        site.setEconomics(20_000, 9_999, REVERSION_BPS, MAX_REVERSION_WEEKS, COOLDOWN_SECS);

        vm.prank(siteOwner);
        vm.expectRevert(TermsLib.TakeTooHigh.selector);
        site.setEconomics(30_001, PAYOUT_BPS, REVERSION_BPS, MAX_REVERSION_WEEKS, COOLDOWN_SECS);
    }

    /// §2.5.1 — rent terms stay freely mutable in BOTH directions even after the lock, because a
    /// change cannot touch an active tenancy (the fee is snapshotted per listing) and an owner who
    /// dislikes a new rate simply does not list. That recourse is what take economics lack.
    function test_rentTermsStayFreelyMutableAfterTheLock() public {
        _claim(alice, HERO_HEADLINE);
        assertTrue(site.termsLocked());

        vm.prank(siteOwner);
        site.setRentalTerms(3_000, 14 days, 50);
        assertEq(site.siteRentBps(), 3_000, "raised after the lock");

        vm.prank(siteOwner);
        site.setRentalTerms(1_000, 30 days, 25);
        assertEq(site.siteRentBps(), 1_000, "and lowered again");
    }

    /// The band is enforced on both sides. The LOWER bound is the structural one: at zero total fee a
    /// continuously-rented position is reversion-immune and never trades again.
    function test_theRentFeeBandIsEnforcedOnBothSides() public {
        vm.prank(siteOwner);
        vm.expectRevert(SlotSite.InvalidConfig.selector);
        site.setRentalTerms(400, 30 days, 25); // 400 + 500 protocol = 900 < 1000 floor

        vm.prank(siteOwner);
        vm.expectRevert(SlotSite.InvalidConfig.selector);
        site.setRentalTerms(3_600, 30 days, 25); // 3600 + 500 = 4100 > 4000 ceiling
    }

    function test_floorPolicyOnlyTightensAfterTheLock() public {
        _claim(alice, HERO_HEADLINE);

        vm.prank(siteOwner);
        site.setFloorPolicy(FLOOR_DELTA_BPS - 500, FLOOR_CHANGE_COOLDOWN + 1 hours, MAX_ASK_BPS - 10_000);

        vm.prank(siteOwner);
        vm.expectRevert(TermsLib.RatchetDirection.selector);
        site.setFloorPolicy(FLOOR_DELTA_BPS, FLOOR_CHANGE_COOLDOWN + 1 hours, MAX_ASK_BPS - 10_000);
    }

    function test_onlyTheSiteOwnerMayChangeTerms() public {
        vm.prank(alice);
        vm.expectRevert();
        site.setEconomics(13_000, PAYOUT_BPS, REVERSION_BPS, MAX_REVERSION_WEEKS, COOLDOWN_SECS);
    }

    /// §11.2 / §1.4 — floors are rejected below `minFloor`, which is derived from the settlement
    /// token's own decimals. A constant tuned for 6 decimals is wrong by 1e12 against an 18-decimal
    /// token, and this contract is frozen.
    function test_dustFloorsAreRejected() public {
        bytes32 key = keccak256("footer.link.1");
        vm.prank(siteOwner);
        vm.expectRevert(SlotSite.InvalidFloor.selector);
        site.registerSlots(_keys(key), _floors(1));

        uint256 legal = site.minFloor(); // hoisted, or it eats the prank and reverts Unauthorized
        vm.prank(siteOwner);
        site.registerSlots(_keys(key), _floors(legal));
    }
}

/// @notice ERC-4907 (§4). Maps to rentals only — never to editor grants, whose lifetime is a take
/// count rather than a timestamp, so `userExpires` for a grant would have to lie.
contract SlotSiteErc4907Test is SlotSiteBase {
    function test_supportsTheInterface() public view {
        assertTrue(site.supportsInterface(0xad092b5c), "declared so integrators gating on it can read");
        assertTrue(site.supportsInterface(0x2a55205a), "ERC-2981 still there");
    }

    function test_userOfAndUserExpiresTrackTheTenancy() public {
        _claim(alice, HERO_HEADLINE);
        assertEq(site.userOf(uint256(HERO_HEADLINE)), address(0), "no tenancy, no user");

        uint256 rate = _fairRatePerDay(HERO_HEADLINE);
        _list(alice, HERO_HEADLINE, rate, 30 days);
        _rent(advertiser, HERO_HEADLINE, 5 days);

        assertEq(site.userOf(uint256(HERO_HEADLINE)), advertiser);
        assertEq(site.userExpires(uint256(HERO_HEADLINE)), block.timestamp + 5 days);
    }

    /// An expired-but-uncleared term reads as absent rather than as a live tenancy a UI would render.
    function test_userOfReadsAbsentOnceTheTermLapses() public {
        _claim(alice, HERO_HEADLINE);
        uint256 rate = _fairRatePerDay(HERO_HEADLINE);
        _list(alice, HERO_HEADLINE, rate, 30 days);
        _rent(advertiser, HERO_HEADLINE, 1 days);

        vm.warp(block.timestamp + 2 days);
        assertEq(site.userOf(uint256(HERO_HEADLINE)), address(0), "lapsed reads as no user");
        assertGt(site.userExpires(uint256(HERO_HEADLINE)), 0, "but the raw expiry is still visible");
    }

    /// A bare `setUser` would create a tenancy bypassing the payment path entirely. It reverts
    /// loudly, and the interface is still declared because the READ path is what integrators consume.
    function test_setUserRevertsBecauseTenancyIsPaidFor() public {
        _claim(alice, HERO_HEADLINE);
        vm.prank(alice);
        vm.expectRevert(SlotSite.TenancyViaRentOnly.selector);
        site.setUser(uint256(HERO_HEADLINE), bob, uint64(block.timestamp + 1 days));
    }
}
