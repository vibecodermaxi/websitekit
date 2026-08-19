// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SlotSiteBase } from "./SlotSiteBase.t.sol";
import { SlotSite } from "../src/SlotSite.sol";

/// @notice Does the fixture stand up at all, on both settlement paths?
contract SlotSiteSmokeTest is SlotSiteBase {
    function test_siteInitializes() public view {
        assertEq(site.takeBps(), TAKE_BPS);
        assertEq(site.reversionBps(), REVERSION_BPS);
        assertEq(site.settlementToken(), USE_TOKEN() ? address(token) : address(0));
        assertEq(site.owner(), siteOwner);
        assertFalse(site.termsLocked(), "no claim yet");
    }

    function test_claimAndTake() public {
        uint256 c = _claim(alice, HERO_HEADLINE);
        assertEq(c, _floor(), "a claim costs the floor");
        assertEq(site.ownerOf(uint256(HERO_HEADLINE)), alice);
        assertTrue(site.termsLocked(), "the first claim closes the free-edit window");
        _assertSolvent();

        vm.warp(block.timestamp + COOLDOWN_SECS);
        uint256 t = _take(bob, HERO_HEADLINE);
        assertEq(t, (_floor() * TAKE_BPS) / 10_000, "a take costs takeBps of the effective floor");
        assertEq(site.ownerOf(uint256(HERO_HEADLINE)), bob);
        _assertSolvent();
    }
}

contract SlotSiteSmokeTokenTest is SlotSiteSmokeTest {
    function USE_TOKEN() internal pure override returns (bool) {
        return true;
    }

    function test_minFloorTracksTokenDecimals() public view {
        // §11.2: derived from the token's own decimals, never an implementation constant. A constant
        // tuned for 6 decimals is wrong by 1e12 against an 18-decimal token.
        assertEq(site.minFloor(), 10 ** (6 - 4), "minFloor tracks 6-decimal units");
    }
}
