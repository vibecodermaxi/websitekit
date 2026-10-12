// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ImageBoard } from "../src/ImageBoard.sol";
import { ImageBoardBase } from "./ImageBoardBase.t.sol";

/// @notice Lowering the price of unsold squares (`IMAGE-BOARD-SPEC.md` §2a, 2026-10-11): the board
/// NFT's holder alone, only ever down, every price on the board alike, a block's whole price scaled
/// and rounded up.
///
/// The cell price (10,003) is odd, so half of it is not a whole unit: a block of one cell at 5,000
/// bps is 5,001.5 and must charge 5,002; a block of two is exactly 10,003, where cutting each cell
/// and adding would charge 10,004.
contract ImageBoardPriceCutTest is ImageBoardBase {
    event PricesLowered(address indexed holder, uint256 priceBps);

    function _lower(address by, uint256 bps) internal {
        vm.prank(by);
        board.lowerPrices(bps);
    }

    // ---------------------------------------------------------------------
    // Who
    // ---------------------------------------------------------------------

    function test_aBoardStartsAtFullPrice() public view {
        assertEq(board.priceBps(), 10_000);
        assertEq(board.quote(0, 0, 3, 1), 3 * CELL_PRICE);
    }

    function test_theBoardsHolderLowersPrices() public {
        vm.expectEmit(true, false, false, true);
        emit PricesLowered(seller, 8_000);
        _lower(seller, 8_000);
        assertEq(board.priceBps(), 8_000);
    }

    function test_nobodyElseLowersPrices() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        vm.prank(alice); // owns a block, not the board
        vm.expectRevert(ImageBoard.NotBoardHolder.selector);
        board.lowerPrices(5_000);
        vm.prank(bob);
        vm.expectRevert(ImageBoard.NotBoardHolder.selector);
        board.lowerPrices(5_000);
        assertEq(board.ownerOf(id), alice);
        assertEq(board.priceBps(), 10_000);
    }

    /// The power follows the board's NFT: the old holder loses it the moment it moves.
    function test_thePowerFollowsTheBoardsNft() public {
        uint256 token = board.boardTokenId();
        vm.prank(seller);
        collection.transferFrom(seller, bob, token);

        vm.prank(seller);
        vm.expectRevert(ImageBoard.NotBoardHolder.selector);
        board.lowerPrices(5_000);

        _lower(bob, 5_000);
        assertEq(board.priceBps(), 5_000);
    }

    // ---------------------------------------------------------------------
    // Only down
    // ---------------------------------------------------------------------

    function test_onlyEverDown() public {
        _lower(seller, 7_000);

        vm.prank(seller);
        vm.expectRevert(ImageBoard.InvalidPrice.selector);
        board.lowerPrices(7_000); // the same

        vm.prank(seller);
        vm.expectRevert(ImageBoard.InvalidPrice.selector);
        board.lowerPrices(7_001); // one up

        _lower(seller, 6_999); // one down
        assertEq(board.priceBps(), 6_999);
    }

    function test_fullPriceIsNotACut() public {
        vm.prank(seller);
        vm.expectRevert(ImageBoard.InvalidPrice.selector);
        board.lowerPrices(10_000);
    }

    function test_zeroIsRefusedAndOneIsTheFloor() public {
        vm.prank(seller);
        vm.expectRevert(ImageBoard.InvalidPrice.selector);
        board.lowerPrices(0);
        _lower(seller, 1);
        assertEq(board.priceBps(), 1);
    }

    // ---------------------------------------------------------------------
    // What a block costs after a cut
    // ---------------------------------------------------------------------

    function test_aBlocksPriceIsScaledAndRoundedUp() public {
        _lower(seller, 5_000);
        assertEq(board.quote(0, 0, 1, 1), 5_002, "5,001.5 rounds up");
        assertEq(board.quote(0, 0, 2, 1), 10_003, "the whole block is scaled, not each cell");
    }

    /// The smallest share on the smallest price is still a unit: no cut makes a square free.
    function test_noCutMakesASquareFree() public {
        ImageBoard.Config memory cfg = _config(300, 300, 10);
        cfg.cellPrice = 1;
        board = _create(cfg);
        _lower(seller, 1);
        assertEq(board.quote(0, 0, 1, 1), 1);
        assertEq(board.quote(0, 0, 0, 1), 0, "an empty rectangle is still nothing");
    }

    function test_zonesAreScaledAlike() public {
        ImageBoard.Config memory cfg = _config(300, 300, 10);
        cfg.zones = new ImageBoard.Zone[](1);
        cfg.zones[0] = ImageBoard.Zone({ col: 0, row: 0, cols: 2, rows: 2, cellPrice: 30_011 });
        board = _create(cfg);
        _lower(seller, 2_500);
        // One zone cell and one plain cell: (30,011 + 10,003) / 4 = 10,003.5 → 10,004.
        assertEq(board.quote(1, 0, 2, 1), 10_004);
    }

    function test_aBuyAfterACutChargesAndCreditsTheCutPrice() public {
        _lower(seller, 5_000);
        uint256 before = usd.balanceOf(alice);
        _buy(alice, alice, 0, 0, 1, 1);
        assertEq(before - usd.balanceOf(alice), 5_002);
        assertEq(board.pendingWithdrawals(protocol), 250, "500 bps of 5,002, rounded down");
        assertEq(board.pendingWithdrawals(seller), 4_752);
    }

    /// A buyer who signed at the old price still buys, and pays the new one: the permit was for the
    /// most they would pay, and the cut only made the buy cheaper.
    function test_aCutBetweenSigningAndBuyingChargesTheNewPrice() public {
        vm.prank(alice);
        usd.approve(address(board), 0);
        uint256 shown = board.quote(0, 0, 2, 2);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(alicePk, address(board), shown, deadline);

        _lower(seller, 6_000);
        uint256 now_ = board.quote(0, 0, 2, 2);
        ImageBoard.Rect[] memory rects = _one(0, 0, 2, 2);
        uint256 before = usd.balanceOf(alice);
        vm.prank(alice);
        board.buyBlocksWithPermit(alice, rects, shown, deadline, v, r, s);

        assertEq(before - usd.balanceOf(alice), now_);
        assertLt(now_, shown);
        assertEq(usd.allowance(alice, address(board)), shown - now_, "what the cut saved stays the buyer's allowance");
    }

    /// Blocks already sold keep what their owners ask: a cut is about unsold squares only.
    function test_aCutDoesNotTouchListings() public {
        uint256 id = _buy(alice, alice, 0, 0, 2, 2);
        vm.prank(alice);
        board.listBlock(id, 77_777);
        _lower(seller, 1_000);
        assertEq(board.listPrice(id), 77_777);
        vm.prank(bob);
        board.buyListedBlock(id, bob, 77_777);
        assertEq(board.ownerOf(id), bob);
    }
}
