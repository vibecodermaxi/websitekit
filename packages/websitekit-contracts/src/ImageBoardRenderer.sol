// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { LibString } from "solady/utils/LibString.sol";
import { Base64 } from "solady/utils/Base64.sol";

import { Pricing } from "./Pricing.sol";
import { ImageBoard } from "./ImageBoard.sol";
import { ImageBoardStorage } from "./ImageBoardStorage.sol";

/// @notice Builds every metadata string an image board answers with: its own token's (in the Boards
/// collection), its collection's, and each block's. `docs/IMAGE-BOARD-SPEC.md` §13.7–§13.8.
///
/// View-only, holding nothing but two strings fixed at deployment, and an immutable of every board
/// implementation that names it — so nobody can change how an existing board's metadata reads. A
/// fix reaches only boards created from a later implementation.
///
/// **Every picture is addressed by its hash** (spec §13.7): a block's `contentHash` is `sha256` of
/// the picture's bytes, which IS a CIDv1 raw block's address, written here as `b` + base32. The
/// source image is too large for one block, so its CID is the board's `sourceCid`.
///
/// **The board token's `image` is the one thing here that needs a server** (decided 2026-10-21):
/// `thumbnailBase ‖ boardTokenId ‖ "?v=" ‖ changes`, a composite drawn by whoever serves that base,
/// at a new address after every change. Its `animation_url`, every block's `image` and the
/// collection's `image` need only the chain and IPFS.
contract ImageBoardRenderer {
    using LibString for uint256;

    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant BPS_SQUARED = 100_000_000;
    uint256 internal constant CELLS_PER_WORD = 8;
    uint256 internal constant ID_BITS = 32;
    uint256 internal constant ID_MASK = type(uint32).max;

    /// @notice Where the board token's composite is drawn: its token id and `?v=` follow.
    string public thumbnailBase;
    /// @notice The reference renderer's page, an `ipfs://` address: `?chain=…&board=…` follow.
    string public rendererPage;

    constructor(string memory thumbnailBase_, string memory rendererPage_) {
        thumbnailBase = thumbnailBase_;
        rendererPage = rendererPage_;
    }

    // ---------------------------------------------------------------------
    // The three documents
    // ---------------------------------------------------------------------

    /// @notice The board's own token, in the Boards collection.
    function boardURI(address board) external view returns (string memory) {
        ImageBoard b = ImageBoard(board);
        string memory image = string.concat(thumbnailBase, b.boardTokenId().toString(), "?v=", b.changes().toString());
        return _data(
            string.concat(
                '{"name":',
                _q(b.name()),
                _description(b.description()),
                ',"image":',
                _q(image),
                ',"animation_url":',
                _q(_page(board)),
                ',"attributes":[',
                _boardTraits(b),
                "]}"
            )
        );
    }

    /// @notice ERC-7572, for the board's collection of blocks: its name and the original picture.
    function contractURI(address board) external view returns (string memory) {
        ImageBoard b = ImageBoard(board);
        return _data(
            string.concat(
                '{"name":', _q(b.name()), _description(b.description()), ',"image":', _q(string.concat("ipfs://", cidOf(b.sourceCid()))), "}"
            )
        );
    }

    /// @notice One block: the picture it shows now (the tenant's during a term, else the owner's;
    /// none while there is none), and the live view of the squares it still holds.
    function blockURI(address board, uint256 blockId) external view returns (string memory) {
        ImageBoard b = ImageBoard(board);
        bytes32 shown = b.shownHash(blockId);
        string memory image = shown == bytes32(0) ? "" : string.concat(',"image":', _q(string.concat("ipfs://", rawCid(shown))));
        return _data(
            string.concat(
                '{"name":',
                _q(string.concat(b.name(), " #", blockId.toString())),
                image,
                ',"animation_url":',
                _q(string.concat(_page(board), "&block=", blockId.toString())),
                ',"attributes":[',
                _blockTraits(b, blockId),
                "]}"
            )
        );
    }

    // ---------------------------------------------------------------------
    // Addresses (spec §13.7)
    // ---------------------------------------------------------------------

    /// @notice The CIDv1 of a raw block whose `sha256` is `hash`: `0x01 0x55 0x12 0x20 ‖ hash`, as
    /// `b` + RFC 4648 base32, lowercase, unpadded (`bafkrei…`).
    function rawCid(bytes32 hash) public pure returns (string memory) {
        return cidOf(abi.encodePacked(bytes4(0x01551220), hash));
    }

    /// @notice A binary CID as its base32 string.
    function cidOf(bytes memory cid) public pure returns (string memory) {
        return string.concat("b", _base32(cid));
    }

    function _base32(bytes memory data) internal pure returns (string memory) {
        bytes memory alphabet = "abcdefghijklmnopqrstuvwxyz234567";
        bytes memory out = new bytes((data.length * 8 + 4) / 5);
        uint256 buffer;
        uint256 bits;
        uint256 j;
        for (uint256 i = 0; i < data.length; i++) {
            buffer = (buffer << 8) | uint8(data[i]);
            bits += 8;
            while (bits >= 5) {
                bits -= 5;
                out[j++] = alphabet[(buffer >> bits) & 31];
            }
            // Bits already written pile up above `bits`; a shift drops them off the top of the word,
            // and only the five below `bits` are ever read, so nothing needs clearing.
        }
        if (bits > 0) out[j] = alphabet[(buffer << (5 - bits)) & 31];
        return string(out);
    }

    // ---------------------------------------------------------------------
    // What a take of a block costs now (spec §11.3)
    // ---------------------------------------------------------------------

    /// @notice What taking every square `blockId` still holds would cost right now, in the settlement
    /// token's smallest units — the same figure the board charges for that part of a buy. A reading:
    /// it falls weekly by reversion with no transaction. Zero for a block with nothing left.
    function takePrice(address board, uint256 blockId) public view returns (uint256) {
        ImageBoard b = ImageBoard(board);
        ImageBoardStorage.Block memory k = b.blockOf(blockId);
        if (k.cellsLeft == 0) return 0;
        uint256 base = _baseOf(b, k, blockId);
        uint256 takeBps = b.takeBps();
        (, uint256 floorLevel) = Pricing.computeTakePrice(
            k.level, BPS_DENOMINATOR, (block.timestamp - k.boughtAt) / 1 weeks, b.reversionBps(), takeBps, b.maxReversionWeeks()
        );
        return (base * floorLevel * takeBps) / BPS_SQUARED;
    }

    /// @dev The creation price of the cells `blockId` still holds: each cell its zone's price or the
    /// board's, painted zone by zone as the board does, so cells plus zones, never their product.
    function _baseOf(ImageBoard b, ImageBoardStorage.Block memory k, uint256 blockId) internal view returns (uint256 base) {
        uint256[] memory prices = new uint256[](uint256(k.cols) * k.rows);
        uint256 price = b.cellPrice();
        for (uint256 i = 0; i < prices.length; i++) {
            prices[i] = price;
        }
        ImageBoardStorage.Zone[] memory zs = b.zones();
        for (uint256 i = 0; i < zs.length; i++) {
            _paintZone(prices, k, zs[i]);
        }
        for (uint256 r = k.row; r < uint256(k.row) + k.rows; r++) {
            uint256[] memory words = b.cellRow(r);
            for (uint256 c = k.col; c < uint256(k.col) + k.cols; c++) {
                uint256 id = (words[c / CELLS_PER_WORD] >> ((c % CELLS_PER_WORD) * ID_BITS)) & ID_MASK;
                if (id == blockId) base += prices[(r - k.row) * k.cols + (c - k.col)];
            }
        }
    }

    function _paintZone(uint256[] memory prices, ImageBoardStorage.Block memory k, ImageBoardStorage.Zone memory z) internal pure {
        uint256 c0 = z.col > k.col ? z.col : k.col;
        uint256 c1 = _min(uint256(z.col) + z.cols, uint256(k.col) + k.cols);
        uint256 r0 = z.row > k.row ? z.row : k.row;
        uint256 r1 = _min(uint256(z.row) + z.rows, uint256(k.row) + k.rows);
        for (uint256 r = r0; r < r1; r++) {
            for (uint256 c = c0; c < c1; c++) {
                prices[(r - k.row) * k.cols + (c - k.col)] = z.cellPrice;
            }
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    // ---------------------------------------------------------------------
    // Pieces
    // ---------------------------------------------------------------------

    function _boardTraits(ImageBoard b) internal view returns (string memory) {
        return string.concat(
            _num("Width", b.width()),
            ",",
            _num("Height", b.height()),
            ",",
            _num("Cell size", b.cellSize()),
            ",",
            _num("Squares", uint256(b.gridCols()) * b.gridRows()),
            ",",
            _num("Squares free", b.freeCells()),
            ",",
            _num("Blocks", b.blockCount()),
            ",",
            _str("Settlement token", LibString.toHexStringChecksummed(b.settlementToken())),
            ",",
            _str("Creator", LibString.toHexStringChecksummed(b.creator()))
        );
    }

    function _blockTraits(ImageBoard b, uint256 blockId) internal view returns (string memory) {
        ImageBoardStorage.Block memory k = b.blockOf(blockId);
        return string.concat(_blockShape(k), ",", _blockState(b, blockId, k));
    }

    function _blockShape(ImageBoardStorage.Block memory k) internal pure returns (string memory) {
        return string.concat(
            _num("Column", k.col),
            ",",
            _num("Row", k.row),
            ",",
            _num("Columns", k.cols),
            ",",
            _num("Rows", k.rows),
            ",",
            _num("Squares", uint256(k.cols) * k.rows),
            ",",
            _num("Squares left", k.cellsLeft)
        );
    }

    function _blockState(ImageBoard b, uint256 blockId, ImageBoardStorage.Block memory k) internal view returns (string memory) {
        uint256 expiry = b.rentalOf(blockId).expiry;
        string memory rented = block.timestamp < expiry ? string.concat(",", _date("Rented until", expiry)) : "";
        return string.concat(
            _num("Take price", takePrice(address(b), blockId)),
            ",",
            _date("Cooldown ends", uint256(k.boughtAt) + b.cooldownSecs()),
            rented,
            ",",
            _str("Board", LibString.toHexStringChecksummed(address(b)))
        );
    }

    /// @dev `rendererPage?chain=<id>&board=<address>`.
    function _page(address board) internal view returns (string memory) {
        return string.concat(rendererPage, "?chain=", block.chainid.toString(), "&board=", LibString.toHexStringChecksummed(board));
    }

    function _description(string memory d) internal pure returns (string memory) {
        return bytes(d).length == 0 ? "" : string.concat(',"description":', _q(d));
    }

    function _num(string memory trait, uint256 value) internal pure returns (string memory) {
        return string.concat('{"trait_type":"', trait, '","value":', value.toString(), "}");
    }

    function _str(string memory trait, string memory value) internal pure returns (string memory) {
        return string.concat('{"trait_type":"', trait, '","value":', _q(value), "}");
    }

    function _date(string memory trait, uint256 value) internal pure returns (string memory) {
        return string.concat('{"display_type":"date","trait_type":"', trait, '","value":', value.toString(), "}");
    }

    /// @dev A JSON string, quoted and escaped: names are the creator's, and may hold anything.
    function _q(string memory s) internal pure returns (string memory) {
        return LibString.escapeJSON(s, true);
    }

    function _data(string memory json) internal pure returns (string memory) {
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }
}
