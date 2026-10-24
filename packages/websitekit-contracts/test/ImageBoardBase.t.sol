// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { ImageBoard } from "../src/ImageBoard.sol";
import { ImageBoardStorage } from "../src/ImageBoardStorage.sol";
import { ImageBoardCollection } from "../src/ImageBoardCollection.sol";
import { ImageBoardExtension } from "../src/ImageBoardExtension.sol";
import { ImageBoardRenderer } from "../src/ImageBoardRenderer.sol";
import { TestUSD } from "../src/mocks/TestUSD.sol";

/// @notice Shared setup for the image-board suites: one collection, one board on the doc's running
/// example (a 300×671 image at 10 px cells → 30×67, with a 1 px strip unsold), settled in the
/// permit-capable `TestUSD`.
///
/// The cell price is chosen so the protocol cut does NOT divide evenly — 10,003 raw units at 500 bps
/// is 500.15 — because a split tested only at round figures cannot tell floor from round from ceil.
abstract contract ImageBoardBase is Test {
    uint256 internal constant PROTOCOL_BPS = 500;
    uint256 internal constant CELL_PRICE = 10_003;

    /// A binary CIDv1 for a source image (raw, sha2-256 of "original image bytes"): the shape the
    /// board checks, not an address anything resolves.
    bytes internal constant SOURCE_CID =
        hex"01551220a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

    /// `sha256("original image bytes")`, as a literal: a `sha256` call inside an argument list would
    /// consume a pending `vm.prank` (it is a precompile CALL).
    bytes32 internal constant SOURCE_HASH = 0xfe4f87951686e62398485bd0dbfc644c2aec3467729d139669483b20e58fcea3;

    TestUSD internal usd;
    ImageBoardRenderer internal renderer;
    ImageBoard internal implementation;
    ImageBoardCollection internal collection;
    ImageBoard internal board;

    address internal seller = makeAddr("seller");
    address internal protocol = makeAddr("protocol");
    address internal relayer = makeAddr("relayer");

    uint256 internal alicePk = 0xA11CE;
    uint256 internal bobPk = 0xB0B;
    address internal alice = vm.addr(alicePk);
    address internal bob = vm.addr(bobPk);

    function setUp() public virtual {
        usd = new TestUSD("websitekit Test Dollar", "tUSD", 6);
        implementation = _implementation(PROTOCOL_BPS, protocol);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usd);
        collection = new ImageBoardCollection(
            "Test Image Boards", "TIMG", address(this), address(implementation), tokens, "data:application/json,{}"
        );

        board = _create(_config(300, 671, 10));

        address[2] memory buyers = [alice, bob];
        for (uint256 i = 0; i < buyers.length; i++) {
            usd.mint(buyers[i], 1_000_000 * 1e6);
            vm.prank(buyers[i]);
            usd.approve(address(board), type(uint256).max);
        }
    }

    /// A board implementation as it is deployed: its extension, its renderer, then the board.
    function _implementation(uint256 protocolBps_, address treasury_) internal returns (ImageBoard) {
        renderer = new ImageBoardRenderer("https://example.com/i/boards/", "ipfs://bafyrendererpage/");
        return new ImageBoard(address(new ImageBoardExtension(protocolBps_, treasury_)), address(renderer));
    }

    /// One price for every cell: the default a seller gets by doing nothing.
    function _config(uint32 w, uint32 h, uint8 cell) internal view returns (ImageBoardStorage.Config memory cfg) {
        cfg.settlementToken = address(usd);
        cfg.width = w;
        cfg.height = h;
        cfg.cellSize = cell;
        cfg.cellPrice = CELL_PRICE;
        cfg.imageHash = SOURCE_HASH;
        cfg.sourceCid = SOURCE_CID;
        cfg.name = "Test board";
        cfg.terms = _standardTerms();
    }

    /// The page boards' *Standard* profile: takes at 1.4× the floor, 1.15× of it to the displaced
    /// owner, reverting 3% a week over at most 52, an hour's cooldown.
    function _standardTerms() internal pure returns (ImageBoardStorage.Terms memory) {
        return ImageBoardStorage.Terms({
            takeBps: 14_000, payoutBps: 11_500, reversionBps: 9_700, maxReversionWeeks: 52, cooldownSecs: 3_600
        });
    }

    function _create(ImageBoardStorage.Config memory cfg) internal returns (ImageBoard) {
        (address b,) = collection.createBoardFor(seller, abi.encode(cfg));
        return ImageBoard(b);
    }

    function _buy(address payer, address recipient, uint16 col, uint16 row, uint16 cols, uint16 rows)
        internal
        returns (uint256 id)
    {
        vm.prank(payer);
        id = board.buyBlocks(recipient, _one(col, row, cols, rows), type(uint256).max, block.timestamp);
    }

    /// One rectangle, as the list `buyBlocks` takes.
    function _one(uint16 col, uint16 row, uint16 cols, uint16 rows)
        internal
        pure
        returns (ImageBoardStorage.Rect[] memory rects)
    {
        rects = new ImageBoardStorage.Rect[](1);
        rects[0] = ImageBoardStorage.Rect({ col: col, row: row, cols: cols, rows: rows });
    }

    function _permitSig(uint256 pk, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        address owner_ = vm.addr(pk);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner_,
                spender,
                value,
                usd.nonces(owner_),
                deadline
            )
        );
        (v, r, s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", usd.DOMAIN_SEPARATOR(), structHash)));
    }
}
