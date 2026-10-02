// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { SlotSite } from "../src/SlotSite.sol";
import { SlotSiteBase } from "./SlotSiteBase.t.sol";

/// @notice Stands in for the Escrow contract: a plain payable sink, because the whole point of the
/// pin is that `treasury` may be a CONTRACT that routes on the publisher's behalf, and the native
/// path pays with `.call{value:}` — an address that cannot receive would brick the money spine on a
/// board nobody can repoint.
contract PayableSink {
    receive() external payable { }
}

/// @notice A sink that refuses native value, so the "pinned to something that cannot be paid" state
/// is a measured fact rather than an assumption.
contract RefusingSink { }

/// @notice `SiteConfig.pinTreasury` — frozen at `initialize`.
///
/// It exists so an external contract can hold a site's revenue: the pin is the only thing such a
/// contract needs from bytecode, and this file ships publicly, so it carries the argument rather
/// than a pointer to where the argument is kept.
///
/// The property is narrow and the reason is not: `treasury` is the ONLY address a publisher's cut
/// can reach, `sweepTreasury()` is already permissionless and always pays it, so an external
/// contract can hold that money the moment — and only the moment — the publisher can no longer
/// repoint the pipe. `setTreasury` is `onlyOwner` with no lock, no ratchet and no timelock, which
/// hands the switch to the party being guarded against.
///
/// What must stay true and is asserted here: the pin changes WHO MAY CHANGE the destination and
/// nothing else. The split is untouched, the protocol cut is untouched, a displaced owner is still
/// paid instantly, and both doors out still pay `treasury`.
abstract contract SlotSiteTreasuryPinBase is SlotSiteBase {
    SlotSite internal pinned;
    address internal pipe;

    function setUp() public virtual override {
        super.setUp();
        pipe = address(new PayableSink());
        pinned = _pinnedSite(pipe);
    }

    /// @dev Built through the FACTORY like every other fixture in this tree — the clone path is the
    /// only path production has, and `pinTreasury` is storage-set-once config on exactly that path.
    function _pinnedSite(address treasury_) internal returns (SlotSite s) {
        SlotSite.SiteConfig memory cfg = _defaultConfig();
        cfg.treasury = treasury_;
        cfg.pinTreasury = true;
        (bytes32[] memory keys, uint256[] memory floors) = _defaultSlots();
        vm.prank(siteOwner);
        s = SlotSite(payable(factory.createSite(cfg, keys, floors)));

        address[6] memory funded = [alice, bob, carol, advertiser, keeper, siteOwner];
        for (uint256 i = 0; i < funded.length; i++) {
            vm.prank(funded[i]);
            token.approve(address(s), type(uint256).max);
        }
    }

    function _claimOn(SlotSite s, address buyer, bytes32 key) internal returns (uint256 charged) {
        (charged,) = s.quote(key);
        bytes32 terms = s.encumbranceHash(key);
        vm.prank(buyer);
        s.buy{ value: _pay(buyer, charged) }(key, charged, terms, block.timestamp);
    }

    function _takeOn(SlotSite s, address buyer, bytes32 key) internal returns (uint256 charged) {
        (, charged) = s.quote(key);
        bytes32 terms = s.encumbranceHash(key);
        vm.prank(buyer);
        s.buy{ value: _pay(buyer, charged) }(key, charged, terms, block.timestamp);
    }

    function _held(address who) internal view returns (uint256) {
        return USE_TOKEN() ? token.balanceOf(who) : who.balance;
    }

    // -----------------------------------------------------------------
    // The default is OFF, and that is what makes this generation safe to ship
    // -----------------------------------------------------------------

    /// A board created the way every board is created today must behave exactly as it does today.
    /// `pinTreasury: false` is the whole of the backwards compatibility argument, so it is asserted
    /// rather than assumed.
    function test_boardsAreUnpinnedByDefaultAndSetTreasuryStillWorks() public {
        assertFalse(site.treasuryPinned(), "default config must not pin");

        vm.prank(siteOwner);
        site.setTreasury(carol);
        assertEq(site.treasury(), carol, "an unpinned board is still repointable");
    }

    // -----------------------------------------------------------------
    // The pin
    // -----------------------------------------------------------------

    function test_aPinnedBoardReportsItAndRefusesSetTreasury() public {
        assertTrue(pinned.treasuryPinned());
        assertEq(pinned.treasury(), pipe);

        vm.expectRevert(SlotSite.TreasuryPinned.selector);
        vm.prank(siteOwner);
        pinned.setTreasury(carol);

        assertEq(pinned.treasury(), pipe, "still pointing at the pipe");
    }

    /// The refusal is about the PIN, not about authority — the owner is exactly the party it binds,
    /// so `onlyOwner` passing and the pin then refusing is the whole mechanism. A stranger is still
    /// refused for the ordinary reason, which is what stops this reading as a weakened access check.
    function test_aStrangerIsStillRefusedForTheOrdinaryReason() public {
        vm.expectRevert(); // Ownable.Unauthorized
        vm.prank(alice);
        pinned.setTreasury(alice);
    }

    /// The zero-treasury guard runs BEFORE anything can be pinned, so a board pinned at the zero
    /// address — unrecoverable, since nothing could ever repoint it — cannot be created at all.
    function test_aBoardCannotBePinnedAtTheZeroAddress() public {
        SlotSite.SiteConfig memory cfg = _defaultConfig();
        cfg.treasury = address(0);
        cfg.pinTreasury = true;
        (bytes32[] memory keys, uint256[] memory floors) = _defaultSlots();

        vm.expectRevert(SlotSite.ZeroAddress.selector);
        vm.prank(siteOwner);
        factory.createSite(cfg, keys, floors);
    }

    // -----------------------------------------------------------------
    // Handover — the trap the pin has to survive rather than inherit
    // -----------------------------------------------------------------

    /// `treasury` does not follow ownership (measured by `prove-ownership.ts`), so after a handover
    /// a board's revenue keeps routing to the publisher who LEFT until the new owner calls
    /// `setTreasury`. On a pinned board that call does not exist, so the pin must survive the
    /// handover intact and the routing question moves to whatever holds the pipe.
    function test_thePinSurvivesTheTwoStepHandover() public {
        vm.prank(carol);
        pinned.requestOwnershipHandover();
        vm.prank(siteOwner);
        pinned.completeOwnershipHandover(carol);
        assertEq(pinned.owner(), carol, "board changed hands");

        assertTrue(pinned.treasuryPinned(), "the pin is not an owner's setting");
        vm.expectRevert(SlotSite.TreasuryPinned.selector);
        vm.prank(carol);
        pinned.setTreasury(carol);
    }

    /// Both handover paths are in frozen bytecode, so both are pinned here. Single-step is the one
    /// the platform never surfaces and the one a script could still reach.
    function test_thePinSurvivesSingleStepTransferOwnership() public {
        vm.prank(siteOwner);
        pinned.transferOwnership(carol);

        vm.expectRevert(SlotSite.TreasuryPinned.selector);
        vm.prank(carol);
        pinned.setTreasury(carol);
    }

    // -----------------------------------------------------------------
    // The pipe still flows — the pin must not become a way to strand money
    // -----------------------------------------------------------------

    function test_sweepTreasuryStillPaysThePinnedAddress() public {
        _claimOn(pinned, alice, HERO_HEADLINE);
        uint256 accrued = pinned.treasuryBalance();
        assertGt(accrued, 0);

        uint256 before = _held(pipe);
        vm.prank(keeper); // permissionless, exactly as today
        pinned.sweepTreasury();

        assertEq(_held(pipe) - before, accrued, "the publisher's cut reached the pipe");
        assertEq(pinned.treasuryBalance(), 0);
    }

    function test_withdrawTreasuryStillPaysThePinnedAddressAndNotTheOwner() public {
        _claimOn(pinned, alice, HERO_HEADLINE);
        uint256 accrued = pinned.treasuryBalance();

        uint256 ownerBefore = _held(siteOwner);
        uint256 pipeBefore = _held(pipe);
        vm.prank(siteOwner);
        pinned.withdrawTreasury(accrued);

        assertEq(_held(pipe) - pipeBefore, accrued, "owner's own withdraw still lands in the pipe");
        assertEq(_held(siteOwner), ownerBefore, "there is no second door");
    }

    /// The escrow design's §5 table, asserted: only the publisher's cut is routable. The protocol's
    /// cut and a displaced owner's payout go to their own pull-ledger balances and are reachable
    /// whatever the pipe does — which is what lets escrow delay the publisher and nobody else.
    function test_onlyThePublishersCutRoutesThroughTheTreasury() public {
        _claimOn(pinned, alice, HERO_HEADLINE);
        vm.warp(block.timestamp + COOLDOWN_SECS + 1);
        uint256 takePrice = _takeOn(pinned, bob, HERO_HEADLINE);

        assertGt(pinned.pendingWithdrawals(protocolTreasury), 0, "protocol cut is never routed");
        uint256 displaced = pinned.pendingWithdrawals(alice);
        assertGt(displaced, 0, "the displaced owner is credited, not escrowed");

        // The guarantee that survives every input: a displaced owner receives at least the floor.
        assertGe(displaced, _floor(), "displaced owner is made whole at the floor");
        assertGt(takePrice, 0);

        uint256 before = _held(alice);
        vm.prank(keeper);
        pinned.withdrawFor(alice);
        assertEq(_held(alice) - before, displaced, "paid instantly, through a door the pin cannot close");
    }

    /// ERC-2981 quotes `treasury` as the royalty receiver, so pinning the payout pipe pins the
    /// royalty receiver with it. A marketplace paying a royalty pays whatever holds the pipe, and it
    /// arrives as a bare transfer that `treasuryBalance` never counted — so a contract on the other
    /// end has to be able to account for value it did not receive through `sweepTreasury`.
    function test_pinningTheTreasuryAlsoPinsTheRoyaltyReceiver() public view {
        (address receiver,) = pinned.royaltyInfo(uint256(HERO_HEADLINE), 1000);
        assertEq(receiver, pipe, "royalties are quoted to the pinned address, not to the owner");
    }
}

contract SlotSiteTreasuryPinTokenTest is SlotSiteTreasuryPinBase {
    function USE_TOKEN() internal pure override returns (bool) {
        return true;
    }
}

contract SlotSiteTreasuryPinNativeTest is SlotSiteTreasuryPinBase {
    /// Native-only, because it is `_pay`'s `.call{value:}` branch that can fail: a board pinned to
    /// an address that cannot accept native value can never pay its publisher and can never be
    /// repointed. The token branch has no equivalent — `safeTransfer` reaches any address.
    function test_aPinnedBoardCanBeStrandedByPinningToARefusingContract() public {
        SlotSite stranded = _pinnedSite(address(new RefusingSink()));
        _claimOn(stranded, alice, HERO_HEADLINE);
        assertGt(stranded.treasuryBalance(), 0);

        vm.expectRevert(SlotSite.TransferFailed.selector);
        vm.prank(keeper);
        stranded.sweepTreasury();

        vm.expectRevert(SlotSite.TreasuryPinned.selector);
        vm.prank(siteOwner);
        stranded.setTreasury(siteOwner);
    }
}
