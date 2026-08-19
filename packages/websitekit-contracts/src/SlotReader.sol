// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SlotSite } from "./SlotSite.sol";

/// @notice Read-only periphery for `SlotSite`. Implements `docs/PROTOCOL-SPEC.md` §11.4.
///
/// **This contract is deliberately NOT frozen, and that is the point of it.** `SlotSite` is an
/// EIP-1167 clone of a non-upgradeable implementation, so every byte of it is permanent. A reader is
/// an ordinary deployment: it can be replaced whenever a UI needs a view that did not exist before.
/// So every view that is pure convenience belongs here rather than in the implementation, per §1.3 —
/// *anything that can live outside the frozen implementation should.*
///
/// Two things this buys beyond the bytes it frees:
///
///  1. **Net-cost surfacing can evolve.** §2.4.2 requires the buy path to show "you pay X, you
///     inherit Y of rent, net Z". Getting that presentation wrong is a UI bug here, not a permanent
///     one in bytecode.
///  2. **It batches across SITES.** A monolithic `getSlots` can only ever read its own site; a reader
///     reads many in one call, which is what the directory needs.
///
/// It holds no state, custodies nothing, and has no owner. A wrong reader shows wrong numbers; it
/// cannot lose anyone's money.
contract SlotReader {
    /// @notice Everything a client needs to price a buy and describe the deal, composed from the
    /// site's own getters. Frozen for a site's lifetime except where noted, so it is cacheable for as
    /// long as the page lives.
    struct Terms {
        uint256 implementationVersion;
        uint256 takeBps;
        uint256 payoutBps;
        uint256 reversionBps;
        uint256 maxReversionWeeks;
        uint256 cooldownSecs;
        uint256 protocolBps;
        uint256 protocolRentBps;
        uint256 siteRentBps;
        uint256 minRentBps;
        uint256 maxAskBps;
        uint256 floorDeltaBps;
        uint256 floorChangeCooldown;
        uint256 minFloor;
        uint64 maxRentalTerm;
        address settlementToken;
        bool paused;
        bool openRegistration;
        bool termsLocked;
        uint256 defaultFloor;
        address treasury;
        uint96 royaltyBps;
    }

    /// @notice A position, enriched with everything the tenancy layer adds.
    ///
    /// `unaccruedRent` is the field that makes an encumbered position legible: a buyer pays
    /// `charged` and inherits `unaccruedRent`, so the number that actually matters is the
    /// difference. Without it an encumbered position reads as "buy something you cannot use"
    /// (§2.4.1).
    struct SlotView {
        bytes32 key;
        address owner;
        bytes32 contentHash;
        uint256 floor;
        uint256 effectiveFloor;
        uint256 charged;
        uint256 lastPrice;
        uint256 askFloor;
        uint64 lastPurchaseTs;
        uint32 version;
        uint32 takes;
        bool registered;
        /// @dev The publisher's listing toggle. Only meaningful while unclaimed — a board renders
        /// an unavailable open slot as "not currently offered" rather than as claimable.
        bool available;
        // Tenancy
        address tenant;
        uint64 rentalExpiry;
        uint256 unaccruedRent;
        uint256 ratePerDay;
        uint64 maxDurationSecs;
    }

    function readTerms(address site) public view returns (Terms memory t) {
        SlotSite s = SlotSite(payable(site));
        t.implementationVersion = s.implementationVersion();
        t.takeBps = s.takeBps();
        t.payoutBps = s.payoutBps();
        t.reversionBps = s.reversionBps();
        t.maxReversionWeeks = s.maxReversionWeeks();
        t.cooldownSecs = s.cooldownSecs();
        t.protocolBps = s.protocolBps();
        t.protocolRentBps = s.protocolRentBps();
        t.siteRentBps = s.siteRentBps();
        t.minRentBps = s.minRentBps();
        t.maxAskBps = s.maxAskBps();
        t.floorDeltaBps = s.floorDeltaBps();
        t.floorChangeCooldown = s.floorChangeCooldown();
        t.minFloor = s.minFloor();
        t.maxRentalTerm = s.maxRentalTerm();
        t.settlementToken = s.settlementToken();
        t.paused = s.paused();
        t.openRegistration = s.openRegistration();
        t.termsLocked = s.termsLocked();
        t.defaultFloor = s.defaultFloor();
        t.treasury = s.treasury();
        t.royaltyBps = s.royaltyBps();
    }

    function readSlots(address site, bytes32[] calldata keys) public view returns (SlotView[] memory views) {
        SlotSite s = SlotSite(payable(site));
        views = new SlotView[](keys.length);
        for (uint256 i = 0; i < keys.length; i++) {
            views[i] = _one(s, keys[i]);
        }
    }

    /// @notice The directory read: many sites, one RPC call. A monolithic on-site `getSlots` cannot
    /// do this at all.
    function readSlotsMulti(address[] calldata sites, bytes32[][] calldata keys)
        external
        view
        returns (SlotView[][] memory out)
    {
        require(sites.length == keys.length, "length mismatch");
        out = new SlotView[][](sites.length);
        for (uint256 i = 0; i < sites.length; i++) {
            out[i] = readSlots(sites[i], keys[i]);
        }
    }

    function _one(SlotSite s, bytes32 key) internal view returns (SlotView memory v) {
        SlotSite.Slot memory slot = s.slotOf(key);
        (uint256 effectiveFloor, uint256 price) = s.quote(key);

        v.key = key;
        v.owner = s.ownerOfOrZero(key);
        v.contentHash = slot.contentHash;
        v.floor = slot.basePrice;
        v.effectiveFloor = effectiveFloor;
        // What THIS buyer pays: the effective floor on a claim, the take price on a take. Quoting
        // `price` for an unclaimed position would be `takeBps` too high.
        v.charged = v.owner == address(0) ? effectiveFloor : price;
        v.lastPrice = slot.lastPrice;
        v.askFloor = slot.askFloor;
        v.lastPurchaseTs = slot.lastPurchaseTs;
        v.version = slot.version;
        v.takes = slot.takes;
        v.registered = slot.registered;
        v.available = slot.available;

        (address tenant,, uint64 expiry,,,) = s.rentals(key);
        v.tenant = block.timestamp < expiry ? tenant : address(0);
        v.rentalExpiry = expiry;
        v.unaccruedRent = s.unaccruedRent(key);
        (uint192 rate, uint64 maxDur,) = s.listings(key);
        v.ratePerDay = rate;
        v.maxDurationSecs = maxDur;
    }
}
