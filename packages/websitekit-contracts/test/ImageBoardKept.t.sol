// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ImageBoard } from "../src/ImageBoard.sol";
import { ImageBoardStorage } from "../src/ImageBoardStorage.sol";
import { ImageBoardReads } from "./ImageBoardReads.sol";
import { ImageBoardBase } from "./ImageBoardBase.t.sol";

using ImageBoardReads for ImageBoard;

/// @notice Kept squares (2026-10-24, `IMAGE-BOARD-SPEC.md` §4a): a creation price of zero — a zone's,
/// or the board's own outside every zone — is never for sale. Every rule at its boundary: a rectangle
/// touching kept cells from outside and one cell into them, a board priced zero whose priced zones
/// touch, the smallest board that sells anything and the boards that sell nothing.
///
/// Every board here is 30×30 at 10 px.
contract ImageBoardKeptTest is ImageBoardBase {
    uint192 internal constant DEAR = 30_011;
    uint192 internal constant CHEAP = 2_003;

    event ZoneSet(uint256 indexed index, uint16 col, uint16 row, uint16 cols, uint16 rows, uint256 cellPrice);

    function _use(ImageBoard b) internal {
        board = b;
        vm.prank(alice);
        usd.approve(address(board), type(uint256).max);
    }

    function _zone(uint16 col, uint16 row, uint16 cols, uint16 rows, uint192 price)
        internal
        pure
        returns (ImageBoardStorage.Zone memory)
    {
        return ImageBoardStorage.Zone({ col: col, row: row, cols: cols, rows: rows, cellPrice: price });
    }

    /// A priced board keeping (10,10) 5×5.
    function _keepsMiddle() internal view returns (ImageBoardStorage.Config memory cfg) {
        cfg = _config(300, 300, 10);
        cfg.zones = new ImageBoardStorage.Zone[](1);
        cfg.zones[0] = _zone(10, 10, 5, 5, 0);
    }

    /// A board priced zero selling only its bottom-right corner, (20,25) 10×5.
    function _sellsCorner() internal view returns (ImageBoardStorage.Config memory cfg) {
        cfg = _config(300, 300, 10);
        cfg.cellPrice = 0;
        cfg.zones = new ImageBoardStorage.Zone[](1);
        cfg.zones[0] = _zone(20, 25, 10, 5, DEAR);
    }

    function _refused(ImageBoardStorage.Config memory cfg) internal {
        vm.expectRevert(ImageBoardStorage.InvalidConfig.selector);
        collection.createBoardFor(seller, abi.encode(cfg));
    }

    // ---------------------------------------------------------------------
    // A zone priced zero
    // ---------------------------------------------------------------------

    function test_aZeroPricedZoneKeepsItsCells() public {
        _use(_create(_keepsMiddle()));
        assertEq(board.freeCells(), 900 - 25, "a kept cell was counted free");
        assertEq(board.blockError(10, 10, 1, 1), ImageBoardStorage.CellsKept.selector, "its first cell");
        assertEq(board.blockError(14, 14, 1, 1), ImageBoardStorage.CellsKept.selector, "its last cell");
        assertEq(board.blockError(9, 9, 2, 2), ImageBoardStorage.CellsKept.selector, "one cell into it from outside");
        // Touching it from outside, on the right and below: none of these cells is kept.
        assertEq(board.blockError(15, 10, 1, 5), bytes4(0));
        assertEq(board.quote(15, 10, 1, 5), 5 * CELL_PRICE);
        assertEq(board.blockError(10, 15, 5, 1), bytes4(0));
    }

    function test_aBuyOrAQuoteMeetingAKeptCellReverts() public {
        _use(_create(_keepsMiddle()));
        vm.expectRevert(ImageBoardStorage.CellsKept.selector);
        board.quote(9, 9, 2, 2);
        vm.prank(alice);
        vm.expectRevert(ImageBoardStorage.CellsKept.selector);
        board.buyBlocks(bob, _one(9, 9, 2, 2), type(uint256).max, block.timestamp);
        assertEq(board.blockCount(), 0);
    }

    function test_aZeroPricedZoneIsAnnounced() public {
        ImageBoardStorage.Config memory cfg = _keepsMiddle();
        vm.expectEmit(false, false, false, true);
        emit ZoneSet(0, 10, 10, 5, 5, 0);
        _create(cfg);
    }

    // ---------------------------------------------------------------------
    // A board priced zero
    // ---------------------------------------------------------------------

    function test_aBoardPricedZeroSellsOnlyItsZones() public {
        _use(_create(_sellsCorner()));
        assertEq(board.freeCells(), 50);
        assertEq(board.blockError(20, 25, 10, 5), bytes4(0), "the zone exactly");
        assertEq(board.quote(20, 25, 10, 5), 50 * uint256(DEAR));
        assertEq(board.blockError(19, 25, 2, 1), ImageBoardStorage.CellsKept.selector, "one column left of it");
        assertEq(board.blockError(20, 24, 1, 2), ImageBoardStorage.CellsKept.selector, "one row above it");
        assertEq(board.blockError(0, 0, 1, 1), ImageBoardStorage.CellsKept.selector, "far from it");
    }

    function test_aBoardPricedZeroSellsOutItsZones() public {
        _use(_create(_sellsCorner()));
        uint256 total = 50 * uint256(DEAR);
        _buy(alice, bob, 20, 25, 10, 5);
        assertEq(board.freeCells(), 0, "sold out: the zone was all there was");
        assertEq(board.pendingWithdrawals(seller), total - total * PROTOCOL_BPS / 10_000);
    }

    /// Two priced zones side by side cover a rectangle between them: their overlaps add up, so the
    /// rectangle is not kept. One more row is.
    function test_touchingPricedZonesOnABoardPricedZeroSellAcrossBoth() public {
        ImageBoardStorage.Config memory cfg = _config(300, 300, 10);
        cfg.cellPrice = 0;
        cfg.zones = new ImageBoardStorage.Zone[](2);
        cfg.zones[0] = _zone(0, 0, 2, 2, DEAR);
        cfg.zones[1] = _zone(2, 0, 2, 2, CHEAP);
        _use(_create(cfg));
        assertEq(board.freeCells(), 8);
        assertEq(board.blockError(0, 0, 4, 2), bytes4(0));
        assertEq(board.quote(0, 0, 4, 2), 4 * uint256(DEAR) + 4 * uint256(CHEAP));
        assertEq(board.blockError(1, 0, 2, 1), bytes4(0), "one cell of each");
        assertEq(board.blockError(0, 0, 4, 3), ImageBoardStorage.CellsKept.selector, "a row under both");
    }

    // ---------------------------------------------------------------------
    // What a board must sell
    // ---------------------------------------------------------------------

    function test_aBoardWithNothingForSaleIsRefused() public {
        ImageBoardStorage.Config memory cfg = _config(300, 300, 10);
        cfg.cellPrice = 0;
        _refused(cfg);

        cfg.zones = new ImageBoardStorage.Zone[](1);
        cfg.zones[0] = _zone(0, 0, 5, 5, 0);
        _refused(cfg);

        cfg = _config(300, 300, 10);
        cfg.zones = new ImageBoardStorage.Zone[](1);
        cfg.zones[0] = _zone(0, 0, 30, 30, 0);
        _refused(cfg);
    }

    function test_theSmallestBoardThatSellsAnythingIsAccepted() public {
        ImageBoardStorage.Config memory cfg = _config(300, 300, 10);
        cfg.cellPrice = 0;
        cfg.zones = new ImageBoardStorage.Zone[](1);
        cfg.zones[0] = _zone(29, 29, 1, 1, 1);
        _use(_create(cfg));
        assertEq(board.freeCells(), 1);

        cfg = _config(300, 300, 10);
        cfg.zones = new ImageBoardStorage.Zone[](1);
        cfg.zones[0] = _zone(0, 0, 30, 29, 0);
        _use(_create(cfg));
        assertEq(board.freeCells(), 30, "the one row left unkept");
    }

    // ---------------------------------------------------------------------
    // Kept is for good
    // ---------------------------------------------------------------------

    function test_aCutNeverSellsAKeptCell() public {
        _use(_create(_keepsMiddle()));
        vm.prank(seller);
        board.lowerPrices(1);
        assertEq(board.blockError(10, 10, 1, 1), ImageBoardStorage.CellsKept.selector);
        assertEq(board.quote(9, 10, 1, 1), 2, "a priced cell still costs, rounded up");
    }

    /// The kept answer comes before any covered block is asked, so a rectangle over a block in its
    /// cooldown and a kept cell is refused as kept.
    function test_keptIsRefusedBeforeACooldownInTheSameRectangle() public {
        _use(_create(_keepsMiddle()));
        _buy(alice, bob, 8, 10, 2, 1);
        assertEq(board.blockError(8, 10, 2, 1), ImageBoardStorage.CoolingDown.selector, "the block alone");
        assertEq(board.blockError(8, 10, 3, 1), ImageBoardStorage.CellsKept.selector, "the block and a kept cell");
    }

    /// In a buy of several, each rectangle's shape is asked before its cells, rectangle by rectangle.
    function test_inABuyOfSeveralEachRectanglesShapeComesBeforeItsKeptCells() public {
        _use(_create(_keepsMiddle()));
        ImageBoardStorage.Rect[] memory rects = new ImageBoardStorage.Rect[](2);
        rects[0] = ImageBoardStorage.Rect(9, 9, 2, 2);
        rects[1] = ImageBoardStorage.Rect(0, 0, 1, 1);
        assertEq(board.buyError(rects), ImageBoardStorage.CellsKept.selector, "the first is kept");

        rects[0] = ImageBoardStorage.Rect(0, 0, 2, 2);
        rects[1] = ImageBoardStorage.Rect(1, 1, 10, 10);
        assertEq(
            board.buyError(rects), ImageBoardStorage.CellsTaken.selector, "the second overlaps the first, and is kept"
        );

        rects[0] = ImageBoardStorage.Rect(0, 0, 1, 1);
        rects[1] = ImageBoardStorage.Rect(9, 9, 2, 2);
        assertEq(board.buyError(rects), ImageBoardStorage.CellsKept.selector);
        vm.prank(alice);
        vm.expectRevert(ImageBoardStorage.CellsKept.selector);
        board.buyBlocks(bob, rects, type(uint256).max, block.timestamp);
        assertEq(board.blockCount(), 0, "all or nothing");
    }
}
