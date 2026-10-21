// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ImageBoard } from "../src/ImageBoard.sol";
import { ImageBoardStorage } from "../src/ImageBoardStorage.sol";
import { ImageBoardReads } from "./ImageBoardReads.sol";
import { ImageBoardBase } from "./ImageBoardBase.t.sol";


using ImageBoardReads for ImageBoard;
/// @notice Zones (cells priced differently from `cellPrice`), `IMAGE-BOARD-SPEC.md` §4a; kept blocks
/// were removed with §13 (2026-10-21). Every rule at its boundary: a zone ending exactly on
/// the grid's edge and one cell past it, zones that touch and zones that share one cell, a block one
/// cell into a zone.
///
/// The board here is 30×30 with a dear zone at (10,10) 5×5 and a cheap one at (20,0) 4×2. Prices
/// that do not divide by 20, so a cut that rounded the wrong way would show.
contract ImageBoardZonesTest is ImageBoardBase {
    uint192 internal constant DEAR = 30_011;
    uint192 internal constant CHEAP = 2_003;

    event ZoneSet(uint256 indexed index, uint16 col, uint16 row, uint16 cols, uint16 rows, uint256 cellPrice);

    function _zoned() internal view returns (ImageBoardStorage.Config memory cfg) {
        cfg = _config(300, 300, 10);
        cfg.zones = new ImageBoardStorage.Zone[](2);
        cfg.zones[0] = ImageBoardStorage.Zone({ col: 10, row: 10, cols: 5, rows: 5, cellPrice: DEAR });
        cfg.zones[1] = ImageBoardStorage.Zone({ col: 20, row: 0, cols: 4, rows: 2, cellPrice: CHEAP });
    }

    function _use(ImageBoard b) internal {
        board = b;
        vm.prank(alice);
        usd.approve(address(board), type(uint256).max);
    }

    function _oneZone(uint16 col, uint16 row, uint16 cols, uint16 rows, uint192 price)
        internal
        view
        returns (ImageBoardStorage.Config memory cfg)
    {
        cfg = _config(300, 300, 10);
        cfg.zones = new ImageBoardStorage.Zone[](1);
        cfg.zones[0] = ImageBoardStorage.Zone({ col: col, row: row, cols: cols, rows: rows, cellPrice: price });
    }

    function _refused(ImageBoardStorage.Config memory cfg, bytes4 err) internal {
        vm.expectRevert(err);
        collection.createBoardFor(seller, abi.encode(cfg));
    }

    // ---------------------------------------------------------------------
    // Prices by position
    // ---------------------------------------------------------------------

    function test_zonesAreReadBackInTheOrderGiven() public {
        _use(_create(_zoned()));
        ImageBoardStorage.Zone[] memory z = board.zones();
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
        _refused(_oneZone(26, 0, 5, 1, DEAR), ImageBoardStorage.InvalidConfig.selector);
        _refused(_oneZone(0, 29, 1, 2, DEAR), ImageBoardStorage.InvalidConfig.selector);
    }

    function test_anEmptyZoneIsRefused() public {
        _refused(_oneZone(0, 0, 0, 1, DEAR), ImageBoardStorage.InvalidConfig.selector);
        _refused(_oneZone(0, 0, 1, 0, DEAR), ImageBoardStorage.InvalidConfig.selector);
    }

    function test_aZeroPricedZoneIsRefused() public {
        _refused(_oneZone(0, 0, 1, 1, 0), ImageBoardStorage.InvalidConfig.selector);
        _use(_create(_oneZone(0, 0, 1, 1, 1)));
        assertEq(board.quote(0, 0, 1, 1), 1, "the smallest price is a price");
    }

    function test_zonesThatTouchAreAccepted() public {
        ImageBoardStorage.Config memory cfg = _config(300, 300, 10);
        cfg.zones = new ImageBoardStorage.Zone[](3);
        cfg.zones[0] = ImageBoardStorage.Zone({ col: 0, row: 0, cols: 3, rows: 3, cellPrice: DEAR });
        cfg.zones[1] = ImageBoardStorage.Zone({ col: 3, row: 0, cols: 3, rows: 3, cellPrice: CHEAP }); // right
        cfg.zones[2] = ImageBoardStorage.Zone({ col: 0, row: 3, cols: 3, rows: 3, cellPrice: CHEAP }); // below
        _use(_create(cfg));
        assertEq(board.quote(2, 2, 2, 2), uint256(DEAR) + 2 * uint256(CHEAP) + CELL_PRICE);
    }

    function test_zonesSharingOneCellAreRefused() public {
        ImageBoardStorage.Config memory cfg = _config(300, 300, 10);
        cfg.zones = new ImageBoardStorage.Zone[](2);
        cfg.zones[0] = ImageBoardStorage.Zone({ col: 0, row: 0, cols: 3, rows: 3, cellPrice: DEAR });
        cfg.zones[1] = ImageBoardStorage.Zone({ col: 2, row: 2, cols: 3, rows: 3, cellPrice: CHEAP });
        _refused(cfg, ImageBoardStorage.InvalidConfig.selector);
    }

    /// The same overlap given in the other order: the check must not depend on which came first.
    function test_aZoneInsideAnotherIsRefusedEitherWayRound() public {
        ImageBoardStorage.Config memory cfg = _config(300, 300, 10);
        cfg.zones = new ImageBoardStorage.Zone[](2);
        cfg.zones[0] = ImageBoardStorage.Zone({ col: 5, row: 5, cols: 1, rows: 1, cellPrice: CHEAP });
        cfg.zones[1] = ImageBoardStorage.Zone({ col: 0, row: 0, cols: 10, rows: 10, cellPrice: DEAR });
        _refused(cfg, ImageBoardStorage.InvalidConfig.selector);
        (cfg.zones[0], cfg.zones[1]) = (cfg.zones[1], cfg.zones[0]);
        _refused(cfg, ImageBoardStorage.InvalidConfig.selector);
    }

    function test_theMostZonesAreAcceptedAndOneMoreIsRefused() public {
        uint256 most = implementation.MAX_ZONES();
        ImageBoardStorage.Config memory cfg = _config(2560, 10_000, 10);
        cfg.zones = new ImageBoardStorage.Zone[](most + 1);
        for (uint256 i = 0; i <= most; i++) {
            cfg.zones[i] = ImageBoardStorage.Zone({ col: 0, row: uint16(i), cols: 1, rows: 1, cellPrice: DEAR });
        }
        _refused(cfg, ImageBoardStorage.InvalidConfig.selector);
        ImageBoardStorage.Zone[] memory fewer = cfg.zones;
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
        ImageBoardStorage.Config memory cfg = _config(2560, 10_000, 10);
        cfg.zones = new ImageBoardStorage.Zone[](most);
        for (uint256 i = 0; i < most; i++) {
            cfg.zones[i] = ImageBoardStorage.Zone({ col: 0, row: uint16(i), cols: 256, rows: 1, cellPrice: DEAR });
        }
        uint256 before = gasleft();
        _create(cfg);
        assertLt(before - gasleft(), uint256(32_000_000) * 10 / 12, "creating the most zones no longer fits one transaction");
    }
}
