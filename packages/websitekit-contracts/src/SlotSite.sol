// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Pricing } from "./Pricing.sol";
import { ERC721 } from "solady/tokens/ERC721.sol";
import { Ownable } from "solady/auth/Ownable.sol";
import { LibString } from "solady/utils/LibString.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { SignatureCheckerLib } from "solady/utils/SignatureCheckerLib.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { RentalsLib } from "./RentalsLib.sol";
import { TermsLib } from "./TermsLib.sol";

/// @notice SIZE SKELETON for SlotSite v2 — implements `docs/PROTOCOL-SPEC.md`.
///
/// **This file exists to answer one question: does v2 fit under EIP-170's 24,576 bytes?**
/// v1's runtime is 15,305 B with 9,271 B of margin, and via_ir is deliberately unavailable as an
/// escape hatch (foundry.toml explains why). Build order step 1 is measuring this before writing
/// tests, because if it does not fit the answer is structural — library extraction or splitting the
/// contract — and that is far cheaper to discover now.
///
/// Logic is real; doc comments are deliberately thin. Comments cost no bytecode, so the full
/// commentary pass (v1's standard, which explains WHY for every non-obvious invariant) comes after
/// the size question is settled. Spec section references stand in meanwhile.
///
/// NOT audited, NOT tested, NOT the final port.
contract SlotSite is ERC721, Ownable, ReentrancyGuardTransient {
    using LibString for uint256;
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 internal constant SECONDS_PER_WEEK = 604_800;
    uint256 internal constant SECONDS_PER_DAY = 86_400;

    uint256 internal constant MAX_TAKE_BPS = 30_000;
    uint256 internal constant MAX_REVERSION_WEEKS_CEILING = 52;
    uint256 internal constant MAX_COOLDOWN_SECS = 7 days;
    uint96 internal constant MAX_ROYALTY_BPS = 1_000;

    /// @dev §2.5. Band on `siteRentBps + protocolRentBps`. The lower bound is the structural one:
    /// at zero total fee a continuously-rented position is reversion-immune and never trades again.
    uint256 internal constant MIN_RENT_FEE_BPS = 1_000;
    uint256 internal constant MAX_RENT_FEE_BPS = 4_000;

    /// @dev §2.5.4. Not a safety mechanism — buyers are guarded by `encumbranceHash`.
    uint64 internal constant MAX_RENTAL_TERM_CEILING = 365 days;
    /// @dev §2.5.3. The floor on a term; the library owns the constant and enforces it per call.
    uint64 internal constant MIN_RENTAL_DURATION = RentalsLib.MIN_RENTAL_DURATION;

    /// @dev §3.3. `10_000` is down-only; below it an owner could not post an ask at their own cost.
    uint256 internal constant MIN_MAX_ASK_BPS = 10_000;

    /// @dev Ceilings on the promoted-to-per-site knobs (§6.2).
    uint256 internal constant MAX_FLOOR_DELTA_BPS_CEILING = 2_000;
    uint256 internal constant MIN_FLOOR_CHANGE_COOLDOWN = 24 hours;

    bytes4 internal constant INTERFACE_ID_ERC2981 = 0x2a55205a;
    bytes4 internal constant INTERFACE_ID_ERC4907 = 0xad092b5c;

    // ---------------------------------------------------------------------
    // Protocol-level immutables — live in the IMPLEMENTATION, a clone cannot strip them
    // ---------------------------------------------------------------------

    uint256 public immutable protocolBps;
    /// @dev §2.5. 500, mirroring `protocolBps`, so the pitch is one sentence.
    uint256 public immutable protocolRentBps;
    address public immutable protocolTreasury;

    // ---------------------------------------------------------------------
    // Economics — tiered per §6.1: free before the first claim, then holder-safe ratchets
    // ---------------------------------------------------------------------

    uint256 public takeBps;
    uint256 public payoutBps;
    uint256 public reversionBps;
    uint256 public maxReversionWeeks;
    uint256 public cooldownSecs;

    /// @dev Set on the first mint ever. Once true, always true — a position cannot be un-minted.
    bool public termsLocked;

    // ---------------------------------------------------------------------
    // Frozen at initialize()
    // ---------------------------------------------------------------------

    /// @dev §1.1. `address(0)` = native. No setter, ever: changing it orphans every balance.
    address public settlementToken;
    /// @dev §11.2. Derived from the token's decimals at init — never an implementation constant.
    uint256 public minFloor;

    // ---------------------------------------------------------------------
    // Promoted to per-site config (§6.2)
    // ---------------------------------------------------------------------

    uint256 public floorDeltaBps;
    uint256 public floorChangeCooldown;
    uint256 public maxAskBps;
    uint256 public minRentBps;
    /// @dev §2.5.1. Freely mutable; snapshotted into each Listing so a change cannot bait a lister.
    uint256 public siteRentBps;
    uint64 public maxRentalTerm;

    // ---------------------------------------------------------------------
    // Mutable site state
    // ---------------------------------------------------------------------

    address public treasury;
    bool public paused;
    bool public openRegistration;
    uint256 public defaultFloor;

    string internal _name;
    string internal _symbol;
    string public baseTokenURI;
    uint96 public royaltyBps;
    bool private _initialized;

    // ---------------------------------------------------------------------
    // Slots
    // ---------------------------------------------------------------------

    struct Slot {
        uint256 lastPrice;
        uint256 basePrice;
        bytes32 contentHash;
        /// @dev §3. Owner-posted reversion base. 0 = unset, fall through to `lastPrice`.
        uint256 askFloor;
        uint64 lastPurchaseTs;
        uint64 floorUpdatedAt;
        uint32 version;
        uint32 takes;
        bool registered;
        /// @dev §10.4's dashboard toggle. Gates CLAIMS only — an owned position can always be
        /// taken or rented, because withdrawing it from under its holder is not a right the
        /// publisher has. Packs into the word above; costs no storage.
        bool available;
    }

    mapping(bytes32 => Slot) internal _slots;
    bytes32[] public registeredSlots;

    // ---------------------------------------------------------------------
    // Rentals (§2)
    // ---------------------------------------------------------------------

    /// @dev Structs and the state machine live in `RentalsLib` (§11.4). Storage stays here; the
    /// library is pure code at its own address, and it never moves money — it returns amounts and
    /// this contract books them.
    mapping(bytes32 => RentalsLib.Listing) public listings;
    mapping(bytes32 => RentalsLib.Rental) public rentals;
    uint256 public totalEscrowedRent;

    // ---------------------------------------------------------------------
    // Delegated editing
    // ---------------------------------------------------------------------

    struct EditorGrant {
        address editor;
        address grantor;
        uint32 grantedAtTakes;
    }

    mapping(bytes32 => EditorGrant) internal _editorGrants;
    mapping(address => uint256) public editorNonces;

    bytes32 private constant EDITOR_GRANT_TYPEHASH =
        keccak256("EditorGrant(bytes32 key,address editor,uint256 nonce,uint256 deadline)");
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    // ---------------------------------------------------------------------
    // Pull ledger
    // ---------------------------------------------------------------------

    mapping(address => uint256) public pendingWithdrawals;
    uint256 public treasuryBalance;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error SiteAlreadyInitialized();
    error ZeroAddress();
    error InvalidConfig();
    error InvalidReversion();
    error TakeTooHigh();
    error PayoutBelowPrincipal();
    error TakeBelowPayout();
    error LengthMismatch();
    error NotSlotOwner();
    error NotSlotEditor();
    error InvalidSignature();
    error SlotNotRegistered();
    error SlotAlreadyRegistered();
    error SlotUnavailable();
    error InvalidFloor();
    error FloorDeltaTooLarge();
    error FloorCooldownActive();
    error Paused();
    error TermsChanged();
    error SlippageExceeded();
    error InsufficientPayment();
    error CooldownActive();
    error DeadlineExpired();
    error NothingToWithdraw();
    error TransferFailed();
    error NativeNotAccepted();

    // Ask
    error AskBelowBase();
    error AskAboveCap();

    // Tiered mutability (§6.1)
    error TermsAreLocked();
    error RatchetDirection();

    // ERC-4907
    error TenancyViaRentOnly();

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event SlotBought(
        bytes32 indexed key,
        address indexed buyer,
        address indexed previousOwner,
        address payer,
        uint256 price,
        uint256 payout,
        uint256 ts
    );
    event SlotEdited(bytes32 indexed key, address indexed editor, bytes32 contentHash, uint32 version, uint256 ts);
    event EditorSet(bytes32 indexed key, address indexed editor, address indexed grantor, uint32 atTakes);
    event SlotRegistered(bytes32 indexed key, uint256 floor, uint256 ts);
    event AvailabilitySet(bytes32 indexed key, bool available);
    event FloorSet(bytes32 indexed key, uint256 floor, uint256 ts);
    event AskSet(bytes32 indexed key, address indexed owner, uint256 askFloor, uint256 ts);
    event PayoutWithdrawn(address indexed account, uint256 amount);
    event TreasurySet(address indexed treasury);
    event TreasurySwept(address indexed treasury, uint256 amount);
    event PausedSet(bool paused);
    event OpenRegistrationSet(bool open, uint256 defaultFloor);
    event BaseTokenURISet(string uri);
    event RoyaltySet(uint96 bps);
    event SiteInitialized(address indexed owner, address settlementToken, uint256 takeBps, uint256 payoutBps);
    event TermsLocked();
    event EconomicsChanged(uint256 takeBps, uint256 payoutBps, uint256 reversionBps, uint256 maxReversionWeeks);
    event RentalTermsChanged(uint256 siteRentBps, uint64 maxRentalTerm, uint256 minRentBps);

    /// @dev Rental and ERC-4907 events are declared in `RentalsLib` and emitted from there. A
    /// delegatecall attributes them to THIS address, so an indexer watching the site sees them — it
    /// just needs both ABIs to decode, which `sync:abi` must emit.
    event RentClaimed(bytes32 indexed key, address indexed owner, uint256 amount);

    // ---------------------------------------------------------------------
    // Construction / initialization
    // ---------------------------------------------------------------------

    constructor(uint256 protocolBps_, uint256 protocolRentBps_, address protocolTreasury_) {
        if (protocolTreasury_ == address(0)) revert ZeroAddress();
        if (protocolBps_ > BPS_DENOMINATOR || protocolRentBps_ > MAX_RENT_FEE_BPS) revert InvalidConfig();
        protocolBps = protocolBps_;
        protocolRentBps = protocolRentBps_;
        protocolTreasury = protocolTreasury_;
        _initialized = true;
    }

    struct SiteConfig {
        string name;
        string symbol;
        string baseTokenURI;
        address treasury;
        address settlementToken;
        uint256 takeBps;
        uint256 payoutBps;
        uint256 reversionBps;
        uint256 maxReversionWeeks;
        uint256 cooldownSecs;
        uint256 defaultFloor;
        uint256 floorDeltaBps;
        uint256 floorChangeCooldown;
        uint256 maxAskBps;
        uint256 minRentBps;
        uint256 siteRentBps;
        uint64 maxRentalTerm;
        bool openRegistration;
        uint96 royaltyBps;
    }

    function initialize(address owner_, SiteConfig calldata cfg, bytes32[] calldata keys, uint256[] calldata floors)
        external
    {
        if (_initialized) revert SiteAlreadyInitialized();
        _initialized = true;
        if (owner_ == address(0)) revert ZeroAddress();
        _validateConfig(cfg);

        takeBps = cfg.takeBps;
        payoutBps = cfg.payoutBps;
        reversionBps = cfg.reversionBps;
        maxReversionWeeks = cfg.maxReversionWeeks;
        cooldownSecs = cfg.cooldownSecs;

        settlementToken = cfg.settlementToken;
        floorDeltaBps = cfg.floorDeltaBps;
        floorChangeCooldown = cfg.floorChangeCooldown;
        maxAskBps = cfg.maxAskBps;
        minRentBps = cfg.minRentBps;
        siteRentBps = cfg.siteRentBps;
        maxRentalTerm = cfg.maxRentalTerm;

        treasury = cfg.treasury;
        openRegistration = cfg.openRegistration;
        defaultFloor = cfg.defaultFloor;
        _name = cfg.name;
        _symbol = cfg.symbol;
        baseTokenURI = cfg.baseTokenURI;
        royaltyBps = cfg.royaltyBps;

        // §11.2. Derived, so a 6-decimal and an 18-decimal site both get a sane dust floor.
        minFloor = _deriveMinFloor(cfg.settlementToken);

        _initializeOwner(owner_);
        _registerSlots(keys, floors);
        emit SiteInitialized(owner_, cfg.settlementToken, cfg.takeBps, cfg.payoutBps);
    }

    /// @dev §11.2. Derived from the token's own decimals, never an implementation constant: a
    /// constant tuned for 6 decimals is wrong by 1e12 against an 18-decimal token, and this contract
    /// is frozen. Read directly rather than through try/catch — a settlement token that does not
    /// implement `decimals()` has not cleared §11.1's qualification bar and should not be configured.
    function _deriveMinFloor(address token) internal view returns (uint256) {
        uint8 dec = token == address(0) ? 18 : IERC20Metadata(token).decimals();
        // 1e-4 of a unit: headroom above the `floor * payoutBps` truncation edge (§1.4).
        return dec >= 4 ? 10 ** (uint256(dec) - 4) : 1;
    }

    function _validateConfig(SiteConfig calldata cfg) internal view {
        if (cfg.treasury == address(0)) revert ZeroAddress();
        // Same clamps the setters use, so there is one definition of a legal configuration.
        TermsLib.checkEconomicsAbsolute(
            TermsLib.Economics(cfg.takeBps, cfg.payoutBps, cfg.reversionBps, cfg.maxReversionWeeks, cfg.cooldownSecs),
            protocolBps
        );
        TermsLib.checkFloorPolicy(
            TermsLib.FloorPolicy(cfg.floorDeltaBps, cfg.floorChangeCooldown, cfg.maxAskBps),
            TermsLib.FloorPolicy(0, 0, 0),
            false
        );
        if (cfg.royaltyBps > MAX_ROYALTY_BPS) revert InvalidConfig();
        if (cfg.openRegistration && cfg.defaultFloor == 0) revert InvalidFloor();
        _validateRentTerms(cfg.siteRentBps, cfg.maxRentalTerm, cfg.minRentBps);
    }

    function _validateRentTerms(uint256 siteRent, uint64 term, uint256 minRent) internal view {
        uint256 total = siteRent + protocolRentBps;
        if (total < MIN_RENT_FEE_BPS || total > MAX_RENT_FEE_BPS) revert InvalidConfig();
        if (term < MIN_RENTAL_DURATION || term > MAX_RENTAL_TERM_CEILING) revert InvalidConfig();
        if (minRent == 0 || minRent > BPS_DENOMINATOR) revert InvalidConfig();
    }

    function implementationVersion() external pure returns (uint256) {
        return 2;
    }

    // ---------------------------------------------------------------------
    // Money helpers — the ERC-20 branch (§1.2)
    // ---------------------------------------------------------------------

    /// @dev Native: `value` must already be in `msg.value`, caller credits change. Token: pull
    /// exactly, so there is no change ledger on this path at all.
    function _collect(uint256 amount, uint256 budget) internal {
        address token = settlementToken;
        if (token == address(0)) {
            if (budget < amount) revert InsufficientPayment();
        } else {
            if (msg.value != 0) revert NativeNotAccepted();
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        }
    }

    function _pay(address to, uint256 amount) internal {
        address token = settlementToken;
        if (token == address(0)) {
            (bool ok,) = to.call{ value: amount }("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    // ---------------------------------------------------------------------
    // Slot registration
    // ---------------------------------------------------------------------

    function registerSlots(bytes32[] calldata keys, uint256[] calldata floors) external onlyOwner {
        _registerSlots(keys, floors);
    }

    /// @notice The publisher's listing toggle: a registered slot with `available = false` cannot be
    /// claimed. Registration is permanent (keys are identities); this is the reversible half —
    /// take a slot off the market, put it back, from a dashboard, without touching anyone's
    /// position.
    ///
    /// Deliberately legal on a CLAIMED slot, where it has no effect until the position somehow
    /// empties (it cannot today — there is no burn). Reverting there would make every batch call
    /// from a dashboard race against buyers: a claim landing mid-flight would flip a key into the
    /// reverting state and take the whole batch down with it.
    function setAvailability(bytes32[] calldata keys, bool available_) external onlyOwner {
        for (uint256 i = 0; i < keys.length; i++) {
            Slot storage slot = _slots[keys[i]];
            if (!slot.registered) revert SlotNotRegistered();
            slot.available = available_;
            emit AvailabilitySet(keys[i], available_);
        }
    }

    function _registerSlots(bytes32[] calldata keys, uint256[] calldata floors) internal {
        if (keys.length != floors.length) revert LengthMismatch();
        for (uint256 i = 0; i < keys.length; i++) {
            _register(keys[i], floors[i]);
        }
    }

    function _register(bytes32 key, uint256 floor) internal {
        Slot storage slot = _slots[key];
        if (slot.registered) revert SlotAlreadyRegistered();
        if (floor < minFloor) revert InvalidFloor();
        slot.registered = true;
        slot.available = true;
        slot.basePrice = floor;
        slot.floorUpdatedAt = uint64(block.timestamp);
        registeredSlots.push(key);
        emit SlotRegistered(key, floor, block.timestamp);
    }

    function setFloor(bytes32 key, uint256 newFloor) external onlyOwner {
        Slot storage slot = _slots[key];
        if (!slot.registered) revert SlotNotRegistered();
        if (newFloor < minFloor) revert InvalidFloor();
        if (block.timestamp < uint256(slot.floorUpdatedAt) + floorChangeCooldown) revert FloorCooldownActive();

        uint256 current = slot.basePrice;
        uint256 maxDelta = (current * floorDeltaBps) / BPS_DENOMINATOR;
        uint256 delta = newFloor > current ? newFloor - current : current - newFloor;
        if (delta > maxDelta) revert FloorDeltaTooLarge();

        slot.basePrice = newFloor;
        slot.floorUpdatedAt = uint64(block.timestamp);
        emit FloorSet(key, newFloor, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // The ask (§3)
    // ---------------------------------------------------------------------

    /// @dev The reversion BASE, not a list price and not the price a buyer pays. Cleared on sale.
    /// The arithmetic lives in `Pricing` so the parity harness can sweep it without a deployed site.
    function resolveReversionBase(bytes32 key) public view returns (uint256) {
        Slot storage slot = _slots[key];
        return Pricing.resolveReversionBase(slot.askFloor, slot.lastPrice);
    }

    function setAsk(bytes32 key, uint256 askFloor_) external {
        if (_ownerOf(uint256(key)) != msg.sender) revert NotSlotOwner();
        Slot storage slot = _slots[key];
        uint256 base = slot.basePrice;
        if (askFloor_ != 0) {
            if (askFloor_ < base) revert AskBelowBase();
            // Anchor is `lastPrice`, which only moves on a sale — anchoring to the effective floor
            // would compound into an unbounded ratchet (§3.2). `Pricing` owns the arithmetic.
            if (askFloor_ > Pricing.askCeiling(slot.lastPrice, base, maxAskBps)) revert AskAboveCap();
        }
        slot.askFloor = askFloor_;
        emit AskSet(key, msg.sender, askFloor_, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Pricing views
    // ---------------------------------------------------------------------

    function quote(bytes32 key) public view returns (uint256 effectiveFloor, uint256 price) {
        Slot storage slot = _slots[key];
        (price, effectiveFloor) = Pricing.computeTakePrice(
            resolveReversionBase(key),
            slot.basePrice,
            _computeElapsedWeeks(block.timestamp, slot.lastPurchaseTs),
            reversionBps,
            takeBps,
            maxReversionWeeks
        );
    }

    /// @dev §5. Covers what a buyer INHERITS. The rental tuple replaces what would otherwise be a
    /// `maxRentalExpiry` parameter on the money spine. Excludes `askFloor`: it moves price, and
    /// `maxPrice` already guards price.
    function encumbranceHash(bytes32 key) public view returns (bytes32) {
        Slot storage slot = _slots[key];
        RentalsLib.Rental storage r = rentals[key];
        return keccak256(abi.encode(slot.basePrice, slot.registered, r.tenant, r.expiry, r.prepaid, r.claimed));
    }

    // ---------------------------------------------------------------------
    // Buy — the money spine
    // ---------------------------------------------------------------------

    function buyFor(address recipient, bytes32 key, uint256 maxPrice, bytes32 expectedTerms, uint256 deadline)
        external
        payable
        nonReentrant
    {
        _settleBuy(recipient, key, maxPrice, expectedTerms, deadline);
    }

    function buy(bytes32 key, uint256 maxPrice, bytes32 expectedTerms, uint256 deadline)
        external
        payable
        nonReentrant
    {
        _settleBuy(msg.sender, key, maxPrice, expectedTerms, deadline);
    }

    function _settleBuy(address recipient, bytes32 key, uint256 maxPrice, bytes32 expectedTerms, uint256 deadline)
        internal
    {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (recipient == address(0)) revert ZeroAddress();
        uint256 charged = _buy(recipient, key, maxPrice, expectedTerms, msg.value);
        // Change credits the PAYER, never the recipient — a router must be able to forward the
        // remainder back to whoever funded it. Native path only; the token path pulls exactly.
        if (settlementToken == address(0)) {
            uint256 change = msg.value - charged;
            if (change > 0) pendingWithdrawals[msg.sender] += change;
        }
    }

    function _buy(address recipient, bytes32 key, uint256 maxPrice, bytes32 expectedTerms, uint256 budget)
        internal
        returns (uint256 chargedPrice)
    {
        if (paused) revert Paused();
        if (encumbranceHash(key) != expectedTerms) revert TermsChanged();

        Slot storage slot = _slots[key];
        if (!slot.registered) {
            if (!openRegistration) revert SlotNotRegistered();
            _register(key, defaultFloor);
        }

        uint256 tokenId = uint256(key);
        address previousOwner = _ownerOf(tokenId);
        bool isUnclaimed = previousOwner == address(0);

        // A slot the publisher has marked unavailable cannot be CLAIMED. Takes are deliberately
        // untouched: the flag is the publisher's listing toggle, not a lever over positions people
        // already paid for — an owned slot changing hands is none of the publisher's business.
        if (isUnclaimed && !slot.available) revert SlotUnavailable();

        if (!isUnclaimed && block.timestamp < uint256(slot.lastPurchaseTs) + cooldownSecs) {
            revert CooldownActive();
        }

        uint256 payoutAmount;
        {
            (uint256 effectiveFloor, uint256 price) = quote(key);
            Pricing.Split memory split =
                Pricing.computeSplit(effectiveFloor, price, isUnclaimed, payoutBps, protocolBps);

            chargedPrice = split.charged;
            if (chargedPrice > maxPrice) revert SlippageExceeded();
            _collect(chargedPrice, budget);

            payoutAmount = split.payout;
            if (split.payout > 0) pendingWithdrawals[previousOwner] += split.payout;
            if (split.protocolCut > 0) pendingWithdrawals[protocolTreasury] += split.protocolCut;
            treasuryBalance += split.siteCut;
        }

        slot.lastPrice = chargedPrice;
        slot.lastPurchaseTs = uint64(block.timestamp);
        slot.takes += 1;
        // A new owner inherits no ask.
        slot.askFloor = 0;

        // §2.4. Settle rent to the OUTGOING owner before ownership moves, then kill the listing.
        // The rental itself survives: a tenancy a take could destroy is unsellable.
        _settleRent(key);
        // A sale clears the LISTING but not an active RENTAL: the new owner should not be renting
        // out at a rate they never chose, while the tenant keeps their term. Deleted inline —
        // `SlotBought` already records the sale, so a separate event is not worth a delegatecall on
        // the money spine.
        delete listings[key];

        if (isUnclaimed) {
            _mint(recipient, tokenId);
            // §6.1. The first claim in a site's life closes the free-edit window.
            if (!termsLocked) {
                termsLocked = true;
                emit TermsLocked();
            }
        } else {
            _transfer(previousOwner, recipient, tokenId);
        }

        emit SlotBought(key, recipient, previousOwner, msg.sender, chargedPrice, payoutAmount, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Rentals (§2)
    // ---------------------------------------------------------------------

    function accruedRent(bytes32 key) public view returns (uint256) {
        return RentalsLib.accrued(rentals[key]);
    }

    /// @dev §2.4.2. What a buyer would inherit. Exposed on-chain because the buy path needs it
    /// pinned at the same block as the quote.
    function unaccruedRent(bytes32 key) public view returns (uint256) {
        return RentalsLib.unaccrued(rentals[key]);
    }

    /// @dev Books what the library computed: escrow down, owner's pull balance up. The library
    /// marked it claimed; this is the only place the money moves.
    function _settleRent(bytes32 key) internal returns (uint256 delta) {
        delta = RentalsLib.claim(rentals[key]);
        if (delta > 0) {
            totalEscrowedRent -= delta;
            pendingWithdrawals[_ownerOf(uint256(key))] += delta;
        }
    }

    function listForRent(bytes32 key, uint256 ratePerDay, uint64 maxDurationSecs) external {
        if (_ownerOf(uint256(key)) != msg.sender) revert NotSlotOwner();
        (uint256 effectiveFloor,) = quote(key);
        uint256 fee = siteRentBps;
        // The band is re-checked at list time, not only at config time, because `siteRentBps` is
        // freely mutable (§2.5.1) and the snapshot taken here is what the tenant will be charged.
        uint256 total = fee + protocolRentBps;
        if (total < MIN_RENT_FEE_BPS || total > MAX_RENT_FEE_BPS) revert InvalidConfig();
        RentalsLib.list(
            listings[key], key, ratePerDay, maxDurationSecs, maxRentalTerm, effectiveFloor, minRentBps, fee
        );
    }

    function rent(bytes32 key, uint64 durationSecs, uint256 expectedRatePerDay) external payable nonReentrant {
        if (paused) revert Paused();
        // Cannot rent an unclaimed position — there is nobody to pay.
        if (_ownerOf(uint256(key)) == address(0)) revert NotSlotOwner();

        (uint256 cost, uint16 feeBps) = RentalsLib.open(
            rentals[key], listings[key], key, durationSecs, expectedRatePerDay, _slots[key].contentHash
        );
        // The site writes its own storage: a delegatecall to set one field is pure overhead.
        rentals[key].prepaid = _bookRentPayment(cost, feeBps);
    }

    function extendRental(bytes32 key, uint64 durationSecs, uint256 expectedRatePerDay)
        external
        payable
        nonReentrant
    {
        if (paused) revert Paused();
        // Flush what the OUTGOING term earned before restarting, or it is stranded in escrow.
        _settleRent(key);
        (uint256 cost, uint16 feeBps, uint256 carry) =
            RentalsLib.extend(rentals[key], listings[key], key, durationSecs, expectedRatePerDay, maxRentalTerm);
        rentals[key].prepaid = carry + _bookRentPayment(cost, feeBps);
    }

    /// @dev Permissionless and always credits the current owner, never the caller — so a UI
    /// restriction would be a rule the contract does not have.
    function claimRent(bytes32 key) external nonReentrant {
        uint256 amount = _settleRent(key);
        if (amount == 0) revert NothingToWithdraw();
        emit RentClaimed(key, _ownerOf(uint256(key)), amount);
    }

    function endRental(bytes32 key) external nonReentrant {
        _settleRent(key);
        bytes32 restored = RentalsLib.finish(rentals[key], key);
        Slot storage slot = _slots[key];
        slot.contentHash = restored;
        // Bumped so the restore flows through the same content gate as an edit — the render path
        // must not have a second way in.
        slot.version += 1;
    }

    /// @dev §2.5. Takes the protocol cut and the site's snapshotted cut off the top; the remainder
    /// is escrowed and streams to whoever owns the position at the time it accrues.
    function _bookRentPayment(uint256 cost, uint256 feeBps) internal returns (uint256 net) {
        _collect(cost, msg.value);
        if (settlementToken == address(0)) {
            uint256 change = msg.value - cost;
            if (change > 0) pendingWithdrawals[msg.sender] += change;
        }
        (uint256 protocolCut, uint256 siteCut, uint256 escrowed) = RentalsLib.rentSplit(cost, protocolRentBps, feeBps);
        if (protocolCut > 0) pendingWithdrawals[protocolTreasury] += protocolCut;
        treasuryBalance += siteCut;
        net = escrowed;
        totalEscrowedRent += net;
    }

    // ---------------------------------------------------------------------
    // ERC-4907 (§4) — maps to rentals only, never editor grants
    // ---------------------------------------------------------------------

    function userOf(uint256 id) public view returns (address) {
        return RentalsLib.currentTenant(rentals[bytes32(id)]);
    }

    function userExpires(uint256 id) external view returns (uint256) {
        return rentals[bytes32(id)].expiry;
    }

    /// @dev Tenancies are created by `rent` against a listing and paid into escrow; a bare setUser
    /// would bypass the payment path. Reverts loudly rather than silently granting a free tenancy.
    function setUser(uint256, address, uint64) external pure {
        revert TenancyViaRentOnly();
    }

    // ---------------------------------------------------------------------
    // Edit
    // ---------------------------------------------------------------------

    function edit(bytes32 key, bytes32 contentHash) external {
        if (!canEdit(key, msg.sender)) {
            if (_ownerOf(uint256(key)) == address(0)) revert NotSlotOwner();
            revert NotSlotEditor();
        }
        Slot storage slot = _slots[key];
        slot.contentHash = contentHash;
        slot.version += 1;
        emit SlotEdited(key, msg.sender, contentHash, slot.version, block.timestamp);
    }

    function setEditor(bytes32 key, address editor) external {
        if (_ownerOf(uint256(key)) != msg.sender) revert NotSlotOwner();
        _setEditor(key, editor, msg.sender);
    }

    function setEditorWithSig(bytes32 key, address editor, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert DeadlineExpired();
        address owner_ = _ownerOf(uint256(key));
        if (owner_ == address(0)) revert NotSlotOwner();

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(abi.encode(EDITOR_GRANT_TYPEHASH, key, editor, editorNonces[owner_]++, deadline))
            )
        );
        if (!SignatureCheckerLib.isValidSignatureNowCalldata(owner_, digest, signature)) {
            revert InvalidSignature();
        }
        _setEditor(key, editor, owner_);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256(bytes(_name)), keccak256("1"), block.chainid, address(this))
        );
    }

    function _setEditor(bytes32 key, address editor, address grantor) internal {
        uint32 atTakes = _slots[key].takes;
        _editorGrants[key] = EditorGrant({ editor: editor, grantor: grantor, grantedAtTakes: atTakes });
        emit EditorSet(key, editor, grantor, atTakes);
    }

    /// @dev §2.3. During a live term the TENANT edits and the owner is locked out — otherwise the
    /// owner overwrites paid-for content and the tenancy is unsellable.
    function canEdit(bytes32 key, address account) public view returns (bool) {
        if (account == address(0)) return false;
        address owner_ = _ownerOf(uint256(key));
        if (owner_ == address(0)) return false;

        address tenant = RentalsLib.currentTenant(rentals[key]);
        if (tenant != address(0)) return account == tenant;

        if (account == owner_) return true;
        EditorGrant storage grant = _editorGrants[key];
        return grant.editor == account && grant.grantor == owner_ && grant.grantedAtTakes == _slots[key].takes;
    }

    function editorOf(bytes32 key) external view returns (address) {
        EditorGrant storage grant = _editorGrants[key];
        return canEdit(key, grant.editor) ? grant.editor : address(0);
    }

    // ---------------------------------------------------------------------
    // Reads
    //
    // The enriched page view, the terms view and the multi-site directory read all live in
    // `SlotReader`, which is NOT frozen (§11.4). This contract exposes only what the reader cannot
    // derive: raw slot state, the quote, and the tenancy tuples.
    // ---------------------------------------------------------------------

    /// @dev `ownerOf` reverts for an unminted id, and a page read walks unclaimed keys too.
    function ownerOfOrZero(bytes32 key) external view returns (address) {
        return _ownerOf(uint256(key));
    }

    function slotOf(bytes32 key) external view returns (Slot memory) {
        return _slots[key];
    }

    function registeredSlotCount() external view returns (uint256) {
        return registeredSlots.length;
    }

    function registeredSlotsPage(uint256 start, uint256 count) external view returns (bytes32[] memory page) {
        uint256 len = registeredSlots.length;
        if (start >= len) return new bytes32[](0);
        uint256 end = start + count;
        if (end > len) end = len;
        page = new bytes32[](end - start);
        for (uint256 i = 0; i < page.length; i++) {
            page[i] = registeredSlots[start + i];
        }
    }

    // ---------------------------------------------------------------------
    // Pull ledger
    // ---------------------------------------------------------------------

    function withdraw() external nonReentrant {
        _withdrawTo(msg.sender);
    }

    function withdrawFor(address account) external nonReentrant {
        _withdrawTo(account);
    }

    function _withdrawTo(address account) internal {
        uint256 amount = pendingWithdrawals[account];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[account] = 0;
        _pay(account, amount);
        emit PayoutWithdrawn(account, amount);
    }

    function withdrawTreasury(uint256 amount) external onlyOwner nonReentrant {
        treasuryBalance -= amount;
        _pay(treasury, amount);
        emit TreasurySwept(treasury, amount);
    }

    /// @dev §10.4. Permissionless and always pays `treasury`, never the caller, so it grants no new
    /// authority — identical reasoning to `withdrawFor`. Full sweep so nobody can grief with dust.
    /// This is what lets a managed publisher's revenue arrive on a schedule without them signing.
    function sweepTreasury() external nonReentrant {
        uint256 amount = treasuryBalance;
        if (amount == 0) revert NothingToWithdraw();
        treasuryBalance = 0;
        _pay(treasury, amount);
        emit TreasurySwept(treasury, amount);
    }

    /// @dev §1.2. Reverts on a token site: `treasuryBalance` is denominated in the token, so
    /// crediting it with native value corrupts the accounting the invariant suite checks.
    receive() external payable {
        if (settlementToken != address(0)) revert NativeNotAccepted();
        treasuryBalance += msg.value;
    }

    // ---------------------------------------------------------------------
    // Tiered mutability (§6.1) — free before the first claim, then holder-safe ratchets
    // ---------------------------------------------------------------------

    /// @dev §6.1. Validation policy lives in `TermsLib`; this writes the result. The direction
    /// rules only bind once `termsLocked` is set, which happens on the first claim in a site's life.
    function setEconomics(uint256 take, uint256 payout, uint256 rev, uint256 revWeeks, uint256 cooldown)
        external
        onlyOwner
    {
        TermsLib.checkEconomics(
            TermsLib.Economics(take, payout, rev, revWeeks, cooldown),
            TermsLib.Economics(takeBps, payoutBps, reversionBps, maxReversionWeeks, cooldownSecs),
            termsLocked,
            protocolBps
        );
        takeBps = take;
        payoutBps = payout;
        reversionBps = rev;
        maxReversionWeeks = revWeeks;
        cooldownSecs = cooldown;
        emit EconomicsChanged(take, payout, rev, revWeeks);
    }

    /// @dev §2.5.1. Freely mutable in both directions even after the lock: a rent-term change cannot
    /// touch an active tenancy (the fee is taken at `rent` time and snapshotted per listing), and an
    /// owner who dislikes a new rate simply does not list. That recourse is what take economics lack.
    function setRentalTerms(uint256 siteRent, uint64 term, uint256 minRent) external onlyOwner {
        _validateRentTerms(siteRent, term, minRent);
        siteRentBps = siteRent;
        maxRentalTerm = term;
        minRentBps = minRent;
        emit RentalTermsChanged(siteRent, term, minRent);
    }

    function setFloorPolicy(uint256 deltaBps, uint256 changeCooldown, uint256 askCap) external onlyOwner {
        TermsLib.checkFloorPolicy(
            TermsLib.FloorPolicy(deltaBps, changeCooldown, askCap),
            TermsLib.FloorPolicy(floorDeltaBps, floorChangeCooldown, maxAskBps),
            termsLocked
        );
        floorDeltaBps = deltaBps;
        floorChangeCooldown = changeCooldown;
        maxAskBps = askCap;
    }

    // ---------------------------------------------------------------------
    // Site admin
    // ---------------------------------------------------------------------

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function setOpenRegistration(bool open, uint256 defaultFloor_) external onlyOwner {
        if (open && defaultFloor_ < minFloor) revert InvalidFloor();
        openRegistration = open;
        defaultFloor = defaultFloor_;
        emit OpenRegistrationSet(open, defaultFloor_);
    }

    function setBaseTokenURI(string calldata uri) external onlyOwner {
        baseTokenURI = uri;
        emit BaseTokenURISet(uri);
    }

    function setRoyalty(uint96 bps) external onlyOwner {
        if (bps > MAX_ROYALTY_BPS) revert InvalidConfig();
        royaltyBps = bps;
        emit RoyaltySet(bps);
    }

    // ---------------------------------------------------------------------
    // ERC-721 / ERC-2981 / ERC-4907
    // ---------------------------------------------------------------------

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        return string.concat(baseTokenURI, id.toString());
    }

    function royaltyInfo(uint256, uint256 salePrice) external view returns (address, uint256) {
        return (treasury, (salePrice * uint256(royaltyBps)) / BPS_DENOMINATOR);
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == INTERFACE_ID_ERC2981 || interfaceId == INTERFACE_ID_ERC4907
            || super.supportsInterface(interfaceId);
    }

    // No transfer hook: a transfer changes `owner` and NOTHING else, and that invariant is enforced
    // by the hook's absence rather than by its contents.

    function _computeElapsedWeeks(uint256 nowTs, uint256 lastPurchaseTs) internal pure returns (uint256) {
        return (nowTs - lastPurchaseTs) / SECONDS_PER_WEEK;
    }

    function _guardInitializeOwner() internal pure override returns (bool) {
        return true;
    }
}
