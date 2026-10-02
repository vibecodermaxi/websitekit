// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SlotSiteBase } from "./SlotSiteBase.t.sol";
import { SlotSite } from "../src/SlotSite.sol";
import { TestUSD } from "../src/mocks/TestUSD.sol";

/// @notice The deployable settlement stand-in, checked as a settlement token rather than as an
/// ERC-20.
///
/// `MockToken` in `SlotSiteBase.t.sol` already covers the token money spine, and this suite does not
/// duplicate it. What it covers is the gap between the two files: `TestUSD` is the one that gets
/// DEPLOYED to a public chain, and every property below is one whose absence would only be
/// discovered by a buyer whose transaction reverted.
///
/// The `minFloor` case is the reason this file exists at all. §11.2 derives it from the token's own
/// `decimals()`, so a stand-in that answered 18 would put every floor in the starter set twelve
/// orders of magnitude out — and `createSite` validates the whole floor array at once and reverts
/// with a selector that names no slot, so the symptom would be a board that will not deploy and no
/// indication of which number is wrong.
contract TestUSDTest is SlotSiteBase {
    TestUSD internal usd;
    SlotSite internal usdSite;

    uint256 internal constant UNIT = 1e6; // one whole test dollar, at 6 decimals
    uint256 internal constant FLOOR = UNIT / 100; // $0.01

    function setUp() public override {
        super.setUp();

        usd = new TestUSD("websitekit Test Dollar", "tUSD", 6);

        SlotSite.SiteConfig memory config = _defaultConfig();
        config.settlementToken = address(usd);

        vm.prank(siteOwner);
        usdSite = SlotSite(payable(factory.createSite(config, _keys(HERO_HEADLINE), _floors(FLOOR))));

        for (uint256 i = 0; i < 2; i++) {
            address who = i == 0 ? alice : bob;
            usd.mint(who, 1_000 * UNIT);
            vm.prank(who);
            usd.approve(address(usdSite), type(uint256).max);
        }
    }

    function test_itAnswersTheDecimalsItWasDeployedWith() public view {
        assertEq(usd.decimals(), 6, "a stand-in that answers 18 misprices every floor by 1e12");
        assertEq(usd.symbol(), "tUSD");
    }

    /// §11.2 — `10 ** (decimals - 4)`. 100 raw units here, against 1e14 on a native board.
    function test_aBoardSettlingInItDerivesMinFloorFromSixDecimals() public view {
        assertEq(usdSite.minFloor(), 100, "minFloor must come from the token, not from 18");
        assertTrue(usdSite.minFloor() != 10 ** 14, "this is the native figure and it is wrong here");
    }

    /// The whole point of deploying it: a stranger with no role can fund themselves and buy.
    function test_anyoneCanMintAndThenClaimASlotWithIt() public {
        address stranger = makeAddr("stranger");
        usd.mint(stranger, 10 * UNIT);
        vm.prank(stranger);
        usd.approve(address(usdSite), type(uint256).max);

        (uint256 charged,) = usdSite.quote(HERO_HEADLINE);
        bytes32 terms = usdSite.encumbranceHash(HERO_HEADLINE);
        uint256 before = usd.balanceOf(stranger);

        vm.prank(stranger);
        usdSite.buy(HERO_HEADLINE, charged, terms, block.timestamp);

        assertEq(usdSite.ownerOf(uint256(HERO_HEADLINE)), stranger, "the buyer owns the slot");
        assertEq(before - usd.balanceOf(stranger), charged, "pulled exactly, no change ledger");
        assertEq(usdSite.pendingWithdrawals(stranger), 0);
    }

    /// A displaced owner is paid in the settlement token, which is the property the platform's
    /// cash-out path depends on. Asserted here because the payout is what a publisher measures.
    function test_aTakeoverPaysTheDisplacedOwnerInTheToken() public {
        (uint256 claimPrice,) = usdSite.quote(HERO_HEADLINE);
        bytes32 claimTerms = usdSite.encumbranceHash(HERO_HEADLINE);
        vm.prank(alice);
        usdSite.buy(HERO_HEADLINE, claimPrice, claimTerms, block.timestamp);

        vm.warp(block.timestamp + COOLDOWN_SECS);

        (, uint256 takePrice) = usdSite.quote(HERO_HEADLINE);
        bytes32 takeTerms = usdSite.encumbranceHash(HERO_HEADLINE);
        vm.prank(bob);
        usdSite.buy(HERO_HEADLINE, takePrice, takeTerms, block.timestamp);

        uint256 owed = usdSite.pendingWithdrawals(alice);
        assertGe(owed, FLOOR, "a displaced owner always receives at least the floor");

        uint256 before = usd.balanceOf(alice);
        usdSite.withdrawFor(alice); // permissionless — this is the relayer's path
        assertEq(usd.balanceOf(alice) - before, owed, "paid in the settlement token");
    }

    /// @dev Not scarcity — an overflow guard. Without it one call can park `totalSupply` where every
    /// later `_mint` reverts, bricking the faucet for everyone at the cost of one transaction.
    function test_theMintCapIsEnforcedAndDerivedFromDecimals() public {
        // Hoisted, and this is not style. `usd.maxMintPerCall()` is an external call, so inside an
        // argument list it is evaluated AFTER `vm.expectRevert` is armed and CONSUMES it — the test
        // then fails with "next call did not revert as expected", which reads like a missing guard
        // in the contract rather than a broken test. It cost this suite one run.
        uint256 cap = usd.maxMintPerCall();
        assertEq(cap, 1_000_000 * UNIT);

        usd.mint(alice, cap); // the boundary itself is allowed

        vm.expectRevert(bytes("TestUSD: over the per-call cap"));
        usd.mint(alice, cap + 1);

        vm.expectRevert(bytes("TestUSD: over the per-call cap"));
        usd.mint(alice, type(uint256).max);
    }

    /// The two contracts are the same shape and must not converge: `MockToken`'s permissionless
    /// `freeze`/`setReturnsNothing` are a test instrument under `vm.prank` and a griefing switch on
    /// a public chain. This asserts the deployed one has neither.
    function test_itCarriesNoneOfTheMockTestHooks() public {
        (bool frozeIt,) = address(usd).call(abi.encodeWithSignature("freeze(address)", alice));
        assertFalse(frozeIt, "TestUSD must not expose MockToken's permissionless freeze");

        (bool setIt,) = address(usd).call(abi.encodeWithSignature("setReturnsNothing(bool)", true));
        assertFalse(setIt, "TestUSD must not expose MockToken's return-shape switch");
    }
}
