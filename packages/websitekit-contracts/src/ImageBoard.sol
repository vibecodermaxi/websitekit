// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SignatureCheckerLib } from "solady/utils/SignatureCheckerLib.sol";
import { LibString } from "solady/utils/LibString.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { Pricing } from "./Pricing.sol";
import { ImageBoardStorage, IImageBoardCollection } from "./ImageBoardStorage.sol";
import { ImageBoardExtension } from "./ImageBoardExtension.sol";

/// @notice Builds every metadata string a board answers with. An immutable of the implementation,
/// so nobody can change how an existing board's metadata reads.
interface IImageBoardRenderer {
    function boardURI(address board) external view returns (string memory);
    function contractURI(address board) external view returns (string memory);
    function blockURI(address board, uint256 blockId) external view returns (string memory);
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 id, bytes calldata data) external returns (bytes4);
}

/// @notice ERC-5646. Declared so its interface id is computed, never typed.
interface IERC5646 {
    function getStateFingerprint(uint256 tokenId) external view returns (bytes32);
}

/// @notice One uploaded image, sold as rectangles of square cells — and an ERC-721 collection whose
/// tokens are those rectangles. Implements `docs/IMAGE-BOARD-SPEC.md` §1–§12 as amended by §13.
///
/// An EIP-1167 clone of one implementation, created by `ImageBoardCollection`, which mints the
/// board's own token to its seller. Outside the frozen core, like the escrow contracts, and
/// unaudited. Its set-up and its rentals run in `ImageBoardExtension` by DELEGATECALL, in this
/// board's storage (`ImageBoardStorage`), because the whole does not fit EIP-170.
///
/// **Every block is a token** (decided 2026-10-21, reversing 2026-10-09's *a block is not a token*):
/// minted to the buyer at the buy, approvable, tradable anywhere. Each board is its own collection,
/// so a board's blocks are listed together and nothing else is — the flood the old rule guarded
/// against came from one collection holding every board's blocks. A marketplace sees the
/// collection from the first sale.
///
/// **Proceeds go to whoever holds the board's NFT at the moment of the sale.** Owning the board is
/// owning its squares' income; money already credited stays with whoever it was credited to. That
/// holder is also this collection's `owner()`, which grants nothing here.
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
/// never raise it; a cut touches nothing already sold. An approval moves a block and nothing else.
///
/// **A block can also be resold, whole, inside this contract** (decided 2026-10-11). Its owner
/// lists it at a price; anyone buys it at exactly that price. The sale pays the protocol its cut,
/// pays `RESALE_ROYALTY_BPS` to whoever holds the board's NFT at that moment, and credits the rest
/// to the block's owner. A take on a listed block ends the listing. A sale elsewhere is the
/// marketplace's, and pays the royalty only if the marketplace honours ERC-2981.
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
contract ImageBoard is ImageBoardStorage {
    using SafeERC20 for IERC20;

    /// @dev `id * LANES` repeats a 32-bit id in all eight lanes of a word.
    uint256 internal constant LANES = 0x0000000100000001000000010000000100000001000000010000000100000001;
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

    /// @notice The set-up and rentals, DELEGATECALLed. Its protocol immutables are this one's.
    address public immutable extension;
    /// @notice What builds this board's metadata. Fixed for every board of this implementation.
    address public immutable renderer;

    // ---------------------------------------------------------------------
    // Construction / initialization
    // ---------------------------------------------------------------------

    /// @dev The protocol's cut and treasury are READ from the extension, so the two contracts that
    /// share a board's storage cannot disagree about them.
    constructor(address extension_, address renderer_)
        ImageBoardStorage(ImageBoardExtension(extension_).protocolBps(), ImageBoardExtension(extension_).protocolTreasury())
    {
        if (renderer_.code.length == 0) revert ZeroAddress();
        extension = extension_;
        renderer = renderer_;
    }

    /// @notice Called by the collection, in the transaction that clones this board; run by the
    /// extension (`ImageBoardExtension.initialize`).
    function initialize(uint256, address, bytes calldata) external {
        _delegate();
    }

    /// @dev Runs this call's own calldata in the extension, in this board's storage, and returns or
    /// reverts with exactly what it did.
    function _delegate() internal {
        address ext = extension;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), ext, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
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
    /// cell at its creation price. Stops at the first covered block that refuses: cooling down, or one
    /// past the buy's block cap.
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
        _changed();
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
            uint256 before = _blocks[from].cellsLeft;
            // A block never loses more cells than it holds: the survey counted these off the map.
            _blocks[from].cellsLeft = uint24(before - s.counts[i]);
            _shrinkTenancy(from, owner_, s.counts[i], before);
            // Both offers were for the block as it was.
            _endRentListing(from, owner_);
            if (listPrice[from] != 0) {
                delete listPrice[from];
                emit BlockDelisted(from, owner_);
            }
            emit CellsLost(from, blockId, owner_, s.counts[i], payout);
            emit MetadataUpdate(from);
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

    /// @dev Paints the rectangle with a new block's id, records the block and mints its token. No
    /// receiver callback: a buy to a contract can be neither refused nor re-entered by it.
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
        unchecked {
            _balances[owner_] += 1;
        }
        emit Transfer(address(0), owner_, blockId);
    }

    // ---------------------------------------------------------------------
    // Blocks as tokens (ERC-721)
    // ---------------------------------------------------------------------

    /// @notice Reverts for an id never sold, as ERC-721 requires.
    function ownerOf(uint256 blockId) public view returns (address owner_) {
        owner_ = _owners[blockId];
        if (owner_ == address(0)) revert NoSuchBlock();
    }

    function balanceOf(address account) external view returns (uint256) {
        if (account == address(0)) revert ZeroAddress();
        return _balances[account];
    }

    function getApproved(uint256 blockId) external view returns (address) {
        ownerOf(blockId);
        return _approvals[blockId];
    }

    function isApprovedForAll(address owner_, address operator) external view returns (bool) {
        return _operators[owner_][operator];
    }

    /// @notice An approval moves a block and nothing else: editing, naming an editor, listing and
    /// offering for rent stay the owner's.
    function approve(address spender, uint256 blockId) external {
        address owner_ = _owners[blockId];
        if (msg.sender != owner_ && !_operators[owner_][msg.sender]) revert NotAuthorized();
        _approvals[blockId] = spender;
        emit Approval(owner_, spender, blockId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operators[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 blockId) public nonReentrant {
        // An unsold id's owner is zero, so a zero `from` would match it: refused outright.
        if (from == address(0) || from != _owners[blockId]) revert NotBlockOwner();
        if (to == address(0)) revert ZeroAddress();
        if (msg.sender != from && !_operators[from][msg.sender] && msg.sender != _approvals[blockId]) {
            revert NotAuthorized();
        }
        _move(blockId, from, to);
    }

    function safeTransferFrom(address from, address to, uint256 blockId) external {
        safeTransferFrom(from, to, blockId, "");
    }

    /// @dev The receiver is asked after the block has moved and the guard is released, as ERC-721
    /// implementations do; a wrong answer undoes the whole transfer.
    function safeTransferFrom(address from, address to, uint256 blockId, bytes memory data) public {
        transferFrom(from, to, blockId);
        if (to.code.length != 0) {
            if (IERC721Receiver(to).onERC721Received(msg.sender, from, blockId, data) != IERC721Receiver.onERC721Received.selector) {
                revert UnsafeRecipient();
            }
        }
    }

    /// @dev Every change of a block's owner — a transfer, a gift, a resale — comes through here. What
    /// the tenancy streamed so far was earned by the owner who held it; the rent offer, the listing,
    /// the editor grant and the approval were theirs too, so all end. The tenancy survives.
    function _move(uint256 blockId, address from, address to) internal {
        _settle(blockId, from);
        _endRentListing(blockId, from);
        _owners[blockId] = to;
        unchecked {
            _balances[from] -= 1;
            _balances[to] += 1;
        }
        delete _approvals[blockId];
        delete _editors[blockId];
        delete listPrice[blockId];
        emit Transfer(from, to, blockId);
    }

    // ---------------------------------------------------------------------
    // Metadata and the standards around it (spec §13.5, §13.8)
    // ---------------------------------------------------------------------

    /// @notice This collection's symbol: the Boards collection's, `-`, this board's token id. Read
    /// from the collection, so no brand is a literal here.
    function symbol() external view returns (string memory) {
        return string.concat(IImageBoardCollection(collection).symbol(), "-", LibString.toString(boardTokenId));
    }

    function tokenURI(uint256 blockId) external view returns (string memory) {
        ownerOf(blockId);
        return IImageBoardRenderer(renderer).blockURI(address(this), blockId);
    }

    /// @notice ERC-7572: this board's collection.
    function contractURI() external view returns (string memory) {
        return IImageBoardRenderer(renderer).contractURI(address(this));
    }

    /// @notice The board's own token's metadata, which the collection's `tokenURI` returns.
    function boardURI() external view returns (string memory) {
        return IImageBoardRenderer(renderer).boardURI(address(this));
    }

    /// @notice ERC-173's read: whoever holds the board's NFT, so they manage this collection's page
    /// where a marketplace offers that. It grants nothing in this contract, and ownership moves only
    /// with the board's NFT — so ERC-173 itself (`transferOwnership`) is not claimed.
    function owner() external view returns (address) {
        return seller();
    }

    /// @notice ERC-2981: `RESALE_ROYALTY_BPS` to whoever holds the board's NFT now — what a resale
    /// here pays them, asked of a sale elsewhere. A marketplace may ignore it.
    function royaltyInfo(uint256, uint256 salePrice) external view returns (address, uint256) {
        return (seller(), (salePrice * RESALE_ROYALTY_BPS) / BPS_DENOMINATOR);
    }

    /// @notice ERC-4907: the tenant while a term is live.
    function userOf(uint256 blockId) external view returns (address) {
        Rental storage t = _rentals[blockId];
        return block.timestamp < t.expiry ? t.tenant : address(0);
    }

    function userExpires(uint256 blockId) external view returns (uint256) {
        return _rentals[blockId].expiry;
    }

    /// @notice A user is made only by a paid term (`rent`). Unlike ERC-4907's reference, a user
    /// survives a transfer, because the tenancy does.
    function setUser(uint256, address, uint64) external pure {
        revert NotAuthorized();
    }

    /// @notice ERC-5646. Changes with a take, a new picture, a term or a change of listing; not with
    /// the take price, which falls weekly by the clock with no transaction.
    function getStateFingerprint(uint256 blockId) external view returns (bytes32) {
        Block storage b = _blocks[blockId];
        Rental storage t = _rentals[blockId];
        RentListing storage l = rentListing[blockId];
        return keccak256(
            abi.encode(b.cellsLeft, b.contentHash, shownHash(blockId), t.tenant, t.expiry, listPrice[blockId], l.ratePerDay, l.maxDurationSecs)
        );
    }

    /// @notice A term that lapsed with a tenant's picture showing changed the drawn board with no
    /// transaction. Anyone may announce it, once per term.
    function poke(uint256 blockId) external {
        Rental storage t = _rentals[blockId];
        if (t.poked || t.tenantHash == bytes32(0) || t.expiry == 0 || block.timestamp < t.expiry) revert NotLapsed();
        t.poked = true;
        emit MetadataUpdate(blockId);
        _changed();
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0x80ac58cd // ERC-721
            || interfaceId == 0x5b5e139f // ERC-721 metadata
            || interfaceId == 0x2a55205a // ERC-2981
            || interfaceId == 0xad092b5c // ERC-4907
            || interfaceId == 0x49064906 // ERC-4906
            || interfaceId == type(IERC5646).interfaceId;
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
        _permit(expectedPrice, permitDeadline, v, r, s);
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
    // Renting — run by the extension (spec §12); the reads and the take's part stay here
    // ---------------------------------------------------------------------

    function listForRent(uint256, uint256, uint64) external {
        _delegate();
    }

    function rent(uint256, address, uint64, uint256) external {
        _delegate();
    }

    function rentWithPermit(uint256, address, uint64, uint256, uint256, uint8, bytes32, bytes32) external {
        _delegate();
    }

    function extendRental(uint256, uint64, uint256) external {
        _delegate();
    }

    function extendRentalWithPermit(uint256, uint64, uint256, uint256, uint8, bytes32, bytes32) external {
        _delegate();
    }

    function claimRent(uint256[] calldata) external {
        _delegate();
    }

    function editRented(uint256, bytes32) external {
        _delegate();
    }

    /// @notice The picture the block shows now: the tenant's while a term is live and they have
    /// chosen one, the owner's otherwise.
    function shownHash(uint256 blockId) public view returns (bytes32) {
        Rental storage t = _rentals[blockId];
        if (block.timestamp < t.expiry && t.tenantHash != bytes32(0)) return t.tenantHash;
        return _blocks[blockId].contentHash;
    }

    function rentalOf(uint256 blockId) external view returns (Rental memory) {
        return _rentals[blockId];
    }

    /// @dev A take cost a rented block `lost` of its `before` cells. The owner is credited what has
    /// streamed; the tenant is refunded the unstreamed rent for the cells lost, in proportion, rounded
    /// down; the rest streams on over the cells left, from now to the same end.
    function _shrinkTenancy(uint256 blockId, address owner_, uint256 lost, uint256 before) internal {
        Rental storage t = _rentals[blockId];
        if (block.timestamp >= t.expiry) return;
        _settle(blockId, owner_);
        uint256 unstreamed = t.prepaid - t.claimed;
        uint256 refund = (unstreamed * lost) / before;
        t.prepaid = uint128(unstreamed - refund);
        t.claimed = 0;
        t.start = uint40(block.timestamp);
        pendingWithdrawals[t.tenant] += refund;
        emit RentRefunded(blockId, t.tenant, lost, refund);
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
        emit MetadataUpdate(blockId);
        _changed();
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

    /// @notice Which block holds each cell of `row`: ⌈gridCols / 8⌉ words, eight 32-bit ids each,
    /// column `c` in word `c / 8`, lane `c % 8`. Zero is a free cell.
    function cellRow(uint256 row) external view returns (uint256[] memory words) {
        words = new uint256[]((uint256(gridCols) + CELLS_PER_WORD - 1) / CELLS_PER_WORD);
        for (uint256 i = 0; i < words.length; i++) {
            words[i] = _cellWords[row * WORDS_PER_ROW + i];
        }
    }

    /// @notice A block's record, zero for an id never sold. (`ownerOf` reverts for one.)
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
