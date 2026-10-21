// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Vm } from "forge-std/Vm.sol";
import { stdStorage, StdStorage } from "forge-std/StdStorage.sol";
import { ImageBoard } from "../src/ImageBoard.sol";
import { ImageBoardStorage } from "../src/ImageBoardStorage.sol";
import { ImageBoardReads } from "./ImageBoardReads.sol";
import { TermsLib } from "../src/TermsLib.sol";
import { ImageBoardBase } from "./ImageBoardBase.t.sol";


using ImageBoardReads for ImageBoard;
/// @notice Takeovers (`IMAGE-BOARD-SPEC.md` §11, 2026-10-14): any cell may be bought, sold or not,
/// except one still in its cooldown. Each rule at its boundary, the money to the unit, and the gas
/// the caps are set from, measured cold.
///
/// The base board is *Standard* terms (take 1.4×, payout 1.15×, 3% a week over 52, an hour's
/// cooldown) at 10,003 a cell, so no figure below divides evenly.
contract ImageBoardTakeoversTest is ImageBoardBase {
    using stdStorage for StdStorage;

    uint256 internal constant HOUR = 3_600;

    function _use(ImageBoard b) internal {
        board = b;
        address[2] memory buyers = [alice, bob];
        for (uint256 i = 0; i < buyers.length; i++) {
            vm.prank(buyers[i]);
            usd.approve(address(board), type(uint256).max);
        }
    }

    function _rects(uint16[4][] memory r) internal pure returns (ImageBoardStorage.Rect[] memory rects) {
        rects = new ImageBoardStorage.Rect[](r.length);
        for (uint256 i = 0; i < r.length; i++) {
            rects[i] = ImageBoardStorage.Rect({ col: r[i][0], row: r[i][1], cols: r[i][2], rows: r[i][3] });
        }
    }

    // ---------------------------------------------------------------------
    // One take, to the unit
    // ---------------------------------------------------------------------

    /// A one-cell block bought at its creation price and taken an hour later, inside its first week:
    /// the floor is 10,003, charged 1.4× (14,004.2 → 14,004), the owner credited 1.15× (11,503.45 →
    /// 11,503), the protocol 5% (500.15 → 500), the board's holder the rest (2,001).
    function test_aTakeChargesTheFloorTimesTakeAndPaysTheOwnerTheFloorTimesPayout() public {
        uint256 first = _buy(alice, alice, 0, 0, 1, 1);
        vm.warp(block.timestamp + HOUR);
        uint256 paid = usd.balanceOf(bob);

        vm.expectEmit(true, true, true, true);
        emit ImageBoardStorage.CellsLost(first, 2, alice, 1, 11_503);
        uint256 id = _buy(bob, bob, 0, 0, 1, 1);

        assertEq(paid - usd.balanceOf(bob), 14_004, "charged");
        assertEq(board.pendingWithdrawals(alice), 11_503, "the displaced owner");
        assertEq(board.pendingWithdrawals(protocol), 500 + 500, "both sales' cuts");
        assertEq(board.pendingWithdrawals(seller), 9_503 + 2_001, "the first sale and the take's rest");
        assertEq(usd.balanceOf(address(board)), 10_003 + 14_004, "the board holds exactly what it owes");

        assertEq(board.ownerOf(first), alice, "a take moves no block");
        assertEq(board.blockOf(first).cellsLeft, 0);
        assertEq(board.blockOf(id).cellsLeft, 1);
        // 14,004 × 10,000 / 10,003 = 13,999.8… → up.
        assertEq(board.blockOf(id).level, 14_000);
        assertEq(board.blockOf(id).boughtAt, block.timestamp);
        assertEq(board.cellRow(0)[0], id, "the cell is the new block's");
    }

    /// The level reverts once per whole week, truncating each time, as a page slot's does: 14,000 →
    /// 13,580 → 13,172 (13,172.6 truncated). One second short of the second week is still one.
    function test_theLevelRevertsWeeklyTowardTheCreationPrice() public {
        _buy(alice, alice, 0, 0, 1, 1);
        vm.warp(block.timestamp + HOUR);
        _buy(bob, bob, 0, 0, 1, 1); // level 14,000
        uint256 bought = block.timestamp;

        vm.warp(bought + 2 weeks - 1);
        assertEq(board.quote(0, 0, 1, 1), 19_017, "one week: 10,003 x 13,580 x 1.4");
        vm.warp(bought + 2 weeks);
        assertEq(board.quote(0, 0, 1, 1), 18_446, "two weeks: 10,003 x 13,172 x 1.4");
    }

    /// However long it sits, a sold cell's floor is its creation price: reversion stops at 10,000.
    function test_theFloorNeverFallsBelowTheCreationPrice() public {
        _buy(alice, alice, 0, 0, 1, 1);
        vm.warp(block.timestamp + HOUR);
        _buy(bob, bob, 0, 0, 1, 1);
        vm.warp(block.timestamp + 104 weeks);
        assertEq(board.quote(0, 0, 1, 1), 14_004);
    }

    /// A rectangle over two blocks and two free cells: each part priced on its own, the free part as
    /// a first sale, one `CellsLost` per block, and the new block's level the whole over its base.
    function test_aTakeAcrossTwoBlocksAndFreeCells() public {
        uint256 a = _buy(alice, alice, 0, 0, 2, 1); // cells 0, 1
        uint256 b = _buy(bob, bob, 3, 0, 1, 1); // cell 3
        vm.warp(block.timestamp + HOUR);
        address carol = makeAddr("carol");
        usd.mint(carol, 1e12);
        vm.prank(carol);
        usd.approve(address(board), type(uint256).max);
        uint256 holderBefore = board.pendingWithdrawals(seller);
        uint256 protocolBefore = board.pendingWithdrawals(protocol);

        // Free 20,006; alice's part 20,006 → charged 28,008, paid 23,006; bob's 10,003 → 14,004, 11,503.
        assertEq(board.quote(0, 0, 5, 1), 20_006 + 28_008 + 14_004);
        vm.expectEmit(true, true, true, true);
        emit ImageBoardStorage.CellsLost(a, 3, alice, 2, 23_006);
        vm.expectEmit(true, true, true, true);
        emit ImageBoardStorage.CellsLost(b, 3, bob, 1, 11_503);
        uint256 id = _buy(carol, carol, 0, 0, 5, 1);

        assertEq(board.pendingWithdrawals(alice), 23_006);
        assertEq(board.pendingWithdrawals(bob), 11_503);
        assertEq(board.pendingWithdrawals(protocol) - protocolBefore, 1_000 + 1_000 + 500);
        assertEq(board.pendingWithdrawals(seller) - holderBefore, 62_018 - 2_500 - 34_509);
        // 62,018 × 10,000 / 50,015 = 12,399.88 → up.
        assertEq(board.blockOf(id).level, 12_400);
        assertEq(board.freeCells(), 30 * 67 - 5);
    }

    /// A block met in two runs of one rectangle (split by a later block) is tallied once.
    function test_aBlockMetTwiceInOneRectangleLosesItsCellsOnce() public {
        uint256 a = _buy(alice, alice, 0, 0, 3, 2);
        vm.warp(block.timestamp + HOUR);
        _buy(bob, bob, 1, 0, 1, 1); // row 0 now reads a, b, a
        vm.warp(block.timestamp + HOUR);

        vm.recordLogs();
        _buy(bob, bob, 0, 0, 3, 2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 lostByA;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == ImageBoardStorage.CellsLost.selector && uint256(logs[i].topics[1]) == a) {
                lostByA++;
                (uint256 cells,) = abi.decode(logs[i].data, (uint256, uint256));
                assertEq(cells, 5);
            }
        }
        assertEq(lostByA, 1);
        assertEq(board.blockOf(a).cellsLeft, 0);
    }

    // ---------------------------------------------------------------------
    // Cooldown, a creator's own block, listings
    // ---------------------------------------------------------------------

    function test_aCellCannotBeTakenInsideItsCooldown() public {
        _buy(alice, alice, 0, 0, 1, 1);
        vm.warp(block.timestamp + HOUR - 1);
        assertEq(board.blockError(0, 0, 1, 1), ImageBoardStorage.CoolingDown.selector);
        vm.warp(block.timestamp + 1);
        assertEq(board.blockError(0, 0, 1, 1), bytes4(0));
    }

    /// Kept squares are gone (2026-10-21): a creator's own spot is bought like anyone's, and taken
    /// like anyone's once its cooldown is over — whether or not they also hold the board's NFT.
    function test_theCreatorsOwnBlockIsTakenLikeAnyOther() public {
        usd.mint(seller, 1e12);
        vm.prank(seller);
        usd.approve(address(board), type(uint256).max);
        _buy(seller, seller, 0, 0, 2, 2);
        vm.warp(block.timestamp + HOUR);
        assertEq(board.blockError(1, 1, 2, 2), bytes4(0));
        _buy(alice, alice, 1, 1, 2, 2);
        assertEq(board.blockOf(1).cellsLeft, 3);
    }

    function test_aTakeEndsTheListingOfEveryBlockItTouches() public {
        uint256 a = _buy(alice, alice, 0, 0, 2, 1);
        vm.prank(alice);
        board.listBlock(a, 1_000_000);
        vm.warp(block.timestamp + HOUR);

        vm.expectEmit(true, true, false, false);
        emit ImageBoardStorage.BlockDelisted(a, alice);
        _buy(bob, bob, 1, 0, 1, 1);
        assertEq(board.listPrice(a), 0);
        vm.prank(bob);
        vm.expectRevert(ImageBoardStorage.NotListed.selector);
        board.buyListedBlock(a, bob, 1_000_000);

        vm.prank(alice);
        board.listBlock(a, 1_000_000); // a cell left: it may be listed again
    }

    function test_aBlockWithNoCellsLeftCannotBeListed() public {
        uint256 a = _buy(alice, alice, 0, 0, 1, 1);
        vm.warp(block.timestamp + HOUR);
        _buy(bob, bob, 0, 0, 1, 1);
        vm.prank(alice);
        vm.expectRevert(ImageBoardStorage.NothingLeft.selector);
        board.listBlock(a, 1);
    }

    /// A cut lowers FREE squares only; a block bought after a cut is still taken against the full
    /// creation price, so its owner is credited more than they paid.
    function test_aCutTouchesNothingSold() public {
        uint256 a = _buy(alice, alice, 0, 0, 1, 1);
        vm.prank(seller);
        board.lowerPrices(5_000);
        uint256 b = _buy(bob, bob, 1, 0, 1, 1); // 5,002
        assertEq(board.blockOf(b).level, 5_001, "50,020,000 / 10,003 = 5,000.5 -> up");
        vm.warp(block.timestamp + HOUR);

        assertEq(board.quote(0, 0, 1, 1), 14_004, "alice's cell ignores the cut");
        assertEq(board.quote(2, 0, 1, 1), 5_002, "a free cell is cut");
        _buy(alice, alice, 1, 0, 1, 1);
        assertEq(board.pendingWithdrawals(bob), 11_503, "paid 5,002, credited against 10,003");
        assertEq(board.ownerOf(a), alice);
    }

    // ---------------------------------------------------------------------
    // The buy's bounds
    // ---------------------------------------------------------------------

    function test_theBuyRefusesATotalAboveItsBound() public {
        _buy(alice, alice, 0, 0, 1, 1);
        vm.warp(block.timestamp + HOUR);
        uint256 total = board.quote(0, 0, 2, 1);
        uint256 snap = vm.snapshotState();
        vm.prank(bob);
        vm.expectRevert(ImageBoardStorage.PriceTooHigh.selector);
        board.buyBlocks(bob, _one(0, 0, 2, 1), total - 1, block.timestamp);
        vm.revertToState(snap);
        vm.prank(bob);
        board.buyBlocks(bob, _one(0, 0, 2, 1), total, block.timestamp);
    }

    function test_theBuyRefusesAfterItsDeadline() public {
        vm.prank(alice);
        vm.expectRevert(ImageBoardStorage.DeadlineExpired.selector);
        board.buyBlocks(alice, _one(0, 0, 1, 1), type(uint256).max, block.timestamp - 1);
        vm.prank(alice);
        board.buyBlocks(alice, _one(0, 0, 1, 1), type(uint256).max, block.timestamp);
    }

    /// The cap counts the words each row of a rectangle spans, so where a rectangle starts matters:
    /// eight columns from column 0 are one word a row, from column 4 two.
    function test_aBuyWritesAtMostTheWordCap() public {
        _use(_create(_config(2560, 10_000, 10)));
        assertEq(board.MAX_WORDS_PER_BUY(), 512);
        assertEq(board.blockError(0, 0, 256, 16), bytes4(0), "32 words a row, 16 rows");
        assertEq(board.blockError(0, 0, 256, 17), ImageBoardStorage.TooLarge.selector);
        assertEq(board.blockError(0, 0, 8, 512), bytes4(0), "one word a row");
        assertEq(board.blockError(0, 0, 8, 513), ImageBoardStorage.TooLarge.selector);
        assertEq(board.blockError(4, 0, 8, 256), bytes4(0), "two words a row");
        assertEq(board.blockError(4, 0, 8, 257), ImageBoardStorage.TooLarge.selector);
        assertEq(board.blockError(7, 0, 2, 256), bytes4(0), "two cells, two words");
        assertEq(board.blockError(7, 0, 2, 257), ImageBoardStorage.TooLarge.selector);
        // Counted across the rectangles of one buy.
        uint16[4][] memory r = new uint16[4][](2);
        r[0] = [uint16(0), 0, 256, 16];
        r[1] = [uint16(0), 16, 1, 1];
        assertEq(board.buyError(_rects(r)), ImageBoardStorage.TooLarge.selector);
        vm.prank(alice);
        vm.expectRevert(ImageBoardStorage.TooLarge.selector);
        board.buyBlocks(alice, _rects(r), type(uint256).max, block.timestamp);
    }

    function test_aBuyTakesFromAtMostTheBlockCap() public {
        _use(_create(_config(2560, 1_000, 10)));
        uint256 cap = board.MAX_BLOCKS_TAKEN_PER_BUY();
        uint16[4][] memory r = new uint16[4][](cap + 1);
        for (uint256 i = 0; i <= cap; i++) {
            r[i] = [uint16(i), 0, 1, 1];
        }
        vm.prank(alice);
        board.buyBlocks(alice, _rects(r), type(uint256).max, block.timestamp);
        vm.warp(block.timestamp + HOUR);
        assertEq(board.blockError(0, 0, uint16(cap), 1), bytes4(0));
        assertEq(board.blockError(0, 0, uint16(cap) + 1, 1), ImageBoardStorage.TooManyBlocks.selector);
    }

    /// `quoteBlocks` never prices what the buy refuses: it reverts with `buyError`'s answer.
    function test_quoteRevertsWithTheGatesAnswer() public {
        _buy(alice, alice, 0, 0, 1, 1);
        assertEq(board.blockError(0, 0, 1, 1), ImageBoardStorage.CoolingDown.selector);
        vm.expectRevert(ImageBoardStorage.CoolingDown.selector);
        board.quote(0, 0, 1, 1);
    }

    function test_blockIdsStopWhereACellCanHoldThem() public {
        stdstore.target(address(board)).sig("blockCount()").checked_write(uint256(type(uint32).max) - 1);
        _buy(alice, alice, 0, 0, 1, 1);
        vm.prank(alice);
        vm.expectRevert(ImageBoardStorage.InvalidConfig.selector);
        board.buyBlocks(alice, _one(1, 0, 1, 1), type(uint256).max, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Terms
    // ---------------------------------------------------------------------

    function test_termsAreThePageBoardsClamps() public {
        ImageBoardStorage.Config memory cfg = _config(300, 300, 10);
        cfg.terms.payoutBps = 9_999;
        vm.expectRevert(TermsLib.PayoutBelowPrincipal.selector);
        collection.createBoardFor(seller, abi.encode(cfg));

        cfg = _config(300, 300, 10);
        cfg.terms.takeBps = 12_000; // 11,500 + 500: nothing left for the board's holder
        vm.expectRevert(TermsLib.TakeBelowPayout.selector);
        collection.createBoardFor(seller, abi.encode(cfg));

        cfg = _config(300, 300, 10);
        cfg.terms.cooldownSecs = 7 days + 1;
        vm.expectRevert(TermsLib.InvalidConfig.selector);
        collection.createBoardFor(seller, abi.encode(cfg));

        cfg = _config(300, 300, 10);
        cfg.terms.reversionBps = 0;
        vm.expectRevert(TermsLib.InvalidReversion.selector);
        collection.createBoardFor(seller, abi.encode(cfg));
    }

    function test_theTermsAreRecorded() public view {
        assertEq(board.takeBps(), 14_000);
        assertEq(board.payoutBps(), 11_500);
        assertEq(board.reversionBps(), 9_700);
        assertEq(board.maxReversionWeeks(), 52);
        assertEq(board.cooldownSecs(), 3_600);
        assertEq(board.creator(), seller);
    }

    // ---------------------------------------------------------------------
    // Gas: what the caps are set from. Cold, as a real buy finds the board.
    // ---------------------------------------------------------------------

    uint256 internal constant TX_CAP_WITH_HEADROOM = uint256(32_000_000) * 10 / 12;
    uint192 internal constant DEAR = 30_011;

    function _mostZones() internal returns (ImageBoard) {
        uint256 most = implementation.MAX_ZONES();
        ImageBoardStorage.Config memory cfg = _config(2560, 10_000, 10);
        cfg.zones = new ImageBoardStorage.Zone[](most);
        for (uint256 i = 0; i < most; i++) {
            cfg.zones[i] = ImageBoardStorage.Zone({ col: 0, row: uint16(i), cols: 256, rows: 1, cellPrice: DEAR });
        }
        return _create(cfg);
    }

    function _measure(address payer, ImageBoardStorage.Rect[] memory rects) internal returns (uint256 used) {
        vm.cool(address(board));
        vm.cool(address(usd));
        vm.prank(payer);
        uint256 before = gasleft();
        board.buyBlocks(payer, rects, type(uint256).max, block.timestamp);
        used = before - gasleft();
    }

    /// The cap's words, all fresh, 256 wide and under the most zones.
    function test_gas_aFreshWideBuyAtTheWordCap() public {
        _use(_mostZones());
        uint256 used = _measure(alice, _one(0, 0, 256, 16));
        emit log_named_uint("fresh 256 x 16 buy at the word cap, gas", used);
        assertLt(used, TX_CAP_WITH_HEADROOM);
    }

    /// The cap's words, all fresh, eight cells in each, every row its own zone.
    function test_gas_aFreshTallBuyAtTheWordCap() public {
        _use(_mostZones());
        uint256 used = _measure(alice, _one(0, 0, 8, 512));
        emit log_named_uint("fresh 8 x 512 buy at the word cap, gas", used);
        assertLt(used, TX_CAP_WITH_HEADROOM);
    }

    /// The worst take: the cap's words, taking from the cap's blocks — each a different owner never
    /// credited before, each in its own word, each listed (the take ends every listing) and a year
    /// old (the reversion loop runs its full 52 weeks) — with the rest fresh, under the most zones.
    function test_gas_theWorstTakeAtBothCaps() public {
        _use(_mostZones());
        uint256 blocks = board.MAX_BLOCKS_TAKEN_PER_BUY();
        uint256 rows = board.MAX_WORDS_PER_BUY() / 32;
        uint256 perRow = (blocks + rows - 1) / rows;
        uint256 stride = 256 / perRow;
        uint16[4][] memory r = new uint16[4][](blocks);
        for (uint256 i = 0; i < blocks; i++) {
            r[i] = [uint16((i % perRow) * stride), uint16(i / perRow), 1, 1];
        }
        ImageBoardStorage.Rect[] memory seeds = _rects(r);
        for (uint256 i = 0; i < blocks; i++) {
            ImageBoardStorage.Rect[] memory one = new ImageBoardStorage.Rect[](1);
            one[0] = seeds[i];
            address owner_ = address(uint160(0x10000 + i));
            vm.prank(bob);
            uint256 id = board.buyBlocks(owner_, one, type(uint256).max, block.timestamp);
            vm.prank(owner_);
            board.listBlock(id, 1_000_000);
        }
        vm.warp(block.timestamp + 52 weeks);
        uint256 used = _measure(alice, _one(0, 0, 256, uint16(rows)));
        emit log_named_uint("worst take at both caps, gas", used);
        assertLt(used, TX_CAP_WITH_HEADROOM);
    }
    /// The same take with every block it covers rented for a year, each to its own tenant (2026-10-20):
    /// each tenancy is settled, refunded and restarted inside the buy, every refund a fresh balance —
    /// the dearest take there is.
    function test_gas_theWorstTakeOfRentedBlocksAtBothCaps() public {
        _use(_mostZones());
        uint256 blocks = board.MAX_BLOCKS_TAKEN_PER_BUY();
        uint256 rows = board.MAX_WORDS_PER_BUY() / 32;
        uint256 perRow = (blocks + rows - 1) / rows;
        uint256 stride = 256 / perRow;
        for (uint256 i = 0; i < blocks; i++) {
            ImageBoardStorage.Rect[] memory one = new ImageBoardStorage.Rect[](1);
            one[0] = ImageBoardStorage.Rect(uint16((i % perRow) * stride), uint16(i / perRow), 1, 1);
            address owner_ = address(uint160(0x10000 + i));
            vm.prank(bob);
            uint256 id = board.buyBlocks(owner_, one, type(uint256).max, block.timestamp);
            vm.prank(owner_);
            board.listForRent(id, 1_000_000, 365 days);
            // A different tenant each, with nothing owed yet: every refund writes a fresh balance.
            vm.prank(bob);
            board.rent(id, address(uint160(0x20000 + i)), 365 days, 1_000_000);
            // Put up for resale during the term too, so the take ends both offers as well.
            vm.prank(owner_);
            board.listBlock(id, 1_000_000);
        }
        vm.warp(block.timestamp + 52 weeks);
        uint256 used = _measure(alice, _one(0, 0, 256, uint16(rows)));
        emit log_named_uint("worst take of rented blocks at both caps, gas", used);
        assertLt(used, TX_CAP_WITH_HEADROOM);
    }
}
