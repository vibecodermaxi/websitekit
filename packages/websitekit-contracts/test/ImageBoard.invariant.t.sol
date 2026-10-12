// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { console } from "forge-std/console.sol";
import { ImageBoard } from "../src/ImageBoard.sol";
import { ImageBoardCollection } from "../src/ImageBoardCollection.sol";
import { TestUSD } from "../src/mocks/TestUSD.sol";

/// What the board is created with. The model below does NOT read these: it has its own map.
function invariantBoardConfig(address token) pure returns (ImageBoard.Config memory cfg) {
    cfg.settlementToken = token;
    cfg.width = 125;
    cfg.height = 104;
    cfg.cellSize = 10;
    cfg.cellPrice = 10_003;
    cfg.imageHash = keccak256("img");
    cfg.zones = new ImageBoard.Zone[](3);
    cfg.zones[0] = ImageBoard.Zone({ col: 0, row: 0, cols: 4, rows: 3, cellPrice: 30_011 });
    cfg.zones[1] = ImageBoard.Zone({ col: 6, row: 5, cols: 3, rows: 4, cellPrice: 2_003 });
    cfg.zones[2] = ImageBoard.Zone({ col: 9, row: 7, cols: 3, rows: 2, cellPrice: 50_009 });
    cfg.kept = new ImageBoard.Rect[](1);
    cfg.kept[0] = ImageBoard.Rect({ col: 10, row: 8, cols: 2, rows: 2 });
}

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
/// **Zones and kept squares (2026-10-11)**: the board is made with three zones — one dearer, one
/// cheaper, one lying over a kept block — and one kept block, the seller's, as block 1. The model
/// prices a buy CELL BY CELL from its own map (`_cellPrice`), where the contract sums overlaps per
/// zone: two algorithms that must agree, on buys that straddle zone edges.
///
/// **Several rectangles in one buy, and lowered prices (2026-10-11)**: buys of two rectangles —
/// sometimes overlapping each other on purpose — are decided by the model as a whole, all or
/// nothing, and each block priced on its own. Whoever the model says holds the board (and, to be
/// refused, anyone else) lowers prices; the model keeps its own share and scales each block's
/// cell-by-cell total by it, rounding up.
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

    /// cell (col, row) → token id, 0 = free.
    mapping(uint256 => mapping(uint256 => uint256)) public ghostCell;
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
    uint256 public violStrangerMovedBlock;
    uint256 public violPaidTheWrongHolder;
    uint256 public violResaleModelDisagrees;
    uint256 public violMoneyAcrossResale;
    uint256 public violStrangerListed;
    uint256 public violListingOutlivedOwner;
    uint256 public violCutModelDisagrees;

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
        // The kept block, made with the board: the seller's, paid by nobody.
        _record(1, seller_, 10, 8, 2, 2);
    }

    function _one(uint16 col, uint16 row, uint16 cols, uint16 rows) internal pure returns (ImageBoard.Rect[] memory rects) {
        rects = new ImageBoard.Rect[](1);
        rects[0] = ImageBoard.Rect({ col: col, row: row, cols: cols, rows: rows });
    }

    /// One cell's price, written out by hand. Prices do not divide by 20, so the cut rounds.
    function _cellPrice(uint256 c, uint256 r) internal pure returns (uint256) {
        if (c < 4 && r < 3) return 30_011;
        if (c >= 6 && c < 9 && r >= 5 && r < 9) return 2_003;
        if (c >= 9 && r >= 7 && r < 9) return 50_009;
        return 10_003;
    }

    function _modelTotal(uint16 col, uint16 row, uint16 cols, uint16 rows) internal pure returns (uint256 total, bool mixed) {
        uint256 first = _cellPrice(col, row);
        for (uint256 c = col; c < uint256(col) + cols; c++) {
            for (uint256 r = row; r < uint256(row) + rows; r++) {
                uint256 p = _cellPrice(c, r);
                total += p;
                if (p != first) mixed = true;
            }
        }
    }

    /// A block's price now: its cell-by-cell total at the model's share, rounded UP — written as a
    /// floor plus one when anything is left over, not the contract's `(x + d - 1) / d`.
    function _modelPrice(uint16 col, uint16 row, uint16 cols, uint16 rows) internal view returns (uint256 price, bool mixed) {
        uint256 total;
        (total, mixed) = _modelTotal(col, row, cols, rows);
        uint256 scaled = total * ghostPriceBps;
        price = scaled / 10_000 + (scaled % 10_000 == 0 ? 0 : 1);
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
    function buyOverATakenCell(uint256 payerSeed, uint256 recipientSeed, uint256 idSeed, uint16 cols, uint16 rows) external {
        ghostCalls++;
        if (ghostBlocks == 0) return;
        uint16[4] memory taken = _ghostShape[idSeed % ghostBlocks + 1];
        _tryBuy(payerSeed, recipientSeed, taken[0], taken[1], uint16(bound(cols, 1, 3)), uint16(bound(rows, 1, 3)));
    }

    /// A buy whose top-left sits one cell outside a zone edge, so its cells span two prices. Uniform
    /// picks on a grid that fills in a few dozen buys land too few of these to rely on.
    function buyAcrossAZoneEdge(uint256 payerSeed, uint256 recipientSeed, uint256 edgeSeed, uint16 cols, uint16 rows)
        external
    {
        ghostCalls++;
        uint16[2][6] memory starts = [
            [uint16(3), 0], // zone 0's right edge
            [uint16(0), 2], // zone 0's bottom edge
            [uint16(5), 5], // zone 1's left edge
            [uint16(6), 4], // zone 1's top edge
            [uint16(8), 7], // zone 1 into zone 2
            [uint16(9), 6] // zone 2's top edge, toward the kept block
        ];
        uint16[2] memory at = starts[edgeSeed % 6];
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
            ImageBoard.Rect[] memory singles = new ImageBoard.Rect[](2);
            singles[0] = ImageBoard.Rect({ col: c1, row: r1, cols: 1, rows: 1 });
            singles[1] = ImageBoard.Rect({ col: c2, row: r2, cols: 1, rows: 1 });
            _tryBuyAll(payerSeed, recipientSeed, singles);
            return;
        }
        ImageBoard.Rect[] memory rects = new ImageBoard.Rect[](2);
        rects[0] = ImageBoard.Rect({ col: c1, row: r1, cols: uint16(1 + shapeSeed % 2), rows: uint16(1 + (shapeSeed >> 8) % 2) });
        bool inside = mode == 0;
        rects[1] = ImageBoard.Rect({
            col: inside ? c1 : c2,
            row: inside ? r1 : r2,
            cols: uint16(1 + (shapeSeed >> 24) % 2),
            rows: uint16(1 + (shapeSeed >> 32) % 2)
        });
        _tryBuyAll(payerSeed, recipientSeed, rects);
    }

    /// The first free cell at or after `seed`'s cell, reading row by row and wrapping.
    function _freeCellFrom(uint256 seed) internal view returns (uint16 col, uint16 row, bool found) {
        uint256 cells = uint256(COLS) * ROWS;
        for (uint256 i = 0; i < cells; i++) {
            uint256 at = (seed + i) % cells;
            if (ghostCell[at % COLS][at / COLS] == 0) return (uint16(at % COLS), uint16(at / COLS), true);
        }
    }

    function _tryBuyAll(uint256 payerSeed, uint256 recipientSeed, ImageBoard.Rect[] memory rects) internal {
        uint256 p = payerSeed % 4;
        address payer = actors[p];
        address recipient = actors[(p + 1 + recipientSeed % 3) % 4]; // never the payer

        (bool modelOk, bool selfOverlap) = _modelAcceptsAll(rects);
        Before memory b = Before({
            board: usd.balanceOf(address(board)),
            payer: usd.balanceOf(payer),
            holderOwed: board.pendingWithdrawals(ghostHolder),
            protocolOwed: board.pendingWithdrawals(protocol),
            count: board.blockCount(),
            rows: _rowsDigest()
        });

        vm.prank(payer);
        try board.buyBlocks(recipient, rects) returns (uint256 first) {
            if (!modelOk) {
                violAcceptedWhatModelRefused++;
                return;
            }
            ghostBuysOk++;
            if (rects.length > 1) ghostMultiBuysOk++;
            if (ghostBoardMoves > 0) ghostBuysAfterAMove++;
            if (ghostPriceBps < 10_000) ghostBuysAfterACut++;
            uint256 total;
            uint256 cut;
            for (uint256 i = 0; i < rects.length; i++) {
                ImageBoard.Rect memory k = rects[i];
                (uint256 price, bool mixed) = _modelPrice(k.col, k.row, k.cols, k.rows);
                if (mixed) ghostBuysMixedPrice++;
                total += price;
                // Each block cut on its own, as if bought alone.
                cut += (price * protocolBps) / 10_000;
                if (board.ownerOf(first + i) != recipient) violWrongRecipient++;
                _record(first + i, recipient, k.col, k.row, k.cols, k.rows);
            }
            _measureBuy(b, payer, total, cut);
        } catch {
            if (modelOk) violRefusedWhatModelAccepted++;
            if (selfOverlap) ghostMultiBuysSelfOverlap++;
            // Counted for single rectangles only: a pair's refusal may be either rectangle's.
            ImageBoard.Rect memory k = rects[0];
            if (rects.length > 1 || k.cols == 0 || k.rows == 0) { }
            else if (uint256(k.col) + k.cols > COLS || uint256(k.row) + k.rows > ROWS) ghostBuysOutside++;
            else ghostBuysTaken++;
            if (usd.balanceOf(address(board)) != b.board || board.blockCount() != b.count || _rowsDigest() != b.rows) {
                violRefusedBuyChangedState++;
            }
        }
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

    /// The holder's credit is measured on the MODEL's holder: if the board paid someone else, this
    /// delta is zero and the violation fires.
    function _measureBuy(Before memory b, address payer, uint256 total, uint256 cut) internal {
        if (
            usd.balanceOf(address(board)) - b.board != total || b.payer - usd.balanceOf(payer) != total
                || board.pendingWithdrawals(protocol) - b.protocolOwed != cut
        ) violMoneyAcrossBuy++;
        if (board.pendingWithdrawals(ghostHolder) - b.holderOwed != total - cut) violPaidTheWrongHolder++;
        ghostPaidIn += total;
        ghostSellerCredited += total - cut;
        ghostProtocolCredited += cut;
        ghostCredited[ghostHolder] += total - cut;
        ghostCredited[protocol] += cut;
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

    function transfer(uint256 idSeed, uint256 toSeed) external {
        ghostCalls++;
        if (ghostBlocks == 0) return;
        uint256 id = idSeed % ghostBlocks + 1;
        // Half the time aim at a listed block, so a gift ending a listing is not left to chance:
        // with every action drawn uniformly, a run could end without one (seen 2026-10-11).
        for (uint256 i = 0; toSeed % 2 == 0 && i < ghostBlocks && ghostList[id] == 0; i++) {
            id = id % ghostBlocks + 1;
        }
        address from = ghostOwner[id];
        address to = actors[(toSeed >> 1) % 4];
        if (ghostList[id] != 0) ghostListingsEndedByGift++;
        vm.prank(from);
        board.transferBlock(id, to);
        ghostOwner[id] = to;
        ghostList[id] = 0;
        if (board.listPrice(id) != 0) violListingOutlivedOwner++;
        ghostTransfers++;
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
        board.listBlock(id, price);
        ghostList[id] = price;
        ghostListings++;
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
            _measureResale(b, payer, from, listed);
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
    function _measureResale(ResaleBefore memory b, address payer, address from, uint256 price) internal {
        uint256 cut = (price * protocolBps) / 10_000;
        uint256 royalty = (price * 500) / 10_000;
        uint256 toOwner = price - cut - royalty;
        if (usd.balanceOf(address(board)) - b.board != price || b.payer - usd.balanceOf(payer) != price) {
            violMoneyAcrossResale++;
        }
        uint256 ownerGain = toOwner + (from == ghostHolder ? royalty : 0);
        uint256 holderGain = royalty + (from == ghostHolder ? toOwner : 0);
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
        if (stranger == owner_) return;
        if (strangerSeed % 3 == 0) {
            // Make the stranger the block's editor first: an editor may change it, never move it.
            vm.prank(owner_);
            board.setEditor(id, stranger);
        }
        ghostStrangerAttempts++;
        vm.prank(stranger);
        try board.transferBlock(id, stranger) {
            violStrangerMovedBlock++;
        } catch { }
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
        ghostEdits++;
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
    // The model
    // -----------------------------------------------------------------

    function _modelAccepts(uint16 col, uint16 row, uint16 cols, uint16 rows) internal view returns (bool) {
        if (cols == 0 || rows == 0) return false;
        if (uint256(col) + cols > COLS || uint256(row) + rows > ROWS) return false;
        for (uint256 c = col; c < uint256(col) + cols; c++) {
            for (uint256 r = row; r < uint256(row) + rows; r++) {
                if (ghostCell[c][r] != 0) return false;
            }
        }
        return true;
    }

    /// Every rectangle against the model's grid and against the ones before it in the same buy.
    /// `selfOverlap`: refused only because two of them share a cell.
    function _modelAcceptsAll(ImageBoard.Rect[] memory rects) internal view returns (bool ok, bool selfOverlap) {
        ok = true;
        for (uint256 i = 0; i < rects.length; i++) {
            ImageBoard.Rect memory k = rects[i];
            if (!_modelAccepts(k.col, k.row, k.cols, k.rows)) return (false, false);
            for (uint256 j = 0; j < i; j++) {
                ImageBoard.Rect memory e = rects[j];
                bool apart = uint256(k.col) + k.cols <= e.col || uint256(e.col) + e.cols <= k.col
                    || uint256(k.row) + k.rows <= e.row || uint256(e.row) + e.rows <= k.row;
                if (!apart) return (false, true);
            }
        }
    }

    function _rowsDigest() internal view returns (bytes32 d) {
        for (uint256 r = 0; r < ROWS + 2; r++) {
            d = keccak256(abi.encode(d, board.rowBits(r)));
        }
    }
}

/// @notice The core properties: no shared cells; money in equals
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
/// One `invariant_` on purpose: each is a separate campaign, so grouping keeps the run short.
/// 64 runs × 500 calls: the model is checked cell by cell after every call, and 256 runs took
/// 221 s for no more coverage — the 12×10 grid fills within a few dozen buys per run.
/// forge-config: default.invariant.runs = 64
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
        ImageBoard implementation = new ImageBoard(500, protocol);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usd);
        ImageBoardCollection collection =
            new ImageBoardCollection("Test Image Boards", "TIMG", address(this), address(implementation), tokens, "");

        // 125×104 at 10 px → 12×10, with a strip unsold on both axes; zones and a kept block as
        // `invariantBoardConfig` describes.
        address[4] memory actors = [makeAddr("a0"), makeAddr("a1"), makeAddr("a2"), makeAddr("a3")];
        (address created,) = collection.createBoardFor(seller, invariantBoardConfig(address(usd)));
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
    }

    /// Every listing on the board is the one the model says its current owner set; a resale went
    /// through exactly when the model said it should, and never at a price the buyer did not name.
    function _listingsAreTheCurrentOwnersOnly() internal view {
        assertEq(handler.violResaleModelDisagrees(), 0, "a resale went through, or was refused, against the model");
        assertEq(handler.violStrangerListed(), 0, "someone other than the owner listed or delisted a block");
        assertEq(handler.violListingOutlivedOwner(), 0, "a listing survived its block changing hands");
        for (uint256 id = 1; id <= handler.ghostBlocks(); id++) {
            assertEq(board.listPrice(id), handler.ghostList(id), "a listing the model does not know");
        }
    }

    /// The bitmap equals the model's occupancy cell for cell, and the model only ever accepted
    /// disjoint blocks — so a buy the board took over a taken cell shows up as a violation.
    function _noSharedCells() internal view {
        assertEq(handler.violAcceptedWhatModelRefused(), 0, "the board sold a block the model says overlaps or is outside");
        assertEq(handler.violRefusedWhatModelAccepted(), 0, "the board refused a block the model says is free");
        assertEq(handler.violRefusedBuyChangedState(), 0, "a refused buy changed state");

        for (uint256 r = 0; r < handler.ROWS() + 2; r++) {
            uint256 expected;
            for (uint256 c = 0; c < handler.COLS(); c++) {
                if (handler.ghostCell(c, r) != 0) expected |= uint256(1) << c;
            }
            assertEq(board.rowBits(r), expected, "the bitmap and the model disagree");
        }
        for (uint256 id = 1; id <= handler.ghostBlocks(); id++) {
            ImageBoard.Block memory b = board.blockOf(id);
            uint16[4] memory s = handler.shape(id);
            assertEq(b.col, s[0], "a block's shape changed");
            assertEq(b.row, s[1], "a block's shape changed");
            assertEq(b.cols, s[2], "a block's shape changed");
            assertEq(b.rows, s[3], "a block's shape changed");
            for (uint256 c = b.col; c < uint256(b.col) + b.cols; c++) {
                for (uint256 r = b.row; r < uint256(b.row) + b.rows; r++) {
                    assertEq(handler.ghostCell(c, r), id, "two blocks claim one cell");
                }
            }
        }
    }

    function _moneyInEqualsCredits() internal view {
        assertEq(handler.violMoneyAcrossBuy(), 0, "a buy or withdrawal moved the wrong amount");
        assertEq(handler.violMoneyAcrossResale(), 0, "a resale moved or credited the wrong amount");
        assertEq(
            handler.ghostPaidIn(),
            handler.ghostSellerCredited() + handler.ghostProtocolCredited() + handler.ghostResaleCredited(),
            "money in is not seller credit plus protocol cut plus resale credits"
        );
        assertEq(handler.violPaidTheWrongHolder(), 0, "a sale credited someone other than the board's holder");
        assertEq(handler.violCutModelDisagrees(), 0, "a price cut went through, or was refused, against the model");
        assertEq(board.priceBps(), handler.ghostPriceBps(), "the board's prices are not the ones the model lowered them to");
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
        assertEq(usd.balanceOf(address(board)), owed, "the board holds other than what it owes");
    }

    function _ownersAreRecipientsAndOnlyTheyMoveBlocks() internal view {
        assertEq(handler.violWrongRecipient(), 0, "a block was minted to someone other than the recipient");
        assertEq(handler.violStrangerMovedBlock(), 0, "a stranger moved someone's block");
        assertEq(board.blockCount(), handler.ghostBlocks(), "a block appeared the model did not see");
        for (uint256 id = 1; id <= handler.ghostBlocks(); id++) {
            assertEq(board.ownerOf(id), handler.ghostOwner(id), "a block changed hands without its owner");
        }
        assertEq(board.ownerOf(handler.ghostBlocks() + 1), address(0), "an unsold id has an owner");
        assertEq(boardCollection.ownerOf(board.boardTokenId()), handler.ghostHolder(), "the board moved without its holder");
    }

    /// Coverage, so a green run means the properties were exercised. Skipped on a shrink replay, or
    /// its message replaces the property failure that caused the replay.
    function afterInvariant() public view {
        if (handler.ghostCalls() < COVERAGE_MIN_CALLS) return;
        console.log("buys ok / taken / outside", handler.ghostBuysOk(), handler.ghostBuysTaken(), handler.ghostBuysOutside());
        console.log("transfers / stranger tries", handler.ghostTransfers(), handler.ghostStrangerAttempts());
        console.log("edits / withdrawals       ", handler.ghostEdits(), handler.ghostWithdrawals());
        console.log("board moves / buys after  ", handler.ghostBoardMoves(), handler.ghostBuysAfterAMove());
        console.log("listings / resales ok / stale", handler.ghostListings(), handler.ghostResalesOk(), handler.ghostResalesStale());
        console.log("listings ended by a gift  ", handler.ghostListingsEndedByGift());
        assertGt(handler.ghostBuysOk(), 0, "no buy ever landed");
        assertGt(handler.ghostBuysTaken(), 0, "no buy ever hit a taken cell - the overlap property was vacuous");
        assertGt(handler.ghostBuysOutside(), 0, "no buy ever left the grid");
        assertGt(handler.ghostTransfers(), 0, "no block ever changed hands");
        assertGt(handler.ghostStrangerAttempts(), 0, "no stranger ever tried");
        assertGt(handler.ghostWithdrawals(), 0, "nothing was ever withdrawn");
        assertGt(handler.ghostBuysAfterAMove(), 0, "no sale ever followed a move of the board - proceeds-follow-the-NFT was vacuous");
        assertGt(handler.ghostResalesOk(), 0, "no resale ever landed");
        assertGt(handler.ghostResalesStale(), 0, "no resale ever named a stale price - the price check was vacuous");
        assertGt(handler.ghostListingsEndedByGift(), 0, "no listing was ever ended by a gift");
        console.log("buys over mixed prices    ", handler.ghostBuysMixedPrice());
        assertGt(handler.ghostBuysMixedPrice(), 0, "no buy ever straddled a zone edge - zone pricing was vacuous");
        console.log("two-block buys ok / self-overlap", handler.ghostMultiBuysOk(), handler.ghostMultiBuysSelfOverlap());
        console.log("cuts / refused / buys after", handler.ghostCuts(), handler.ghostCutsRefused(), handler.ghostBuysAfterACut());
        assertGt(handler.ghostMultiBuysOk(), 0, "no two-block buy ever landed");
        assertGt(handler.ghostMultiBuysSelfOverlap(), 0, "no buy ever overlapped itself - the all-or-nothing rule was vacuous");
        assertGt(handler.ghostCuts(), 0, "no price was ever lowered");
        assertGt(handler.ghostCutsRefused(), 0, "no cut was ever refused");
        assertGt(handler.ghostBuysAfterACut(), 0, "no buy followed a cut - the scaled price was vacuous");
    }
}
