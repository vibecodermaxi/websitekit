// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { console } from "forge-std/console.sol";
import { ImageBoard } from "../src/ImageBoard.sol";
import { ImageBoardStorage } from "../src/ImageBoardStorage.sol";
import { ImageBoardReads } from "./ImageBoardReads.sol";
import { ImageBoardCollection } from "../src/ImageBoardCollection.sol";
import { ImageBoardExtension } from "../src/ImageBoardExtension.sol";
import { ImageBoardRenderer } from "../src/ImageBoardRenderer.sol";
import { TestUSD } from "../src/mocks/TestUSD.sol";

/// What the board is created with. The model below does NOT read these: it has its own map.
function invariantBoardConfig(address token) pure returns (ImageBoardStorage.Config memory cfg) {
    cfg.settlementToken = token;
    cfg.width = 125;
    cfg.height = 104;
    cfg.cellSize = 10;
    cfg.cellPrice = 10_003;
    cfg.imageHash = keccak256("img");
    cfg.sourceCid = hex"0155122000";
    cfg.name = "Invariant board";
    cfg.terms = ImageBoardStorage.Terms({
        takeBps: 14_000, payoutBps: 11_500, reversionBps: 9_700, maxReversionWeeks: 52, cooldownSecs: 3_600
    });
    cfg.zones = new ImageBoardStorage.Zone[](4);
    cfg.zones[0] = ImageBoardStorage.Zone({ col: 0, row: 0, cols: 4, rows: 3, cellPrice: 30_011 });
    cfg.zones[1] = ImageBoardStorage.Zone({ col: 6, row: 5, cols: 3, rows: 4, cellPrice: 2_003 });
    cfg.zones[2] = ImageBoardStorage.Zone({ col: 9, row: 7, cols: 3, rows: 2, cellPrice: 50_009 });
    // Kept: priced zero, beside zone 0's right edge.
    cfg.zones[3] = ImageBoardStorage.Zone({ col: 4, row: 0, cols: 2, rows: 2, cellPrice: 0 });
}

using ImageBoardReads for ImageBoard;

/// @notice Drives one small board with random buys (many of them overlapping or out of the grid on
/// purpose), block transfers, transfer attempts by strangers, edits, withdrawals and moves of the
/// board's NFT between parties, and keeps its own model of the grid and of who is owed what.
///
/// **The model is independent of the contract.** Occupancy is a cell→token map built from blocks
/// the model accepted, never from `rowBits`; the expected outcome of each buy is decided by the
/// model BEFORE the call. A test that two things agree must use an input where they can disagree —
/// so the handler sends buys the model expects to be refused and records a violation if the board
/// accepts one, and the other way round.
///
/// Money is MEASURED across each call (balances before and after), not read off the ledger after:
/// a self-consistent ledger is not money reaching the right party.
///
/// **Resale (2026-10-11)**: owners list and delist, strangers try to list, and buyers buy listings
/// naming sometimes the right price and sometimes a stale one. The model keeps its own listing per
/// block and decides each resale's outcome before the call.
///
/// **Zones (2026-10-11)**: the board is made with three zones — one dearer, two cheaper. The model
/// prices a buy CELL BY CELL from its own map (`_cellPrice`), where the contract sums overlaps per
/// zone: two algorithms that must agree, on buys that straddle zone edges.
///
/// **Kept squares (2026-10-24)**: a fourth zone is priced zero. The model refuses a buy that meets a
/// kept cell by looking at every cell's price; the contract decides it from the zones' overlaps
/// alone. The refusal must be `CellsKept` exactly when the model says kept — before any cooldown in
/// the same rectangle — and a kept cell is never counted free.
///
/// **Several rectangles in one buy, and lowered prices (2026-10-11)**: buys of two rectangles —
/// sometimes overlapping each other on purpose — are decided by the model as a whole, all or
/// nothing, and each block priced on its own. Whoever the model says holds the board (and, to be
/// refused, anyone else) lowers prices; the model keeps its own share and scales each block's
/// cell-by-cell total by it, rounding up.
///
/// **Takeovers (2026-10-14)**: any cell may be bought, sold or not. The model keeps its own cell →
/// block map, each block's level and when it was bought, and a clock the handler moves (`wait`), and
/// decides every buy before the call: refused over a cell in its cooldown; otherwise each covered block's part priced cell by cell at its floor (its own
/// reversion loop, written here), the free part at the model's share. EVERY party's credit is
/// measured across the call against the model's, so a payout to the wrong owner, at the wrong floor,
/// or a holder's share that is off by a unit, each shows.
///
/// **Blocks are tokens (2026-10-21, spec §13)**: a transfer is made by the owner, by an address the
/// owner approved, or by an operator, and the rent it settles is MEASURED across the call — an
/// operator's transfer must credit exactly what the owner's gift does. The model keeps its own
/// approvals and operators, every balance, the change counter and each term's `poke` mark; an
/// approved address tries to edit, list, offer for rent and name an editor, and must be refused.
contract ImageBoardHandler is Test {
    ImageBoard internal board;
    ImageBoardCollection internal collection;
    TestUSD internal usd;
    address internal protocol;
    uint256 internal protocolBps;

    address[4] internal actors;
    /// Everyone who can be owed money: the seller, the four actors (any of whom may come to hold the
    /// board's NFT), and the protocol.
    address[6] internal parties;
    /// Who the model says holds the board's NFT, and so is paid for the next square.
    address public ghostHolder;
    /// What share of the creation prices a square costs now, as the model has it.
    uint256 public ghostPriceBps = 10_000;

    uint16 public constant COLS = 12;
    uint16 public constant ROWS = 10;

    /// cell (col, row) → block id, 0 = free.
    mapping(uint256 => mapping(uint256 => uint256)) public ghostCell;
    /// What each block cost over the creation price of its cells, in bps, rounded up; and when.
    mapping(uint256 => uint256) public ghostLevel;
    mapping(uint256 => uint256) public ghostBoughtAt;
    /// Credited to displaced owners by takes.
    uint256 public ghostPayoutsCredited;
    mapping(uint256 => address) public ghostOwner;
    mapping(uint256 => uint16[4]) internal _ghostShape;
    uint256 public ghostBlocks;

    uint256 public ghostPaidIn;
    uint256 public ghostSellerCredited;
    uint256 public ghostProtocolCredited;
    /// A resale's owner share plus its royalty: everything a resale credits but the protocol's cut.
    uint256 public ghostResaleCredited;
    /// block id → the price its CURRENT owner listed it at; 0 = not for sale.
    mapping(uint256 => uint256) public ghostList;
    mapping(address => uint256) public ghostCredited;
    mapping(address => uint256) public ghostWithdrawn;

    /// Violations a property reads. Each is set where the evidence is, and checked as zero.
    uint256 public violAcceptedWhatModelRefused;
    uint256 public violRefusedWhatModelAccepted;
    uint256 public violWrongRecipient;
    uint256 public violMoneyAcrossBuy;
    uint256 public violRefusedBuyChangedState;
    uint256 public violKeptWrongReason;
    uint256 public violStrangerMovedBlock;
    uint256 public violPaidTheWrongHolder;
    uint256 public violResaleModelDisagrees;
    uint256 public violMoneyAcrossResale;
    uint256 public violStrangerListed;
    uint256 public violListingOutlivedOwner;
    uint256 public violCutModelDisagrees;
    uint256 public violListedWithNothingLeft;

    uint256 public ghostCalls;
    uint256 public ghostBuysOk;
    uint256 public ghostBuysTaken;
    uint256 public ghostBuysOutside;
    uint256 public ghostTransfers;
    uint256 public ghostStrangerAttempts;
    uint256 public ghostEdits;
    uint256 public ghostWithdrawals;
    uint256 public ghostBoardMoves;
    uint256 public ghostBuysAfterAMove;
    uint256 public ghostListings;
    uint256 public ghostResalesOk;
    uint256 public ghostResalesStale;
    uint256 public ghostListingsEndedByGift;
    /// Buys whose cells were not all one price: the only buys where a zone rule can be wrong.
    uint256 public ghostBuysMixedPrice;
    uint256 public ghostMultiBuysOk;
    /// Two-rectangle buys refused only because the two shared a cell — each was free alone.
    uint256 public ghostMultiBuysSelfOverlap;
    uint256 public ghostCuts;
    uint256 public ghostCutsRefused;
    uint256 public ghostBuysAfterACut;
    uint256 public ghostTakesOk;
    uint256 public ghostTakesAfterAWeek;
    uint256 public ghostRefusedCooling;
    uint256 public ghostRefusedKept;
    uint256 public ghostListingsEndedByTake;
    uint256 public ghostListRefusedNothingLeft;
    uint256 public ghostWaits;

    /// Rentals (2026-10-20). The model's own tenancy per block, streamed by its own accrual.
    struct GhostRental {
        address tenant;
        uint256 start;
        uint256 expiry;
        uint256 prepaid;
        uint256 claimed;
        bytes32 tenantHash;
        bool poked;
    }

    mapping(uint256 => GhostRental) internal _gr;
    mapping(uint256 => uint256) public ghostRentRate;
    mapping(uint256 => uint256) public ghostRentMax;
    mapping(uint256 => bytes32) public ghostOwnerHash;
    /// Everything rent credited but the protocol's cut: the holder's royalty, streams, refunds.
    uint256 public ghostRentCredited;
    uint256 public violRentModelDisagrees;
    uint256 public violMoneyAcrossRent;
    uint256 public ghostRentListings;
    uint256 public ghostRentals;
    uint256 public ghostRentalsAfterALapse;
    uint256 public ghostRentRefusedStale;
    uint256 public ghostRentRefusedActive;
    uint256 public ghostExtensions;
    uint256 public ghostExtendRefused;
    uint256 public ghostRefundsOnTake;
    uint256 public ghostRentedChangedHands;
    uint256 public ghostRentClaims;
    uint256 public ghostTenantPictures;
    uint256 public ghostRentListingsEndedByTake;
    uint256 public ghostListingsEndedByRent;

    /// Tokens (2026-10-21). The model's approvals and operators; what `changes` should read.
    mapping(uint256 => address) public ghostApproved;
    mapping(address => mapping(address => bool)) public ghostOperator;
    uint256 public ghostChanges;
    uint256 public violMoneyAcrossTransfer;
    uint256 public violApprovalOutlivedOwner;
    uint256 public violApprovedDidMore;
    uint256 public violTransferModelDisagrees;
    uint256 public violPokeModelDisagrees;
    uint256 public ghostTransfersByApproved;
    uint256 public ghostTransfersByOperator;
    uint256 public ghostTransfersRefused;
    uint256 public ghostApprovedRefused;
    uint256 public ghostPokes;
    uint256 public ghostPokesRefused;

    constructor(
        ImageBoard board_,
        ImageBoardCollection collection_,
        TestUSD usd_,
        address seller_,
        address protocol_,
        address[4] memory actors_
    ) {
        board = board_;
        collection = collection_;
        usd = usd_;
        protocol = protocol_;
        protocolBps = board_.protocolBps();
        actors = actors_;
        parties = [seller_, actors_[0], actors_[1], actors_[2], actors_[3], protocol_];
        ghostHolder = seller_;
    }

    function _one(uint16 col, uint16 row, uint16 cols, uint16 rows)
        internal
        pure
        returns (ImageBoardStorage.Rect[] memory rects)
    {
        rects = new ImageBoardStorage.Rect[](1);
        rects[0] = ImageBoardStorage.Rect({ col: col, row: row, cols: cols, rows: rows });
    }

    /// One cell's price, written out by hand. Prices do not divide by 20, so the cut rounds.
    function _cellPrice(uint256 c, uint256 r) internal pure returns (uint256) {
        if (c < 4 && r < 3) return 30_011;
        if (c >= 4 && c < 6 && r < 2) return 0;
        if (c >= 6 && c < 9 && r >= 5 && r < 9) return 2_003;
        if (c >= 9 && r >= 7 && r < 9) return 50_009;
        return 10_003;
    }

    /// One covered block's part of one rectangle, as the model prices it.
    struct Part {
        uint256 id;
        uint256 cells;
        uint256 base;
        uint256 charged;
        uint256 payout;
        uint256 cut;
    }

    struct Plan {
        uint256 total;
        uint256 cut;
        uint256 base;
        uint256 level;
        uint256 freeBase;
        uint256 freeCells;
        bool mixed;
        Part[] parts;
        uint256 n;
    }

    /// Why the model refuses a buy: nothing (0), its shape (1), two of its rectangles share a cell
    /// (2), a cell in its cooldown (4), a kept cell (8).
    uint8 internal constant OK = 0;
    uint8 internal constant SHAPE = 1;
    uint8 internal constant SELF = 2;
    uint8 internal constant COOLING = 4;
    uint8 internal constant KEPT = 8;
    /// The kept zone's cells: never free, never sold.
    uint256 public constant KEPT_CELLS = 4;

    /// A sold block's floor level now: its level, cut by 3% per whole week since it was bought (at
    /// most 52 weeks, truncating each week), never below the creation price.
    function _modelFloor(uint256 id) internal view returns (uint256 level) {
        level = ghostLevel[id];
        uint256 weeks_ = (block.timestamp - ghostBoughtAt[id]) / 604_800;
        if (weeks_ > 52) weeks_ = 52;
        for (uint256 w = 0; w < weeks_; w++) {
            level = level * 9_700 / 10_000;
        }
        if (level < 10_000) level = 10_000;
    }

    /// One rectangle, cell by cell: who holds each, what each was created at, and what the whole
    /// costs. Covered blocks are found by a linear search over the ones met so far.
    function _modelPlan(ImageBoardStorage.Rect memory k) internal view returns (uint8 why, Plan memory p) {
        if (k.cols == 0 || k.rows == 0) return (SHAPE, p);
        if (uint256(k.col) + k.cols > COLS || uint256(k.row) + k.rows > ROWS) return (SHAPE, p);
        // Kept anywhere in the rectangle refuses it before any covered block is asked.
        for (uint256 r = k.row; r < uint256(k.row) + k.rows; r++) {
            for (uint256 c = k.col; c < uint256(k.col) + k.cols; c++) {
                if (_cellPrice(c, r) == 0) return (KEPT, p);
            }
        }
        p.parts = new Part[](uint256(k.cols) * k.rows);
        uint256 first = _cellPrice(k.col, k.row);
        for (uint256 r = k.row; r < uint256(k.row) + k.rows; r++) {
            for (uint256 c = k.col; c < uint256(k.col) + k.cols; c++) {
                uint256 price = _cellPrice(c, r);
                if (price != first) p.mixed = true;
                p.base += price;
                uint256 id = ghostCell[c][r];
                if (id == 0) {
                    p.freeBase += price;
                    p.freeCells++;
                    continue;
                }
                if (block.timestamp < ghostBoughtAt[id] + 3_600) return (COOLING, p);
                uint256 j = 0;
                while (j < p.n && p.parts[j].id != id) j++;
                if (j == p.n) p.parts[p.n++].id = id;
                p.parts[j].cells++;
                p.parts[j].base += price;
            }
        }
        if (p.freeCells != 0) {
            uint256 scaled = p.freeBase * ghostPriceBps;
            uint256 free = scaled / 10_000 + (scaled % 10_000 == 0 ? 0 : 1);
            p.total = free;
            p.cut = free * protocolBps / 10_000;
        }
        for (uint256 j = 0; j < p.n; j++) {
            Part memory part = p.parts[j];
            uint256 floor_ = _modelFloor(part.id);
            part.charged = part.base * floor_ * 14_000 / 100_000_000;
            part.payout = part.base * floor_ * 11_500 / 100_000_000;
            part.cut = part.base * floor_ * protocolBps / 100_000_000;
            p.total += part.charged;
            p.cut += part.cut;
        }
        uint256 lv = p.total * 10_000;
        p.level = lv / p.base + (lv % p.base == 0 ? 0 : 1);
    }

    function _cellsLeft(uint256 id) public view returns (uint256 n) {
        uint16[4] memory sh = _ghostShape[id];
        for (uint256 c = sh[0]; c < uint256(sh[0]) + sh[2]; c++) {
            for (uint256 r = sh[1]; r < uint256(sh[1]) + sh[3]; r++) {
                if (ghostCell[c][r] == id) n++;
            }
        }
    }

    /// What the model's tenancy has streamed so far: linear from start to expiry, stopping at expiry.
    function _mAccrued(uint256 id) internal view returns (uint256) {
        GhostRental storage g = _gr[id];
        if (g.expiry == 0) return 0;
        uint256 end = block.timestamp < g.expiry ? block.timestamp : g.expiry;
        if (end <= g.start) return 0;
        return g.prepaid * (end - g.start) / (g.expiry - g.start);
    }

    /// Credits `to` what streamed since the last settlement, as the board must.
    function _mSettle(uint256 id, address to) internal returns (uint256 due) {
        GhostRental storage g = _gr[id];
        uint256 acc = _mAccrued(id);
        due = acc - g.claimed;
        if (due == 0) return 0;
        g.claimed = acc;
        ghostCredited[to] += due;
        ghostRentCredited += due;
    }

    /// Every change of a block's owner: the old owner keeps what streamed; their rent offer ends.
    function _mOwnerChange(uint256 id, address from) internal returns (uint256 due) {
        ghostApproved[id] = address(0);
        due = _mSettle(id, from);
        ghostRentRate[id] = 0;
        ghostRentMax[id] = 0;
        if (block.timestamp < _gr[id].expiry) ghostRentedChangedHands++;
    }

    function ghostRental(uint256 id) external view returns (GhostRental memory) {
        return _gr[id];
    }

    /// Rent paid and not yet streamed to anyone, as the model has it.
    function ghostEscrow() public view returns (uint256 e) {
        for (uint256 id = 1; id <= ghostBlocks; id++) {
            e += _gr[id].prepaid - _gr[id].claimed;
        }
    }

    function ghostShown(uint256 id) external view returns (bytes32) {
        GhostRental storage g = _gr[id];
        if (block.timestamp < g.expiry && g.tenantHash != bytes32(0)) return g.tenantHash;
        return ghostOwnerHash[id];
    }

    function _partyIndex(address a) internal view returns (uint256) {
        for (uint256 i = 0; i < 6; i++) {
            if (parties[i] == a) return i;
        }
        revert("not a party");
    }

    function party(uint256 i) external view returns (address) {
        return parties[i];
    }

    function shape(uint256 id) external view returns (uint16[4] memory) {
        return _ghostShape[id];
    }

    // -----------------------------------------------------------------
    // Actions
    // -----------------------------------------------------------------

    struct Before {
        uint256 board;
        uint256 payer;
        uint256 holderOwed;
        uint256 protocolOwed;
        uint256 count;
        bytes32 rows;
    }

    function buy(uint256 payerSeed, uint256 recipientSeed, uint16 col, uint16 row, uint16 cols, uint16 rows)
        external
    {
        ghostCalls++;
        // Slightly past the grid on every axis, and sometimes empty, so refusals are exercised.
        _tryBuy(
            payerSeed,
            recipientSeed,
            uint16(bound(col, 0, COLS + 1)),
            uint16(bound(row, 0, ROWS + 1)),
            uint16(bound(cols, 0, 5)),
            uint16(bound(rows, 0, 5))
        );
    }

    /// A buy aimed at a cell some block already holds. Without it, a campaign with many other
    /// actions can end having never sent a buy into a taken cell, and the overlap property is then
    /// untested — "uniform picks starve state-gated actions".
    function buyOverATakenCell(uint256 payerSeed, uint256 recipientSeed, uint256 idSeed, uint16 cols, uint16 rows)
        external
    {
        ghostCalls++;
        if (ghostBlocks == 0) return;
        uint256 id = idSeed % ghostBlocks + 1;
        // Half the time a listed block, so a take ending a listing is not left to chance.
        for (uint256 i = 0; (idSeed >> 128) % 2 == 0 && i < ghostBlocks && ghostList[id] == 0; i++) {
            id = id % ghostBlocks + 1;
        }
        uint16[4] memory taken = _ghostShape[id];
        _tryBuy(payerSeed, recipientSeed, taken[0], taken[1], uint16(bound(cols, 1, 3)), uint16(bound(rows, 1, 3)));
    }

    /// A buy whose top-left sits one cell outside a zone edge, so its cells span two prices. Uniform
    /// picks on a grid that fills in a few dozen buys land too few of these to rely on.
    function buyAcrossAZoneEdge(uint256 payerSeed, uint256 recipientSeed, uint256 edgeSeed, uint16 cols, uint16 rows)
        external
    {
        ghostCalls++;
        uint16[2][8] memory starts = [
            [uint16(3), 0], // zone 0's right edge, into the kept squares
            [uint16(0), 2], // zone 0's bottom edge
            [uint16(5), 5], // zone 1's left edge
            [uint16(6), 4], // zone 1's top edge
            [uint16(8), 7], // zone 1 into zone 2
            [uint16(9), 6], // zone 2's top edge
            [uint16(3), 2], // zone 0's corner, just under the kept squares
            [uint16(6), 0] // just right of the kept squares
        ];
        uint16[2] memory at = starts[edgeSeed % 8];
        _tryBuy(payerSeed, recipientSeed, at[0], at[1], uint16(bound(cols, 2, 3)), uint16(bound(rows, 2, 3)));
    }

    function _tryBuy(uint256 payerSeed, uint256 recipientSeed, uint16 col, uint16 row, uint16 cols, uint16 rows)
        internal
    {
        _tryBuyAll(payerSeed, recipientSeed, _one(col, row, cols, rows));
    }

    /// Two rectangles in one buy, each starting on a cell the model says is free so that pairs land
    /// often enough to be measured — uniform picks on a grid that fills in a few dozen buys starve
    /// them. Three modes, one in three each, chosen from a HASH of `shapeSeed` because the fuzzer
    /// often passes small numbers whose high bits are all zero: the second starts inside the first,
    /// so the buy is refused for sharing a cell with itself; **both are single cells on two DIFFERENT
    /// free cells (2026-10-12)**, which lands whenever two cells are free; or both are up to 2×2,
    /// which alone clipped sold cells or the edge often enough that one campaign landed no pair.
    function buyTwo(uint256 payerSeed, uint256 recipientSeed, uint256 at1, uint256 at2, uint256 shapeSeed) external {
        ghostCalls++;
        (uint16 c1, uint16 r1, bool free1) = _freeCellFrom(at1);
        (uint16 c2, uint16 r2, bool free2) = _freeCellFrom(at2);
        if (!free1 || !free2) return;
        uint256 mode = uint256(keccak256(abi.encode(shapeSeed))) % 3;
        if (mode == 1) {
            if (c1 == c2 && r1 == r2) {
                (c2, r2, free2) = _freeCellFrom(uint256(r1) * COLS + c1 + 1);
                if (!free2 || (c1 == c2 && r1 == r2)) return; // one free cell left: no pair to buy
            }
            ImageBoardStorage.Rect[] memory singles = new ImageBoardStorage.Rect[](2);
            singles[0] = ImageBoardStorage.Rect({ col: c1, row: r1, cols: 1, rows: 1 });
            singles[1] = ImageBoardStorage.Rect({ col: c2, row: r2, cols: 1, rows: 1 });
            _tryBuyAll(payerSeed, recipientSeed, singles);
            return;
        }
        ImageBoardStorage.Rect[] memory rects = new ImageBoardStorage.Rect[](2);
        rects[0] = ImageBoardStorage.Rect({
            col: c1, row: r1, cols: uint16(1 + shapeSeed % 2), rows: uint16(1 + (shapeSeed >> 8) % 2)
        });
        bool inside = mode == 0;
        rects[1] = ImageBoardStorage.Rect({
            col: inside ? c1 : c2,
            row: inside ? r1 : r2,
            cols: uint16(1 + (shapeSeed >> 24) % 2),
            rows: uint16(1 + (shapeSeed >> 32) % 2)
        });
        _tryBuyAll(payerSeed, recipientSeed, rects);
    }

    /// The first free cell at or after `seed`'s cell, reading row by row and wrapping. Kept cells are
    /// not free: a pair aimed at one would only ever be refused.
    function _freeCellFrom(uint256 seed) internal view returns (uint16 col, uint16 row, bool found) {
        uint256 cells = uint256(COLS) * ROWS;
        for (uint256 i = 0; i < cells; i++) {
            uint256 at = (seed % cells + i) % cells;
            uint256 c = at % COLS;
            uint256 r = at / COLS;
            if (ghostCell[c][r] == 0 && _cellPrice(c, r) != 0) return (uint16(c), uint16(r), true);
        }
    }

    function _tryBuyAll(uint256 payerSeed, uint256 recipientSeed, ImageBoardStorage.Rect[] memory rects) internal {
        uint256 p = payerSeed % 4;
        address payer = actors[p];
        address recipient = actors[(p + 1 + recipientSeed % 3) % 4]; // never the payer

        (uint8 why, Plan[] memory plans) = _modelAll(rects);
        Before memory b = Before({
            board: usd.balanceOf(address(board)),
            payer: usd.balanceOf(payer),
            holderOwed: board.pendingWithdrawals(ghostHolder),
            protocolOwed: board.pendingWithdrawals(protocol),
            count: board.blockCount(),
            rows: _rowsDigest()
        });
        uint256[6] memory owedBefore;
        for (uint256 i = 0; i < 6; i++) {
            owedBefore[i] = board.pendingWithdrawals(parties[i]);
        }

        vm.prank(payer);
        try board.buyBlocks(recipient, rects, type(uint256).max, block.timestamp) returns (uint256 first) {
            if (why != OK) {
                violAcceptedWhatModelRefused++;
                return;
            }
            _landed(rects, plans, first, recipient, payer, b, owedBefore);
        } catch (bytes memory reason) {
            if (why == OK) violRefusedWhatModelAccepted++;
            if (why == SELF) ghostMultiBuysSelfOverlap++;
            if (why == KEPT) ghostRefusedKept++;
            // Both ways round: kept is the refusal exactly when the model says kept.
            if ((why == KEPT) != (bytes4(reason) == ImageBoardStorage.CellsKept.selector)) violKeptWrongReason++;
            if (why == COOLING) ghostRefusedCooling++;
            // Counted for single rectangles only: a pair's refusal may be either rectangle's.
            ImageBoardStorage.Rect memory k = rects[0];
            if (rects.length == 1 && why == SHAPE && k.cols != 0 && k.rows != 0) ghostBuysOutside++;
            if (rects.length == 1 && why == COOLING) ghostBuysTaken++;
            if (usd.balanceOf(address(board)) != b.board || board.blockCount() != b.count || _rowsDigest() != b.rows)
            {
                violRefusedBuyChangedState++;
            }
        }
    }

    /// Every rectangle against the model's map and against the ones before it in the same buy.
    function _modelAll(ImageBoardStorage.Rect[] memory rects) internal view returns (uint8 why, Plan[] memory plans) {
        plans = new Plan[](rects.length);
        for (uint256 i = 0; i < rects.length; i++) {
            ImageBoardStorage.Rect memory k = rects[i];
            if (k.cols == 0 || k.rows == 0 || uint256(k.col) + k.cols > COLS || uint256(k.row) + k.rows > ROWS) {
                return (SHAPE, plans);
            }
            for (uint256 j = 0; j < i; j++) {
                ImageBoardStorage.Rect memory e = rects[j];
                bool apart = uint256(k.col) + k.cols <= e.col || uint256(e.col) + e.cols <= k.col
                    || uint256(k.row) + k.rows <= e.row || uint256(e.row) + e.rows <= k.row;
                if (!apart) return (SELF, plans);
            }
            (why, plans[i]) = _modelPlan(k);
            if (why != OK) return (why, plans);
        }
    }

    /// A buy the model accepted went through: check what it moved against the plan, then take the
    /// plan into the model.
    function _landed(
        ImageBoardStorage.Rect[] memory rects,
        Plan[] memory plans,
        uint256 first,
        address recipient,
        address payer,
        Before memory b,
        uint256[6] memory owedBefore
    ) internal {
        ghostBuysOk++;
        ghostChanges++;
        if (rects.length > 1) ghostMultiBuysOk++;
        if (ghostBoardMoves > 0) ghostBuysAfterAMove++;
        if (ghostPriceBps < 10_000) ghostBuysAfterACut++;
        uint256[6] memory expected;
        uint256 total;
        for (uint256 i = 0; i < rects.length; i++) {
            Plan memory plan = plans[i];
            if (plan.mixed) ghostBuysMixedPrice++;
            total += plan.total;
            uint256 payouts;
            for (uint256 j = 0; j < plan.n; j++) {
                Part memory part = plan.parts[j];
                _mTakeFromTenancy(part.id, part.cells, expected);
                expected[_partyIndex(ghostOwner[part.id])] += part.payout;
                ghostCredited[ghostOwner[part.id]] += part.payout;
                payouts += part.payout;
                if (ghostList[part.id] != 0) ghostListingsEndedByTake++;
                ghostList[part.id] = 0;
                if (block.timestamp >= ghostBoughtAt[part.id] + 604_800) ghostTakesAfterAWeek++;
            }
            if (plan.n != 0) ghostTakesOk++;
            uint256 rest = plan.total - plan.cut - payouts;
            expected[_partyIndex(ghostHolder)] += rest;
            expected[5] += plan.cut;
            ghostPaidIn += plan.total;
            ghostSellerCredited += rest;
            ghostProtocolCredited += plan.cut;
            ghostPayoutsCredited += payouts;
            ghostCredited[ghostHolder] += rest;
            ghostCredited[protocol] += plan.cut;

            ImageBoardStorage.Rect memory k = rects[i];
            if (board.ownerOf(first + i) != recipient) violWrongRecipient++;
            _record(first + i, recipient, k.col, k.row, k.cols, k.rows);
            ghostLevel[first + i] = plan.level;
            ghostBoughtAt[first + i] = block.timestamp;
        }
        if (usd.balanceOf(address(board)) - b.board != total || b.payer - usd.balanceOf(payer) != total) {
            violMoneyAcrossBuy++;
        }
        for (uint256 i = 0; i < 6; i++) {
            if (board.pendingWithdrawals(parties[i]) - owedBefore[i] != expected[i]) {
                if (parties[i] == ghostHolder) violPaidTheWrongHolder++;
                else violMoneyAcrossBuy++;
            }
        }
    }

    /// A take of `cells` of a block: a live tenancy is settled to the owner, the tenant refunded the
    /// unstreamed share for the cells lost, and the rest streams on from now; any rent offer ends.
    /// `before` is the block's cells as the model has them before this rectangle is recorded.
    function _mTakeFromTenancy(uint256 id, uint256 cells, uint256[6] memory expected) internal {
        if (ghostRentRate[id] != 0) ghostRentListingsEndedByTake++;
        ghostRentRate[id] = 0;
        ghostRentMax[id] = 0;
        GhostRental storage g = _gr[id];
        if (block.timestamp >= g.expiry) return;
        address owner_ = ghostOwner[id];
        expected[_partyIndex(owner_)] += _mSettle(id, owner_);
        uint256 unstreamed = g.prepaid - g.claimed;
        uint256 refund = unstreamed * cells / _cellsLeft(id);
        expected[_partyIndex(g.tenant)] += refund;
        ghostCredited[g.tenant] += refund;
        ghostRentCredited += refund;
        g.prepaid = unstreamed - refund;
        g.claimed = 0;
        g.start = block.timestamp;
        if (refund != 0) ghostRefundsOnTake++;
    }

    /// Time passes: cooldowns end and levels revert. Up to two weeks a step.
    function wait(uint256 secs) external {
        ghostCalls++;
        vm.warp(block.timestamp + bound(secs, 0, 2 weeks));
        ghostWaits++;
    }

    /// The holder alone may lower prices, and only below the share the model holds. Anyone else
    /// tries too, and so do zero and the current share. The model decides first.
    function lowerPrices(uint256 bySeed, uint256 bps) external {
        ghostCalls++;
        address by = bySeed % 4 == 0 ? parties[(bySeed >> 8) % 6] : ghostHolder;
        bps = bound(bps, 0, ghostPriceBps + 1);
        bool modelOk = by == ghostHolder && bps != 0 && bps < ghostPriceBps;
        vm.prank(by);
        try board.lowerPrices(bps) {
            if (!modelOk) violCutModelDisagrees++;
            ghostPriceBps = bps;
            ghostCuts++;
        } catch {
            if (modelOk) violCutModelDisagrees++;
            ghostCutsRefused++;
        }
    }

    function _record(uint256 id, address recipient, uint16 col, uint16 row, uint16 cols, uint16 rows) internal {
        ghostBlocks = id;
        ghostOwner[id] = recipient;
        _ghostShape[id] = [col, row, cols, rows];
        for (uint256 c = col; c < uint256(col) + cols; c++) {
            for (uint256 r = row; r < uint256(row) + rows; r++) {
                ghostCell[c][r] = id;
            }
        }
    }

    /// A block changes hands by `transferFrom`: from its owner, from an address the owner approved
    /// for it, or from an operator the owner approved for all — one in three each. What the term
    /// streamed is the old owner's, MEASURED across the call: every path must credit the same.
    function transfer(uint256 idSeed, uint256 toSeed) external {
        ghostCalls++;
        if (ghostBlocks == 0) return;
        uint256 id = idSeed % ghostBlocks + 1;
        // Half the time aim at a listed block, so a gift ending a listing is not left to chance:
        // with every action drawn uniformly, a run could end without one (seen 2026-10-11).
        for (uint256 i = 0; toSeed % 2 == 0 && i < ghostBlocks && ghostList[id] == 0; i++) {
            id = id % ghostBlocks + 1;
        }
        // A third of the time a block in a live term, so a rented block changing hands is not left
        // to chance either (seen 2026-10-20).
        if ((toSeed >> 2) % 3 == 0 && _liveRental(idSeed) != 0) id = _liveRental(idSeed);
        address from = ghostOwner[id];
        address to = actors[(toSeed >> 1) % 4];
        address by = _transferrer(id, from, toSeed >> 8);
        if (ghostList[id] != 0) ghostListingsEndedByGift++;
        uint256 owedBefore = board.pendingWithdrawals(from);
        uint256 due = _mAccrued(id) - _gr[id].claimed;
        vm.prank(by);
        board.transferFrom(from, to, id);
        if (board.pendingWithdrawals(from) - owedBefore != due) violMoneyAcrossTransfer++;
        _mOwnerChange(id, from);
        ghostOwner[id] = to;
        ghostList[id] = 0;
        if (board.listPrice(id) != 0) violListingOutlivedOwner++;
        if (board.getApproved(id) != address(0)) violApprovalOutlivedOwner++;
        ghostTransfers++;
    }

    /// Who sends a transfer: the owner, an address they approve for this block now, or an operator
    /// they approve for all now. The approvals are made here so every path lands in every run.
    function _transferrer(uint256 id, address owner_, uint256 seed) internal returns (address by) {
        uint256 mode = seed % 3;
        if (mode == 0) return owner_;
        by = parties[(seed >> 4) % 6];
        if (by == owner_) return owner_;
        vm.prank(owner_);
        if (mode == 1) {
            board.approve(by, id);
            ghostApproved[id] = by;
            ghostTransfersByApproved++;
        } else {
            board.setApprovalForAll(by, true);
            ghostOperator[owner_][by] = true;
            ghostTransfersByOperator++;
        }
    }

    /// An owner approves someone for one block, or sets or clears an operator for all of theirs.
    function approveSomeone(uint256 idSeed, uint256 whoSeed, uint256 modeSeed) external {
        ghostCalls++;
        if (ghostBlocks == 0) return;
        uint256 id = idSeed % ghostBlocks + 1;
        address owner_ = ghostOwner[id];
        address who = parties[whoSeed % 6];
        vm.prank(owner_);
        if (modeSeed % 2 == 0) {
            board.approve(who, id);
            ghostApproved[id] = who;
        } else {
            bool on = (modeSeed >> 1) % 2 == 0;
            board.setApprovalForAll(who, on);
            ghostOperator[owner_][who] = on;
        }
    }

    /// Someone the model says may NOT move the block tries: refused, and nothing moves. And an
    /// address the owner approved tries everything but a move — edit, list, offer for rent, name an
    /// editor — and is refused each time: an approval moves a block and nothing else.
    function approvedTriesMore(uint256 idSeed, uint256 whoSeed) external {
        ghostCalls++;
        if (ghostBlocks == 0) return;
        uint256 id = idSeed % ghostBlocks + 1;
        address owner_ = ghostOwner[id];
        address who = parties[whoSeed % 6];
        if (who == owner_) return;
        vm.prank(owner_);
        board.approve(who, id);
        ghostApproved[id] = who;
        vm.startPrank(who);
        bool editor = board.editorOf(id) == who;
        if (!editor) {
            try board.edit(id, keccak256("approved")) {
                violApprovedDidMore++;
            } catch { }
        }
        try board.listBlock(id, 1_000_003) {
            violApprovedDidMore++;
        } catch { }
        try board.listForRent(id, 10_007, 1 days) {
            violApprovedDidMore++;
        } catch { }
        try board.setEditor(id, who) {
            violApprovedDidMore++;
        } catch { }
        vm.stopPrank();
        ghostApprovedRefused++;
    }

    // -----------------------------------------------------------------
    // Resale
    // -----------------------------------------------------------------

    function list(uint256 idSeed, uint256 price) external {
        ghostCalls++;
        if (ghostBlocks == 0) return;
        uint256 id = idSeed % ghostBlocks + 1;
        // Prices that do not divide by 20, so the cut and the royalty round.
        price = bound(price, 1, 50_000_003);
        vm.prank(ghostOwner[id]);
        try board.listBlock(id, price) {
            if (_cellsLeft(id) == 0) violListedWithNothingLeft++;
            ghostList[id] = price;
            ghostListings++;
        } catch {
            if (_cellsLeft(id) != 0) violListedWithNothingLeft++;
            ghostListRefusedNothingLeft++;
        }
    }

    function delist(uint256 idSeed) external {
        ghostCalls++;
        if (ghostBlocks == 0) return;
        uint256 id = idSeed % ghostBlocks + 1;
        if (ghostList[id] == 0) return;
        vm.prank(ghostOwner[id]);
        board.delistBlock(id);
        ghostList[id] = 0;
    }

    /// Anyone but the owner — the board's holder, the block's editor, the last buyer — tries to list
    /// it or take it off sale. Both must fail and leave the listing as it was.
    function strangerList(uint256 idSeed, uint256 strangerSeed) external {
        ghostCalls++;
        if (ghostBlocks == 0) return;
        uint256 id = idSeed % ghostBlocks + 1;
        address stranger = parties[strangerSeed % 6];
        if (stranger == ghostOwner[id]) return;
        vm.prank(stranger);
        try board.listBlock(id, 1) {
            violStrangerListed++;
        } catch { }
        vm.prank(stranger);
        try board.delistBlock(id) {
            violStrangerListed++;
        } catch { }
        if (board.listPrice(id) != ghostList[id]) violStrangerListed++;
    }

    struct ResaleBefore {
        uint256 board;
        uint256 payer;
        uint256 owner;
        uint256 holder;
        uint256 protocol;
    }

    /// A buyer names a price: the listed one, or (one time in three) one off by one — the price an
    /// owner's change left them with. The model decides first; money is measured across the call.
    function buyListed(uint256 idSeed, uint256 payerSeed, uint256 recipientSeed, uint256 staleSeed) external {
        ghostCalls++;
        if (ghostBlocks == 0) return;
        // Aim at a listed block when there is one, so resales land often enough to be measured;
        // an unlisted id is still tried when nothing is for sale.
        uint256 id = idSeed % ghostBlocks + 1;
        for (uint256 i = 0; i < ghostBlocks && ghostList[id] == 0; i++) {
            id = id % ghostBlocks + 1;
        }
        // Nothing for sale: its owner lists it first. Without this a run where every listing had
        // already sold or been given away tried no resale at all, and the stale-price coverage
        // check failed on a seed with nothing wrong (seen 2026-10-11).
        for (uint256 i = 0; i < ghostBlocks && ghostList[id] == 0 && _cellsLeft(id) == 0; i++) {
            id = id % ghostBlocks + 1;
        }
        if (ghostList[id] == 0 && _cellsLeft(id) == 0) return; // every block taken to nothing
        if (ghostList[id] == 0) {
            uint256 price = 10_003 + idSeed % 1_000_000;
            vm.prank(ghostOwner[id]);
            board.listBlock(id, price);
            ghostList[id] = price;
            ghostListings++;
        }
        address payer = actors[payerSeed % 4];
        address recipient = actors[recipientSeed % 4];
        address from = ghostOwner[id];
        uint256 listed = ghostList[id];
        uint256 expected = staleSeed % 3 == 0 ? listed + 1 : listed;
        bool modelOk = listed != 0 && expected == listed;
        // What streamed to the seller is theirs before the block changes hands (2026-10-20).
        uint256 rentDue = _mAccrued(id) - _gr[id].claimed;

        ResaleBefore memory b = ResaleBefore({
            board: usd.balanceOf(address(board)),
            payer: usd.balanceOf(payer),
            owner: board.pendingWithdrawals(from),
            holder: board.pendingWithdrawals(ghostHolder),
            protocol: board.pendingWithdrawals(protocol)
        });

        vm.prank(payer);
        try board.buyListedBlock(id, recipient, expected) {
            if (!modelOk) {
                violResaleModelDisagrees++;
                return;
            }
            _measureResale(b, payer, from, listed, rentDue);
            _mOwnerChange(id, from);
            ghostOwner[id] = recipient;
            ghostList[id] = 0;
            if (board.ownerOf(id) != recipient) violWrongRecipient++;
            if (board.listPrice(id) != 0) violListingOutlivedOwner++;
            ghostResalesOk++;
        } catch {
            if (modelOk) violResaleModelDisagrees++;
            if (listed != 0) ghostResalesStale++;
            if (usd.balanceOf(address(board)) != b.board || board.ownerOf(id) != from) violResaleModelDisagrees++;
        }
    }

    /// Each party's credit is measured on the MODEL's idea of who it is, and the three shares are
    /// computed here, not read from `resaleSplit`. Parties can coincide (an owner who holds the
    /// board, a payer who owns the block), so the expected deltas are summed per address.
    function _measureResale(ResaleBefore memory b, address payer, address from, uint256 price, uint256 rentDue)
        internal
    {
        uint256 cut = (price * protocolBps) / 10_000;
        uint256 royalty = (price * 500) / 10_000;
        uint256 toOwner = price - cut - royalty;
        if (usd.balanceOf(address(board)) - b.board != price || b.payer - usd.balanceOf(payer) != price) {
            violMoneyAcrossResale++;
        }
        uint256 ownerGain = toOwner + rentDue + (from == ghostHolder ? royalty : 0);
        uint256 holderGain = royalty + (from == ghostHolder ? toOwner + rentDue : 0);
        if (board.pendingWithdrawals(from) - b.owner != ownerGain) violMoneyAcrossResale++;
        if (board.pendingWithdrawals(ghostHolder) - b.holder != holderGain) violMoneyAcrossResale++;
        if (board.pendingWithdrawals(protocol) - b.protocol != cut) violMoneyAcrossResale++;
        ghostPaidIn += price;
        ghostProtocolCredited += cut;
        ghostResaleCredited += toOwner + royalty;
        ghostCredited[from] += toOwner;
        ghostCredited[ghostHolder] += royalty;
        ghostCredited[protocol] += cut;
    }

    /// Anyone but the block's owner tries to move it — including whoever holds the board, and the
    /// block's own editor. It must fail.
    function strangerTransfer(uint256 idSeed, uint256 strangerSeed) external {
        ghostCalls++;
        if (ghostBlocks == 0) return;
        uint256 id = idSeed % ghostBlocks + 1;
        address owner_ = ghostOwner[id];
        address stranger = parties[strangerSeed % 6];
        if (stranger == owner_ || ghostApproved[id] == stranger || ghostOperator[owner_][stranger]) return;
        if (strangerSeed % 3 == 0) {
            // Make the stranger the block's editor first: an editor may change it, never move it.
            vm.prank(owner_);
            board.setEditor(id, stranger);
        }
        ghostStrangerAttempts++;
        vm.prank(stranger);
        try board.transferFrom(owner_, stranger, id) {
            violStrangerMovedBlock++;
        } catch {
            ghostTransfersRefused++;
        }
    }

    /// The board's NFT changes hands. Proceeds of the NEXT sale follow it; the ledger does not move.
    function moveBoard(uint256 toSeed) external {
        ghostCalls++;
        address to = parties[toSeed % 5]; // never the protocol
        address from = ghostHolder;
        if (to == from) return;
        // Read before the prank: a call in the argument list would consume it.
        uint256 tokenId = board.boardTokenId();
        vm.prank(from);
        collection.transferFrom(from, to, tokenId);
        ghostHolder = to;
        ghostBoardMoves++;
    }

    function edit(uint256 idSeed, bytes32 contentHash) external {
        ghostCalls++;
        if (ghostBlocks == 0) return;
        uint256 id = idSeed % ghostBlocks + 1;
        vm.prank(ghostOwner[id]);
        board.edit(id, contentHash);
        ghostOwnerHash[id] = contentHash;
        ghostEdits++;
        ghostChanges++;
    }

    function withdraw(uint256 partySeed) external {
        ghostCalls++;
        address account = parties[partySeed % 6];
        uint256 owed = board.pendingWithdrawals(account);
        if (owed == 0) return;
        uint256 before = usd.balanceOf(account);
        board.withdrawFor(account);
        if (usd.balanceOf(account) - before != owed) violMoneyAcrossBuy++;
        ghostWithdrawn[account] += owed;
        ghostWithdrawals++;
    }

    // -----------------------------------------------------------------
    // Rentals (2026-10-20)
    // -----------------------------------------------------------------

    /// The owner — or, one time in five, anyone else — sets a rent offer, ends one, or tries one the
    /// board must refuse: a term under an hour or past a year, or a block with no cells left.
    function listRent(uint256 idSeed, uint256 rate, uint256 maxDur, uint256 bySeed) external {
        ghostCalls++;
        if (ghostBlocks == 0) return;
        uint256 id = idSeed % ghostBlocks + 1;
        address by = bySeed % 5 == 0 ? parties[(bySeed >> 8) % 6] : ghostOwner[id];
        // Rates that do not divide by 20, so both cuts truncate; terms either side of the bounds.
        rate = bound(rate, 0, 5_000_003);
        maxDur = (bySeed >> 16) % 7 == 0 ? 366 days : bound(maxDur, 1 hours - 1, 30 days);
        bool ok =
            by == ghostOwner[id] && (rate == 0 || (_cellsLeft(id) != 0 && maxDur >= 1 hours && maxDur <= 365 days));
        vm.prank(by);
        try board.listForRent(id, rate, uint64(maxDur)) {
            if (!ok) violRentModelDisagrees++;
            ghostRentRate[id] = rate;
            ghostRentMax[id] = rate == 0 ? 0 : maxDur;
            if (rate != 0) ghostRentListings++;
        } catch {
            if (ok) violRentModelDisagrees++;
        }
    }

    struct RentBefore {
        uint256 board;
        uint256 payer;
        uint256[6] owed;
    }

    function _rentBefore(address payer) internal view returns (RentBefore memory b) {
        b.board = usd.balanceOf(address(board));
        b.payer = usd.balanceOf(payer);
        for (uint256 i = 0; i < 6; i++) {
            b.owed[i] = board.pendingWithdrawals(parties[i]);
        }
    }

    /// Money moved by a rent or an extension of `cost`: the payer paid it, the board holds it, and
    /// every party's credit moved by exactly `expected`.
    function _measureRent(RentBefore memory b, address payer, uint256 cost, uint256[6] memory expected) internal {
        if (usd.balanceOf(address(board)) - b.board != cost || b.payer - usd.balanceOf(payer) != cost) {
            violMoneyAcrossRent++;
        }
        for (uint256 i = 0; i < 6; i++) {
            if (board.pendingWithdrawals(parties[i]) - b.owed[i] != expected[i]) violMoneyAcrossRent++;
        }
    }

    /// A term's cost split as the model has it: the protocol's cut and the holder's royalty credited,
    /// the rest returned for the tenancy.
    function _mBook(uint256 cost, uint256[6] memory expected) internal returns (uint256 net) {
        uint256 cut = cost * protocolBps / 10_000;
        uint256 royalty = cost * 500 / 10_000;
        net = cost - cut - royalty;
        expected[5] += cut;
        expected[_partyIndex(ghostHolder)] += royalty;
        ghostCredited[protocol] += cut;
        ghostCredited[ghostHolder] += royalty;
        ghostProtocolCredited += cut;
        ghostRentCredited += royalty;
        ghostPaidIn += cost;
    }

    /// Someone rents a block for an actor, naming the offered rate or (one time in four) a stale one,
    /// for a term inside the offer or (one time in five) outside it. Aimed at offered blocks; when
    /// none is, an owner offers one first. The model decides first; money is measured across.
    function rentBlock(uint256 idSeed, uint256 payerSeed, uint256 tenantSeed, uint256 durSeed, uint256 staleSeed)
        external
    {
        ghostCalls++;
        if (ghostBlocks == 0) return;
        uint256 id = idSeed % ghostBlocks + 1;
        // Half the time a block whose term has lapsed, so renting again is not left to chance: a run
        // could otherwise end with every lapsed block's offer gone (seen 2026-10-20).
        uint256 lapsed = (staleSeed >> 8) % 2 == 0 ? _lapsedRental(idSeed) : 0;
        if (lapsed != 0) id = lapsed;
        for (uint256 i = 0; lapsed == 0 && i < ghostBlocks && ghostRentRate[id] == 0; i++) {
            id = id % ghostBlocks + 1;
        }
        if (ghostRentRate[id] == 0) {
            for (uint256 i = 0; i < ghostBlocks && _cellsLeft(id) == 0; i++) {
                id = id % ghostBlocks + 1;
            }
            if (_cellsLeft(id) == 0) return;
            uint256 offer = 10_007 + idSeed % 2_000_000;
            uint256 longest = 1 hours + durSeed % 20 days;
            vm.prank(ghostOwner[id]);
            board.listForRent(id, offer, uint64(longest));
            ghostRentRate[id] = offer;
            ghostRentMax[id] = longest;
            ghostRentListings++;
        }
        // A third of the time the owner has put it up for resale too, so a rental ending a resale
        // listing is exercised (2026-10-20).
        if ((staleSeed >> 16) % 3 == 0 && ghostList[id] == 0 && _cellsLeft(id) != 0) {
            vm.prank(ghostOwner[id]);
            board.listBlock(id, 1_000_003);
            ghostList[id] = 1_000_003;
            ghostListings++;
        }
        uint256 rate = ghostRentRate[id];
        uint256 max = ghostRentMax[id];
        uint256 named = staleSeed % 4 == 1 ? rate + 1 : rate;
        uint256 dur = staleSeed % 5 == 2 ? (durSeed % 2 == 0 ? 1 hours - 1 : max + 1) : bound(durSeed, 1 hours, max);
        _attemptRent(id, actors[payerSeed % 4], actors[tenantSeed % 4], dur, named);
    }

    /// One rent the model decides before the call; on success the money is measured across it.
    function _attemptRent(uint256 id, address payer, address tenant, uint256 dur, uint256 named) internal {
        uint256 rate = ghostRentRate[id];
        uint256 max = ghostRentMax[id];
        bool active = block.timestamp < _gr[id].expiry;
        bool inTerm = dur >= 1 hours && dur <= max;
        bool ok = rate != 0 && named == rate && inTerm && !active;

        RentBefore memory b = _rentBefore(payer);
        vm.prank(payer);
        try board.rent(id, tenant, uint64(dur), named) {
            if (!ok) {
                violRentModelDisagrees++;
                return;
            }
            _rented(id, tenant, payer, dur, b);
        } catch {
            if (ok) violRentModelDisagrees++;
            if (named != rate) ghostRentRefusedStale++;
            else if (active && inTerm) ghostRentRefusedActive++;
            if (usd.balanceOf(address(board)) != b.board) violRentModelDisagrees++;
        }
    }

    /// A whole term on one block in one call: offered, rented for an hour, refused while live,
    /// lapsed, rented again — so each of those paths is exercised in every run rather than left to
    /// the order uniform picks happen to land in (2026-10-20).
    function rentCycle(uint256 idSeed, uint256 payerSeed, uint256 tenantSeed) external {
        ghostCalls++;
        if (ghostBlocks == 0) return;
        uint256 id = idSeed % ghostBlocks + 1;
        for (uint256 i = 0; i < ghostBlocks && (_cellsLeft(id) == 0 || block.timestamp < _gr[id].expiry); i++) {
            id = id % ghostBlocks + 1;
        }
        if (_cellsLeft(id) == 0 || block.timestamp < _gr[id].expiry) return;
        uint256 offer = 10_007 + idSeed % 1_000_000;
        vm.prank(ghostOwner[id]);
        board.listForRent(id, offer, 2 days);
        ghostRentRate[id] = offer;
        ghostRentMax[id] = 2 days;
        ghostRentListings++;
        address payer = actors[payerSeed % 4];
        _attemptRent(id, payer, actors[tenantSeed % 4], 1 hours, offer);
        _attemptRent(id, payer, actors[(tenantSeed >> 8) % 4], 1 hours, offer);
        vm.warp(block.timestamp + 1 hours);
        _attemptRent(id, payer, actors[(tenantSeed >> 16) % 4], 1 hours, offer);
    }

    /// A rental the model accepted went through: the lapsed term's last stream to the owner, the
    /// split, a fresh tenancy, the resale listing ended — then the money measured.
    function _rented(uint256 id, address tenant, address payer, uint256 dur, RentBefore memory b) internal {
        GhostRental storage g = _gr[id];
        bool lapsed = g.expiry != 0;
        uint256[6] memory expected;
        expected[_partyIndex(ghostOwner[id])] += _mSettle(id, ghostOwner[id]);
        uint256 cost = ghostRentRate[id] * dur / 86_400;
        g.prepaid = _mBook(cost, expected);
        g.tenant = tenant;
        g.start = block.timestamp;
        g.expiry = block.timestamp + dur;
        g.claimed = 0;
        g.tenantHash = bytes32(0);
        g.poked = false;
        if (ghostList[id] != 0) ghostListingsEndedByRent++;
        ghostList[id] = 0;
        _measureRent(b, payer, cost, expected);
        ghostRentals++;
        if (lapsed) ghostRentalsAfterALapse++;
    }

    /// The tenant — or, one time in five, someone else — extends a live term at the offered rate or a
    /// stale one. Settle, then restart: the model rolls the unstreamed rest into the new term.
    function extendRent(uint256 idSeed, uint256 durSeed, uint256 staleSeed, uint256 bySeed) external {
        ghostCalls++;
        uint256 id = _liveRental(idSeed);
        if (id == 0) return;
        GhostRental storage g = _gr[id];
        address by = bySeed % 5 == 0 ? actors[(bySeed >> 8) % 4] : g.tenant;
        uint256 rate = ghostRentRate[id];
        uint256 max = ghostRentMax[id];
        uint256 named = staleSeed % 4 == 1 ? rate + 1 : rate;
        uint256 dur = max == 0 ? 1 hours : bound(durSeed, 1 hours, max);
        bool ok = by == g.tenant && rate != 0 && named == rate;

        RentBefore memory b = _rentBefore(by);
        vm.prank(by);
        try board.extendRental(id, uint64(dur), named) {
            if (!ok) {
                violRentModelDisagrees++;
                return;
            }
            _extended(id, by, dur, b);
        } catch {
            if (ok) violRentModelDisagrees++;
            ghostExtendRefused++;
        }
    }

    /// Settle, then restart: the unstreamed rest rolls into the new term with the new rent.
    function _extended(uint256 id, address by, uint256 dur, RentBefore memory b) internal {
        GhostRental storage g = _gr[id];
        uint256[6] memory expected;
        expected[_partyIndex(ghostOwner[id])] += _mSettle(id, ghostOwner[id]);
        uint256 cost = ghostRentRate[id] * dur / 86_400;
        g.prepaid = g.prepaid - g.claimed + _mBook(cost, expected);
        g.claimed = 0;
        g.start = block.timestamp;
        g.expiry = block.timestamp + dur;
        _measureRent(b, by, cost, expected);
        ghostExtensions++;
    }

    /// Anyone claims two blocks' rent; each owner is credited exactly what streamed to them.
    function claimRents(uint256 seedA, uint256 seedB, uint256 bySeed) external {
        ghostCalls++;
        if (ghostBlocks == 0) return;
        uint256[] memory ids = new uint256[](2);
        ids[0] = seedA % ghostBlocks + 1;
        ids[1] = seedB % ghostBlocks + 1;
        RentBefore memory b = _rentBefore(address(this));
        uint256[6] memory expected;
        for (uint256 i = 0; i < 2; i++) {
            expected[_partyIndex(ghostOwner[ids[i]])] += _mSettle(ids[i], ghostOwner[ids[i]]);
        }
        vm.prank(parties[bySeed % 6]);
        board.claimRent(ids);
        for (uint256 i = 0; i < 6; i++) {
            if (board.pendingWithdrawals(parties[i]) - b.owed[i] != expected[i]) violMoneyAcrossRent++;
        }
        if (usd.balanceOf(address(board)) != b.board) violMoneyAcrossRent++;
        ghostRentClaims++;
    }

    /// The tenant — or the owner, or anyone, one time in three — sets the term's picture.
    function editRented(uint256 idSeed, bytes32 contentHash, uint256 bySeed) external {
        ghostCalls++;
        if (ghostBlocks == 0) return;
        uint256 id = _liveRental(idSeed);
        if (id == 0) id = idSeed % ghostBlocks + 1;
        GhostRental storage g = _gr[id];
        if (contentHash == bytes32(0)) contentHash = keccak256(abi.encode(idSeed));
        address by = bySeed % 3 == 0 ? parties[(bySeed >> 8) % 6] : g.tenant;
        bool ok = block.timestamp < g.expiry && by == g.tenant && by != address(0);
        vm.prank(by);
        try board.editRented(id, contentHash) {
            if (!ok) violRentModelDisagrees++;
            g.tenantHash = contentHash;
            ghostTenantPictures++;
            ghostChanges++;
        } catch {
            if (ok) violRentModelDisagrees++;
        }
    }

    /// A buy over a cell of a block in a live term, so a take of a rented block is not left to
    /// chance — uniform picks rarely land one. Cooldowns may still refuse it.
    function buyOverARentedBlock(uint256 payerSeed, uint256 recipientSeed, uint256 idSeed, uint16 cols) external {
        ghostCalls++;
        uint256 id = _liveRental(idSeed);
        if (id == 0) return;
        uint16[4] memory sh = _ghostShape[id];
        for (uint16 r = sh[1]; r < sh[1] + sh[3]; r++) {
            for (uint16 c = sh[0]; c < sh[0] + sh[2]; c++) {
                if (ghostCell[c][r] == id) {
                    _tryBuy(payerSeed, recipientSeed, c, r, uint16(bound(cols, 1, 2)), 1);
                    return;
                }
            }
        }
    }

    /// The first block at or after `seed`'s whose term has lapsed and which still holds a cell, or 0.
    function _lapsedRental(uint256 seed) internal view returns (uint256) {
        uint256 id = seed % ghostBlocks + 1;
        for (uint256 i = 0; i < ghostBlocks; i++) {
            if (_gr[id].expiry != 0 && block.timestamp >= _gr[id].expiry && _cellsLeft(id) != 0) return id;
            id = id % ghostBlocks + 1;
        }
        return 0;
    }

    /// The first block at or after `seed`'s with a live term, or 0.
    function _liveRental(uint256 seed) internal view returns (uint256) {
        if (ghostBlocks == 0) return 0;
        uint256 id = seed % ghostBlocks + 1;
        for (uint256 i = 0; i < ghostBlocks; i++) {
            if (block.timestamp < _gr[id].expiry) return id;
            id = id % ghostBlocks + 1;
        }
        return 0;
    }

    /// Anyone pokes a block: once per term, after it lapsed, and only if a tenant's picture was
    /// showing. Half the time a block not in a term is first rented for an hour, given a tenant's
    /// picture and run to its end, so a poke that should land is not left to chance — uniform picks
    /// almost never leave a lapsed term with a picture (seen 2026-10-21). Only an hour passes, so
    /// longer terms elsewhere stay live (a warp to a long term's end starved extensions, the same
    /// day). The model decides first.
    function poke(uint256 idSeed, uint256 bySeed) external {
        ghostCalls++;
        if (ghostBlocks == 0) return;
        uint256 id = idSeed % ghostBlocks + 1;
        if (bySeed % 2 == 0) {
            uint256 made = _hourWithAPicture(idSeed, bySeed);
            if (made != 0) id = made;
        }
        GhostRental storage g = _gr[id];
        bool ok = g.expiry != 0 && block.timestamp >= g.expiry && g.tenantHash != bytes32(0) && !g.poked;
        vm.prank(parties[bySeed % 6]);
        try board.poke(id) {
            if (!ok) violPokeModelDisagrees++;
            g.poked = true;
            ghostChanges++;
            ghostPokes++;
        } catch {
            if (ok) violPokeModelDisagrees++;
            ghostPokesRefused++;
        }
    }

    /// A block with cells and no live term is offered, rented for an hour through the model, given
    /// the tenant's picture, and the hour run out.
    function _hourWithAPicture(uint256 idSeed, uint256 seed) internal returns (uint256) {
        uint256 id = idSeed % ghostBlocks + 1;
        for (uint256 i = 0; i < ghostBlocks && (_cellsLeft(id) == 0 || block.timestamp < _gr[id].expiry); i++) {
            id = id % ghostBlocks + 1;
        }
        if (_cellsLeft(id) == 0 || block.timestamp < _gr[id].expiry) return 0;
        uint256 offer = 10_007 + idSeed % 1_000_000;
        vm.prank(ghostOwner[id]);
        board.listForRent(id, offer, 2 days);
        ghostRentRate[id] = offer;
        ghostRentMax[id] = 2 days;
        ghostRentListings++;
        address tenant = actors[(seed >> 8) % 4];
        _attemptRent(id, actors[(seed >> 16) % 4], tenant, 1 hours, offer);
        if (_gr[id].tenant != tenant || block.timestamp >= _gr[id].expiry) return 0;
        bytes32 picture = keccak256(abi.encode("poke", idSeed));
        vm.prank(tenant);
        board.editRented(id, picture);
        _gr[id].tenantHash = picture;
        ghostTenantPictures++;
        ghostChanges++;
        vm.warp(block.timestamp + 1 hours);
        return id;
    }

    // -----------------------------------------------------------------
    // The model
    // -----------------------------------------------------------------

    function _rowsDigest() internal view returns (bytes32 d) {
        for (uint256 r = 0; r < ROWS + 2; r++) {
            d = keccak256(abi.encode(d, board.cellRow(r)));
        }
    }
}

/// @notice The core properties: every cell held by exactly the block the model says; money in equals
/// seller credit plus protocol cut; the minted owner is `recipient`. Plus the one the spec promises in
/// words — no function takes a block from its owner — and, since the board became the NFT
/// (2026-10-09), that every sale credits whoever held the board at that moment.
///
/// Since 2026-10-11, also: a listing is only ever the current owner's, ends when the block changes
/// hands, and a resale credits the owner, the board's holder and the protocol exactly the price.
/// And: a buy of several rectangles is all or nothing, each block priced and cut on its own; only
/// the board's holder lowers prices, only ever down, and every buy after is charged the model's
/// scaled price.
///
/// Since 2026-10-14 (takeovers): a block's cells left, level and time of purchase equal the model's;
/// every party — displaced owners, the board's holder, the protocol — is credited across each buy
/// exactly what the model priced.
///
/// Since 2026-10-20 (rentals): every tenancy, rent offer and shown picture equals the model's;
/// rentals, extensions, claims, takes and changes of owner each credit exactly what the model
/// streamed or refunded; the board holds what it owes plus the rent still streaming.
///
/// Since 2026-10-21 (blocks are tokens): every balance is the number of blocks the model gives that
/// address; every approval and operator is the model's and an approval dies with every change of
/// owner; a transfer by an approved address or an operator credits exactly what the owner's own
/// gift would; an approved address can do nothing but move the block; the change counter and each
/// term's `poke` mark are the model's; an id never sold has no owner.
///
/// One `invariant_` on purpose: each is a separate campaign, so grouping keeps the run short.
/// 48 runs × 750 calls (2026-10-20; 64 × 500 before rentals): six rental actions spread a run's
/// calls thinner, and longer runs keep every coverage check landing. The model is checked cell by
/// cell after every call; the 12×10 grid fills within a few dozen buys per run.
/// forge-config: default.invariant.runs = 48
/// forge-config: default.invariant.depth = 750
contract ImageBoardInvariantTest is Test {
    ImageBoard internal board;
    TestUSD internal usd;
    ImageBoardHandler internal handler;
    ImageBoardCollection internal boardCollection;

    address internal seller = makeAddr("seller");
    address internal protocol = makeAddr("protocol");

    /// A run with fewer handler calls than this is a shrink replay; see `afterInvariant`.
    uint256 internal constant COVERAGE_MIN_CALLS = 200;

    function setUp() public {
        usd = new TestUSD("websitekit Test Dollar", "tUSD", 6);
        ImageBoardRenderer renderer = new ImageBoardRenderer("https://example.com/i/boards/", "ipfs://bafyrenderer/");
        ImageBoard implementation = new ImageBoard(address(new ImageBoardExtension(500, protocol)), address(renderer));
        address[] memory tokens = new address[](1);
        tokens[0] = address(usd);
        ImageBoardCollection collection =
            new ImageBoardCollection("Test Image Boards", "TIMG", address(this), address(implementation), tokens, "");

        // 125×104 at 10 px → 12×10, with a strip unsold on both axes; zones as
        // `invariantBoardConfig` describes.
        address[4] memory actors = [makeAddr("a0"), makeAddr("a1"), makeAddr("a2"), makeAddr("a3")];
        (address created,) = collection.createBoardFor(seller, abi.encode(invariantBoardConfig(address(usd))));
        board = ImageBoard(created);
        boardCollection = collection;

        for (uint256 i = 0; i < 4; i++) {
            usd.mint(actors[i], 1_000_000 * 1e6);
            vm.prank(actors[i]);
            usd.approve(address(board), type(uint256).max);
        }

        handler = new ImageBoardHandler(board, collection, usd, seller, protocol, actors);
        targetContract(address(handler));
    }

    function invariant_imageBoard() public view {
        _noSharedCells();
        _moneyInEqualsCredits();
        _ownersAreRecipientsAndOnlyTheyMoveBlocks();
        _listingsAreTheCurrentOwnersOnly();
        _rentalsAreTheModels();
        _tokensAreTheModels();
    }

    /// Balances, approvals, operators, the change counter and every term's poke mark are the model's;
    /// transfers moved exactly the rent the model streamed; an approval granted nothing but a move.
    function _tokensAreTheModels() internal view {
        assertEq(handler.violMoneyAcrossTransfer(), 0, "a transfer credited other than what streamed");
        assertEq(handler.violApprovalOutlivedOwner(), 0, "an approval survived its block changing hands");
        assertEq(handler.violApprovedDidMore(), 0, "an approved address edited, listed, offered or named an editor");
        assertEq(handler.violPokeModelDisagrees(), 0, "a poke went through, or was refused, against the model");
        assertEq(board.changes(), handler.ghostChanges(), "the change counter is not the model's");
        for (uint256 i = 0; i < 6; i++) {
            address a = handler.party(i);
            uint256 held;
            for (uint256 id = 1; id <= handler.ghostBlocks(); id++) {
                if (handler.ghostOwner(id) == a) held++;
            }
            assertEq(board.balanceOf(a), held, "a balance is not the blocks the model gives that address");
            for (uint256 j = 0; j < 6; j++) {
                address b = handler.party(j);
                assertEq(board.isApprovedForAll(a, b), handler.ghostOperator(a, b), "an operator is not the model's");
            }
        }
        for (uint256 id = 1; id <= handler.ghostBlocks(); id++) {
            assertEq(board.getApproved(id), handler.ghostApproved(id), "an approval is not the model's");
            assertEq(board.rentalOf(id).poked, handler.ghostRental(id).poked, "a term's poke mark is not the model's");
        }
    }

    /// Every tenancy, rent offer and shown picture is the model's; a rental, extension or edit went
    /// through exactly when the model said; rent moved exactly what the model priced.
    function _rentalsAreTheModels() internal view {
        assertEq(
            handler.violRentModelDisagrees(), 0, "a rental action went through, or was refused, against the model"
        );
        assertEq(handler.violMoneyAcrossRent(), 0, "rent moved or credited the wrong amount");
        for (uint256 id = 1; id <= handler.ghostBlocks(); id++) {
            ImageBoardStorage.Rental memory t = board.rentalOf(id);
            ImageBoardHandler.GhostRental memory g = handler.ghostRental(id);
            assertEq(t.tenant, g.tenant, "a tenancy's tenant is not the model's");
            assertEq(t.start, g.start, "a tenancy's start is not the model's");
            assertEq(t.expiry, g.expiry, "a tenancy's end is not the model's");
            assertEq(t.prepaid, g.prepaid, "a tenancy's escrow is not the model's");
            assertEq(t.claimed, g.claimed, "a tenancy's claimed rent is not the model's");
            assertEq(t.tenantHash, g.tenantHash, "a tenant's picture is not the model's");
            (uint192 rate, uint64 max) = board.rentListing(id);
            assertEq(rate, handler.ghostRentRate(id), "a rent offer is not the model's");
            assertEq(max, handler.ghostRentMax(id), "a rent offer's term is not the model's");
            assertEq(board.shownHash(id), handler.ghostShown(id), "the picture shown is not the model's");
        }
    }

    /// Every listing on the board is the one the model says its current owner set; a resale went
    /// through exactly when the model said it should, and never at a price the buyer did not name.
    function _listingsAreTheCurrentOwnersOnly() internal view {
        assertEq(handler.violResaleModelDisagrees(), 0, "a resale went through, or was refused, against the model");
        assertEq(handler.violStrangerListed(), 0, "someone other than the owner listed or delisted a block");
        assertEq(handler.violListingOutlivedOwner(), 0, "a listing survived its block changing hands");
        assertEq(
            handler.violListedWithNothingLeft(), 0, "a block with no cells was listed, or one with cells refused"
        );
        for (uint256 id = 1; id <= handler.ghostBlocks(); id++) {
            assertEq(board.listPrice(id), handler.ghostList(id), "a listing the model does not know");
        }
    }

    /// The board's cell map equals the model's, cell for cell, and so does what each block has left,
    /// its level and when it was bought. A buy the board took that the model refused — over a cooling
    /// cell, or itself — shows up as a violation.
    function _noSharedCells() internal view {
        assertEq(handler.violAcceptedWhatModelRefused(), 0, "the board sold cells the model refuses");
        assertEq(handler.violRefusedWhatModelAccepted(), 0, "the board refused a buy the model accepts");
        assertEq(handler.violRefusedBuyChangedState(), 0, "a refused buy changed state");
        assertEq(handler.violKeptWrongReason(), 0, "a buy was refused as kept, or not, against the model");

        for (uint256 r = 0; r < handler.ROWS() + 2; r++) {
            uint256[] memory words = board.cellRow(r);
            uint256 bits;
            for (uint256 c = 0; c < handler.COLS(); c++) {
                uint256 id = (words[c / 8] >> ((c % 8) * 32)) & type(uint32).max;
                assertEq(id, r < handler.ROWS() ? handler.ghostCell(c, r) : 0, "the cell map and the model disagree");
                if (id != 0) bits |= uint256(1) << c;
            }
            assertEq(board.rowBits(r), bits, "rowBits is not the map's");
        }
        uint256 free = uint256(handler.COLS()) * handler.ROWS() - handler.KEPT_CELLS();
        for (uint256 id = 1; id <= handler.ghostBlocks(); id++) {
            ImageBoardStorage.Block memory b = board.blockOf(id);
            uint16[4] memory s = handler.shape(id);
            assertEq(b.col, s[0], "a block's shape changed");
            assertEq(b.row, s[1], "a block's shape changed");
            assertEq(b.cols, s[2], "a block's shape changed");
            assertEq(b.rows, s[3], "a block's shape changed");
            uint256 left = handler._cellsLeft(id);
            assertEq(b.cellsLeft, left, "a block's cells left are not the model's");
            assertEq(b.level, handler.ghostLevel(id), "a block's level is not the model's");
            assertEq(b.boughtAt, handler.ghostBoughtAt(id), "a block's time is not the model's");
            free -= left;
        }
        assertEq(board.freeCells(), free, "free cells are not the model's");
    }

    function _moneyInEqualsCredits() internal view {
        assertEq(handler.violMoneyAcrossBuy(), 0, "a buy or withdrawal moved the wrong amount");
        assertEq(handler.violMoneyAcrossResale(), 0, "a resale moved or credited the wrong amount");
        assertEq(
            handler.ghostPaidIn(),
            handler.ghostSellerCredited() + handler.ghostProtocolCredited() + handler.ghostResaleCredited()
                + handler.ghostPayoutsCredited() + handler.ghostRentCredited() + handler.ghostEscrow(),
            "money in is not every credit plus the rent still streaming"
        );
        assertEq(handler.violPaidTheWrongHolder(), 0, "a sale credited someone other than the board's holder");
        assertEq(handler.violCutModelDisagrees(), 0, "a price cut went through, or was refused, against the model");
        assertEq(
            board.priceBps(), handler.ghostPriceBps(), "the board's prices are not the ones the model lowered them to"
        );
        uint256 owed;
        for (uint256 i = 0; i < 6; i++) {
            address a = handler.party(i);
            assertEq(
                board.pendingWithdrawals(a) + handler.ghostWithdrawn(a),
                handler.ghostCredited(a),
                "a party's ledger lost or gained money"
            );
            owed += board.pendingWithdrawals(a);
        }
        // Since rentals (2026-10-20): owed, plus rent paid and not yet streamed to anyone.
        assertEq(
            usd.balanceOf(address(board)),
            owed + handler.ghostEscrow(),
            "the board holds other than what it owes and escrows"
        );
    }

    function _ownersAreRecipientsAndOnlyTheyMoveBlocks() internal view {
        assertEq(handler.violWrongRecipient(), 0, "a block was minted to someone other than the recipient");
        assertEq(handler.violStrangerMovedBlock(), 0, "a stranger moved someone's block");
        assertEq(board.blockCount(), handler.ghostBlocks(), "a block appeared the model did not see");
        for (uint256 id = 1; id <= handler.ghostBlocks(); id++) {
            assertEq(board.ownerOf(id), handler.ghostOwner(id), "a block changed hands without its owner");
        }
        // ERC-721: an id never sold has no owner to answer with.
        (bool answered,) = address(board).staticcall(abi.encodeCall(board.ownerOf, (handler.ghostBlocks() + 1)));
        assertFalse(answered, "an unsold id has an owner");
        assertEq(
            boardCollection.ownerOf(board.boardTokenId()), handler.ghostHolder(), "the board moved without its holder"
        );
    }

    /// Coverage, so a green run means the properties were exercised. Skipped on a shrink replay, or
    /// its message replaces the property failure that caused the replay.
    function afterInvariant() public view {
        if (handler.ghostCalls() < COVERAGE_MIN_CALLS) return;
        console.log(
            "buys ok / taken / outside", handler.ghostBuysOk(), handler.ghostBuysTaken(), handler.ghostBuysOutside()
        );
        console.log("transfers / stranger tries", handler.ghostTransfers(), handler.ghostStrangerAttempts());
        console.log("edits / withdrawals       ", handler.ghostEdits(), handler.ghostWithdrawals());
        console.log("board moves / buys after  ", handler.ghostBoardMoves(), handler.ghostBuysAfterAMove());
        console.log(
            "listings / resales ok / stale",
            handler.ghostListings(),
            handler.ghostResalesOk(),
            handler.ghostResalesStale()
        );
        console.log("listings ended by a gift  ", handler.ghostListingsEndedByGift());
        assertGt(handler.ghostBuysOk(), 0, "no buy ever landed");
        assertGt(handler.ghostBuysTaken(), 0, "no buy was ever refused over a sold cell");
        assertGt(handler.ghostBuysOutside(), 0, "no buy ever left the grid");
        assertGt(handler.ghostTransfers(), 0, "no block ever changed hands");
        assertGt(handler.ghostStrangerAttempts(), 0, "no stranger ever tried");
        assertGt(handler.ghostWithdrawals(), 0, "nothing was ever withdrawn");
        assertGt(
            handler.ghostBuysAfterAMove(),
            0,
            "no sale ever followed a move of the board - proceeds-follow-the-NFT was vacuous"
        );
        assertGt(handler.ghostResalesOk(), 0, "no resale ever landed");
        assertGt(handler.ghostResalesStale(), 0, "no resale ever named a stale price - the price check was vacuous");
        assertGt(handler.ghostListingsEndedByGift(), 0, "no listing was ever ended by a gift");
        console.log("buys over mixed prices    ", handler.ghostBuysMixedPrice());
        assertGt(handler.ghostBuysMixedPrice(), 0, "no buy ever straddled a zone edge - zone pricing was vacuous");
        console.log(
            "two-block buys ok / self-overlap", handler.ghostMultiBuysOk(), handler.ghostMultiBuysSelfOverlap()
        );
        console.log(
            "cuts / refused / buys after",
            handler.ghostCuts(),
            handler.ghostCutsRefused(),
            handler.ghostBuysAfterACut()
        );
        assertGt(handler.ghostMultiBuysOk(), 0, "no two-block buy ever landed");
        assertGt(
            handler.ghostMultiBuysSelfOverlap(),
            0,
            "no buy ever overlapped itself - the all-or-nothing rule was vacuous"
        );
        assertGt(handler.ghostCuts(), 0, "no price was ever lowered");
        assertGt(handler.ghostCutsRefused(), 0, "no cut was ever refused");
        assertGt(handler.ghostBuysAfterACut(), 0, "no buy followed a cut - the scaled price was vacuous");
        console.log(
            "takes / after a week / cooling",
            handler.ghostTakesOk(),
            handler.ghostTakesAfterAWeek(),
            handler.ghostRefusedCooling()
        );
        console.log(
            "listings ended by a take / listing refused, nothing left",
            handler.ghostListingsEndedByTake(),
            handler.ghostListRefusedNothingLeft()
        );
        assertGt(handler.ghostTakesOk(), 0, "no take ever landed");
        assertGt(handler.ghostTakesAfterAWeek(), 0, "no take came a week after a buy - reversion was vacuous");
        assertGt(handler.ghostRefusedCooling(), 0, "no buy was refused for a cooldown");
        console.log("refused as kept           ", handler.ghostRefusedKept());
        assertGt(handler.ghostRefusedKept(), 0, "no buy was ever refused over a kept cell");
        assertGt(handler.ghostListingsEndedByTake(), 0, "no take ever ended a listing");
        console.log(
            "rent offers / rentals / after a lapse",
            handler.ghostRentListings(),
            handler.ghostRentals(),
            handler.ghostRentalsAfterALapse()
        );
        console.log("rent refused stale / active", handler.ghostRentRefusedStale(), handler.ghostRentRefusedActive());
        console.log("extensions / refused", handler.ghostExtensions(), handler.ghostExtendRefused());
        console.log(
            "refunds on a take / rented changed hands",
            handler.ghostRefundsOnTake(),
            handler.ghostRentedChangedHands()
        );
        console.log("claims / tenant pictures", handler.ghostRentClaims(), handler.ghostTenantPictures());
        console.log(
            "rent offers ended by a take / resale listings ended by a rental",
            handler.ghostRentListingsEndedByTake(),
            handler.ghostListingsEndedByRent()
        );
        assertGt(handler.ghostRentals(), 0, "no rental ever landed");
        assertGt(handler.ghostRentalsAfterALapse(), 0, "no block was rented again after a term lapsed");
        assertGt(handler.ghostRentRefusedStale(), 0, "no rental named a stale rate - the rate check was vacuous");
        assertGt(handler.ghostRentRefusedActive(), 0, "no rental was refused over a live term");
        assertGt(handler.ghostExtensions(), 0, "no term was ever extended");
        assertGt(handler.ghostRefundsOnTake(), 0, "no take ever refunded a tenant");
        assertGt(handler.ghostRentedChangedHands(), 0, "no rented block ever changed hands");
        assertGt(handler.ghostTenantPictures(), 0, "no tenant ever set a picture");
        assertGt(handler.ghostRentListingsEndedByTake(), 0, "no take ever ended a rent offer");
        assertGt(handler.ghostListingsEndedByRent(), 0, "no rental ever ended a resale listing");
        console.log(
            "transfers by approved / by operator / refused",
            handler.ghostTransfersByApproved(),
            handler.ghostTransfersByOperator(),
            handler.ghostTransfersRefused()
        );
        console.log(
            "approved tried more / pokes / refused",
            handler.ghostApprovedRefused(),
            handler.ghostPokes(),
            handler.ghostPokesRefused()
        );
        assertGt(handler.ghostTransfersByApproved(), 0, "no block was ever moved by an approved address");
        assertGt(handler.ghostTransfersByOperator(), 0, "no block was ever moved by an operator");
        assertGt(handler.ghostTransfersRefused(), 0, "no unapproved transfer was ever refused");
        assertGt(handler.ghostApprovedRefused(), 0, "no approved address ever tried more than a move");
        assertGt(handler.ghostPokes(), 0, "no lapsed term was ever poked");
        assertGt(handler.ghostPokesRefused(), 0, "no poke was ever refused");
    }
}
