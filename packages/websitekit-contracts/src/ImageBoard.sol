// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SignatureCheckerLib } from "solady/utils/SignatureCheckerLib.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

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
/// owning its unsold squares' income; money already credited stays with whoever it was credited to.
///
/// **Nobody has power over a board once it exists, except to make its unsold squares cheaper.**
/// There is no owner role: nothing pauses, and a block moves only by its owner's act —
/// `transferBlock`, or a sale of the listing they put up. Whoever holds the board's NFT may lower
/// every unsold square's price (`lowerPrices`, decided 2026-10-11), and never raise it. That is why a
/// first buy still carries no price bound and no deadline: between quoting and buying the price can
/// only fall, and the only other thing that can change is whether the cells are still free, which
/// the buy refuses.
///
/// **A block can be resold, whole, inside this contract** (decided 2026-10-11). Its owner lists it
/// at a price; anyone buys it at exactly that price. The sale pays the protocol its cut, pays
/// `RESALE_ROYALTY_BPS` to whoever holds the board's NFT at that moment, and credits the rest to the
/// block's owner. A listing is not a token and no marketplace sees it, so resale does not bring back
/// one listing per block. Unlike a first buy, a listing's price CAN move, so a resale names the
/// price the buyer agreed to and refuses any other.
///
/// **Prices can differ by position** (decided 2026-10-11). By default every cell costs `cellPrice`.
/// A seller may draw zones at creation, each with its own price per cell, dearer or cheaper; zones
/// never overlap, so a cell has exactly one price, and a block costs the sum of its cells' prices.
/// Zones are frozen with the rest of the board; a later cut (`priceBps`) scales every one of them
/// and the board's own price alike.
///
/// **Several rectangles in one buy** (decided 2026-10-11): `buyBlocks` takes a list, all or nothing,
/// and makes each rectangle its own block — an L-shape is two blocks bought together, so a block
/// stays a rectangle with one picture everywhere else.
///
/// **A seller may keep squares** (decided 2026-10-11): rectangles recorded at creation as ordinary
/// blocks owned by the creator, for nothing and with no protocol cut. They can hold a picture, be
/// given away or be resold like any block. Without them, a seller who wanted their own logo on the
/// board would have to buy it from themselves and pay the protocol's cut for the privilege.
///
/// The grid is fixed at creation: `gridCols = width / cellSize`, `gridRows = height / cellSize`,
/// counted from the top-left. The strip a whole cell does not fit is not for sale. Taken cells are a
/// bitmap with one storage word per row (bit `c` is column `c`), which caps a board at 256 cells
/// across. A block may be anything from one cell to the whole grid, and the grid is capped at 1,000
/// rows so the whole grid is always ONE transaction (measured: buying all of the largest grid is
/// under 23M gas, against Robinhood Chain's 32M cap per transaction): without the cap a tall image
/// offers blocks no transaction can buy.
contract ImageBoard is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Constants and protocol immutables (live in the implementation; a clone cannot strip them)
    // ---------------------------------------------------------------------

    uint256 internal constant BPS_DENOMINATOR = 10_000;
    /// @dev One storage word per row.
    uint256 internal constant MAX_GRID_COLS = 256;
    /// @dev So buying the whole grid fits one transaction; see the contract's doc comment.
    uint256 internal constant MAX_GRID_ROWS = 1_000;
    /// @dev Not a product limit; the chain's. Each zone costs ~31k gas to create and adds ~3–4k to
    /// every buy (a cold read, and the overlap arithmetic). At 512, creating the largest board takes
    /// ~16M (room left for kept blocks in the same transaction) and its whole-grid buy ~24.8M, both
    /// inside 4663's 32M cap with 1.2× headroom (`ImageBoardZones.t.sol` measures both, cold).
    uint256 public constant MAX_ZONES = 512;

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
    /// @notice The price set at creation. What a square costs NOW is this scaled by `priceBps`.
    uint256 public cellPrice;
    bytes32 public imageHash;
    bool private _initialized;

    // ---------------------------------------------------------------------
    // The one thing that changes about a board's prices
    // ---------------------------------------------------------------------

    /// @notice What share of the prices set at creation an unsold square costs now, in bps: 10,000
    /// until whoever holds the board's NFT lowers it, and it only ever falls. Applied to the whole
    /// block's price and rounded UP, so no cut makes a square free.
    uint256 public priceBps;

    // ---------------------------------------------------------------------
    // Blocks
    // ---------------------------------------------------------------------

    struct Block {
        uint16 col;
        uint16 row;
        uint16 cols;
        uint16 rows;
        uint32 version;
        bytes32 contentHash;
    }

    /// @dev Block ids run from 1, so an id of zero is never a block.
    uint256 public blockCount;
    mapping(uint256 => Block) internal _blocks;
    mapping(uint256 => address) internal _owners;
    mapping(uint256 => uint256) internal _rowBits;

    /// @dev Deleted on every transfer, so a grant never outlives the owner who made it — including
    /// across A→B→A, which a grantor check alone would revive.
    mapping(uint256 => address) internal _editors;
    mapping(address => uint256) public editorNonces;

    mapping(address => uint256) public pendingWithdrawals;

    /// @notice What a block is listed for, in the settlement token's units; zero when it is not for
    /// sale. Deleted whenever the block changes hands, so a listing only ever names the price its
    /// current owner set.
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
    error NotBlockOwner();
    error NotBlockEditor();
    error InvalidSignature();
    error DeadlineExpired();
    error NothingToWithdraw();
    error InvalidPrice();
    error NotListed();
    error PriceChanged();
    error NotBoardHolder();

    event BoardInitialized(
        address indexed collection,
        uint256 indexed boardTokenId,
        address settlementToken,
        uint16 gridCols,
        uint16 gridRows,
        uint256 cellPrice
    );
    /// @param seller Who was credited: the board NFT's holder at the moment of the sale.
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
    /// collection does not know it and will not take its updates. `creator` owns the kept blocks;
    /// the collection has already refused a zero one.
    function initialize(uint256 boardTokenId_, address creator, Config calldata cfg) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        if (cfg.settlementToken == address(0)) revert ZeroAddress();
        if (cfg.cellSize != 10 && cfg.cellSize != 15 && cfg.cellSize != 20) revert InvalidConfig();
        if (cfg.cellPrice == 0 || cfg.imageHash == bytes32(0)) revert InvalidConfig();

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

        emit BoardInitialized(msg.sender, boardTokenId_, cfg.settlementToken, uint16(cols), uint16(rows), cfg.cellPrice);

        _setZones(cfg.zones, rows);
        for (uint256 i = 0; i < cfg.kept.length; i++) {
            Rect calldata k = cfg.kept[i];
            uint256 blockId = _take(creator, k.col, k.row, k.cols, k.rows);
            emit BlockKept(blockId, creator, k.col, k.row, k.cols, k.rows);
        }
    }

    /// @dev Overlap is checked on a bitmap in memory, one word per row, so it costs the zones' rows
    /// rather than every pair of zones. A zone may cover kept cells: those are never sold first-hand,
    /// so the zone's price simply never applies to them.
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

    /// @notice Who is paid for the next square sold: whoever holds this board's NFT right now.
    function seller() public view returns (address) {
        return IImageBoardCollection(collection).ownerOf(boardTokenId);
    }

    /// @notice Lowers every unsold square's price to `newPriceBps` of what was set at creation — the
    /// board's own price and every zone's alike. Whoever holds the board's NFT alone, since they are
    /// the one paid for those squares. Only ever down: anything at or above the current share, or
    /// zero, is refused. Blocks already sold, and the prices their owners list them at, are untouched.
    function lowerPrices(uint256 newPriceBps) external {
        if (msg.sender != seller()) revert NotBoardHolder();
        if (newPriceBps == 0 || newPriceBps >= priceBps) revert InvalidPrice();
        priceBps = newPriceBps;
        emit PricesLowered(msg.sender, newPriceBps);
    }

    // ---------------------------------------------------------------------
    // The one gate on a rectangle
    // ---------------------------------------------------------------------

    /// @notice Why a block could not be bought right now, as an error selector, or zero if it can.
    /// The buy reverts with exactly this, so a screen asking here cannot offer what the buy refuses.
    function blockError(uint16 col, uint16 row, uint16 cols, uint16 rows) public view returns (bytes4) {
        if (cols == 0 || rows == 0) return EmptyBlock.selector;
        if (uint256(col) + cols > gridCols || uint256(row) + rows > gridRows) return OutsideGrid.selector;
        uint256 mask = _mask(col, cols);
        for (uint256 r = row; r < uint256(row) + rows; r++) {
            if (_rowBits[r] & mask != 0) return CellsTaken.selector;
        }
        return bytes4(0);
    }

    function _mask(uint16 col, uint16 cols) internal pure returns (uint256) {
        // `cols` is at most 256 here; `1 << 256` is zero, and all ones is the right answer.
        return (cols == MAX_GRID_COLS ? type(uint256).max : (uint256(1) << cols) - 1) << col;
    }

    /// @notice What the block at this position costs now: each cell at its zone's price, or
    /// `cellPrice` outside every zone, the sum scaled by `priceBps` and rounded up. Only ever falls.
    /// Says nothing about whether the cells are free — that is `blockError`.
    function quote(uint16 col, uint16 row, uint16 cols, uint16 rows) public view returns (uint256) {
        uint256 area = uint256(cols) * rows;
        uint256 total;
        uint256 zoned;
        uint256 n = _zones.length;
        for (uint256 i = 0; i < n; i++) {
            Zone memory z = _zones[i];
            uint256 ov = _overlap(col, cols, z.col, z.cols) * _overlap(row, rows, z.row, z.rows);
            if (ov == 0) continue;
            zoned += ov;
            total += ov * z.cellPrice;
        }
        // Zones never overlap, so `zoned` never exceeds `area`.
        total += (area - zoned) * cellPrice;
        // Up, so a cut never makes a block free: a whole block's price is at least one unit.
        return (total * priceBps + BPS_DENOMINATOR - 1) / BPS_DENOMINATOR;
    }

    /// @dev How many of `[a, a + an)` fall in `[b, b + bn)`.
    function _overlap(uint256 a, uint256 an, uint256 b, uint256 bn) internal pure returns (uint256) {
        uint256 lo = a > b ? a : b;
        uint256 aEnd = a + an;
        uint256 bEnd = b + bn;
        uint256 hi = aEnd < bEnd ? aEnd : bEnd;
        return hi > lo ? hi - lo : 0;
    }

    // ---------------------------------------------------------------------
    // Buy
    // ---------------------------------------------------------------------

    /// @notice Buys every rectangle in `rects` for `recipient`, each as its own block, all or nothing:
    /// one taken cell, or two rectangles that share one, refuses the whole buy with `blockError`'s
    /// answer. Block ids are consecutive from `firstId`, in the order given. Each block is priced and
    /// cut on its own, as if bought alone, so splitting a buy never changes who is credited what for
    /// any one block.
    function buyBlocks(address recipient, Rect[] calldata rects) external nonReentrant returns (uint256 firstId) {
        return _buy(recipient, rects);
    }

    /// @notice A buy in one transaction: the payer's EIP-2612 signature for `permitValue`, which the
    /// screen sets to the total it showed. A cut landing between signing and sending only lowers what
    /// is pulled; the rest of the allowance stays the payer's, spendable only by their own buys. A
    /// failed `permit` is ignored rather than fatal, so someone replaying the signature first cannot
    /// make the buy revert; without an allowance the token pull refuses instead.
    function buyBlocksWithPermit(
        address recipient,
        Rect[] calldata rects,
        uint256 permitValue,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 firstId) {
        try IERC20Permit(settlementToken).permit(msg.sender, address(this), permitValue, permitDeadline, v, r, s) { }
            catch { }
        return _buy(recipient, rects);
    }

    function _buy(address recipient, Rect[] calldata rects) internal returns (uint256 firstId) {
        if (recipient == address(0)) revert ZeroAddress();
        if (rects.length == 0) revert EmptyBlock();
        firstId = blockCount + 1;
        address paid = seller();
        uint256 total;
        uint256 cut;
        for (uint256 i = 0; i < rects.length; i++) {
            (uint256 price, uint256 blockCut) = _buyOne(recipient, rects[i], paid);
            total += price;
            cut += blockCut;
        }
        pendingWithdrawals[paid] += total - cut;
        pendingWithdrawals[protocolTreasury] += cut;

        IERC20(settlementToken).safeTransferFrom(msg.sender, address(this), total);
        IImageBoardCollection(collection).boardChanged();
    }

    /// @dev One rectangle of a buy: its block, its price and its cut, announced. Money moves once, in `_buy`.
    function _buyOne(address recipient, Rect calldata k, address paid) internal returns (uint256 price, uint256 blockCut) {
        price = quote(k.col, k.row, k.cols, k.rows);
        blockCut = (price * protocolBps) / BPS_DENOMINATOR;
        uint256 blockId = _take(recipient, k.col, k.row, k.cols, k.rows);
        emit BlockBought(blockId, msg.sender, recipient, k.col, k.row, k.cols, k.rows, price, blockCut, paid);
    }

    /// @dev Marks the cells and records the block, refusing exactly what `blockError` names. A buy
    /// and a kept block both come through here, so they cannot disagree about what is free.
    function _take(address owner_, uint16 col, uint16 row, uint16 cols, uint16 rows)
        internal
        returns (uint256 blockId)
    {
        bytes4 err = blockError(col, row, cols, rows);
        if (err != bytes4(0)) {
            assembly ("memory-safe") {
                mstore(0, err)
                revert(0, 4)
            }
        }

        uint256 mask = _mask(col, cols);
        for (uint256 r = row; r < uint256(row) + rows; r++) {
            _rowBits[r] |= mask;
        }

        blockId = ++blockCount;
        _blocks[blockId] = Block({ col: col, row: row, cols: cols, rows: rows, version: 0, contentHash: bytes32(0) });
        _owners[blockId] = owner_;
    }

    // ---------------------------------------------------------------------
    // Owning a block
    // ---------------------------------------------------------------------

    /// @notice Zero for an id never sold.
    function ownerOf(uint256 blockId) public view returns (address) {
        return _owners[blockId];
    }

    /// @notice Hands a block to someone else, for nothing. Its owner alone. There are no approvals:
    /// a block is given, or sold through its own listing (`buyListedBlock`), and nothing else moves it.
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
    /// owner alone. The whole block is sold; there is no partial sale.
    function listBlock(uint256 blockId, uint256 price) external {
        if (_owners[blockId] != msg.sender) revert NotBlockOwner();
        if (price == 0) revert InvalidPrice();
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
    /// owner can change it at any time, including while this transaction is on its way.
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

    function rowBits(uint256 row) external view returns (uint256) {
        return _rowBits[row];
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
