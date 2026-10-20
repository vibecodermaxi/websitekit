// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Vm } from "forge-std/Vm.sol";
import { ImageBoard } from "../src/ImageBoard.sol";
import { ImageBoardReads } from "./ImageBoardReads.sol";
import { ImageBoardBase } from "./ImageBoardBase.t.sol";


using ImageBoardReads for ImageBoard;
/// @notice Several rectangles in one buy (`IMAGE-BOARD-SPEC.md` §6, 2026-10-11): all or nothing,
/// each rectangle its own block, each priced and cut as if bought alone, one payment.
///
/// The cell price (10,003) leaves 0.15 of a unit in every cell's 500 bps cut, so seven one-cell
/// blocks cut alone come to 3,500 where one seven-cell block would be 3,501 — the rounding that
/// tells "each block on its own" from "the buy as a whole".
contract ImageBoardMultiBuyTest is ImageBoardBase {
    event BlockBought(
        uint256 indexed blockId,
        address indexed payer,
        address indexed recipient,
        uint16 col,
        uint16 row,
        uint16 cols,
        uint16 rows,
        uint256 total,
        uint256 protocolCut,
        address seller
    );

    function _two(uint16[4] memory a, uint16[4] memory b) internal pure returns (ImageBoard.Rect[] memory rects) {
        rects = new ImageBoard.Rect[](2);
        rects[0] = ImageBoard.Rect({ col: a[0], row: a[1], cols: a[2], rows: a[3] });
        rects[1] = ImageBoard.Rect({ col: b[0], row: b[1], cols: b[2], rows: b[3] });
    }

    function _buyAll(address payer, address recipient, ImageBoard.Rect[] memory rects) internal returns (uint256 firstId) {
        vm.prank(payer);
        firstId = board.buyBlocks(recipient, rects, type(uint256).max, block.timestamp);
    }

    /// Everything a refused buy could have touched, so "nothing happened" is measured, not assumed.
    function _snapshot() internal view returns (bytes32) {
        bytes32 rows;
        for (uint256 r = 0; r < 12; r++) {
            rows = keccak256(abi.encode(rows, board.rowBits(r)));
        }
        return keccak256(
            abi.encode(rows, board.blockCount(), usd.balanceOf(alice), usd.balanceOf(address(board)), board.pendingWithdrawals(seller))
        );
    }

    function _refused(ImageBoard.Rect[] memory rects, bytes4 err) internal {
        bytes32 before = _snapshot();
        vm.prank(alice);
        vm.expectRevert(err);
        board.buyBlocks(alice, rects, type(uint256).max, block.timestamp);
        assertEq(_snapshot(), before, "a refused buy changed something");
    }

    // ---------------------------------------------------------------------
    // Blocks
    // ---------------------------------------------------------------------

    function test_eachRectangleIsItsOwnBlockInTheOrderGiven() public {
        _buy(alice, alice, 20, 20, 1, 1); // block 1, so the buy's ids do not start at 1
        uint256 first = _buyAll(alice, bob, _two([uint16(0), 0, 2, 3], [uint16(5), 1, 4, 1]));
        assertEq(first, 2);
        assertEq(board.blockCount(), 3);
        assertEq(board.ownerOf(2), bob);
        assertEq(board.ownerOf(3), bob);
        ImageBoard.Block memory a = board.blockOf(2);
        ImageBoard.Block memory b = board.blockOf(3);
        assertEq(abi.encode(a.col, a.row, a.cols, a.rows), abi.encode(uint16(0), uint16(0), uint16(2), uint16(3)));
        assertEq(abi.encode(b.col, b.row, b.cols, b.rows), abi.encode(uint16(5), uint16(1), uint16(4), uint16(1)));
    }

    /// An L: two rectangles that touch along an edge are two blocks, both bought.
    function test_rectanglesThatTouchAreBoughtTogether() public {
        _buyAll(alice, alice, _two([uint16(0), 0, 1, 3], [uint16(1), 2, 2, 1]));
        assertEq(board.rowBits(0), 1);
        assertEq(board.rowBits(1), 1);
        assertEq(board.rowBits(2), 7);
    }

    // ---------------------------------------------------------------------
    // All or nothing
    // ---------------------------------------------------------------------

    function test_oneCellInItsCooldownRefusesTheWholeBuy() public {
        _buy(bob, bob, 10, 10, 1, 1);
        _refused(_two([uint16(0), 0, 2, 2], [uint16(9), 9, 2, 2]), ImageBoard.CoolingDown.selector);
    }

    function test_rectanglesSharingOneCellAreRefused() public {
        _refused(_two([uint16(0), 0, 2, 2], [uint16(1), 1, 2, 2]), ImageBoard.CellsTaken.selector);
    }

    function test_theSameRectangleTwiceIsRefused() public {
        _refused(_two([uint16(4), 4, 1, 1], [uint16(4), 4, 1, 1]), ImageBoard.CellsTaken.selector);
    }

    function test_anEmptyOrOutsideRectangleRefusesTheBuy() public {
        _refused(_two([uint16(0), 0, 1, 1], [uint16(3), 3, 0, 1]), ImageBoard.EmptyBlock.selector);
        _refused(_two([uint16(0), 0, 1, 1], [uint16(29), 0, 2, 1]), ImageBoard.OutsideGrid.selector);
    }

    /// The first failing rectangle names the error, in the order given.
    function test_theFirstBadRectangleNamesTheError() public {
        _buy(bob, bob, 10, 10, 1, 1);
        _refused(_two([uint16(10), 10, 1, 1], [uint16(30), 0, 1, 1]), ImageBoard.CoolingDown.selector);
        _refused(_two([uint16(30), 0, 1, 1], [uint16(10), 10, 1, 1]), ImageBoard.OutsideGrid.selector);
    }

    function test_nothingToBuyIsRefused() public {
        _refused(new ImageBoard.Rect[](0), ImageBoard.EmptyBlock.selector);
    }

    function test_theRecipientMustBeNamed() public {
        ImageBoard.Rect[] memory rects = _two([uint16(0), 0, 1, 1], [uint16(2), 0, 1, 1]);
        vm.prank(alice);
        vm.expectRevert(ImageBoard.ZeroAddress.selector);
        board.buyBlocks(address(0), rects, type(uint256).max, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Money
    // ---------------------------------------------------------------------

    function test_onePaymentOfEveryBlocksPrice() public {
        uint256 total = board.quote(0, 0, 2, 3) + board.quote(5, 1, 4, 1);
        uint256 before = usd.balanceOf(alice);
        _buyAll(alice, alice, _two([uint16(0), 0, 2, 3], [uint16(5), 1, 4, 1]));
        assertEq(before - usd.balanceOf(alice), total);
        assertEq(total, 10 * CELL_PRICE);
        assertEq(usd.balanceOf(address(board)), total, "the board holds exactly what it owes");
    }

    /// Seven one-cell blocks: 7 × 500 = 3,500 to the protocol, where one seven-cell block's cut is
    /// 3,501. Each block is cut as if bought alone.
    function test_eachBlockIsCutAsIfBoughtAlone() public {
        ImageBoard.Rect[] memory rects = new ImageBoard.Rect[](7);
        for (uint16 i = 0; i < 7; i++) {
            rects[i] = ImageBoard.Rect({ col: i * 2, row: 0, cols: 1, rows: 1 });
        }
        _buyAll(alice, alice, rects);
        assertEq(board.pendingWithdrawals(protocol), 3_500);
        assertEq(board.pendingWithdrawals(seller), 7 * CELL_PRICE - 3_500);
        assertEq((7 * CELL_PRICE * PROTOCOL_BPS) / 10_000, 3_501, "the case where the two differ");
    }

    function test_eachBlockIsAnnouncedWithItsOwnPriceAndCut() public {
        uint256 one = board.quote(0, 0, 1, 1);
        uint256 three = board.quote(4, 0, 3, 1);
        vm.expectEmit(true, true, true, true);
        emit BlockBought(1, alice, bob, 0, 0, 1, 1, one, (one * PROTOCOL_BPS) / 10_000, seller);
        vm.expectEmit(true, true, true, true);
        emit BlockBought(2, alice, bob, 4, 0, 3, 1, three, (three * PROTOCOL_BPS) / 10_000, seller);
        _buyAll(alice, bob, _two([uint16(0), 0, 1, 1], [uint16(4), 0, 3, 1]));
    }

    /// The board's picture changed once, however many blocks the buy made.
    function test_theCollectionIsToldOnce() public {
        vm.recordLogs();
        _buyAll(alice, alice, _two([uint16(0), 0, 1, 1], [uint16(4), 0, 3, 1]));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 updates;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(collection) && logs[i].topics[0] == keccak256("MetadataUpdate(uint256)")) updates++;
        }
        assertEq(updates, 1);
    }

    // ---------------------------------------------------------------------
    // Permit
    // ---------------------------------------------------------------------

    function test_onePermitPaysForEveryBlock() public {
        vm.prank(alice);
        usd.approve(address(board), 0);
        uint256 total = board.quote(0, 0, 2, 2) + board.quote(8, 8, 3, 1);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(alicePk, address(board), total, deadline);
        ImageBoard.Rect[] memory rects = _two([uint16(0), 0, 2, 2], [uint16(8), 8, 3, 1]);
        vm.prank(alice);
        uint256 first = board.buyBlocksWithPermit(alice, rects, total, deadline, v, r, s);
        assertEq(board.ownerOf(first), alice);
        assertEq(board.ownerOf(first + 1), alice);
        assertEq(usd.allowance(alice, address(board)), 0, "the permit was for exactly the total");
    }

    /// A permit for one block's price does not buy two.
    function test_aPermitForLessThanTheTotalIsRefused() public {
        vm.prank(alice);
        usd.approve(address(board), 0);
        uint256 short_ = board.quote(0, 0, 2, 2);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(alicePk, address(board), short_, deadline);
        ImageBoard.Rect[] memory rects = _two([uint16(0), 0, 2, 2], [uint16(8), 8, 3, 1]);
        vm.prank(alice);
        vm.expectRevert();
        board.buyBlocksWithPermit(alice, rects, short_, deadline, v, r, s);
    }
}
