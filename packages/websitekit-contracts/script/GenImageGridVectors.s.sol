// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { ImageBoard } from "../src/ImageBoard.sol";
import { ImageBoardStorage } from "../src/ImageBoardStorage.sol";
import { ImageBoardReads } from "../test/ImageBoardReads.sol";
import { ImageBoardCollection } from "../src/ImageBoardCollection.sol";
import { ImageBoardExtension } from "../src/ImageBoardExtension.sol";
import { ImageBoardRenderer } from "../src/ImageBoardRenderer.sol";
import { TermsLib } from "../src/TermsLib.sol";
import { TestUSD } from "../src/mocks/TestUSD.sol";

using ImageBoardReads for ImageBoard;

/// @notice The image-board grid rule as JSONL, for the TypeScript twin to assert against
/// (`packages/websitekit-sdk/src/image-grid.ts`). Written to `out/image-grid-vectors.jsonl` via `vm.writeLine`.
///
/// By `kind`:
///
///   - `grid`   — `(width, height, cellSize)` → `(gridCols, gridRows)` or `InvalidConfig`, read off
///                a REAL board the collection created (or refused), not recomputed here.
///   - `layout` — the board's price and its zones → the error `initialize` reverts with, or `none`,
///                from a real `createBoardFor` on a 12×10 grid (2026-10-11). Every refusal at its
///                boundary; since kept squares (2026-10-24) a price of zero is a case too, and a
///                board with nothing left for sale is refused.
///   - `terms`  — a board's five take terms → the error `initialize` reverts with (TermsLib's), or
///                `none`, at every clamp and one past it (2026-10-14).
///   - `state`  — everything the twin prices a buy against, READ off a real board at one moment:
///                the grid, prices, zones, terms, the chain's clock, every
///                non-zero row of `cellRow`, and each block's owner, level and `boughtAt`. The lines
///                after it are against that state.
///   - `rect`   — `(col, row, cols, rows)` → `blockError`'s answer and `quote`'s total (zero when
///                refused), for every rectangle of nine shapes at every origin.
///   - `multi`  — a list of rectangles → `buyError`'s answer and `quoteBlocks`' total, each also
///                bought for real on a snapshot, asserting the buy reverts with the same error or
///                pulls exactly that total.
///   - `cid`    — a hash or binary CID → the string the renderer writes in metadata (`rawCid`,
///                `cidOf`, spec §13.7), for the SDK's `contentHashToCid` and `cidBytesToString`.
///
/// Since takeovers (2026-10-14) the states come from a "market" board built by real buys at real
/// times — blocks taken in part, taken twice, one in its cooldown, zones (one priced near 2^150, so a twin computing in floating point fails), reversion
/// partway and past its last week, free squares cut to 3,333 bps — and a board 256 × 600 with 130
/// one-cell blocks and one wide block in a row, for the word and block caps at their boundaries; and
/// a board whose reversion stops after two weeks, swept week by week past it. Since kept squares
/// (2026-10-24) the market board keeps a zone priced zero, and a board priced zero sells only two
/// touching zones in its corner — swept while its one block cools and after.
///
/// No RNG: re-running emits the same file.
contract GenImageGridVectors is Script {
    string internal constant OUT_PATH = "out/image-grid-vectors.jsonl";
    /// Fixed parties: a script contract's own address is ephemeral, and forge refuses it.
    address internal constant SELLER = address(0x5E11);
    address internal constant BUYER = address(0xB0B);
    address internal constant B1 = address(0xB1);
    address internal constant B2 = address(0xB2);
    address internal constant B3 = address(0xB3);
    uint256 internal constant HOUR = 3_600;
    uint256 internal constant T0 = 1_800_000_000;

    TestUSD internal usd;
    ImageBoardCollection internal collection;
    uint256 internal lines;

    function run() external {
        vm.writeFile(OUT_PATH, "");
        vm.warp(T0);
        // 60 decimals, so one mint covers buying cells in the zone priced near 2^150.
        usd = new TestUSD("Vector Dollar", "vUSD", 60);
        ImageBoardRenderer renderer = new ImageBoardRenderer("https://example.com/i/boards/", "ipfs://bafyrenderer/");
        ImageBoard implementation =
            new ImageBoard(address(new ImageBoardExtension(500, address(0xBEEF))), address(renderer));
        address[] memory tokens = new address[](1);
        tokens[0] = address(usd);
        collection =
            new ImageBoardCollection("Vector Image Boards", "VIMG", SELLER, address(implementation), tokens, "");

        _emitGrids();
        _emitLayouts();
        _emitTerms();
        _emitMarket();
        _emitShortReversion();
        _emitCorner();
        _emitCaps();
        _emitCids(renderer);
        console2.log("GenImageGridVectors: lines", lines);
    }

    function _standard() internal pure returns (ImageBoardStorage.Terms memory) {
        return ImageBoardStorage.Terms({
            takeBps: 14_000, payoutBps: 11_500, reversionBps: 9_700, maxReversionWeeks: 52, cooldownSecs: 3_600
        });
    }

    function _config(uint32 w, uint32 h, uint8 cell) internal view returns (ImageBoardStorage.Config memory cfg) {
        cfg.settlementToken = address(usd);
        cfg.width = w;
        cfg.height = h;
        cfg.cellSize = cell;
        cfg.cellPrice = 1;
        cfg.imageHash = keccak256("v");
        cfg.sourceCid = hex"0155122000";
        cfg.name = "Vector board";
        cfg.terms = _standard();
    }

    function _emitGrids() internal {
        uint32[3][28] memory cases = [
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
            [uint32(100), 100, 12], // any whole size in the range (2026-10-20), not only 10, 15 or 20
            [uint32(100), 100, 9], // one under MIN_CELL_SIZE → refused
            [uint32(100), 100, 5], // rejected in §2
            [uint32(200), 200, 200], // MAX_CELL_SIZE, one cell
            [uint32(1000), 1000, 199],
            [uint32(1000), 1000, 201], // one over MAX_CELL_SIZE → refused
            [uint32(1000), 1000, 255], // the most a uint8 holds → refused
            [uint32(51_399), 400, 200], // 256 across at 200
            [uint32(51_400), 400, 200] // 257 at 200 → refused
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
            try collection.createBoardFor(SELLER, abi.encode(_config(w, h, cell))) returns (address b, uint256) {
                (uint16 c, uint16 r) = ImageBoard(b).gridSize();
                _write(
                    string.concat(
                        head, ',"gridCols":', vm.toString(c), ',"gridRows":', vm.toString(r), ',"error":"none"}'
                    )
                );
            } catch (bytes memory reason) {
                require(bytes4(reason) == ImageBoardStorage.InvalidConfig.selector, "unexpected refusal");
                _write(string.concat(head, ',"error":"InvalidConfig"}'));
            }
        }
    }

    // -----------------------------------------------------------------
    // Zones
    // -----------------------------------------------------------------

    function _zone(uint16 c, uint16 r, uint16 w, uint16 h, uint192 p)
        internal
        pure
        returns (ImageBoardStorage.Zone memory)
    {
        return ImageBoardStorage.Zone({ col: c, row: r, cols: w, rows: h, cellPrice: p });
    }

    function _rect(uint16 c, uint16 r, uint16 w, uint16 h) internal pure returns (ImageBoardStorage.Rect memory) {
        return ImageBoardStorage.Rect({ col: c, row: r, cols: w, rows: h });
    }

    function _zonesJson(ImageBoardStorage.Zone[] memory z) internal pure returns (string memory out) {
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

    function _rectsJson(ImageBoardStorage.Rect[] memory k) internal pure returns (string memory out) {
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

    function _layoutCase(ImageBoardStorage.Zone[] memory zones) internal {
        _layoutCase(1, zones);
    }

    function _layoutCase(uint256 cellPrice, ImageBoardStorage.Zone[] memory zones) internal {
        ImageBoardStorage.Config memory cfg = _config(125, 104, 10);
        cfg.cellPrice = cellPrice;
        cfg.zones = zones;
        string memory err = "none";
        try collection.createBoardFor(SELLER, abi.encode(cfg)) { }
        catch (bytes memory reason) {
            bytes4 sel = bytes4(reason);
            if (sel == ImageBoardStorage.InvalidConfig.selector) err = "InvalidConfig";
            else err = _errorName(sel);
        }
        _write(
            string.concat(
                '{"kind":"layout","cellPrice":"',
                vm.toString(cellPrice),
                '","zones":',
                _zonesJson(zones),
                ',"error":"',
                err,
                '"}'
            )
        );
    }

    /// On a 12×10 grid. Each case names the boundary it sits on.
    function _emitLayouts() internal {
        ImageBoardStorage.Zone[] memory z;
        ImageBoardStorage.Zone[] memory none = new ImageBoardStorage.Zone[](0);

        _layoutCase(none); // the default
        z = new ImageBoardStorage.Zone[](1);
        z[0] = _zone(8, 7, 4, 3, 5); // ends exactly on both edges
        _layoutCase(z);
        z[0] = _zone(9, 0, 4, 1, 5); // one column past
        _layoutCase(z);
        z[0] = _zone(0, 8, 1, 3, 5); // one row past
        _layoutCase(z);
        z[0] = _zone(0, 0, 0, 1, 5); // empty
        _layoutCase(z);
        z[0] = _zone(0, 0, 1, 0, 5);
        _layoutCase(z);
        z[0] = _zone(0, 0, 1, 1, 0); // kept
        _layoutCase(z);
        z[0] = _zone(0, 0, 1, 1, 1); // the smallest price
        _layoutCase(z);

        z = new ImageBoardStorage.Zone[](2);
        z[0] = _zone(0, 0, 3, 3, 5);
        z[1] = _zone(3, 0, 3, 3, 9); // touching on the right
        _layoutCase(z);
        z[1] = _zone(0, 3, 3, 3, 9); // touching below
        _layoutCase(z);
        z[1] = _zone(2, 2, 3, 3, 9); // sharing one corner cell
        _layoutCase(z);
        z[1] = _zone(1, 1, 1, 1, 9); // inside the first
        _layoutCase(z);
        z[0] = _zone(1, 1, 1, 1, 9); // and the other way round
        z[1] = _zone(0, 0, 3, 3, 5);
        _layoutCase(z);

        // A bad zone among good ones is refused.
        z = new ImageBoardStorage.Zone[](2);
        z[0] = _zone(0, 0, 4, 4, 5);
        z[1] = _zone(0, 4, 13, 1, 5);
        _layoutCase(z);

        // Kept squares (2026-10-24): what is left for sale, at its boundary.
        _layoutCase(0, none); // a board priced zero with no zone sells nothing
        z = new ImageBoardStorage.Zone[](1);
        z[0] = _zone(0, 0, 3, 3, 0);
        _layoutCase(0, z); // nor with only a kept zone
        z[0] = _zone(11, 9, 1, 1, 1);
        _layoutCase(0, z); // one priced square is enough
        z[0] = _zone(0, 0, 12, 10, 0);
        _layoutCase(z); // a kept zone over the whole grid
        z[0] = _zone(0, 0, 12, 9, 0);
        _layoutCase(z); // all but the last row
        z[0] = _zone(9, 0, 4, 1, 5);
        _layoutCase(0, z); // a zone past the grid, on a board priced zero
    }

    // -----------------------------------------------------------------
    // Terms
    // -----------------------------------------------------------------

    function _termsCase(uint256 take, uint256 payout, uint256 reversion, uint256 weeks_, uint256 cooldown) internal {
        ImageBoardStorage.Config memory cfg = _config(125, 104, 10);
        cfg.terms = ImageBoardStorage.Terms(take, payout, reversion, weeks_, cooldown);
        string memory err = "none";
        try collection.createBoardFor(SELLER, abi.encode(cfg)) { }
        catch (bytes memory reason) {
            err = _termsErrorName(bytes4(reason));
        }
        _write(
            string.concat(
                '{"kind":"terms","takeBps":',
                vm.toString(take),
                ',"payoutBps":',
                vm.toString(payout),
                ',"reversionBps":',
                vm.toString(reversion),
                ',"maxReversionWeeks":',
                vm.toString(weeks_),
                ',"cooldownSecs":',
                vm.toString(cooldown),
                ',"error":"',
                err,
                '"}'
            )
        );
    }

    /// Each clamp of `TermsLib.checkEconomicsAbsolute`, at it and one past it, with a protocol cut of 500.
    function _emitTerms() internal {
        _termsCase(14_000, 11_500, 9_700, 52, 3_600); // Standard
        _termsCase(20_000, 16_000, 9_900, 52, 86_400); // Collector
        _termsCase(13_000, 11_000, 9_000, 12, 900); // Rotating
        _termsCase(12_000, 11_500, 9_700, 52, 3_600); // take = payout + cut
        _termsCase(12_001, 11_500, 9_700, 52, 3_600);
        _termsCase(40_000, 9_999, 9_700, 52, 3_600); // payout under the floor, checked first
        _termsCase(10_501, 10_000, 9_700, 52, 3_600); // payout exactly the floor
        _termsCase(30_000, 29_499, 9_700, 52, 3_600); // the most take
        _termsCase(30_001, 11_500, 9_700, 52, 3_600);
        _termsCase(30_000, 29_500, 9_700, 52, 3_600);
        _termsCase(14_000, 11_500, 0, 52, 3_600); // no reversion step
        _termsCase(14_000, 11_500, 1, 52, 3_600);
        _termsCase(14_000, 11_500, 10_000, 52, 3_600); // reversion that never moves
        _termsCase(14_000, 11_500, 10_001, 52, 3_600);
        _termsCase(14_000, 11_500, 9_700, 0, 3_600);
        _termsCase(14_000, 11_500, 9_700, 53, 3_600);
        _termsCase(14_000, 11_500, 9_700, 52, 0);
        _termsCase(14_000, 11_500, 9_700, 52, 604_800);
        _termsCase(14_000, 11_500, 9_700, 52, 604_801);
    }

    function _termsErrorName(bytes4 err) internal pure returns (string memory) {
        if (err == TermsLib.PayoutBelowPrincipal.selector) return "PayoutBelowPrincipal";
        if (err == TermsLib.TakeTooHigh.selector) return "TakeTooHigh";
        if (err == TermsLib.TakeBelowPayout.selector) return "TakeBelowPayout";
        if (err == TermsLib.InvalidReversion.selector) return "InvalidReversion";
        if (err == TermsLib.InvalidConfig.selector) return "InvalidConfig";
        revert("unknown terms error");
    }

    // -----------------------------------------------------------------
    // The market board: takes at real times
    // -----------------------------------------------------------------

    function _fund(ImageBoard board, address who) internal {
        usd.mint(who, 1e65);
        vm.prank(who);
        usd.approve(address(board), type(uint256).max);
    }

    function _buy(ImageBoard board, address who, uint16 c, uint16 r, uint16 w, uint16 h) internal {
        vm.prank(who);
        board.buyBlocks(who, _list(_rect(c, r, w, h)), type(uint256).max, block.timestamp);
    }

    function _emitMarket() internal {
        ImageBoardStorage.Config memory cfg = _config(125, 104, 10);
        cfg.cellPrice = 7;
        cfg.zones = new ImageBoardStorage.Zone[](4);
        cfg.zones[0] = _zone(0, 0, 4, 3, 13);
        cfg.zones[1] = _zone(6, 4, 3, 5, 3);
        cfg.zones[2] = _zone(9, 7, 3, 3, uint192(2 ** 150 + 1));
        cfg.zones[3] = _zone(4, 0, 2, 2, 0); // kept, beside zone 0
        (address created,) = collection.createBoardFor(SELLER, abi.encode(cfg));
        ImageBoard board = ImageBoard(created);
        _fund(board, B1);
        _fund(board, B2);
        _fund(board, B3);

        // Nothing sold yet.
        _emitState(board);
        _emitRect(board, _rect(10, 8, 1, 1));
        _emitRect(board, _rect(4, 0, 2, 1)); // kept
        _emitRect(board, _rect(3, 0, 3, 1)); // one cell of zone 0, then kept
        _emitRect(board, _rect(4, 2, 2, 1)); // just under the kept squares
        _emitRect(board, _rect(3, 2, 3, 1)); // zone 0 into the base, under them

        uint256 t0 = block.timestamp;
        _buy(board, B1, 0, 4, 3, 3); // 1: P
        _buy(board, B2, 8, 0, 4, 1); // 2: Q
        _buy(board, B3, 9, 6, 2, 2); // 3: in the 2^150 zone
        vm.warp(t0 + HOUR);
        _buy(board, B3, 1, 5, 3, 1); // 4: R, over P and free cells
        _buy(board, B1, 6, 4, 3, 3); // 5: S, in a zone
        vm.warp(t0 + 3 weeks);
        _buy(board, B1, 2, 5, 1, 2); // 6: W, over R and P: a block taken twice
        _buy(board, B2, 7, 5, 2, 2); // 7: U, over S
        _buy(board, B3, 0, 9, 1, 1); // 8: V
        _buy(board, B2, 10, 6, 1, 1); // 9: over the 2^150 block
        vm.prank(B2);
        board.transferFrom(B2, B1, 2); // Q, given away: an owner a take pays is the one now

        // Some blocks still cooling.
        vm.warp(t0 + 3 weeks + 30 minutes);
        _sweep(board, true);
        _emitMarketMultis(board);
        // Nothing cooling; reversion four weeks into R's level.
        vm.warp(t0 + 4 weeks + HOUR);
        _sweep(board, false);
        // Free squares cut, a block bought at the cut (its level under 10,000), and every block past
        // its last week of reversion.
        vm.prank(SELLER);
        board.lowerPrices(3_333);
        _buy(board, B3, 3, 8, 2, 1); // 10
        vm.warp(t0 + 60 weeks);
        _sweep(board, false);
    }

    /// Every rectangle of the shapes below at every origin — one past the grid too when `edges`.
    function _sweep(ImageBoard board, bool edges) internal {
        _emitState(board);
        uint16[2][9] memory sizes = [
            [uint16(1), 1],
            [uint16(2), 2],
            [uint16(3), 2],
            [uint16(5), 1],
            [uint16(1), 4],
            [uint16(4), 4],
            [uint16(12), 10],
            [uint16(0), 1],
            [uint16(1), 0]
        ];
        (uint16 gc, uint16 gr) = board.gridSize();
        for (uint16 col = 0; col <= gc; col++) {
            for (uint16 row = 0; row <= gr; row++) {
                for (uint256 i = 0; i < sizes.length; i++) {
                    uint16 w = sizes[i][0];
                    uint16 h = sizes[i][1];
                    if (!edges && (col + w > gc || row + h > gr || w == 0 || h == 0)) continue;
                    _emitRect(board, _rect(col, row, w, h));
                }
            }
        }
    }

    function _emitRect(ImageBoard board, ImageBoardStorage.Rect memory k) internal {
        bytes4 err = board.blockError(k.col, k.row, k.cols, k.rows);
        uint256 total = err == bytes4(0) ? board.quote(k.col, k.row, k.cols, k.rows) : 0;
        _write(
            string.concat(
                '{"kind":"rect","col":',
                vm.toString(k.col),
                ',"row":',
                vm.toString(k.row),
                ',"cols":',
                vm.toString(k.cols),
                ',"rows":',
                vm.toString(k.rows),
                ',"error":"',
                _errorName(err),
                '","total":"',
                vm.toString(total),
                '"}'
            )
        );
    }

    function _emitMarketMultis(ImageBoard board) internal {
        _multiCase(board, new ImageBoardStorage.Rect[](0)); // nothing to buy
        _multiCase(board, _list(_rect(0, 0, 1, 1))); // one free
        _multiCase(board, _list(_rect(0, 0, 1, 1), _rect(0, 4, 2, 3))); // free, and a take over two blocks
        _multiCase(board, _list(_rect(0, 0, 2, 2), _rect(2, 0, 2, 2))); // touching
        _multiCase(board, _list(_rect(0, 0, 2, 2), _rect(1, 1, 2, 2))); // sharing a cell with each other
        _multiCase(board, _list(_rect(0, 0, 1, 1), _rect(0, 0, 1, 1))); // the same rectangle twice
        _multiCase(board, _list(_rect(0, 4, 1, 1), _rect(1, 4, 1, 1))); // the same block from two rectangles
        _multiCase(board, _list(_rect(0, 0, 1, 1), _rect(7, 5, 1, 1))); // the second on a cooling block
        _multiCase(board, _list(_rect(0, 0, 1, 1), _rect(8, 0, 2, 1))); // the second on a block given away
        _multiCase(board, _list(_rect(0, 0, 1, 1), _rect(11, 9, 2, 1))); // the second leaves the grid
        _multiCase(board, _list(_rect(0, 0, 1, 1), _rect(5, 5, 0, 1))); // the second empty
        _multiCase(board, _list(_rect(7, 5, 1, 1), _rect(20, 0, 1, 1))); // both bad: the first names it
        _multiCase(board, _list(_rect(20, 0, 1, 1), _rect(7, 5, 1, 1))); // and the other way round
        _multiCase(board, _list(_rect(0, 0, 1, 1), _rect(4, 0, 1, 1))); // the second kept
        _multiCase(board, _list(_rect(4, 1, 1, 1), _rect(7, 5, 1, 1))); // kept, then cooling: kept names it
        _multiCase(board, _list(_rect(7, 5, 1, 1), _rect(4, 1, 1, 1))); // and the other way round
        _multiCase(board, _list(_rect(4, 0, 4, 6))); // one rectangle over kept squares and a cooling block
        _multiCase(board, _list(_rect(0, 0, 2, 2), _rect(1, 0, 5, 1))); // overlapping the first, and kept
    }

    /// A board priced zero that sells only its corner: two touching priced zones, one block bought
    /// in them. A take over the block covers priced cells only, so it is never refused as kept.
    function _emitCorner() internal {
        ImageBoardStorage.Config memory cfg = _config(125, 104, 10);
        cfg.cellPrice = 0;
        cfg.zones = new ImageBoardStorage.Zone[](2);
        cfg.zones[0] = _zone(8, 7, 4, 3, 11);
        cfg.zones[1] = _zone(6, 7, 2, 3, 3);
        (address created,) = collection.createBoardFor(SELLER, abi.encode(cfg));
        ImageBoard board = ImageBoard(created);
        _fund(board, B1);
        _fund(board, B2);
        _buy(board, B1, 7, 8, 3, 1); // across both zones
        _sweep(board, true);
        _multiCase(board, _list(_rect(6, 7, 6, 3))); // both zones, over the cooling block
        _multiCase(board, _list(_rect(6, 7, 1, 1), _rect(11, 9, 1, 1)));
        _multiCase(board, _list(_rect(6, 7, 1, 1), _rect(5, 7, 1, 1))); // the second one column outside
        vm.warp(block.timestamp + HOUR);
        _sweep(board, false);
        _multiCase(board, _list(_rect(6, 7, 6, 3))); // the same, now a take
    }

    /// The view's answer, then the same list bought for real on a snapshot: the buy must revert with
    /// that error, or pull exactly that total.
    function _multiCase(ImageBoard board, ImageBoardStorage.Rect[] memory rects) internal {
        bytes4 err = board.buyError(rects);
        uint256 total = err == bytes4(0) ? board.quoteBlocks(rects) : 0;
        uint256 snap = vm.snapshotState();
        uint256 before = usd.balanceOf(B1);
        vm.prank(B1);
        try board.buyBlocks(B1, rects, type(uint256).max, block.timestamp) {
            require(err == bytes4(0), "the view refused what the buy took");
            require(before - usd.balanceOf(B1) == total, "the buy pulled other than the quote");
        } catch (bytes memory reason) {
            require(bytes4(reason) == err, "the buy refused with another error");
        }
        vm.revertToState(snap);
        _write(
            string.concat(
                '{"kind":"multi","rects":',
                _rectsJson(rects),
                ',"error":"',
                _errorName(err),
                '","total":"',
                vm.toString(total),
                '"}'
            )
        );
    }

    /// Terms whose reversion stops after two weeks: past them a taken block's floor holds, which a
    /// board reverting for 52 weeks never shows (its floors reach the creation price first).
    function _emitShortReversion() internal {
        ImageBoardStorage.Config memory cfg = _config(125, 104, 10);
        cfg.cellPrice = 1_000_003;
        cfg.terms = ImageBoardStorage.Terms({
            takeBps: 14_000, payoutBps: 11_500, reversionBps: 9_900, maxReversionWeeks: 2, cooldownSecs: 3_600
        });
        (address created,) = collection.createBoardFor(SELLER, abi.encode(cfg));
        ImageBoard board = ImageBoard(created);
        _fund(board, B1);
        _fund(board, B2);
        _buy(board, B1, 0, 0, 2, 2);
        vm.warp(block.timestamp + HOUR);
        _buy(board, B2, 0, 0, 1, 2); // level 14,000
        uint256 bought = block.timestamp;
        for (uint256 w = 0; w <= 4; w++) {
            vm.warp(bought + w * 1 weeks + HOUR);
            _emitState(board);
            _emitRect(board, _rect(0, 0, 1, 1));
            _emitRect(board, _rect(0, 0, 2, 2));
            _emitRect(board, _rect(0, 0, 3, 3));
        }
    }

    // -----------------------------------------------------------------
    // The caps
    // -----------------------------------------------------------------

    function _emitCaps() internal {
        // 2560 × 6000 at 10 px → 256 × 600.
        (address created,) = collection.createBoardFor(SELLER, abi.encode(_config(2560, 6000, 10)));
        ImageBoard board = ImageBoard(created);
        _fund(board, B1);
        ImageBoardStorage.Rect[] memory ones = new ImageBoardStorage.Rect[](130);
        for (uint16 i = 0; i < 130; i++) {
            ones[i] = _rect(i, 20, 1, 1);
        }
        vm.prank(B1);
        board.buyBlocks(B1, ones, type(uint256).max, block.timestamp);
        vm.prank(B1);
        board.buyBlocks(B1, _list(_rect(130, 20, 126, 1)), type(uint256).max, block.timestamp); // one wide block
        vm.warp(block.timestamp + HOUR);
        _emitState(board);

        _emitRect(board, _rect(0, 20, 88, 1)); // 88 blocks, the cap (2026-10-20: 128 before rentals)
        _emitRect(board, _rect(0, 20, 89, 1)); // 89
        _emitRect(board, _rect(0, 20, 256, 2)); // 131, among free cells
        _emitRect(board, _rect(0, 19, 88, 3)); // 88, among free cells
        _emitRect(board, _rect(0, 0, 256, 16)); // 512 words
        _emitRect(board, _rect(0, 0, 256, 17)); // 544
        _emitRect(board, _rect(0, 0, 1, 512)); // a column of 512
        _emitRect(board, _rect(0, 0, 1, 513));
        _emitRect(board, _rect(4, 0, 8, 256)); // straddling two words a row: 512
        _emitRect(board, _rect(4, 0, 8, 257));
        _emitRect(board, _rect(8, 0, 8, 512)); // aligned: one word a row
        _emitRect(board, _rect(8, 0, 8, 513));

        _multiCase(board, _list(_rect(0, 20, 44, 1), _rect(44, 20, 44, 1))); // 88 across two
        _multiCase(board, _list(_rect(0, 20, 44, 1), _rect(44, 20, 45, 1))); // 89 across two
        _multiCase(board, _list(_rect(0, 0, 256, 8), _rect(0, 8, 256, 8))); // 512 words across two
        _multiCase(board, _list(_rect(0, 0, 256, 8), _rect(0, 8, 256, 9))); // 544
        // The word cap is checked before the second rectangle's blocks are counted.
        _multiCase(board, _list(_rect(0, 30, 256, 16), _rect(0, 20, 1, 1)));
        // And after its overlap with the first.
        _multiCase(board, _list(_rect(0, 30, 256, 16), _rect(0, 30, 1, 1)));
        // Blocks are counted across every rectangle: 29 + 30 + 30, and 29 + 29 + 30.
        _multiCase(board, _list3(_rect(0, 20, 29, 1), _rect(29, 20, 30, 1), _rect(59, 20, 30, 1)));
        _multiCase(board, _list3(_rect(0, 20, 29, 1), _rect(29, 20, 29, 1), _rect(58, 20, 30, 1)));
        // ... once in each rectangle that meets them: the wide block in two is two of 89.
        _multiCase(board, _list3(_rect(66, 20, 65, 1), _rect(131, 20, 1, 1), _rect(0, 20, 23, 1)));
        _multiCase(board, _list3(_rect(66, 20, 65, 1), _rect(131, 20, 1, 1), _rect(0, 20, 22, 1)));
    }

    // -----------------------------------------------------------------
    // State
    // -----------------------------------------------------------------

    /// What the twin needs, read off the board now: never what the script meant to build.
    function _emitState(ImageBoard board) internal {
        (uint16 gc, uint16 gr) = board.gridSize();
        string memory head = string.concat(
            '{"kind":"state","gridCols":',
            vm.toString(gc),
            ',"gridRows":',
            vm.toString(gr),
            ',"cellPrice":"',
            vm.toString(board.cellPrice()),
            '","priceBps":',
            vm.toString(board.priceBps()),
            ',"zones":',
            _zonesJson(board.zones()),
            ',"terms":',
            _termsJson(board),
            ',"now":"',
            vm.toString(block.timestamp),
            '"'
        );
        _write(string.concat(head, ',"rows":', _rowsJson(board, gr), ',"blocks":', _blocksJson(board), "}"));
    }

    function _termsJson(ImageBoard board) internal view returns (string memory) {
        return string.concat(
            '{"takeBps":',
            vm.toString(board.takeBps()),
            ',"payoutBps":',
            vm.toString(board.payoutBps()),
            ',"reversionBps":',
            vm.toString(board.reversionBps()),
            ',"maxReversionWeeks":',
            vm.toString(board.maxReversionWeeks()),
            ',"cooldownSecs":',
            vm.toString(board.cooldownSecs()),
            "}"
        );
    }

    /// `[[row, ["word", …]], …]` for every row with a cell held; the rest are all zero.
    function _rowsJson(ImageBoard board, uint16 gr) internal view returns (string memory out) {
        out = "[";
        bool first = true;
        for (uint256 r = 0; r < gr; r++) {
            uint256[] memory words = board.cellRow(r);
            bool any;
            string memory ws = "[";
            for (uint256 i = 0; i < words.length; i++) {
                if (words[i] != 0) any = true;
                ws = string.concat(ws, i == 0 ? '"' : ',"', vm.toString(words[i]), '"');
            }
            if (!any) continue;
            out = string.concat(out, first ? "[" : ",[", vm.toString(r), ",", ws, "]]");
            first = false;
        }
        out = string.concat(out, "]");
    }

    /// `[[id, "owner", "level", "boughtAt", col, row, cols, rows], …]` for every block.
    function _blocksJson(ImageBoard board) internal view returns (string memory out) {
        out = "[";
        uint256 n = board.blockCount();
        for (uint256 id = 1; id <= n; id++) {
            ImageBoardStorage.Block memory b = board.blockOf(id);
            out = string.concat(
                out,
                id == 1 ? "[" : ",[",
                vm.toString(id),
                ',"',
                vm.toString(board.ownerOf(id)),
                '","',
                vm.toString(uint256(b.level)),
                '","',
                vm.toString(uint256(b.boughtAt)),
                '",',
                _rectJson(b)
            );
        }
        out = string.concat(out, "]");
    }

    function _rectJson(ImageBoardStorage.Block memory b) internal pure returns (string memory) {
        return string.concat(
            vm.toString(b.col), ",", vm.toString(b.row), ",", vm.toString(b.cols), ",", vm.toString(b.rows), "]"
        );
    }

    function _list(ImageBoardStorage.Rect memory a) internal pure returns (ImageBoardStorage.Rect[] memory l) {
        l = new ImageBoardStorage.Rect[](1);
        l[0] = a;
    }

    function _list(ImageBoardStorage.Rect memory a, ImageBoardStorage.Rect memory b)
        internal
        pure
        returns (ImageBoardStorage.Rect[] memory l)
    {
        l = new ImageBoardStorage.Rect[](2);
        l[0] = a;
        l[1] = b;
    }

    function _list3(ImageBoardStorage.Rect memory a, ImageBoardStorage.Rect memory b, ImageBoardStorage.Rect memory c)
        internal
        pure
        returns (ImageBoardStorage.Rect[] memory l)
    {
        l = new ImageBoardStorage.Rect[](3);
        l[0] = a;
        l[1] = b;
        l[2] = c;
    }

    // -----------------------------------------------------------------
    // Addresses (spec §13.7)
    // -----------------------------------------------------------------

    /// What the renderer writes for a picture's hash and for a source's binary CID: the SDK's
    /// encoders must write the same. Hashes at the edges of the alphabet, and CIDs of every length
    /// mod 5 (base32 pads differently for each).
    function _emitCids(ImageBoardRenderer renderer) internal {
        bytes32[4] memory hashes = [bytes32(0), bytes32(type(uint256).max), sha256("hello"), keccak256("v")];
        for (uint256 i = 0; i < hashes.length; i++) {
            _write(
                string.concat(
                    '{"kind":"cid","hash":"', vm.toString(hashes[i]), '","cid":"', renderer.rawCid(hashes[i]), '"}'
                )
            );
        }
        bytes[6] memory cids = [
            bytes(hex"01"),
            hex"0170",
            hex"017012",
            hex"01701220",
            hex"0170122000",
            abi.encodePacked(hex"0170122020", sha256("source"))
        ];
        for (uint256 i = 0; i < cids.length; i++) {
            _write(
                string.concat(
                    '{"kind":"cid","bytes":"', vm.toString(cids[i]), '","cid":"', renderer.cidOf(cids[i]), '"}'
                )
            );
        }
    }

    function _errorName(bytes4 err) internal pure returns (string memory) {
        if (err == bytes4(0)) return "none";
        if (err == ImageBoardStorage.EmptyBlock.selector) return "EmptyBlock";
        if (err == ImageBoardStorage.OutsideGrid.selector) return "OutsideGrid";
        if (err == ImageBoardStorage.CellsTaken.selector) return "CellsTaken";
        if (err == ImageBoardStorage.CellsKept.selector) return "CellsKept";
        if (err == ImageBoardStorage.CoolingDown.selector) return "CoolingDown";
        if (err == ImageBoardStorage.TooLarge.selector) return "TooLarge";
        if (err == ImageBoardStorage.TooManyBlocks.selector) return "TooManyBlocks";
        revert("unknown buy error");
    }

    function _write(string memory line) internal {
        vm.writeLine(OUT_PATH, line);
        lines++;
    }
}
