// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SignatureCheckerLib } from "solady/utils/SignatureCheckerLib.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { Pricing } from "./Pricing.sol";
import { TermsLib } from "./TermsLib.sol";

/// @notice What a board needs of the collection that made it: who holds the board's NFT, and a way
/// to say the board's picture has changed.
interface IImageBoardCollection {
    function ownerOf(uint256 tokenId) external view returns (address);
    function boardChanged() external;
}

/// @notice One uploaded image, sold as rectangles of square cells. Implements
/// `docs/IMAGE-BOARD-SPEC.md`.
///
/// An EIP-1167 clone of one implementation, created by `ImageBoardCollection`. Outside the frozen
/// core, like the escrow contracts, and unaudited.
///
/// **The board is the NFT; a block is not** (decided 2026-10-09). The collection mints one ERC-721
/// per board, whose picture is the whole board with every block's picture in it. A block is a plain
/// record here — who owns which cells and who may change them — with no token, so no marketplace
/// lists it: one board would otherwise be hundreds of listings of unrelated pictures.
///
/// **Proceeds go to whoever holds the board's NFT at the moment of the sale.** Owning the board is
/// owning its squares' income; money already credited stays with whoever it was credited to.
///
/// **Any cell can be taken** (decided 2026-10-14, as every page slot can be). A buy may cover free
/// cells, sold cells, or both; what it covers becomes a NEW block drawn on top, and every block it
/// covered keeps its owner, its picture and the cells it still has. A sold cell costs its creation
/// price times its block's level — what the block cost over the creation price of its cells —
/// reverted weekly toward the creation price and multiplied by `takeBps`; the block's owner is
/// credited `payoutBps` of that floor, so they always get at least the floor of what they lose.
/// The terms are the creator's, chosen at creation from the same clamps as a page board's.
/// Prices can rise between quoting and buying, so a buy names the most it will pay and a deadline.
///
/// **Nobody else has power over a board once it exists.** There is no owner role and nothing
/// pauses. Whoever holds the board's NFT may lower every FREE square's price (`lowerPrices`) and
/// never raise it; a cut touches nothing already sold.
///
/// **A seller may keep squares** (decided 2026-10-11): rectangles recorded at creation as ordinary
/// blocks owned by the creator, for nothing and with no protocol cut. They cannot be taken while the
/// creator owns them (decided 2026-10-14) — the point of them is the creator's own logo — and become
/// ordinary blocks if the creator gives or sells them.
///
/// **A block can also be resold, whole, inside this contract** (decided 2026-10-11). Its owner
/// lists it at a price; anyone buys it at exactly that price. The sale pays the protocol its cut,
/// pays `RESALE_ROYALTY_BPS` to whoever holds the board's NFT at that moment, and credits the rest
/// to the block's owner. A take on a listed block ends the listing.
///
/// **Prices can differ by position** (decided 2026-10-11). By default every cell costs `cellPrice`.
/// A seller may draw zones at creation, each with its own price per cell; zones never overlap, so a
/// cell has exactly one creation price, and it is what that cell's take price is built on too.
///
/// The grid is fixed at creation: `gridCols = width / cellSize`, `gridRows = height / cellSize`,
/// counted from the top-left. The strip a whole cell does not fit is not for sale. Which block holds
/// each cell is a `uint32` id per cell, eight cells to a storage word (zero is free), which caps a
/// board at 256 cells across. One buy writes at most `MAX_WORDS_PER_BUY` of those words and takes
/// cells from at most `MAX_BLOCKS_TAKEN_PER_BUY` blocks, so every buy the gate allows fits one
/// transaction.
contract ImageBoard is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Constants and protocol immutables (live in the implementation; a clone cannot strip them)
    // ---------------------------------------------------------------------

    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant BPS_SQUARED = 100_000_000;
    uint256 internal constant MAX_GRID_COLS = 256;
    uint256 internal constant MAX_GRID_ROWS = 1_000;
    /// @dev A block id per cell, eight to a word, so a row of 256 cells is 32 words.
    uint256 internal constant CELLS_PER_WORD = 8;
    uint256 internal constant WORDS_PER_ROW = MAX_GRID_COLS / CELLS_PER_WORD;
    uint256 internal constant ID_BITS = 32;
    uint256 internal constant ID_MASK = type(uint32).max;
    /// @dev `id * LANES` repeats a 32-bit id in all eight lanes of a word.
    uint256 internal constant LANES = 0x0000000100000001000000010000000100000001000000010000000100000001;
    /// @dev Not a product limit; the chain's: zones are read on every buy. See `ImageBoardTakeovers.t.sol`.
    uint256 public constant MAX_ZONES = 512;
    /// @notice The most cell words one buy may write, across all its rectangles: each row of a
    /// rectangle counts the words its columns span (eight cells to a word). Words, not cells, because
    /// a word is what a buy pays for — a column one cell wide writes a word per cell, a row of 256
    /// writes one per eight. 512 is a 64 × 64 square or a 256 × 16 strip. Set so the dearest buy the
    /// gate allows fits Robinhood Chain's 32M gas per transaction with headroom, measured cold in
    /// `ImageBoardTakeovers.t.sol`.
    uint256 public constant MAX_WORDS_PER_BUY = 512;
    /// @notice The most blocks one buy may take cells from, counted once per rectangle. Each costs
    /// a credit, a count and an event, so this bounds a take across many small blocks.
    uint256 public constant MAX_BLOCKS_TAKEN_PER_BUY = 128;
    /// @dev The lookup a rectangle tallies covered blocks in: a power of two, twice the most entries.
    uint256 internal constant TABLE_SIZE = 256;

    bytes32 private constant EDITOR_GRANT_TYPEHASH =
        keccak256("EditorGrant(uint256 blockId,address editor,uint256 nonce,uint256 deadline)");
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    /// @dev One name for every board: `verifyingContract` is what tells two boards' grants apart.
    /// Names no product (2026-10-12): wallets show it when a grant is signed, and the protocol's
    /// bytecode carries no brand — whoever deploys names the collection instead.
    bytes32 private constant DOMAIN_NAME_HASH = keccak256("Image Board");

    /// @notice What a resale pays whoever holds the board's NFT at that moment, on top of the
    /// protocol's cut. A constant, like the 5% creator royalty on the board itself.
    uint256 public constant RESALE_ROYALTY_BPS = 500;

    uint256 public immutable protocolBps;
    address public immutable protocolTreasury;

    // ---------------------------------------------------------------------
    // Frozen at initialize()
    // ---------------------------------------------------------------------

    /// @notice A rectangle of cells, counted from the top-left like the grid.
    struct Rect {
        uint16 col;
        uint16 row;
        uint16 cols;
        uint16 rows;
    }

    /// @notice Cells priced differently from `cellPrice`. One storage word: the rectangle and a
    /// price up to 2^192, which no settlement token's units approach.
    struct Zone {
        uint16 col;
        uint16 row;
        uint16 cols;
        uint16 rows;
        uint192 cellPrice;
    }

    /// @notice How a sold cell is taken: the same five numbers, under the same clamps, as a page
    /// board's (`TermsLib.checkEconomicsAbsolute`). Chosen by the creator; frozen.
    struct Terms {
        uint256 takeBps;
        uint256 payoutBps;
        uint256 reversionBps;
        uint256 maxReversionWeeks;
        uint256 cooldownSecs;
    }

    struct Config {
        /// ERC-20 only. There is no native path, so there is no change ledger.
        address settlementToken;
        /// The image's own pixels.
        uint32 width;
        uint32 height;
        /// 10, 15 or 20.
        uint8 cellSize;
        uint256 cellPrice;
        /// Hash of the original image bytes.
        bytes32 imageHash;
        /// Optional, may be empty: inside the grid, non-empty, non-zero price, never overlapping.
        Zone[] zones;
        /// Optional, may be empty: blocks the creator keeps, in this order, from block id 1.
        Rect[] kept;
        Terms terms;
    }

    /// @notice The collection that made this board and holds its NFT.
    address public collection;
    /// @notice This board's token in `collection`. Whoever owns it is paid for every square sold.
    uint256 public boardTokenId;
    address public settlementToken;
    uint32 public width;
    uint32 public height;
    uint8 public cellSize;
    uint16 public gridCols;
    uint16 public gridRows;
    /// @notice The price set at creation. What a FREE square costs now is this scaled by `priceBps`.
    uint256 public cellPrice;
    bytes32 public imageHash;
    bool private _initialized;

    /// @notice Who the board was created for: the owner of its kept blocks.
    address public creator;
    /// @notice Kept blocks are ids `1..keptCount`.
    uint32 public keptCount;
    uint16 public takeBps;
    uint16 public payoutBps;
    uint16 public reversionBps;
    uint8 public maxReversionWeeks;
    uint32 public cooldownSecs;

    // ---------------------------------------------------------------------
    // The one thing that changes about a board's prices
    // ---------------------------------------------------------------------

    /// @notice What share of the prices set at creation a FREE square costs now, in bps: 10,000
    /// until whoever holds the board's NFT lowers it, and it only ever falls. Applied to the free
    /// part of a rectangle and rounded UP, so no cut makes a square free. Sold cells never see it.
    uint256 public priceBps;

    // ---------------------------------------------------------------------
    // Blocks
    // ---------------------------------------------------------------------

    /// @dev The first word: the rectangle, the version, and what a take of it is priced from.
    /// `level` is what the block cost over the creation price of its cells, in bps, rounded up.
    struct Block {
        uint16 col;
        uint16 row;
        uint16 cols;
        uint16 rows;
        uint32 version;
        uint96 level;
        uint40 boughtAt;
        uint24 cellsLeft;
        bytes32 contentHash;
    }

    /// @dev Block ids run from 1, so an id of zero is never a block — and a cell of zero is free.
    uint256 public blockCount;
    /// @notice Cells no block holds.
    uint256 public freeCells;
    mapping(uint256 => Block) internal _blocks;
    mapping(uint256 => address) internal _owners;
    /// @dev `row * WORDS_PER_ROW + col / 8` → eight 32-bit block ids, column `col % 8` in lane `col % 8`.
    mapping(uint256 => uint256) internal _cellWords;

    /// @dev Deleted on every transfer, so a grant never outlives the owner who made it — including
    /// across A→B→A, which a grantor check alone would revive.
    mapping(uint256 => address) internal _editors;
    mapping(address => uint256) public editorNonces;

    mapping(address => uint256) public pendingWithdrawals;

    /// @notice What a block is listed for, in the settlement token's units; zero when it is not for
    /// sale. Deleted whenever the block changes hands or loses cells to a take, so a listing only
    /// ever names a price its current owner set for what the block is now.
    mapping(uint256 => uint256) public listPrice;

    Zone[] internal _zones;

    // ---------------------------------------------------------------------
    // Errors and events
    // ---------------------------------------------------------------------

    error AlreadyInitialized();
    error ZeroAddress();
    error InvalidConfig();
    error EmptyBlock();
    error OutsideGrid();
    error CellsTaken();
    error CellsKept();
    error CoolingDown();
    error TooLarge();
    error TooManyBlocks();
    error PriceTooHigh();
    error NotBlockOwner();
    error NotBlockEditor();
    error InvalidSignature();
    error DeadlineExpired();
    error NothingToWithdraw();
    error InvalidPrice();
    error NotListed();
    error PriceChanged();
    error NotBoardHolder();
    error NothingLeft();

    event BoardInitialized(
        address indexed collection,
        uint256 indexed boardTokenId,
        address settlementToken,
        uint16 gridCols,
        uint16 gridRows,
        uint256 cellPrice
    );
    /// @param total What the whole rectangle cost: its free cells and every cell it took.
    /// @param protocolCut The protocol's share of `total`.
    /// @param seller Who was credited the rest, after every `CellsLost` payout: the board NFT's
    /// holder at the moment of the sale.
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
    /// @notice A block lost `cells` cells to the new block `toBlockId`, and its owner was credited
    /// `payout` for them. Once per covered block per rectangle, before the new block's `BlockBought`.
    event CellsLost(
        uint256 indexed fromBlockId, uint256 indexed toBlockId, address indexed owner, uint256 cells, uint256 payout
    );
    /// @notice A block the creator kept at creation: no payment, no protocol cut.
    event BlockKept(uint256 indexed blockId, address indexed owner, uint16 col, uint16 row, uint16 cols, uint16 rows);
    event ZoneSet(uint256 indexed index, uint16 col, uint16 row, uint16 cols, uint16 rows, uint256 cellPrice);
    event BlockTransferred(uint256 indexed blockId, address indexed from, address indexed to);
    event BlockEdited(uint256 indexed blockId, address indexed editor, bytes32 contentHash, uint32 version);
    event EditorSet(uint256 indexed blockId, address indexed editor, address indexed grantor);
    event Withdrawn(address indexed account, uint256 amount);
    /// @param holder Who lowered them: the board NFT's holder at that moment.
    event PricesLowered(address indexed holder, uint256 priceBps);
    event BlockListed(uint256 indexed blockId, address indexed owner, uint256 price);
    event BlockDelisted(uint256 indexed blockId, address indexed owner);
    /// @param blockSeller Who sold it, and was credited `price − protocolCut − royalty`.
    /// @param boardHolder Who held the board's NFT at the moment of the sale, and was credited `royalty`.
    event BlockResold(
        uint256 indexed blockId,
        address indexed payer,
        address indexed recipient,
        address blockSeller,
        uint256 price,
        uint256 protocolCut,
        uint256 royalty,
        address boardHolder
    );

    // ---------------------------------------------------------------------
    // Construction / initialization
    // ---------------------------------------------------------------------

    constructor(uint256 protocolBps_, address protocolTreasury_) {
        if (protocolTreasury_ == address(0)) revert ZeroAddress();
        // A resale pays the protocol and the royalty out of one price; together they cannot exceed it.
        if (protocolBps_ + RESALE_ROYALTY_BPS > BPS_DENOMINATOR) revert InvalidConfig();
        protocolBps = protocolBps_;
        protocolTreasury = protocolTreasury_;
        _initialized = true;
    }

    /// @notice Called by the collection, in the transaction that clones this board. `msg.sender`
    /// becomes the collection: a clone initialized by anyone else is not one of ours, because our
    /// collection does not know it and will not take its updates. `creator_` owns the kept blocks;
    /// the collection has already refused a zero one.
    function initialize(uint256 boardTokenId_, address creator_, Config calldata cfg) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        if (cfg.settlementToken == address(0)) revert ZeroAddress();
        if (cfg.cellSize != 10 && cfg.cellSize != 15 && cfg.cellSize != 20) revert InvalidConfig();
        if (cfg.cellPrice == 0 || cfg.imageHash == bytes32(0)) revert InvalidConfig();
        Terms calldata t = cfg.terms;
        TermsLib.checkEconomicsAbsolute(
            TermsLib.Economics(t.takeBps, t.payoutBps, t.reversionBps, t.maxReversionWeeks, t.cooldownSecs),
            protocolBps
        );

        uint256 cols = cfg.width / cfg.cellSize;
        uint256 rows = cfg.height / cfg.cellSize;
        if (cols == 0 || cols > MAX_GRID_COLS || rows == 0 || rows > MAX_GRID_ROWS) revert InvalidConfig();

        collection = msg.sender;
        boardTokenId = boardTokenId_;
        settlementToken = cfg.settlementToken;
        width = cfg.width;
        height = cfg.height;
        cellSize = cfg.cellSize;
        gridCols = uint16(cols);
        gridRows = uint16(rows);
        cellPrice = cfg.cellPrice;
        imageHash = cfg.imageHash;
        priceBps = BPS_DENOMINATOR;
        creator = creator_;
        // The clamps above bound every one of these well inside its width.
        takeBps = uint16(t.takeBps);
        payoutBps = uint16(t.payoutBps);
        reversionBps = uint16(t.reversionBps);
        maxReversionWeeks = uint8(t.maxReversionWeeks);
        cooldownSecs = uint32(t.cooldownSecs);
        freeCells = cols * rows;

        emit BoardInitialized(msg.sender, boardTokenId_, cfg.settlementToken, uint16(cols), uint16(rows), cfg.cellPrice);

        _setZones(cfg.zones, rows);
        for (uint256 i = 0; i < cfg.kept.length; i++) {
            Rect calldata k = cfg.kept[i];
            uint256 blockId = _keep(creator_, k);
            emit BlockKept(blockId, creator_, k.col, k.row, k.cols, k.rows);
        }
        keptCount = uint32(cfg.kept.length);
    }

    /// @dev Overlap is checked on a bitmap in memory, one word per row, so it costs the zones' rows
    /// rather than every pair of zones. A zone may cover kept cells: those are never sold first-hand,
    /// so the zone's price applies to them only if the creator lets them go and someone takes them.
    function _setZones(Zone[] calldata given, uint256 rows) internal {
        if (given.length > MAX_ZONES) revert InvalidConfig();
        uint256[] memory covered = new uint256[](rows);
        for (uint256 i = 0; i < given.length; i++) {
            Zone calldata z = given[i];
            if (z.cellPrice == 0 || z.cols == 0 || z.rows == 0) revert InvalidConfig();
            if (uint256(z.col) + z.cols > gridCols || uint256(z.row) + z.rows > gridRows) revert InvalidConfig();
            uint256 mask = _mask(z.col, z.cols);
            for (uint256 r = z.row; r < uint256(z.row) + z.rows; r++) {
                if (covered[r] & mask != 0) revert InvalidConfig();
                covered[r] |= mask;
            }
            _zones.push(z);
            emit ZoneSet(i, z.col, z.row, z.cols, z.rows, z.cellPrice);
        }
    }

    function _mask(uint16 col, uint16 cols) internal pure returns (uint256) {
        // `cols` is at most 256 here; `1 << 256` is zero, and all ones is the right answer.
        return (cols == MAX_GRID_COLS ? type(uint256).max : (uint256(1) << cols) - 1) << col;
    }

    /// @dev A kept block: free cells only (two kept blocks that overlap revert `CellsTaken`), worth
    /// its creation prices (level 10,000), for nothing.
    function _keep(address owner_, Rect calldata k) internal returns (uint256 blockId) {
        if (k.cols == 0 || k.rows == 0) revert EmptyBlock();
        if (uint256(k.col) + k.cols > gridCols || uint256(k.row) + k.rows > gridRows) revert OutsideGrid();
        uint256 end = uint256(k.col) + k.cols;
        for (uint256 r = k.row; r < uint256(k.row) + k.rows; r++) {
            for (uint256 c = k.col; c < end; c++) {
                if (_idAt(r, c) != 0) revert CellsTaken();
            }
        }
        uint256 cells = uint256(k.cols) * k.rows;
        blockId = _record(owner_, k, BPS_DENOMINATOR, cells);
        freeCells -= cells;
    }

    /// @notice Who is paid for the next square sold: whoever holds this board's NFT right now.
    function seller() public view returns (address) {
        return IImageBoardCollection(collection).ownerOf(boardTokenId);
    }

    /// @notice Lowers every FREE square's price to `newPriceBps` of what was set at creation — the
    /// board's own price and every zone's alike. Whoever holds the board's NFT alone, since they are
    /// the one paid for those squares. Only ever down: anything at or above the current share, or
    /// zero, is refused. Sold cells, and the prices their owners list them at, are untouched.
    function lowerPrices(uint256 newPriceBps) external {
        if (msg.sender != seller()) revert NotBoardHolder();
        if (newPriceBps == 0 || newPriceBps >= priceBps) revert InvalidPrice();
        priceBps = newPriceBps;
        emit PricesLowered(msg.sender, newPriceBps);
    }

    // ---------------------------------------------------------------------
    // The one gate on a buy, and what it costs
    // ---------------------------------------------------------------------

    /// @dev Memory one buy (or one question about a buy) works in, allocated once. `ids` … `slots`
    /// hold the blocks the current rectangle covers, in the order it meets them; `table` finds an id
    /// among them, by `id % TABLE_SIZE` and the next free slot.
    struct Scratch {
        Zone[] zones;
        uint256[] table;
        uint256[] ids;
        uint256[] bases;
        uint256[] counts;
        uint256[] floors;
        uint256[] slots;
        address[] owners;
    }

    /// @dev What one rectangle covers. `base` is the creation price of all its cells; the free part's
    /// is `freeBase`; the first `parts` entries of the scratch arrays are the blocks it takes from.
    struct Survey {
        bytes4 err;
        uint256 base;
        uint256 freeBase;
        uint256 freeCells;
        uint256 parts;
    }

    function _scratch() internal view returns (Scratch memory s) {
        s.zones = _zones;
        s.table = new uint256[](TABLE_SIZE);
        s.ids = new uint256[](MAX_BLOCKS_TAKEN_PER_BUY);
        s.bases = new uint256[](MAX_BLOCKS_TAKEN_PER_BUY);
        s.counts = new uint256[](MAX_BLOCKS_TAKEN_PER_BUY);
        s.floors = new uint256[](MAX_BLOCKS_TAKEN_PER_BUY);
        s.slots = new uint256[](MAX_BLOCKS_TAKEN_PER_BUY);
        s.owners = new address[](MAX_BLOCKS_TAKEN_PER_BUY);
    }

    /// @notice Why these rectangles could not be bought together right now, as an error selector,
    /// or zero if they can. The buy reverts with exactly this, checked in the same order, so a screen
    /// asking here cannot offer what the buy refuses.
    function buyError(Rect[] memory rects) public view returns (bytes4 err) {
        (err,) = _inspect(rects);
    }

    /// @notice What these rectangles cost bought together, now: exactly what `buyBlocks` pulls.
    /// Reverts with `buyError`'s answer when they cannot be bought, so it never prices a refusal.
    function quoteBlocks(Rect[] memory rects) public view returns (uint256 total) {
        bytes4 err;
        (err, total) = _inspect(rects);
        _revertWith(err);
    }

    /// @notice `buyError` for one rectangle.
    function blockError(uint16 col, uint16 row, uint16 cols, uint16 rows) external view returns (bytes4) {
        return buyError(_one(col, row, cols, rows));
    }

    /// @notice `quoteBlocks` for one rectangle.
    function quote(uint16 col, uint16 row, uint16 cols, uint16 rows) external view returns (uint256) {
        return quoteBlocks(_one(col, row, cols, rows));
    }

    function _one(uint16 col, uint16 row, uint16 cols, uint16 rows) internal pure returns (Rect[] memory r) {
        r = new Rect[](1);
        r[0] = Rect(col, row, cols, rows);
    }

    function _inspect(Rect[] memory rects) internal view returns (bytes4, uint256 total) {
        if (rects.length == 0) return (EmptyBlock.selector, 0);
        Scratch memory s = _scratch();
        uint256 words;
        uint256 taken;
        for (uint256 i = 0; i < rects.length; i++) {
            bytes4 err;
            (err, words) = _rectError(rects, i, words);
            if (err != bytes4(0)) return (err, 0);
            Survey memory v = _survey(rects[i], s, taken);
            if (v.err != bytes4(0)) return (v.err, 0);
            taken += v.parts;
            (uint256 price,) = _priceOf(v, s);
            total += price;
            _clearTable(v, s);
        }
        return (bytes4(0), total);
    }

    /// @dev What the shape of rectangle `i` alone decides: empty, off the grid, sharing a cell with
    /// an earlier rectangle of the same buy, or past the buy's word cap. Returns the running count.
    function _rectError(Rect[] memory rects, uint256 i, uint256 wordsSoFar)
        internal
        view
        returns (bytes4, uint256 words)
    {
        Rect memory k = rects[i];
        if (k.cols == 0 || k.rows == 0) return (EmptyBlock.selector, 0);
        if (uint256(k.col) + k.cols > gridCols || uint256(k.row) + k.rows > gridRows) {
            return (OutsideGrid.selector, 0);
        }
        for (uint256 j = 0; j < i; j++) {
            Rect memory e = rects[j];
            if (k.col < e.col + e.cols && e.col < k.col + k.cols && k.row < e.row + e.rows && e.row < k.row + k.rows) {
                return (CellsTaken.selector, 0);
            }
        }
        uint256 perRow = (uint256(k.col) + k.cols - 1) / CELLS_PER_WORD - k.col / CELLS_PER_WORD + 1;
        words = wordsSoFar + perRow * k.rows;
        if (words > MAX_WORDS_PER_BUY) return (TooLarge.selector, 0);
        return (bytes4(0), words);
    }

    /// @dev Walks the rectangle row by row and tallies its cells by the block that holds them, each
    /// cell at its creation price. Stops at the first covered block that refuses: kept, cooling down,
    /// or one past the buy's block cap.
    function _survey(Rect memory k, Scratch memory s, uint256 takenSoFar) internal view returns (Survey memory v) {
        uint256[] memory prices = _pricesOf(k, s.zones);
        Run memory run = Run({ id: type(uint256).max, base: 0, cells: 0, takenSoFar: takenSoFar });
        for (uint256 r = k.row; r < uint256(k.row) + k.rows; r++) {
            _scanRow(v, s, run, prices, k, r);
            if (v.err != bytes4(0)) return v;
        }
        _tally(v, s, run);
    }

    /// @dev Cells of one block met one after another, row-major; `_tally` adds each run to the survey.
    struct Run {
        uint256 id;
        uint256 base;
        uint256 cells;
        uint256 takenSoFar;
    }

    /// @dev Each cell's creation price, row-major over the rectangle. Every zone is visited once and
    /// paints only its overlap, and zones never overlap, so this costs the rectangle's cells plus the
    /// board's zones — never cells times zones, which a tall rectangle under many zones would make
    /// larger than a transaction.
    function _pricesOf(Rect memory k, Zone[] memory zs) internal view returns (uint256[] memory prices) {
        prices = new uint256[](uint256(k.cols) * k.rows);
        uint256 price = cellPrice;
        for (uint256 i = 0; i < prices.length; i++) {
            prices[i] = price;
        }
        for (uint256 i = 0; i < zs.length; i++) {
            _paintZone(prices, k, zs[i]);
        }
    }

    /// @dev Writes one zone's price over its overlap with the rectangle, if any.
    function _paintZone(uint256[] memory prices, Rect memory k, Zone memory z) internal pure {
        uint256 c0 = z.col > k.col ? z.col : k.col;
        uint256 c1 = _min(uint256(z.col) + z.cols, uint256(k.col) + k.cols);
        uint256 r0 = z.row > k.row ? z.row : k.row;
        uint256 r1 = _min(uint256(z.row) + z.rows, uint256(k.row) + k.rows);
        for (uint256 r = r0; r < r1; r++) {
            uint256 at = (r - k.row) * k.cols;
            for (uint256 c = c0; c < c1; c++) {
                prices[at + c - k.col] = z.cellPrice;
            }
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _scanRow(
        Survey memory v,
        Scratch memory s,
        Run memory run,
        uint256[] memory prices,
        Rect memory k,
        uint256 r
    ) internal view {
        uint256 end = uint256(k.col) + k.cols;
        uint256 at = (r - k.row) * k.cols;
        uint256 word = _cellWords[r * WORDS_PER_ROW + k.col / CELLS_PER_WORD];
        for (uint256 c = k.col; c < end; c++) {
            uint256 lane = c % CELLS_PER_WORD;
            if (lane == 0 && c != k.col) word = _cellWords[r * WORDS_PER_ROW + c / CELLS_PER_WORD];
            uint256 id = (word >> (lane * ID_BITS)) & ID_MASK;
            if (id != run.id) {
                if (run.cells != 0) {
                    _tally(v, s, run);
                    if (v.err != bytes4(0)) return;
                }
                run.id = id;
                run.base = 0;
                run.cells = 0;
            }
            run.base += prices[at + c - k.col];
            run.cells++;
        }
    }

    /// @dev Adds a run of cells held by block `id` (zero: free) to the survey. A block met for the
    /// first time in this rectangle is checked and its floor level read once.
    function _tally(Survey memory v, Scratch memory s, Run memory run) internal view {
        uint256 id = run.id;
        uint256 base = run.base;
        uint256 cells = run.cells;
        v.base += base;
        if (id == 0) {
            v.freeBase += base;
            v.freeCells += cells;
            return;
        }
        uint256 slot = id % TABLE_SIZE;
        while (true) {
            uint256 at = s.table[slot];
            if (at == 0) break;
            if (s.ids[at - 1] == id) {
                s.bases[at - 1] += base;
                s.counts[at - 1] += cells;
                return;
            }
            slot = (slot + 1) % TABLE_SIZE;
        }
        if (run.takenSoFar + v.parts == MAX_BLOCKS_TAKEN_PER_BUY) {
            v.err = TooManyBlocks.selector;
            return;
        }
        Block storage b = _blocks[id];
        address owner_ = _owners[id];
        if (id <= keptCount && owner_ == creator) {
            v.err = CellsKept.selector;
            return;
        }
        uint256 boughtAt = b.boughtAt;
        if (block.timestamp < boughtAt + cooldownSecs) {
            v.err = CoolingDown.selector;
            return;
        }
        // The page boards' own reversion: the level falls weekly toward 10,000 — the creation price —
        // and never below it.
        (, uint256 floorLevel) = Pricing.computeTakePrice(
            b.level, BPS_DENOMINATOR, (block.timestamp - boughtAt) / 1 weeks, reversionBps, takeBps, maxReversionWeeks
        );
        uint256 i = v.parts++;
        s.ids[i] = id;
        s.bases[i] = base;
        s.counts[i] = cells;
        s.floors[i] = floorLevel;
        s.slots[i] = slot;
        s.owners[i] = owner_;
        s.table[slot] = i + 1;
    }

    /// @dev What the surveyed rectangle costs, and the protocol's share. The free part is a first
    /// sale at `priceBps`, rounded up; each covered block's part is its cells' creation price at the
    /// floor level times `takeBps`, rounded down — computed from the floor directly, not from a
    /// rounded take level, so `charged ≥ payout + protocol` holds for every part.
    function _priceOf(Survey memory v, Scratch memory s) internal view returns (uint256 total, uint256 cut) {
        if (v.freeCells != 0) {
            uint256 free = (v.freeBase * priceBps + BPS_DENOMINATOR - 1) / BPS_DENOMINATOR;
            total = free;
            cut = (free * protocolBps) / BPS_DENOMINATOR;
        }
        for (uint256 i = 0; i < v.parts; i++) {
            uint256 worth = s.bases[i] * s.floors[i];
            total += (worth * takeBps) / BPS_SQUARED;
            cut += (worth * protocolBps) / BPS_SQUARED;
        }
    }

    function _clearTable(Survey memory v, Scratch memory s) internal pure {
        for (uint256 i = 0; i < v.parts; i++) {
            s.table[s.slots[i]] = 0;
        }
    }

    function _revertWith(bytes4 err) internal pure {
        if (err != bytes4(0)) {
            assembly ("memory-safe") {
                mstore(0, err)
                revert(0, 4)
            }
        }
    }

    // ---------------------------------------------------------------------
    // Buy
    // ---------------------------------------------------------------------

    /// @notice Buys every rectangle in `rects` for `recipient`, each as its own block, all or nothing,
    /// for at most `maxTotal` and no later than `deadline`. A rectangle may cover free cells, sold
    /// cells, or both; the cells it covers become its block's. Block ids are consecutive from
    /// `firstId`, in the order given.
    function buyBlocks(address recipient, Rect[] calldata rects, uint256 maxTotal, uint256 deadline)
        external
        nonReentrant
        returns (uint256 firstId)
    {
        return _buy(recipient, rects, maxTotal, deadline);
    }

    /// @notice A buy in one transaction: the payer's EIP-2612 signature for `maxTotal`, which the
    /// screen sets to the total it showed, with the buy's own deadline. Whatever the buy does not
    /// pull stays the payer's allowance, spendable only by their own buys. A failed `permit` is
    /// ignored rather than fatal, so someone replaying the signature first cannot make the buy
    /// revert; without an allowance the token pull refuses instead.
    function buyBlocksWithPermit(
        address recipient,
        Rect[] calldata rects,
        uint256 maxTotal,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 firstId) {
        try IERC20Permit(settlementToken).permit(msg.sender, address(this), maxTotal, deadline, v, r, s) { }
            catch { }
        return _buy(recipient, rects, maxTotal, deadline);
    }

    function _buy(address recipient, Rect[] calldata rects, uint256 maxTotal, uint256 deadline)
        internal
        returns (uint256 firstId)
    {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (recipient == address(0)) revert ZeroAddress();
        if (rects.length == 0) revert EmptyBlock();
        firstId = blockCount + 1;
        Rect[] memory list = rects;
        Scratch memory s = _scratch();
        Sums memory sum;
        sum.holder = seller();
        for (uint256 i = 0; i < list.length; i++) {
            bytes4 err;
            (err, sum.words) = _rectError(list, i, sum.words);
            _revertWith(err);
            Survey memory v = _survey(list[i], s, sum.taken);
            _revertWith(v.err);
            sum.taken += v.parts;
            _apply(recipient, list[i], v, s, sum);
        }
        if (sum.total > maxTotal) revert PriceTooHigh();
        pendingWithdrawals[sum.holder] += sum.total - sum.cut - sum.payouts;
        pendingWithdrawals[protocolTreasury] += sum.cut;

        IERC20(settlementToken).safeTransferFrom(msg.sender, address(this), sum.total);
        IImageBoardCollection(collection).boardChanged();
    }

    /// @dev A buy's running figures, so `_buy` stays inside the stack.
    struct Sums {
        address holder;
        uint256 words;
        uint256 taken;
        uint256 total;
        uint256 cut;
        uint256 payouts;
    }

    /// @dev One rectangle of a buy: every covered block credited and shrunk, the cells repainted with
    /// the new block's id, the block recorded at the level it was bought at. Money moves once, in `_buy`.
    function _apply(address recipient, Rect memory k, Survey memory v, Scratch memory s, Sums memory sum) internal {
        (uint256 total, uint256 cut) = _priceOf(v, s);
        uint256 blockId = blockCount + 1;
        for (uint256 i = 0; i < v.parts; i++) {
            uint256 from = s.ids[i];
            address owner_ = s.owners[i];
            uint256 payout = (s.bases[i] * s.floors[i] * payoutBps) / BPS_SQUARED;
            pendingWithdrawals[owner_] += payout;
            sum.payouts += payout;
            // A block never loses more cells than it holds: the survey counted these off the map.
            _blocks[from].cellsLeft -= uint24(s.counts[i]);
            if (listPrice[from] != 0) {
                delete listPrice[from];
                emit BlockDelisted(from, owner_);
            }
            emit CellsLost(from, blockId, owner_, s.counts[i], payout);
            s.table[s.slots[i]] = 0;
        }
        freeCells -= v.freeCells;
        sum.total += total;
        sum.cut += cut;
        // Up, so a block's cells are never worth less than what was paid for them.
        uint256 level = (total * BPS_DENOMINATOR + v.base - 1) / v.base;
        _record(recipient, k, level, uint256(k.cols) * k.rows);
        emit BlockBought(blockId, msg.sender, recipient, k.col, k.row, k.cols, k.rows, total, cut, sum.holder);
    }

    /// @dev Paints the rectangle with a new block's id and records the block.
    function _record(address owner_, Rect memory k, uint256 level, uint256 cells) internal returns (uint256 blockId) {
        blockId = ++blockCount;
        // Four billion blocks on one board; past it an id would not fit its cell.
        if (blockId > ID_MASK) revert InvalidConfig();
        uint256 painted = blockId * LANES;
        uint256 end = uint256(k.col) + k.cols;
        for (uint256 r = k.row; r < uint256(k.row) + k.rows; r++) {
            uint256 c = k.col;
            while (c < end) {
                uint256 lo = c % CELLS_PER_WORD;
                uint256 wordEnd = c - lo + CELLS_PER_WORD;
                uint256 stop = wordEnd < end ? wordEnd : end;
                uint256 lanes = stop - c;
                uint256 mask = lanes == CELLS_PER_WORD ? type(uint256).max : ((uint256(1) << (lanes * ID_BITS)) - 1) << (lo * ID_BITS);
                uint256 at = r * WORDS_PER_ROW + c / CELLS_PER_WORD;
                _cellWords[at] = (_cellWords[at] & ~mask) | (painted & mask);
                c = stop;
            }
        }
        _blocks[blockId] = Block({
            col: k.col,
            row: k.row,
            cols: k.cols,
            rows: k.rows,
            version: 0,
            level: SafeCast.toUint96(level),
            boughtAt: uint40(block.timestamp),
            cellsLeft: uint24(cells),
            contentHash: bytes32(0)
        });
        _owners[blockId] = owner_;
    }

    function _idAt(uint256 row, uint256 col) internal view returns (uint256) {
        return (_cellWords[row * WORDS_PER_ROW + col / CELLS_PER_WORD] >> ((col % CELLS_PER_WORD) * ID_BITS)) & ID_MASK;
    }

    // ---------------------------------------------------------------------
    // Owning a block
    // ---------------------------------------------------------------------

    /// @notice Zero for an id never sold.
    function ownerOf(uint256 blockId) public view returns (address) {
        return _owners[blockId];
    }

    /// @notice Hands a block to someone else, for nothing. Its owner alone. There are no approvals:
    /// a block is given, sold through its own listing (`buyListedBlock`), or taken cell by cell.
    function transferBlock(uint256 blockId, address to) external {
        address from = _owners[blockId];
        // An unsold id's owner is zero, which no caller is.
        if (from != msg.sender) revert NotBlockOwner();
        if (to == address(0)) revert ZeroAddress();
        _move(blockId, from, to);
    }

    /// @dev Every change of a block's owner: the editor grant and the listing both belonged to the
    /// old owner, so both end here.
    function _move(uint256 blockId, address from, address to) internal {
        _owners[blockId] = to;
        delete _editors[blockId];
        delete listPrice[blockId];
        emit BlockTransferred(blockId, from, to);
    }

    // ---------------------------------------------------------------------
    // Resale
    // ---------------------------------------------------------------------

    /// @notice Puts a block up for sale at `price`, or changes the price of one already listed. Its
    /// owner alone, while it still holds a cell. The whole block is sold; there is no partial sale.
    function listBlock(uint256 blockId, uint256 price) external {
        if (_owners[blockId] != msg.sender) revert NotBlockOwner();
        if (price == 0) revert InvalidPrice();
        if (_blocks[blockId].cellsLeft == 0) revert NothingLeft();
        listPrice[blockId] = price;
        emit BlockListed(blockId, msg.sender, price);
    }

    function delistBlock(uint256 blockId) external {
        if (_owners[blockId] != msg.sender) revert NotBlockOwner();
        if (listPrice[blockId] == 0) revert NotListed();
        delete listPrice[blockId];
        emit BlockDelisted(blockId, msg.sender);
    }

    /// @notice What each party is credited if the block sells at `price`: the protocol's cut, the
    /// board holder's royalty, and the rest to the block's owner. Both shares round down, so the
    /// owner's remainder makes the three add up to `price` exactly.
    function resaleSplit(uint256 price) public view returns (uint256 protocolCut, uint256 royalty, uint256 toOwner) {
        protocolCut = (price * protocolBps) / BPS_DENOMINATOR;
        royalty = (price * RESALE_ROYALTY_BPS) / BPS_DENOMINATOR;
        toOwner = price - protocolCut - royalty;
    }

    /// @notice Buys a listed block at exactly `expectedPrice`, for `recipient`. Reverts `NotListed`
    /// if it is not for sale and `PriceChanged` if its price is not the one the buyer agreed to — its
    /// owner can change it at any time, including while this transaction is on its way. A resale
    /// moves the block and nothing else: its cells, level and `boughtAt` stay.
    function buyListedBlock(uint256 blockId, address recipient, uint256 expectedPrice) external nonReentrant {
        _resell(blockId, recipient, expectedPrice);
    }

    /// @notice `buyListedBlock` in one transaction: the payer's EIP-2612 signature for exactly
    /// `expectedPrice`. A failed `permit` is ignored, as on a first buy.
    function buyListedBlockWithPermit(
        uint256 blockId,
        address recipient,
        uint256 expectedPrice,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        try IERC20Permit(settlementToken).permit(
            msg.sender, address(this), expectedPrice, permitDeadline, v, r, s
        ) { } catch { }
        _resell(blockId, recipient, expectedPrice);
    }

    function _resell(uint256 blockId, address recipient, uint256 expectedPrice) internal {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 price = listPrice[blockId];
        if (price == 0) revert NotListed();
        if (price != expectedPrice) revert PriceChanged();

        address from = _owners[blockId];
        address holder = seller();
        (uint256 cut, uint256 royalty, uint256 toOwner) = resaleSplit(price);
        pendingWithdrawals[from] += toOwner;
        pendingWithdrawals[holder] += royalty;
        pendingWithdrawals[protocolTreasury] += cut;
        _move(blockId, from, recipient);

        IERC20(settlementToken).safeTransferFrom(msg.sender, address(this), price);

        emit BlockResold(blockId, msg.sender, recipient, from, price, cut, royalty, holder);
    }

    // ---------------------------------------------------------------------
    // Content
    // ---------------------------------------------------------------------

    function edit(uint256 blockId, bytes32 contentHash) external {
        if (!canEdit(blockId, msg.sender)) {
            if (_owners[blockId] == address(0)) revert NotBlockOwner();
            revert NotBlockEditor();
        }
        Block storage b = _blocks[blockId];
        b.contentHash = contentHash;
        b.version += 1;
        emit BlockEdited(blockId, msg.sender, contentHash, b.version);
        IImageBoardCollection(collection).boardChanged();
    }

    function setEditor(uint256 blockId, address editor) external {
        if (_owners[blockId] != msg.sender) revert NotBlockOwner();
        _setEditor(blockId, editor, msg.sender);
    }

    function setEditorWithSig(uint256 blockId, address editor, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert DeadlineExpired();
        address owner_ = _owners[blockId];
        if (owner_ == address(0)) revert NotBlockOwner();

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(abi.encode(EDITOR_GRANT_TYPEHASH, blockId, editor, editorNonces[owner_]++, deadline))
            )
        );
        if (!SignatureCheckerLib.isValidSignatureNowCalldata(owner_, digest, signature)) revert InvalidSignature();
        _setEditor(blockId, editor, owner_);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, DOMAIN_NAME_HASH, keccak256("1"), block.chainid, address(this)));
    }

    function _setEditor(uint256 blockId, address editor, address grantor) internal {
        _editors[blockId] = editor;
        emit EditorSet(blockId, editor, grantor);
    }

    function canEdit(uint256 blockId, address account) public view returns (bool) {
        if (account == address(0)) return false;
        address owner_ = _owners[blockId];
        if (owner_ == address(0)) return false;
        return account == owner_ || _editors[blockId] == account;
    }

    function editorOf(uint256 blockId) external view returns (address) {
        return _editors[blockId];
    }

    // ---------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------

    function gridSize() external view returns (uint16 cols, uint16 rows) {
        return (gridCols, gridRows);
    }

    /// @notice Which block holds each cell of `row`: ⌈gridCols / 8⌉ words, eight 32-bit ids each,
    /// column `c` in word `c / 8`, lane `c % 8`. Zero is a free cell.
    function cellRow(uint256 row) external view returns (uint256[] memory words) {
        words = new uint256[]((uint256(gridCols) + CELLS_PER_WORD - 1) / CELLS_PER_WORD);
        for (uint256 i = 0; i < words.length; i++) {
            words[i] = _cellWords[row * WORDS_PER_ROW + i];
        }
    }

    /// @notice Which cells of `row` some block holds, one bit per column.
    function rowBits(uint256 row) external view returns (uint256 bits) {
        for (uint256 c = 0; c < gridCols; c++) {
            if (_idAt(row, c) != 0) bits |= uint256(1) << c;
        }
    }

    function blockOf(uint256 blockId) external view returns (Block memory) {
        return _blocks[blockId];
    }

    /// @notice Every zone, in the order the seller gave them. Empty when every cell is `cellPrice`.
    function zones() external view returns (Zone[] memory) {
        return _zones;
    }

    // ---------------------------------------------------------------------
    // Pull ledger
    // ---------------------------------------------------------------------

    /// @dev Permissionless and always pays `account`, so it grants nothing — the relayer's path.
    function withdrawFor(address account) external nonReentrant {
        uint256 amount = pendingWithdrawals[account];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[account] = 0;
        IERC20(settlementToken).safeTransfer(account, amount);
        emit Withdrawn(account, amount);
    }
}
