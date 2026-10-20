// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ImageBoard } from "../src/ImageBoard.sol";
import { ImageBoardReads } from "./ImageBoardReads.sol";
import { ImageBoardBase } from "./ImageBoardBase.t.sol";


using ImageBoardReads for ImageBoard;
/// @notice Zones (cells priced differently from `cellPrice`) and kept blocks (the creator's, made
/// with the board), `IMAGE-BOARD-SPEC.md` §4a. Every rule at its boundary: a zone ending exactly on
/// the grid's edge and one cell past it, zones that touch and zones that share one cell, a block one
/// cell into a zone.
///
/// The board here is 30×30 with a dear zone at (10,10) 5×5 and a cheap one at (20,0) 4×2. Prices
/// that do not divide by 20, so a cut that rounded the wrong way would show.
contract ImageBoardZonesTest is ImageBoardBase {
    uint192 internal constant DEAR = 30_011;
    uint192 internal constant CHEAP = 2_003;

    event BlockKept(uint256 indexed blockId, address indexed owner, uint16 col, uint16 row, uint16 cols, uint16 rows);
    event ZoneSet(uint256 indexed index, uint16 col, uint16 row, uint16 cols, uint16 rows, uint256 cellPrice);

    function _zoned() internal view returns (ImageBoard.Config memory cfg) {
        cfg = _config(300, 300, 10);
        cfg.zones = new ImageBoard.Zone[](2);
        cfg.zones[0] = ImageBoard.Zone({ col: 10, row: 10, cols: 5, rows: 5, cellPrice: DEAR });
        cfg.zones[1] = ImageBoard.Zone({ col: 20, row: 0, cols: 4, rows: 2, cellPrice: CHEAP });
    }

    function _use(ImageBoard b) internal {
        board = b;
        vm.prank(alice);
        usd.approve(address(board), type(uint256).max);
    }

    function _oneZone(uint16 col, uint16 row, uint16 cols, uint16 rows, uint192 price)
        internal
        view
        returns (ImageBoard.Config memory cfg)
    {
        cfg = _config(300, 300, 10);
        cfg.zones = new ImageBoard.Zone[](1);
        cfg.zones[0] = ImageBoard.Zone({ col: col, row: row, cols: cols, rows: rows, cellPrice: price });
    }

    function _refused(ImageBoard.Config memory cfg, bytes4 err) internal {
        vm.expectRevert(err);
        collection.createBoardFor(seller, abi.encode(cfg));
    }

    // ---------------------------------------------------------------------
    // Prices by position
    // ---------------------------------------------------------------------

    function test_zonesAreReadBackInTheOrderGiven() public {
        _use(_create(_zoned()));
        ImageBoard.Zone[] memory z = board.zones();
        assertEq(z.length, 2);
        assertEq(z[0].col, 10);
        assertEq(z[0].cellPrice, DEAR);
        assertEq(z[1].col, 20);
        assertEq(z[1].rows, 2);
        assertEq(z[1].cellPrice, CHEAP);
    }

    function test_creatingAZonedBoardAnnouncesEachZone() public {
        vm.expectEmit(true, false, false, true);
        emit ZoneSet(0, 10, 10, 5, 5, DEAR);
        vm.expectEmit(true, false, false, true);
        emit ZoneSet(1, 20, 0, 4, 2, CHEAP);
        _create(_zoned());
    }

    function test_aBlockInsideAZonePaysTheZonesPrice() public {
        _use(_create(_zoned()));
        assertEq(board.quote(11, 11, 2, 3), 6 * uint256(DEAR));
        assertEq(board.quote(20, 0, 4, 2), 8 * uint256(CHEAP), "the cheap zone exactly");
    }

    function test_outsideEveryZoneIsTheBasePrice() public {
        _use(_create(_zoned()));
        // Touching the dear zone's left edge from outside: column 9 is not in it.
        assertEq(board.quote(9, 10, 1, 5), 5 * CELL_PRICE);
        // And its bottom edge from below: row 15 is not in it.
        assertEq(board.quote(10, 15, 5, 1), 5 * CELL_PRICE);
    }

    function test_aBlockOneCellIntoAZonePaysThatCellAtTheZonesPrice() public {
        _use(_create(_zoned()));
        // Columns 8, 9 outside; column 10 inside. One row.
        assertEq(board.quote(8, 10, 3, 1), 2 * CELL_PRICE + DEAR);
        // The same from the far corner: (14,14) is the zone's last cell.
        assertEq(board.quote(14, 14, 2, 2), 3 * CELL_PRICE + DEAR);
    }

    function test_aBlockAcrossTwoZonesAndTheBasePaysEachCellItsOwnPrice() public {
        _use(_create(_zoned()));
        // Rows 0–14, columns 12–23: 25 cells... counted by hand below.
        //   dear zone ∩ block: columns 12–14, rows 10–14 → 3×5 = 15
        //   cheap zone ∩ block: columns 20–23, rows 0–1 → 4×2 = 8
        //   the rest: 12×15 − 15 − 8 = 157
        uint256 expected = 15 * uint256(DEAR) + 8 * uint256(CHEAP) + 157 * CELL_PRICE;
        assertEq(board.quote(12, 0, 12, 15), expected);
    }

    function test_aBuyIsChargedAndCreditedThePositionsPrice() public {
        _use(_create(_zoned()));
        uint256 total = 2 * CELL_PRICE + DEAR;
        uint256 cut = total * PROTOCOL_BPS / 10_000;
        uint256 paidBefore = usd.balanceOf(alice);

        _buy(alice, bob, 8, 10, 3, 1);

        assertEq(paidBefore - usd.balanceOf(alice), total, "the buyer paid other than the position's price");
        assertEq(usd.balanceOf(address(board)), total);
        assertEq(board.pendingWithdrawals(seller), total - cut);
        assertEq(board.pendingWithdrawals(protocol), cut);
    }

    function test_aPermitBuyIsForExactlyThePositionsPrice() public {
        _use(_create(_zoned()));
        vm.prank(alice);
        usd.approve(address(board), 0);

        uint256 total = board.quote(9, 9, 2, 2);
        assertEq(total, 3 * CELL_PRICE + DEAR);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(alicePk, address(board), total, deadline);
        vm.prank(alice);
        uint256 id = board.buyBlocksWithPermit(alice, _one(9, 9, 2, 2), total, deadline, v, r, s);

        assertEq(board.ownerOf(id), alice);
        assertEq(usd.allowance(alice, address(board)), 0, "the permit was for exactly the position's price");
    }

    /// A permit signed for the base price of a block that reaches into a dear zone is too little,
    /// and the buy is refused rather than charged the smaller figure.
    function test_aPermitForTheBasePriceDoesNotBuyAZonedBlock() public {
        _use(_create(_zoned()));
        vm.prank(alice);
        usd.approve(address(board), 0);

        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(alicePk, address(board), 4 * CELL_PRICE, deadline);
        vm.prank(alice);
        vm.expectRevert();
        board.buyBlocksWithPermit(alice, _one(9, 9, 2, 2), 4 * CELL_PRICE, deadline, v, r, s);
    }

    // ---------------------------------------------------------------------
    // What a zone may be
    // ---------------------------------------------------------------------

    function test_aZoneEndingOnTheGridsEdgeIsAccepted() public {
        _use(_create(_oneZone(25, 28, 5, 2, DEAR)));
        assertEq(board.quote(29, 29, 1, 1), DEAR);
    }

    function test_aZoneOneCellPastTheGridIsRefused() public {
        _refused(_oneZone(26, 0, 5, 1, DEAR), ImageBoard.InvalidConfig.selector);
        _refused(_oneZone(0, 29, 1, 2, DEAR), ImageBoard.InvalidConfig.selector);
    }

    function test_anEmptyZoneIsRefused() public {
        _refused(_oneZone(0, 0, 0, 1, DEAR), ImageBoard.InvalidConfig.selector);
        _refused(_oneZone(0, 0, 1, 0, DEAR), ImageBoard.InvalidConfig.selector);
    }

    function test_aZeroPricedZoneIsRefused() public {
        _refused(_oneZone(0, 0, 1, 1, 0), ImageBoard.InvalidConfig.selector);
        _use(_create(_oneZone(0, 0, 1, 1, 1)));
        assertEq(board.quote(0, 0, 1, 1), 1, "the smallest price is a price");
    }

    function test_zonesThatTouchAreAccepted() public {
        ImageBoard.Config memory cfg = _config(300, 300, 10);
        cfg.zones = new ImageBoard.Zone[](3);
        cfg.zones[0] = ImageBoard.Zone({ col: 0, row: 0, cols: 3, rows: 3, cellPrice: DEAR });
        cfg.zones[1] = ImageBoard.Zone({ col: 3, row: 0, cols: 3, rows: 3, cellPrice: CHEAP }); // right
        cfg.zones[2] = ImageBoard.Zone({ col: 0, row: 3, cols: 3, rows: 3, cellPrice: CHEAP }); // below
        _use(_create(cfg));
        assertEq(board.quote(2, 2, 2, 2), uint256(DEAR) + 2 * uint256(CHEAP) + CELL_PRICE);
    }

    function test_zonesSharingOneCellAreRefused() public {
        ImageBoard.Config memory cfg = _config(300, 300, 10);
        cfg.zones = new ImageBoard.Zone[](2);
        cfg.zones[0] = ImageBoard.Zone({ col: 0, row: 0, cols: 3, rows: 3, cellPrice: DEAR });
        cfg.zones[1] = ImageBoard.Zone({ col: 2, row: 2, cols: 3, rows: 3, cellPrice: CHEAP });
        _refused(cfg, ImageBoard.InvalidConfig.selector);
    }

    /// The same overlap given in the other order: the check must not depend on which came first.
    function test_aZoneInsideAnotherIsRefusedEitherWayRound() public {
        ImageBoard.Config memory cfg = _config(300, 300, 10);
        cfg.zones = new ImageBoard.Zone[](2);
        cfg.zones[0] = ImageBoard.Zone({ col: 5, row: 5, cols: 1, rows: 1, cellPrice: CHEAP });
        cfg.zones[1] = ImageBoard.Zone({ col: 0, row: 0, cols: 10, rows: 10, cellPrice: DEAR });
        _refused(cfg, ImageBoard.InvalidConfig.selector);
        (cfg.zones[0], cfg.zones[1]) = (cfg.zones[1], cfg.zones[0]);
        _refused(cfg, ImageBoard.InvalidConfig.selector);
    }

    function test_theMostZonesAreAcceptedAndOneMoreIsRefused() public {
        uint256 most = implementation.MAX_ZONES();
        ImageBoard.Config memory cfg = _config(2560, 10_000, 10);
        cfg.zones = new ImageBoard.Zone[](most + 1);
        for (uint256 i = 0; i <= most; i++) {
            cfg.zones[i] = ImageBoard.Zone({ col: 0, row: uint16(i), cols: 1, rows: 1, cellPrice: DEAR });
        }
        _refused(cfg, ImageBoard.InvalidConfig.selector);
        ImageBoard.Zone[] memory fewer = cfg.zones;
        assembly ("memory-safe") {
            mstore(fewer, most)
        }
        cfg.zones = fewer;
        assertEq(_create(cfg).zones().length, most);
    }

    /// The ceiling exists for this: the largest board, with every zone it may have, is created in
    /// one transaction with 1.2x headroom. What a buy under them costs is `ImageBoardTakeovers.t.sol`'s.
    function test_theLargestBoardWithTheMostZonesIsCreatedInOneTransaction() public {
        uint256 most = implementation.MAX_ZONES();
        ImageBoard.Config memory cfg = _config(2560, 10_000, 10);
        cfg.zones = new ImageBoard.Zone[](most);
        for (uint256 i = 0; i < most; i++) {
            cfg.zones[i] = ImageBoard.Zone({ col: 0, row: uint16(i), cols: 256, rows: 1, cellPrice: DEAR });
        }
        uint256 before = gasleft();
        _create(cfg);
        assertLt(before - gasleft(), uint256(32_000_000) * 10 / 12, "creating the most zones no longer fits one transaction");
    }

    // ---------------------------------------------------------------------
    // Kept blocks
    // ---------------------------------------------------------------------

    function _kept() internal view returns (ImageBoard.Config memory cfg) {
        cfg = _config(300, 300, 10);
        cfg.kept = new ImageBoard.Rect[](2);
        cfg.kept[0] = ImageBoard.Rect({ col: 0, row: 0, cols: 4, rows: 2 });
        cfg.kept[1] = ImageBoard.Rect({ col: 29, row: 29, cols: 1, rows: 1 });
    }

    function test_keptBlocksAreTheCreatorsFromIdOneInOrder() public {
        vm.expectEmit(true, true, false, true);
        emit BlockKept(1, seller, 0, 0, 4, 2);
        vm.expectEmit(true, true, false, true);
        emit BlockKept(2, seller, 29, 29, 1, 1);
        // The relayer pays for creation; the kept blocks are still the seller's.
        vm.prank(relayer);
        (address b,) = collection.createBoardFor(seller, abi.encode(_kept()));
        _use(ImageBoard(b));

        assertEq(board.blockCount(), 2);
        assertEq(board.ownerOf(1), seller);
        assertEq(board.ownerOf(2), seller);
        assertEq(board.ownerOf(3), address(0));
        ImageBoard.Block memory k = board.blockOf(2);
        assertEq(k.col, 29);
        assertEq(k.row, 29);
        assertEq(k.cols, 1);
        assertEq(k.rows, 1);
        assertEq(k.version, 0);
    }

    function test_keepingABlockMovesNoMoney() public {
        _use(_create(_kept()));
        assertEq(usd.balanceOf(address(board)), 0);
        assertEq(board.pendingWithdrawals(seller), 0);
        assertEq(board.pendingWithdrawals(protocol), 0, "the protocol took a cut of nothing");
    }

    function test_keptCellsAreNotForSale() public {
        _use(_create(_kept()));
        assertEq(board.blockError(3, 1, 2, 1), ImageBoard.CellsKept.selector, "the kept block's last cell");
        assertEq(board.blockError(4, 0, 1, 2), bytes4(0), "the column beside it is free");
        vm.prank(alice);
        vm.expectRevert(ImageBoard.CellsKept.selector);
        board.buyBlocks(alice, _one(3, 1, 2, 1), type(uint256).max, block.timestamp);
        // The next bought block takes the next id.
        assertEq(_buy(alice, alice, 4, 0, 1, 2), 3);
    }

    function test_keptBlocksThatOverlapAreRefused() public {
        ImageBoard.Config memory cfg = _kept();
        cfg.kept[1] = ImageBoard.Rect({ col: 3, row: 1, cols: 2, rows: 2 });
        _refused(cfg, ImageBoard.CellsTaken.selector);
    }

    function test_aKeptBlockOutsideTheGridOrEmptyIsRefused() public {
        ImageBoard.Config memory cfg = _kept();
        cfg.kept[1] = ImageBoard.Rect({ col: 29, row: 29, cols: 2, rows: 1 });
        _refused(cfg, ImageBoard.OutsideGrid.selector);
        cfg.kept[1] = ImageBoard.Rect({ col: 5, row: 5, cols: 0, rows: 1 });
        _refused(cfg, ImageBoard.EmptyBlock.selector);
    }

    /// A zone may lie over kept cells: they are never sold first-hand, so its price never applies
    /// to them, and the cells around them still pay it.
    function test_aZoneMayCoverKeptCells() public {
        ImageBoard.Config memory cfg = _kept();
        cfg.zones = new ImageBoard.Zone[](1);
        cfg.zones[0] = ImageBoard.Zone({ col: 0, row: 0, cols: 6, rows: 3, cellPrice: DEAR });
        _use(_create(cfg));
        assertEq(board.ownerOf(1), seller);
        uint256 paidBefore = usd.balanceOf(alice);
        _buy(alice, alice, 4, 0, 2, 3);
        assertEq(paidBefore - usd.balanceOf(alice), 6 * uint256(DEAR));
    }

    function test_aKeptBlockIsAnOrdinaryBlock() public {
        _use(_create(_kept()));

        vm.prank(seller);
        board.edit(1, keccak256("logo"));
        assertEq(board.blockOf(1).version, 1);

        vm.prank(seller);
        board.listBlock(1, 1_000_003);
        vm.prank(alice);
        board.buyListedBlock(1, alice, 1_000_003);
        assertEq(board.ownerOf(1), alice);
        (uint256 cut, uint256 royalty, uint256 toOwner) = board.resaleSplit(1_000_003);
        // The seller is both the block's owner and the board's holder here.
        assertEq(board.pendingWithdrawals(seller), toOwner + royalty);
        assertEq(board.pendingWithdrawals(protocol), cut);

        vm.prank(seller);
        board.transferBlock(2, bob);
        assertEq(board.ownerOf(2), bob);
    }

    /// Kept blocks belong to the creator, not to the board's NFT: selling the board does not hand
    /// them over, and whoever holds the board has no power over them.
    function test_aKeptBlockStaysWithTheCreatorWhenTheBoardIsSold() public {
        _use(_create(_kept()));
        uint256 tokenId = board.boardTokenId();
        vm.prank(seller);
        collection.transferFrom(seller, bob, tokenId);

        assertEq(board.ownerOf(1), seller);
        vm.prank(bob);
        vm.expectRevert(ImageBoard.NotBlockOwner.selector);
        board.transferBlock(1, bob);
    }
}
