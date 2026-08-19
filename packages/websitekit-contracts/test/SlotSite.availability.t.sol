// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { SlotSite } from "../src/SlotSite.sol";
import { SlotSiteBase } from "./SlotSiteBase.t.sol";

/// @notice The publisher's listing toggle (§10.4): `available = false` blocks CLAIMS and nothing
/// else. The property worth this file is the boundary — the flag must never reach into positions
/// people already own, because "unpublish" ends where somebody paid.
contract SlotSiteAvailabilityTest is SlotSiteBase {
    function test_registrationDefaultsToAvailable() public view {
        assertTrue(site.slotOf(HERO_HEADLINE).available, "registered slot should start available");
        assertTrue(site.slotOf(HERO_IMAGE).available);
        assertTrue(site.slotOf(NAV_LINK_1).available);
    }

    function test_unavailableSlotCannotBeClaimed() public {
        vm.prank(siteOwner);
        site.setAvailability(_keys(HERO_HEADLINE), false);

        // Hoisted BEFORE the cheatcodes are armed — an inline read eats the prank.
        (uint256 charged,) = site.quote(HERO_HEADLINE);
        bytes32 terms = site.encumbranceHash(HERO_HEADLINE);

        vm.expectRevert(SlotSite.SlotUnavailable.selector);
        vm.prank(alice);
        site.buy{ value: _pay(alice, charged) }(HERO_HEADLINE, charged, terms, block.timestamp);
    }

    function test_reenablingReopensTheClaim() public {
        vm.prank(siteOwner);
        site.setAvailability(_keys(HERO_HEADLINE), false);
        vm.prank(siteOwner);
        site.setAvailability(_keys(HERO_HEADLINE), true);

        _claim(alice, HERO_HEADLINE);
        assertEq(site.ownerOfOrZero(HERO_HEADLINE), alice);
    }

    /// @notice The boundary. Flipping the flag on an OWNED position must not gate the take: the
    /// toggle is the publisher's listing lever, not a lever over the secondary market.
    function test_takeIgnoresAvailability() public {
        _claim(alice, HERO_HEADLINE);
        vm.prank(siteOwner);
        site.setAvailability(_keys(HERO_HEADLINE), false);

        vm.warp(block.timestamp + COOLDOWN_SECS + 1);
        _take(bob, HERO_HEADLINE);
        assertEq(site.ownerOfOrZero(HERO_HEADLINE), bob);
    }

    /// @notice Same boundary, rental path: an owner lists and rents an unavailable position freely.
    function test_rentalIgnoresAvailability() public {
        _claim(alice, HERO_HEADLINE);
        vm.prank(siteOwner);
        site.setAvailability(_keys(HERO_HEADLINE), false);

        _list(alice, HERO_HEADLINE, _fairRatePerDay(HERO_HEADLINE), uint64(7 days));
        _rent(advertiser, HERO_HEADLINE, uint64(2 days));
        assertEq(site.userOf(uint256(HERO_HEADLINE)), advertiser);
    }

    function test_onlyTheSiteOwnerMayToggle() public {
        bytes32[] memory keys = _keys(HERO_HEADLINE);
        vm.expectRevert();
        vm.prank(alice);
        site.setAvailability(keys, false);
    }

    function test_togglingAnUnregisteredKeyReverts() public {
        bytes32[] memory keys = _keys(keccak256("never.registered"));
        vm.expectRevert(SlotSite.SlotNotRegistered.selector);
        vm.prank(siteOwner);
        site.setAvailability(keys, false);
    }

    function test_batchTogglesEveryKeyAndEmitsPerKey() public {
        bytes32[] memory keys = new bytes32[](2);
        keys[0] = HERO_HEADLINE;
        keys[1] = NAV_LINK_1;

        vm.expectEmit(true, false, false, true, address(site));
        emit SlotSite.AvailabilitySet(HERO_HEADLINE, false);
        vm.expectEmit(true, false, false, true, address(site));
        emit SlotSite.AvailabilitySet(NAV_LINK_1, false);
        vm.prank(siteOwner);
        site.setAvailability(keys, false);

        assertFalse(site.slotOf(HERO_HEADLINE).available);
        assertFalse(site.slotOf(NAV_LINK_1).available);
        assertTrue(site.slotOf(HERO_IMAGE).available, "untouched key must keep its state");
    }

    /// @notice The openRegistration auto-register path runs through `_register`, which defaults the
    /// flag on — so §7.5's open-namespace mode is unaffected by a toggle it never sees.
    function test_openRegistrationAutoRegisterIsBornAvailable() public {
        uint256 floor = site.minFloor() * 2;
        vm.prank(siteOwner);
        site.setOpenRegistration(true, floor);

        bytes32 wild = keccak256("squatted.key");
        bytes32 terms = site.encumbranceHash(wild);
        vm.prank(alice);
        site.buy{ value: _pay(alice, floor) }(wild, floor, terms, block.timestamp);

        assertEq(site.ownerOfOrZero(wild), alice);
        assertTrue(site.slotOf(wild).available);
    }

    /// @notice Legal on a claimed slot, by design — the setter must not race a dashboard batch
    /// against in-flight buyers. It just has no effect while the position is owned.
    function test_togglingAClaimedSlotIsLegalAndInert() public {
        _claim(alice, HERO_HEADLINE);
        vm.prank(siteOwner);
        site.setAvailability(_keys(HERO_HEADLINE), false);
        assertFalse(site.slotOf(HERO_HEADLINE).available);
        assertEq(site.ownerOfOrZero(HERO_HEADLINE), alice, "ownership untouched");
    }
}

/// @notice The same file against 6-decimal token settlement — the flag is settlement-agnostic, and
/// this is the cheap way to prove it stays that way.
contract SlotSiteAvailabilityTokenTest is SlotSiteAvailabilityTest {
    function USE_TOKEN() internal pure override returns (bool) {
        return true;
    }
}
