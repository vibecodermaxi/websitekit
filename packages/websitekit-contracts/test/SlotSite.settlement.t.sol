// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SlotSiteBase } from "./SlotSiteBase.t.sol";
import { SlotSite } from "../src/SlotSite.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice The parts that exist only on the ERC-20 branch (PROTOCOL-SPEC §1.2), plus
/// `sweepTreasury` (§10.4). Everything here is about the money spine, which is the function with the
/// most existing test weight behind it and the one v2 changes most.
contract SlotSiteSettlementTokenTest is SlotSiteBase {
    function USE_TOKEN() internal pure override returns (bool) {
        return true;
    }

    function test_theTokenPathPullsExactlyAndKeepsNoChangeLedger() public {
        uint256 before = token.balanceOf(alice);
        uint256 charged = _claim(alice, HERO_HEADLINE);
        assertEq(before - token.balanceOf(alice), charged, "pulled exactly, no overpay to refund");
        assertEq(site.pendingWithdrawals(alice), 0, "no change ledger entry on the token path");
        _assertSolvent();
    }

    function test_sendingNativeValueToATokenSiteReverts() public {
        (uint256 charged,) = site.quote(HERO_HEADLINE);
        bytes32 terms = site.encumbranceHash(HERO_HEADLINE);
        vm.prank(alice);
        vm.expectRevert(SlotSite.NativeNotAccepted.selector);
        site.buy{ value: 1 ether }(HERO_HEADLINE, charged, terms, block.timestamp);
    }

    /// §1.2 — `treasuryBalance` is denominated in the token, so crediting it with native value would
    /// corrupt the accounting the solvency invariant checks.
    function test_receiveRevertsOnATokenSite() public {
        vm.prank(alice);
        (bool ok,) = address(site).call{ value: 1 ether }("");
        assertFalse(ok, "stray native value is refused rather than mis-booked");
    }

    function test_withdrawalsPayInTheSettlementToken() public {
        _claim(alice, HERO_HEADLINE);
        vm.warp(block.timestamp + COOLDOWN_SECS);
        _take(bob, HERO_HEADLINE);

        uint256 owed = site.pendingWithdrawals(alice);
        assertGt(owed, 0, "alice was displaced and is owed her payout");
        uint256 before = token.balanceOf(alice);

        vm.prank(keeper); // permissionless, always pays the address that is OWED
        site.withdrawFor(alice);
        assertEq(token.balanceOf(alice) - before, owed);
        assertEq(site.pendingWithdrawals(alice), 0);
        _assertSolvent();
    }

    /// §1.2 — `SafeERC20` exists to absorb tokens whose `transfer` returns nothing. USDT is the
    /// famous one; the settlement address is per-site config and chain-portable (§11), so the
    /// tolerant path is the only one safe to freeze.
    function test_aTokenThatReturnsNothingFromTransferStillWorks() public {
        _claim(alice, HERO_HEADLINE);
        vm.warp(block.timestamp + COOLDOWN_SECS);
        _take(bob, HERO_HEADLINE);

        token.setReturnsNothing(true);
        uint256 owed = site.pendingWithdrawals(alice);
        vm.prank(keeper);
        site.withdrawFor(alice);
        assertEq(site.pendingWithdrawals(alice), 0, "SafeERC20 tolerated the missing boolean");
        assertGt(owed, 0);
    }

    /// §1.5 Finding 5 — the issuer can freeze an address. A frozen PAYEE cannot be paid, so their
    /// balance waits in the pull ledger rather than being lost. Funds are delayed, never destroyed,
    /// and this is why conservation is a test-only invariant and never asserted on-chain.
    function test_aFrozenPayeeIsDelayedNotRobbed() public {
        _claim(alice, HERO_HEADLINE);
        vm.warp(block.timestamp + COOLDOWN_SECS);
        _take(bob, HERO_HEADLINE);

        uint256 owed = site.pendingWithdrawals(alice);
        token.freeze(alice);

        vm.prank(keeper);
        vm.expectRevert();
        site.withdrawFor(alice);
        assertEq(site.pendingWithdrawals(alice), owed, "still owed, still recorded");

        token.freeze(address(0));
        vm.prank(keeper);
        site.withdrawFor(alice);
        assertEq(site.pendingWithdrawals(alice), 0, "paid once unfrozen");
    }

    // -----------------------------------------------------------------
    // sweepTreasury (§10.4)
    // -----------------------------------------------------------------

    /// The inconsistency this fixes: position-holder payouts were already permissionless via
    /// `withdrawFor`, but publisher revenue required the publisher to sign. For a product whose
    /// central pitch is publisher revenue that is backwards.
    function test_sweepTreasuryIsPermissionlessAndAlwaysPaysTheTreasury() public {
        _claim(alice, HERO_HEADLINE);
        uint256 accrued = site.treasuryBalance();
        assertGt(accrued, 0);

        uint256 before = token.balanceOf(siteTreasury);
        vm.prank(keeper); // a stranger, e.g. our scheduled payout relayer
        site.sweepTreasury();

        assertEq(token.balanceOf(siteTreasury) - before, accrued, "paid the treasury, never the caller");
        assertEq(token.balanceOf(keeper), 1_000_000e6, "the caller got nothing but a gas bill");
        assertEq(site.treasuryBalance(), 0);
        _assertSolvent();
    }

    function test_sweepTreasuryRevertsWhenThereIsNothingToSweep() public {
        vm.prank(keeper);
        vm.expectRevert(SlotSite.NothingToWithdraw.selector);
        site.sweepTreasury();
    }

    /// A full sweep rather than a caller-chosen amount, so nobody can grief with dust transfers.
    function test_sweepTakesTheWholeBalance() public {
        _claim(alice, HERO_HEADLINE);
        _claim(bob, NAV_LINK_1);
        uint256 total = site.treasuryBalance();
        vm.prank(keeper);
        site.sweepTreasury();
        assertEq(site.treasuryBalance(), 0, "no remainder left for a second call");
        assertGt(total, 0);
    }

    function test_ownerCanStillWithdrawPartially() public {
        _claim(alice, HERO_HEADLINE);
        uint256 total = site.treasuryBalance();
        vm.prank(siteOwner);
        site.withdrawTreasury(total / 2);
        assertEq(site.treasuryBalance(), total - total / 2, "partial control retained for owners who want it");
        _assertSolvent();
    }
}

/// @notice The native path keeps v1's change-crediting behaviour, which the token path does not need.
contract SlotSiteSettlementNativeTest is SlotSiteBase {
    function test_overpaymentCreditsThePayerNotTheRecipient() public {
        (uint256 charged,) = site.quote(HERO_HEADLINE);
        bytes32 terms = site.encumbranceHash(HERO_HEADLINE);

        // A relayer forwarding a user's funds must be able to forward the remainder back, so change
        // credits `msg.sender` and never the recipient.
        vm.prank(carol);
        site.buyFor{ value: charged + 1 ether }(bob, HERO_HEADLINE, charged, terms, block.timestamp);

        assertEq(site.ownerOf(uint256(HERO_HEADLINE)), bob, "recipient owns it");
        assertEq(site.pendingWithdrawals(carol), 1 ether, "payer is credited the change");
        assertEq(site.pendingWithdrawals(bob), 0, "recipient is not gifted the remainder");
        _assertSolvent();
    }

    function test_strayNativeValueAccruesToTheTreasuryOnANativeSite() public {
        uint256 before = site.treasuryBalance();
        vm.prank(alice);
        (bool ok,) = address(site).call{ value: 1 ether }("");
        assertTrue(ok, "a misdirected send is recoverable rather than a support ticket");
        assertEq(site.treasuryBalance(), before + 1 ether);
    }

    function test_sweepTreasuryPaysNative() public {
        _claim(alice, HERO_HEADLINE);
        uint256 accrued = site.treasuryBalance();
        uint256 before = siteTreasury.balance;
        vm.prank(keeper);
        site.sweepTreasury();
        assertEq(siteTreasury.balance - before, accrued);
        _assertSolvent();
    }
}
