// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { ImageBoard } from "../src/ImageBoard.sol";
import { ImageBoardCollection } from "../src/ImageBoardCollection.sol";
import { TestUSD } from "../src/mocks/TestUSD.sol";

/// @notice The image-board grid rule as JSONL, for the TypeScript twin to assert against
/// (`packages/websitekit-sdk/src/image-grid.ts`). Written to `out/image-grid-vectors.jsonl` via `vm.writeLine`.
///
/// Two families, by `kind`:
///
///   - `grid`  — `(width, height, cellSize)` → `(gridCols, gridRows)` or `InvalidConfig`, read off
///               a REAL board the collection created (or refused), not recomputed here.
///   - `rect`  — `(col, row, cols, rows)` → the name of the error `blockError` returns, or `none`,
///               on one board with three blocks already sold. The sweep runs one cell past the grid
///               on both axes and includes empty rectangles, so every refusal appears.
///
///   - `layout` — zones and kept blocks → the error `initialize` reverts with, or `none`, from a
///               real `createBoardFor` on a 12×10 grid (2026-10-11). Every refusal at its boundary.
///   - `quote`  — after a `zoned` line (a board with zones and kept blocks): `(col, row, cols, rows)`
///               → `quote`'s total and `blockError`'s answer, for every rectangle of six shapes at
///               every origin inside the grid. One zone's price is near 2^150, so a twin computing
///               in floating point fails. Three zoned boards: at full price, and lowered to 3,333
///               and to 1 bps (2026-10-11) — shares that do not divide the totals, so a twin that
///               rounded down, or cut each cell rather than the block, fails.
///   - `multi`  — a list of rectangles → the error `buyBlocks` reverts with, or `none`, from a real
///               buy on a fresh 12×10 board with one block sold (2026-10-11): rectangles that share
///               a cell with each other, with the sold block, leave the grid, or are empty, and the
///               empty list. The first failing rectangle names the error.
///
/// Each `board` line carries the grid and the sold blocks, and the `rect` lines after it are against
/// that board, so the twin rebuilds the occupancy rather than trusting a copy of it. There are two
/// boards: the 12×10 sweep, and one 256 cells wide — the only width where a whole row is every bit
/// of the storage word, which a narrow sweep never reaches.
///
/// No RNG: re-running emits the same file.
contract GenImageGridVectors is Script {
    string internal constant OUT_PATH = "out/image-grid-vectors.jsonl";
    /// Fixed parties: a script contract's own address is ephemeral, and forge refuses it.
    address internal constant SELLER = address(0x5E11);
    address internal constant BUYER = address(0xB0B);

    TestUSD internal usd;
    ImageBoardCollection internal collection;
    uint256 internal lines;

    function run() external {
        vm.writeFile(OUT_PATH, "");
        usd = new TestUSD("Vector Dollar", "vUSD", 6);
        ImageBoard implementation = new ImageBoard(500, address(0xBEEF));
        address[] memory tokens = new address[](1);
        tokens[0] = address(usd);
        collection = new ImageBoardCollection("Vector Image Boards", "VIMG", SELLER, address(implementation), tokens, "");

        _emitGrids();
        _emitRects();
        _emitWideRects();
        _emitLayouts();
        _emitZonedQuotes(10_000);
        _emitZonedQuotes(3_333);
        _emitZonedQuotes(1);
        _emitMultiBuys();
        console2.log("GenImageGridVectors: lines", lines);
    }

    function _config(uint32 w, uint32 h, uint8 cell) internal view returns (ImageBoard.Config memory cfg) {
        cfg.settlementToken = address(usd);
        cfg.width = w;
        cfg.height = h;
        cfg.cellSize = cell;
        cfg.cellPrice = 1;
        cfg.imageHash = keccak256("v");
    }

    function _emitGrids() internal {
        uint32[3][21] memory cases = [
            [uint32(300), 671, 10], // §2's example: 30×67
            [uint32(300), 671, 15],
            [uint32(300), 671, 20],
            [uint32(10), 10, 10], // exactly one cell
            [uint32(9), 10, 10], // narrower than a cell
            [uint32(10), 9, 10], // shorter than a cell
            [uint32(19), 19, 10], // a whole cell plus a 9 px strip
            [uint32(29), 44, 15],
            [uint32(39), 40, 20],
            [uint32(2560), 100, 10], // 256 across, the limit
            [uint32(2569), 100, 10], // still 256
            [uint32(2570), 100, 10], // 257 → refused
            [uint32(3840), 100, 15], // 256 at 15
            [uint32(5120), 100, 20], // 256 at 20
            [uint32(5140), 100, 20], // 257 at 20 → refused
            [uint32(100), 10_009, 10], // 1,000 rows, the limit
            [uint32(100), 10_010, 10], // 1,001 → refused
            [uint32(100), 15_014, 15], // 1,000 at 15
            [uint32(100), 20_020, 20], // 1,001 at 20 → refused
            [uint32(100), 100, 12], // not a cell size
            [uint32(100), 100, 5] // rejected in §2
        ];
        for (uint256 i = 0; i < cases.length; i++) {
            uint32 w = cases[i][0];
            uint32 h = cases[i][1];
            uint8 cell = uint8(cases[i][2]);
            string memory head = string.concat(
                '{"kind":"grid","width":',
                vm.toString(w),
                ',"height":',
                vm.toString(h),
                ',"cellSize":',
                vm.toString(cell)
            );
            try collection.createBoardFor(SELLER, _config(w, h, cell)) returns (address b, uint256) {
                (uint16 c, uint16 r) = ImageBoard(b).gridSize();
                _write(string.concat(head, ',"gridCols":', vm.toString(c), ',"gridRows":', vm.toString(r), ',"error":"none"}'));
            } catch (bytes memory reason) {
                require(bytes4(reason) == ImageBoard.InvalidConfig.selector, "unexpected refusal");
                _write(string.concat(head, ',"error":"InvalidConfig"}'));
            }
        }
    }

    function _emitRects() internal {
        // 125×104 at 10 px → 12×10, with a strip unsold on both axes.
        (address created,) = collection.createBoardFor(SELLER, _config(125, 104, 10));
        ImageBoard board = ImageBoard(created);
        usd.mint(BUYER, 1e12);
        vm.prank(BUYER);
        usd.approve(address(board), type(uint256).max);

        uint16[4][3] memory sold = [[uint16(2), 2, 3, 2], [uint16(8), 0, 4, 1], [uint16(0), 9, 1, 1]];
        string memory soldJson = "[";
        for (uint256 i = 0; i < sold.length; i++) {
            vm.prank(BUYER);
            board.buyBlocks(BUYER, _list(_rect(sold[i][0], sold[i][1], sold[i][2], sold[i][3])));
            soldJson = string.concat(
                soldJson,
                i == 0 ? "[" : ",[",
                vm.toString(sold[i][0]),
                ",",
                vm.toString(sold[i][1]),
                ",",
                vm.toString(sold[i][2]),
                ",",
                vm.toString(sold[i][3]),
                "]"
            );
        }
        (uint16 gc, uint16 gr) = board.gridSize();
        _write(
            string.concat(
                '{"kind":"board","gridCols":', vm.toString(gc), ',"gridRows":', vm.toString(gr), ',"sold":', soldJson, "]}"
            )
        );

        uint16[2][8] memory sizes = [
            [uint16(1), 1],
            [uint16(2), 2],
            [uint16(3), 1],
            [uint16(1), 3],
            [uint16(12), 1],
            [uint16(1), 10],
            [uint16(0), 1],
            [uint16(1), 0]
        ];
        for (uint16 col = 0; col <= gc; col++) {
            for (uint16 row = 0; row <= gr; row++) {
                for (uint256 s = 0; s < sizes.length; s++) {
                    bytes4 err = board.blockError(col, row, sizes[s][0], sizes[s][1]);
                    _write(
                        string.concat(
                            '{"kind":"rect","col":',
                            vm.toString(col),
                            ',"row":',
                            vm.toString(row),
                            ',"cols":',
                            vm.toString(sizes[s][0]),
                            ',"rows":',
                            vm.toString(sizes[s][1]),
                            ',"error":"',
                            _errorName(err),
                            '"}'
                        )
                    );
                }
            }
        }
    }

    function _emitWideRects() internal {
        // 2560×30 at 10 px → 256×3, with row 1 sold whole.
        (address created,) = collection.createBoardFor(SELLER, _config(2560, 30, 10));
        ImageBoard board = ImageBoard(created);
        vm.prank(BUYER);
        usd.approve(address(board), type(uint256).max);
        vm.prank(BUYER);
        board.buyBlocks(BUYER, _list(_rect(0, 1, 256, 1)));
        _write('{"kind":"board","gridCols":256,"gridRows":3,"sold":[[0,1,256,1]]}');

        uint16[4][9] memory rects = [
            [uint16(0), 0, 256, 1], // a whole free row
            [uint16(0), 2, 256, 1],
            [uint16(0), 1, 1, 1], // the sold row's first cell
            [uint16(255), 1, 1, 1], // and its last
            [uint16(255), 0, 1, 1], // the last column, free
            [uint16(0), 0, 256, 3], // the whole grid, through the sold row
            [uint16(1), 0, 256, 1], // one past the right edge
            [uint16(255), 0, 2, 1],
            [uint16(256), 0, 1, 1]
        ];
        for (uint256 i = 0; i < rects.length; i++) {
            bytes4 err = board.blockError(rects[i][0], rects[i][1], rects[i][2], rects[i][3]);
            _write(
                string.concat(
                    '{"kind":"rect","col":',
                    vm.toString(rects[i][0]),
                    ',"row":',
                    vm.toString(rects[i][1]),
                    ',"cols":',
                    vm.toString(rects[i][2]),
                    ',"rows":',
                    vm.toString(rects[i][3]),
                    ',"error":"',
                    _errorName(err),
                    '"}'
                )
            );
        }
    }

    // -----------------------------------------------------------------
    // Zones and kept blocks
    // -----------------------------------------------------------------

    function _zone(uint16 c, uint16 r, uint16 w, uint16 h, uint192 p) internal pure returns (ImageBoard.Zone memory) {
        return ImageBoard.Zone({ col: c, row: r, cols: w, rows: h, cellPrice: p });
    }

    function _rect(uint16 c, uint16 r, uint16 w, uint16 h) internal pure returns (ImageBoard.Rect memory) {
        return ImageBoard.Rect({ col: c, row: r, cols: w, rows: h });
    }

    function _zonesJson(ImageBoard.Zone[] memory z) internal pure returns (string memory out) {
        out = "[";
        for (uint256 i = 0; i < z.length; i++) {
            out = string.concat(
                out,
                i == 0 ? "[" : ",[",
                vm.toString(z[i].col),
                ",",
                vm.toString(z[i].row),
                ",",
                vm.toString(z[i].cols),
                ",",
                vm.toString(z[i].rows),
                ',"',
                vm.toString(uint256(z[i].cellPrice)),
                '"]'
            );
        }
        out = string.concat(out, "]");
    }

    function _keptJson(ImageBoard.Rect[] memory k) internal pure returns (string memory out) {
        out = "[";
        for (uint256 i = 0; i < k.length; i++) {
            out = string.concat(
                out,
                i == 0 ? "[" : ",[",
                vm.toString(k[i].col),
                ",",
                vm.toString(k[i].row),
                ",",
                vm.toString(k[i].cols),
                ",",
                vm.toString(k[i].rows),
                "]"
            );
        }
        out = string.concat(out, "]");
    }

    function _layoutCase(ImageBoard.Zone[] memory zones, ImageBoard.Rect[] memory kept) internal {
        ImageBoard.Config memory cfg = _config(125, 104, 10);
        cfg.zones = zones;
        cfg.kept = kept;
        string memory err = "none";
        try collection.createBoardFor(SELLER, cfg) { }
        catch (bytes memory reason) {
            bytes4 sel = bytes4(reason);
            if (sel == ImageBoard.InvalidConfig.selector) err = "InvalidConfig";
            else err = _errorName(sel);
        }
        _write(string.concat('{"kind":"layout","zones":', _zonesJson(zones), ',"kept":', _keptJson(kept), ',"error":"', err, '"}'));
    }

    /// On a 12×10 grid. Each case names the boundary it sits on.
    function _emitLayouts() internal {
        ImageBoard.Zone[] memory z;
        ImageBoard.Rect[] memory k = new ImageBoard.Rect[](0);
        ImageBoard.Zone[] memory none = new ImageBoard.Zone[](0);

        _layoutCase(none, k); // the default
        z = new ImageBoard.Zone[](1);
        z[0] = _zone(8, 7, 4, 3, 5); // ends exactly on both edges
        _layoutCase(z, k);
        z[0] = _zone(9, 0, 4, 1, 5); // one column past
        _layoutCase(z, k);
        z[0] = _zone(0, 8, 1, 3, 5); // one row past
        _layoutCase(z, k);
        z[0] = _zone(0, 0, 0, 1, 5); // empty
        _layoutCase(z, k);
        z[0] = _zone(0, 0, 1, 0, 5);
        _layoutCase(z, k);
        z[0] = _zone(0, 0, 1, 1, 0); // free
        _layoutCase(z, k);
        z[0] = _zone(0, 0, 1, 1, 1); // the smallest price
        _layoutCase(z, k);

        z = new ImageBoard.Zone[](2);
        z[0] = _zone(0, 0, 3, 3, 5);
        z[1] = _zone(3, 0, 3, 3, 9); // touching on the right
        _layoutCase(z, k);
        z[1] = _zone(0, 3, 3, 3, 9); // touching below
        _layoutCase(z, k);
        z[1] = _zone(2, 2, 3, 3, 9); // sharing one corner cell
        _layoutCase(z, k);
        z[1] = _zone(1, 1, 1, 1, 9); // inside the first
        _layoutCase(z, k);
        z[0] = _zone(1, 1, 1, 1, 9); // and the other way round
        z[1] = _zone(0, 0, 3, 3, 5);
        _layoutCase(z, k);

        k = new ImageBoard.Rect[](2);
        k[0] = _rect(0, 0, 2, 2);
        k[1] = _rect(2, 0, 2, 2); // touching
        _layoutCase(none, k);
        k[1] = _rect(1, 1, 2, 2); // overlapping
        _layoutCase(none, k);
        k[1] = _rect(11, 9, 2, 1); // one past
        _layoutCase(none, k);
        k[1] = _rect(11, 9, 1, 1); // the last cell
        _layoutCase(none, k);
        k[1] = _rect(5, 5, 0, 1); // empty
        _layoutCase(none, k);

        // A zone over a kept block is allowed; a bad zone is refused before any kept block is looked at.
        z = new ImageBoard.Zone[](1);
        z[0] = _zone(0, 0, 4, 4, 5);
        k[1] = _rect(4, 4, 1, 1);
        _layoutCase(z, k);
        z[0] = _zone(0, 0, 13, 1, 5);
        k[1] = _rect(1, 1, 2, 2);
        _layoutCase(z, k);
    }

    function _emitZonedQuotes(uint256 priceBps) internal {
        ImageBoard.Config memory cfg = _config(125, 104, 10);
        cfg.cellPrice = 7;
        cfg.zones = new ImageBoard.Zone[](3);
        cfg.zones[0] = _zone(0, 0, 4, 3, 13);
        cfg.zones[1] = _zone(6, 4, 3, 5, 3);
        cfg.zones[2] = _zone(9, 7, 3, 3, uint192(2 ** 150 + 1));
        cfg.kept = new ImageBoard.Rect[](2);
        cfg.kept[0] = _rect(10, 8, 2, 2);
        cfg.kept[1] = _rect(4, 0, 2, 1);
        (address created,) = collection.createBoardFor(SELLER, cfg);
        ImageBoard board = ImageBoard(created);
        if (priceBps < 10_000) {
            vm.prank(SELLER);
            board.lowerPrices(priceBps);
        }
        _write(
            string.concat(
                '{"kind":"zoned","gridCols":12,"gridRows":10,"cellPrice":"7","priceBps":',
                vm.toString(priceBps),
                ',"zones":',
                _zonesJson(cfg.zones),
                ',"kept":',
                _keptJson(cfg.kept),
                "}"
            )
        );

        uint16[2][6] memory sizes = [[uint16(1), 1], [uint16(2), 2], [uint16(3), 2], [uint16(5), 1], [uint16(1), 4], [uint16(4), 4]];
        for (uint16 col = 0; col < 12; col++) {
            for (uint16 row = 0; row < 10; row++) {
                for (uint256 s = 0; s < sizes.length; s++) {
                    uint16 w = sizes[s][0];
                    uint16 h = sizes[s][1];
                    if (col + w > 12 || row + h > 10) continue;
                    _write(
                        string.concat(
                            '{"kind":"quote","col":',
                            vm.toString(col),
                            ',"row":',
                            vm.toString(row),
                            ',"cols":',
                            vm.toString(w),
                            ',"rows":',
                            vm.toString(h),
                            ',"total":"',
                            vm.toString(board.quote(col, row, w, h)),
                            '","error":"',
                            _errorName(board.blockError(col, row, w, h)),
                            '"}'
                        )
                    );
                }
            }
        }
    }

    function _list(ImageBoard.Rect memory a) internal pure returns (ImageBoard.Rect[] memory l) {
        l = new ImageBoard.Rect[](1);
        l[0] = a;
    }

    function _list(ImageBoard.Rect memory a, ImageBoard.Rect memory b) internal pure returns (ImageBoard.Rect[] memory l) {
        l = new ImageBoard.Rect[](2);
        l[0] = a;
        l[1] = b;
    }

    /// Each case on a fresh board, so a buy that lands cannot change the next case's answer.
    function _multiCase(ImageBoard.Rect[] memory rects) internal {
        (address created,) = collection.createBoardFor(SELLER, _config(125, 104, 10));
        ImageBoard board = ImageBoard(created);
        vm.prank(BUYER);
        usd.approve(address(board), type(uint256).max);
        vm.prank(BUYER);
        board.buyBlocks(BUYER, _list(_rect(2, 2, 3, 2)));
        string memory err = "none";
        vm.prank(BUYER);
        try board.buyBlocks(BUYER, rects) { }
        catch (bytes memory reason) {
            err = _errorName(bytes4(reason));
        }
        _write(string.concat('{"kind":"multi","rects":', _keptJson(rects), ',"error":"', err, '"}'));
    }

    function _emitMultiBuys() internal {
        _write('{"kind":"multiBoard","gridCols":12,"gridRows":10,"sold":[[2,2,3,2]]}');
        _multiCase(new ImageBoard.Rect[](0)); // nothing to buy
        _multiCase(_list(_rect(0, 0, 1, 1))); // one
        _multiCase(_list(_rect(0, 0, 1, 1), _rect(6, 6, 2, 2))); // apart
        _multiCase(_list(_rect(0, 0, 2, 2), _rect(2, 0, 2, 2))); // touching
        _multiCase(_list(_rect(0, 0, 2, 2), _rect(1, 1, 2, 2))); // sharing a cell with each other
        _multiCase(_list(_rect(0, 0, 1, 1), _rect(0, 0, 1, 1))); // the same rectangle twice
        _multiCase(_list(_rect(0, 0, 1, 1), _rect(4, 3, 1, 1))); // the second on the sold block
        _multiCase(_list(_rect(0, 0, 1, 1), _rect(11, 9, 2, 1))); // the second leaves the grid
        _multiCase(_list(_rect(0, 0, 1, 1), _rect(5, 5, 0, 1))); // the second empty
        _multiCase(_list(_rect(4, 3, 1, 1), _rect(20, 0, 1, 1))); // both bad: the first names it
        _multiCase(_list(_rect(20, 0, 1, 1), _rect(4, 3, 1, 1))); // and the other way round
    }

    function _errorName(bytes4 err) internal pure returns (string memory) {
        if (err == bytes4(0)) return "none";
        if (err == ImageBoard.EmptyBlock.selector) return "EmptyBlock";
        if (err == ImageBoard.OutsideGrid.selector) return "OutsideGrid";
        if (err == ImageBoard.CellsTaken.selector) return "CellsTaken";
        revert("unknown blockError");
    }

    function _write(string memory line) internal {
        vm.writeLine(OUT_PATH, line);
        lines++;
    }
}
