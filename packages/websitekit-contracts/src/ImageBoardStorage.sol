// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

import { RentalsLib } from "./RentalsLib.sol";

/// @notice What a board needs of the collection that made it: who holds the board's NFT, its
/// symbol (a board's own symbol is built from it), and a way to say the board's picture changed.
interface IImageBoardCollection {
    function ownerOf(uint256 tokenId) external view returns (address);
    function symbol() external view returns (string memory);
    function boardChanged() external;
}

/// @notice Everything an image board stores, and the little both of its contracts do with it.
/// `docs/IMAGE-BOARD-SPEC.md` §13.1.
///
/// A board is two contracts sharing one storage: `ImageBoard`, which every board is a clone of,
/// and `ImageBoardExtension`, which the board DELEGATECALLs for rentals and for its set-up, because
/// the board with its token surface does not fit EIP-170 alone (2026-10-21: 27,812 B whole). Both
/// inherit this, and only this declares storage, so the two layouts cannot drift: a variable added
/// here is added to both, in the same place.
abstract contract ImageBoardStorage is ReentrancyGuardTransient {
    // ---------------------------------------------------------------------
    // Constants and protocol immutables (live in each contract's code; a clone cannot strip them)
    // ---------------------------------------------------------------------

    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant BPS_SQUARED = 100_000_000;
    /// @notice The smallest and largest square a board may be cut into, in the image's own pixels
    /// (2026-10-20: a range, not the three sizes the platform offers today, so a larger square for a
    /// large photo needs no new contract). The grid's caps below bound the count either way.
    uint256 public constant MIN_CELL_SIZE = 10;
    uint256 public constant MAX_CELL_SIZE = 200;
    uint256 internal constant MAX_GRID_COLS = 256;
    uint256 internal constant MAX_GRID_ROWS = 1_000;
    /// @dev A block id per cell, eight to a word, so a row of 256 cells is 32 words.
    uint256 internal constant CELLS_PER_WORD = 8;
    uint256 internal constant WORDS_PER_ROW = MAX_GRID_COLS / CELLS_PER_WORD;
    uint256 internal constant ID_BITS = 32;
    uint256 internal constant ID_MASK = type(uint32).max;
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
    /// a credit, a count and events — and, if rented, settling and refunding its tenancy — so this
    /// bounds a take across many small blocks. 88 (2026-10-20, 128 before rentals): a take of 88
    /// blocks, each rented to its own tenant and offered for rent and for resale, fits the same
    /// headroom.
    uint256 public constant MAX_BLOCKS_TAKEN_PER_BUY = 88;

    /// @notice What a resale pays whoever holds the board's NFT at that moment, on top of the
    /// protocol's cut. A constant, like the 5% creator royalty on the board itself. Also a block's
    /// ERC-2981 royalty on a sale elsewhere.
    uint256 public constant RESALE_ROYALTY_BPS = 500;
    /// @notice What a rental pays whoever holds the board's NFT at that moment, beside the protocol's
    /// cut, as a resale does. Fixed: there is no publisher's dial here.
    uint256 public constant RENT_ROYALTY_BPS = 500;
    /// @notice The shortest and longest term a block can be rented for, or listed at.
    uint64 public constant MIN_RENTAL_DURATION = 1 hours;
    uint64 public constant MAX_RENTAL_TERM = 365 days;

    uint256 public immutable protocolBps;
    address public immutable protocolTreasury;

    // ---------------------------------------------------------------------
    // Types
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
        /// From `MIN_CELL_SIZE` to `MAX_CELL_SIZE`.
        uint8 cellSize;
        uint256 cellPrice;
        /// `sha256` of the source image's bytes: what a renderer checks the fetched source against.
        bytes32 imageHash;
        /// The source's IPFS address as binary CIDv1 bytes. Too large to be one raw block, so its
        /// address is not its hash and is recorded beside it (spec §13.7).
        bytes sourceCid;
        /// The board's name, 1–100 bytes, and an optional description up to 1,000.
        string name;
        string description;
        /// Optional, may be empty: inside the grid, non-empty, non-zero price, never overlapping.
        Zone[] zones;
        Terms terms;
    }

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

    /// @notice A block offered for rent: its daily rate and the longest term it may be taken for. A
    /// rate of zero is not offered. Ends on any change of owner and on a take of any of its cells.
    struct RentListing {
        uint192 ratePerDay;
        uint64 maxDurationSecs;
    }

    /// @notice A block's tenancy. `prepaid` is the rent net of both cuts, escrowed here and streamed
    /// to whoever owns the block, linearly from `start` to `expiry`; `claimed` is what has been
    /// credited of it. `tenantHash` is the tenant's picture, shown instead of the owner's while the
    /// term is live — held apart, so the owner's picture returns by itself when it ends and nothing
    /// needs to end a rental. `expiry` zero is no tenancy. `poked` is set once `poke` has announced
    /// this term's end, and cleared when a new term starts.
    struct Rental {
        address tenant;
        uint40 start;
        uint40 expiry;
        bool poked;
        uint128 prepaid;
        uint128 claimed;
        bytes32 tenantHash;
    }

    // ---------------------------------------------------------------------
    // Storage — declared here alone (see the contract's note)
    // ---------------------------------------------------------------------

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
    bool internal _initialized;

    /// @notice Who the board was created for: the royalty's recipient on the board's own token.
    address public creator;
    uint16 public takeBps;
    uint16 public payoutBps;
    uint16 public reversionBps;
    uint8 public maxReversionWeeks;
    uint32 public cooldownSecs;

    /// @notice What share of the prices set at creation a FREE square costs now, in bps: 10,000
    /// until whoever holds the board's NFT lowers it, and it only ever falls. Applied to the free
    /// part of a rectangle and rounded UP, so no cut makes a square free. Sold cells never see it.
    uint256 public priceBps;

    /// @dev Block ids run from 1, so an id of zero is never a block — and a cell of zero is free.
    uint256 public blockCount;
    /// @notice Cells no block holds.
    uint256 public freeCells;
    mapping(uint256 => Block) internal _blocks;
    mapping(uint256 => address) internal _owners;
    /// @dev `row * WORDS_PER_ROW + col / 8` → eight 32-bit block ids, column `col % 8` in lane `col % 8`.
    mapping(uint256 => uint256) internal _cellWords;

    /// @dev Deleted on every change of owner, so a grant never outlives the owner who made it —
    /// including across A→B→A, which a grantor check alone would revive.
    mapping(uint256 => address) internal _editors;
    mapping(address => uint256) public editorNonces;

    mapping(address => uint256) public pendingWithdrawals;

    /// @notice What a block is listed for, in the settlement token's units; zero when it is not for
    /// sale. Deleted whenever the block changes hands or loses cells to a take, so a listing only
    /// ever names a price its current owner set for what the block is now.
    mapping(uint256 => uint256) public listPrice;

    mapping(uint256 => RentListing) public rentListing;
    mapping(uint256 => Rental) internal _rentals;

    Zone[] internal _zones;

    /// @notice The board's name and description, shown in its metadata (spec §13.3).
    string public name;
    string public description;
    /// @notice Binary CIDv1 of the source image (`Config.sourceCid`).
    bytes public sourceCid;
    /// @notice Counts the changes that alter the drawn board: once per buy, edit, tenant edit and
    /// `poke`. The board token's thumbnail address carries it, so a marketplace sees a new address
    /// after every change (spec §13.6).
    uint256 public changes;

    mapping(address => uint256) internal _balances;
    mapping(uint256 => address) internal _approvals;
    mapping(address => mapping(address => bool)) internal _operators;

    // ---------------------------------------------------------------------
    // Errors and events
    // ---------------------------------------------------------------------

    error AlreadyInitialized();
    error ZeroAddress();
    error InvalidConfig();
    error EmptyBlock();
    error OutsideGrid();
    error CellsTaken();
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
    error NotForRent();
    error RateChanged();
    error TermTooLong();
    error RentalActive();
    error RentalExpired();
    error NotTenant();
    error NotAuthorized();
    error NoSuchBlock();
    error UnsafeRecipient();
    error NotLapsed();

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
    event ZoneSet(uint256 indexed index, uint16 col, uint16 row, uint16 cols, uint16 rows, uint256 cellPrice);
    event BlockEdited(uint256 indexed blockId, address indexed editor, bytes32 contentHash, uint32 version);
    event EditorSet(uint256 indexed blockId, address indexed editor, address indexed grantor);
    event Withdrawn(address indexed account, uint256 amount);
    /// @param holder Who lowered them: the board NFT's holder at that moment.
    event PricesLowered(address indexed holder, uint256 priceBps);
    event BlockListed(uint256 indexed blockId, address indexed owner, uint256 price);
    event BlockDelisted(uint256 indexed blockId, address indexed owner);
    /// @notice A rent listing set, or ended with a `ratePerDay` of zero.
    event RentListed(uint256 indexed blockId, address indexed owner, uint256 ratePerDay, uint256 maxDurationSecs);
    /// @param cost What the tenant paid; the protocol and the board's holder were credited their 5% each.
    event BlockRented(uint256 indexed blockId, address indexed tenant, address indexed payer, uint256 expiry, uint256 cost);
    event RentalExtended(uint256 indexed blockId, address indexed tenant, uint256 expiry, uint256 cost);
    /// @notice Rent streamed so far, credited to whoever owned the block while it accrued.
    event RentClaimed(uint256 indexed blockId, address indexed owner, uint256 amount);
    /// @notice A take cost the tenancy `cells` cells; the tenant was credited the unearned rent for them.
    event RentRefunded(uint256 indexed blockId, address indexed tenant, uint256 cells, uint256 amount);
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
    /// ERC-721.
    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event Approval(address indexed owner, address indexed approved, uint256 indexed id);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    /// ERC-4907: a paid term made `user` the block's user until `expires`.
    event UpdateUser(uint256 indexed tokenId, address indexed user, uint64 expires);
    /// ERC-4906: what this block's metadata says has changed.
    event MetadataUpdate(uint256 _tokenId);

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    constructor(uint256 protocolBps_, address protocolTreasury_) {
        if (protocolTreasury_ == address(0)) revert ZeroAddress();
        // A resale pays the protocol and the royalty out of one price; together they cannot exceed it.
        if (protocolBps_ + RESALE_ROYALTY_BPS > BPS_DENOMINATOR) revert InvalidConfig();
        protocolBps = protocolBps_;
        protocolTreasury = protocolTreasury_;
        // The implementation itself is never a board.
        _initialized = true;
    }

    // ---------------------------------------------------------------------
    // What both contracts do with it
    // ---------------------------------------------------------------------

    /// @notice Who is paid for the next square sold: whoever holds this board's NFT right now.
    function seller() public view returns (address) {
        return IImageBoardCollection(collection).ownerOf(boardTokenId);
    }

    /// @dev The drawn board changed: count it (the thumbnail's address) and tell the collection,
    /// which announces it for the board's token.
    function _changed() internal {
        changes += 1;
        IImageBoardCollection(collection).boardChanged();
    }

    /// @dev Credits `owner_` the rent streamed since the last settlement. Nothing when unrented.
    function _settle(uint256 blockId, address owner_) internal {
        Rental storage t = _rentals[blockId];
        uint256 accrued = RentalsLib.accruedOf(t.prepaid, t.start, t.expiry, block.timestamp);
        uint256 due = accrued - t.claimed;
        if (due == 0) return;
        t.claimed = uint128(accrued);
        pendingWithdrawals[owner_] += due;
        emit RentClaimed(blockId, owner_, due);
    }

    function _endRentListing(uint256 blockId, address owner_) internal {
        if (rentListing[blockId].ratePerDay == 0) return;
        delete rentListing[blockId];
        emit RentListed(blockId, owner_, 0, 0);
    }

    /// @dev A failed `permit` is ignored, as on every buy: without an allowance the pull refuses.
    function _permit(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) internal {
        try IERC20Permit(settlementToken).permit(msg.sender, address(this), value, deadline, v, r, s) { } catch { }
    }
}
