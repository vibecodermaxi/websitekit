// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { ImageBoardStorage } from "./ImageBoardStorage.sol";
import { RentalsLib } from "./RentalsLib.sol";
import { TermsLib } from "./TermsLib.sol";

/// @notice A board's set-up and its rentals, run by the board through DELEGATECALL, in the board's
/// own storage. `docs/IMAGE-BOARD-SPEC.md` §13.1 and §12.
///
/// Split out of `ImageBoard` only because the board with its token surface does not fit EIP-170
/// (2026-10-21: 27,812 B whole, 20,893 B with this moved). The board forwards each of these
/// functions by name, so its own ABI stays complete; there is no fallback.
///
/// **Only meaningful through a board.** `msg.sender` is the board's caller, `address(this)` the
/// board, and every write lands in the board's storage. Called directly, this contract runs on its
/// own empty storage, which holds no board and no money: `initialize` refuses (the constructor marks
/// it initialized) and every rental refuses for want of an offer.
///
/// `nonReentrant` is declared HERE, not on the board's forwarders: the guard's transient slot is the
/// board's under DELEGATECALL, so one guard spans both contracts, and a forwarder that also took it
/// would lock itself out.
contract ImageBoardExtension is ImageBoardStorage {
    using SafeERC20 for IERC20;

    constructor(uint256 protocolBps_, address protocolTreasury_) ImageBoardStorage(protocolBps_, protocolTreasury_) { }

    // ---------------------------------------------------------------------
    // Set-up
    // ---------------------------------------------------------------------

    /// @notice Called by the collection, in the transaction that clones this board. `msg.sender`
    /// becomes the collection: a clone initialized by anyone else is not one of ours, because our
    /// collection does not know it and will not take its updates. `creator_` is who the board was
    /// created for; the collection has already refused a zero one. `config` is an ABI-encoded
    /// `Config`: the collection passes it through unread, so a later implementation may take another
    /// shape. The collection checks `settlementToken` against its allowlist after this returns.
    function initialize(uint256 boardTokenId_, address creator_, bytes calldata config) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        Config memory cfg = abi.decode(config, (Config));
        if (cfg.settlementToken == address(0)) revert ZeroAddress();
        if (cfg.cellSize < MIN_CELL_SIZE || cfg.cellSize > MAX_CELL_SIZE) revert InvalidConfig();
        if (cfg.cellPrice == 0 || cfg.imageHash == bytes32(0)) revert InvalidConfig();
        // Lengths only: the renderer escapes whatever is here, and nothing reads it as UTF-8.
        if (bytes(cfg.name).length == 0 || bytes(cfg.name).length > 100) revert InvalidConfig();
        if (bytes(cfg.description).length > 1_000) revert InvalidConfig();
        // A binary CIDv1; whether it addresses the image is for renderers to check against `imageHash`.
        if (cfg.sourceCid.length == 0 || cfg.sourceCid.length > 64 || cfg.sourceCid[0] != 0x01) revert InvalidConfig();
        Terms memory t = cfg.terms;
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
        sourceCid = cfg.sourceCid;
        name = cfg.name;
        description = cfg.description;
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
    }

    /// @dev Overlap is checked on a bitmap in memory, one word per row, so it costs the zones' rows
    /// rather than every pair of zones.
    function _setZones(Zone[] memory given, uint256 rows) internal {
        if (given.length > MAX_ZONES) revert InvalidConfig();
        uint256[] memory covered = new uint256[](rows);
        for (uint256 i = 0; i < given.length; i++) {
            Zone memory z = given[i];
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

    // ---------------------------------------------------------------------
    // Renting
    // ---------------------------------------------------------------------

    /// @notice Offers a block for rent at `ratePerDay`, for terms up to `maxDurationSecs`; a rate of
    /// zero ends the offer. Its owner alone, while it still holds a cell. A new rate reaches the next
    /// rental and the next extension, never a term already paid for.
    function listForRent(uint256 blockId, uint256 ratePerDay, uint64 maxDurationSecs) external {
        if (_owners[blockId] != msg.sender) revert NotBlockOwner();
        if (ratePerDay == 0) {
            _endRentListing(blockId, msg.sender);
            return;
        }
        if (_blocks[blockId].cellsLeft == 0) revert NothingLeft();
        if (maxDurationSecs < MIN_RENTAL_DURATION || maxDurationSecs > MAX_RENTAL_TERM) revert TermTooLong();
        rentListing[blockId] = RentListing({ ratePerDay: SafeCast.toUint192(ratePerDay), maxDurationSecs: maxDurationSecs });
        emit RentListed(blockId, msg.sender, ratePerDay, maxDurationSecs);
    }

    /// @notice Rents a block for `tenant` for `durationSecs` from now, at exactly `expectedRatePerDay`
    /// — the owner can change the rate at any time, including while this is on its way. The payer
    /// pays the whole term up front: 5% to the protocol, 5% to whoever holds the board's NFT, and the
    /// rest held here and streamed to whoever owns the block as the term runs. A rental starting ends
    /// any resale listing, so nobody buys a block whose term they were not shown.
    function rent(uint256 blockId, address tenant, uint64 durationSecs, uint256 expectedRatePerDay) external nonReentrant {
        _rent(blockId, tenant, durationSecs, expectedRatePerDay);
    }

    /// @notice `rent` in one transaction: the payer's EIP-2612 signature for exactly the term's cost.
    function rentWithPermit(
        uint256 blockId,
        address tenant,
        uint64 durationSecs,
        uint256 expectedRatePerDay,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        _permit(RentalsLib.rentCost(expectedRatePerDay, durationSecs), permitDeadline, v, r, s);
        _rent(blockId, tenant, durationSecs, expectedRatePerDay);
    }

    /// @notice The tenant makes their term `durationSecs` from now, at the CURRENT rate — an
    /// incumbent never keeps an old rate. What they paid and has not yet streamed carries into the
    /// new term. Live terms only; the owner ends the possibility by ending the offer.
    function extendRental(uint256 blockId, uint64 durationSecs, uint256 expectedRatePerDay) external nonReentrant {
        _extend(blockId, durationSecs, expectedRatePerDay);
    }

    function extendRentalWithPermit(
        uint256 blockId,
        uint64 durationSecs,
        uint256 expectedRatePerDay,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        _permit(RentalsLib.rentCost(expectedRatePerDay, durationSecs), permitDeadline, v, r, s);
        _extend(blockId, durationSecs, expectedRatePerDay);
    }

    /// @notice Credits each block's owner the rent streamed to them so far. Permissionless: it only
    /// ever pays whoever owns the block, so it grants nothing.
    function claimRent(uint256[] calldata blockIds) external {
        for (uint256 i = 0; i < blockIds.length; i++) {
            _settle(blockIds[i], _owners[blockIds[i]]);
        }
    }

    /// @notice The tenant's picture for their term. The owner's picture is untouched and returns when
    /// the term ends; the owner may change it meanwhile.
    function editRented(uint256 blockId, bytes32 contentHash) external {
        Rental storage t = _rentals[blockId];
        if (block.timestamp >= t.expiry) revert RentalExpired();
        if (msg.sender != t.tenant) revert NotTenant();
        t.tenantHash = contentHash;
        Block storage b = _blocks[blockId];
        b.version += 1;
        emit BlockEdited(blockId, msg.sender, contentHash, b.version);
        emit MetadataUpdate(blockId);
        _changed();
    }

    function _rent(uint256 blockId, address tenant, uint64 durationSecs, uint256 expectedRatePerDay) internal {
        if (tenant == address(0)) revert ZeroAddress();
        RentListing memory l = _checkRate(blockId, durationSecs, expectedRatePerDay);
        address owner_ = _owners[blockId];
        Rental storage t = _rentals[blockId];
        if (block.timestamp < t.expiry) revert RentalActive();
        // A lapsed term's last stream is its owner's before a new one starts.
        _settle(blockId, owner_);
        uint256 cost = RentalsLib.rentCost(l.ratePerDay, durationSecs);
        uint256 expiry = block.timestamp + durationSecs;
        t.tenant = tenant;
        t.start = uint40(block.timestamp);
        t.expiry = uint40(expiry);
        t.poked = false;
        t.prepaid = SafeCast.toUint128(_book(cost));
        t.claimed = 0;
        delete t.tenantHash;
        if (listPrice[blockId] != 0) {
            delete listPrice[blockId];
            emit BlockDelisted(blockId, owner_);
        }
        emit BlockRented(blockId, tenant, msg.sender, expiry, cost);
        emit UpdateUser(blockId, tenant, uint64(expiry));
        emit MetadataUpdate(blockId);
    }

    function _extend(uint256 blockId, uint64 durationSecs, uint256 expectedRatePerDay) internal {
        Rental storage t = _rentals[blockId];
        if (block.timestamp >= t.expiry) revert RentalExpired();
        if (msg.sender != t.tenant) revert NotTenant();
        RentListing memory l = _checkRate(blockId, durationSecs, expectedRatePerDay);
        _settle(blockId, _owners[blockId]);
        uint256 cost = RentalsLib.rentCost(l.ratePerDay, durationSecs);
        uint256 expiry = block.timestamp + durationSecs;
        // Settle, then restart: the unstreamed remainder rolls into the new term with the new rent.
        t.prepaid = SafeCast.toUint128(t.prepaid - t.claimed + _book(cost));
        t.claimed = 0;
        t.start = uint40(block.timestamp);
        t.expiry = uint40(expiry);
        emit RentalExtended(blockId, msg.sender, expiry, cost);
        emit UpdateUser(blockId, msg.sender, uint64(expiry));
        emit MetadataUpdate(blockId);
    }

    /// @dev The offer the payer agreed to, and a term inside it.
    function _checkRate(uint256 blockId, uint64 durationSecs, uint256 expectedRatePerDay)
        internal
        view
        returns (RentListing memory l)
    {
        l = rentListing[blockId];
        if (l.ratePerDay == 0) revert NotForRent();
        if (l.ratePerDay != expectedRatePerDay) revert RateChanged();
        if (durationSecs < MIN_RENTAL_DURATION || durationSecs > l.maxDurationSecs) revert TermTooLong();
    }

    /// @dev Pulls a term's `cost` from the payer, credits the protocol and the board's holder, and
    /// returns the rest, which the caller escrows in the tenancy.
    function _book(uint256 cost) internal returns (uint256 net) {
        uint256 cut;
        uint256 royalty;
        (cut, royalty, net) = RentalsLib.rentSplit(cost, protocolBps, RENT_ROYALTY_BPS);
        pendingWithdrawals[protocolTreasury] += cut;
        pendingWithdrawals[seller()] += royalty;
        IERC20(settlementToken).safeTransferFrom(msg.sender, address(this), cost);
    }
}
