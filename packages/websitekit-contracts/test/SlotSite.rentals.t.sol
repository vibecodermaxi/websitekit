// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SlotSiteBase } from "./SlotSiteBase.t.sol";
import { SlotSite } from "../src/SlotSite.sol";
import { RentalsLib } from "../src/RentalsLib.sol";

/// @notice Rentals, organised around PROTOCOL-SPEC §2's **load-bearing rules** rather than around
/// the function list. Each of those rules, if violated, silently reintroduces the exact problem the
/// feature exists to solve — so each gets a named test that says which one it is.
contract SlotSiteRentalsTest is SlotSiteBase {
    bytes32 constant CREATIVE = keccak256("advertiser creative");
    bytes32 constant OWNER_CONTENT = keccak256("owner content");

    function _claimAndList(address owner_, bytes32 key, uint64 maxDur) internal returns (uint256 rate) {
        _claim(owner_, key);
        _edit(owner_, key, OWNER_CONTENT);
        rate = _fairRatePerDay(key);
        _list(owner_, key, rate, maxDur);
    }

    // -----------------------------------------------------------------
    // The happy path
    // -----------------------------------------------------------------

    function test_listRentEditClaimEnd() public {
        uint256 rate = _claimAndList(alice, HERO_HEADLINE, 7 days);
        (uint192 listed, uint64 maxDur, uint16 feeBps) = site.listings(HERO_HEADLINE);
        assertEq(listed, rate);
        assertEq(maxDur, 7 days);
        assertEq(feeBps, SITE_RENT_BPS, "the site cut is snapshotted at list time");

        uint256 protocolBefore = site.pendingWithdrawals(protocolTreasury);
        uint256 cost = _rent(advertiser, HERO_HEADLINE, 4 days);
        (address tenant,, uint64 expiry, uint256 prepaid,) = _rentalOf(HERO_HEADLINE);
        assertEq(tenant, advertiser);
        assertEq(expiry, uint64(block.timestamp + 4 days));

        uint256 protocolCut = (cost * PROTOCOL_RENT_BPS) / 10_000;
        uint256 siteCut = (cost * SITE_RENT_BPS) / 10_000;
        assertEq(prepaid, cost - protocolCut - siteCut, "escrow holds the net, fees taken off the top");
        assertEq(site.pendingWithdrawals(protocolTreasury) - protocolBefore, protocolCut, "protocol paid on rent too");
        _assertSolvent();

        // The tenant writes; the owner cannot.
        _edit(advertiser, HERO_HEADLINE, CREATIVE);
        assertEq(site.slotOf(HERO_HEADLINE).contentHash, CREATIVE);

        vm.warp(block.timestamp + 2 days);
        vm.prank(keeper);
        site.claimRent(HERO_HEADLINE);
        assertApproxEqAbs(site.pendingWithdrawals(alice), prepaid / 2, 2, "half the term streamed");
        _assertSolvent();

        vm.warp(block.timestamp + 3 days); // past expiry
        vm.prank(keeper);
        site.endRental(HERO_HEADLINE);
        assertEq(site.slotOf(HERO_HEADLINE).contentHash, OWNER_CONTENT, "owner's content restored");
        assertEq(site.totalEscrowedRent(), 0, "escrow fully drained");
        _assertSolvent();
    }

    // -----------------------------------------------------------------
    // §2.1 — rent streams to whoever owns the position NOW
    // -----------------------------------------------------------------

    /// The rule the whole design is arranged around. If rent were prepaid to the lister, an owner
    /// could rent to themselves and hold a takeover shield for free.
    function test_selfPoisoningForfeitsTheUnaccruedRemainderToTheTaker() public {
        _claimAndList(alice, HERO_HEADLINE, 30 days);
        // Alice rents her own position to block edits.
        _rent(alice, HERO_HEADLINE, 30 days);
        (,,, uint256 prepaid,) = _rentalOf(HERO_HEADLINE);

        vm.warp(block.timestamp + COOLDOWN_SECS);
        _take(bob, HERO_HEADLINE);

        uint256 accruedToAlice = site.accruedRent(HERO_HEADLINE);
        assertLt(accruedToAlice, prepaid / 100, "almost nothing had accrued when she was taken");

        // The remainder now streams to BOB — the adversary who broke the poison.
        vm.warp(block.timestamp + 15 days);
        vm.prank(keeper);
        site.claimRent(HERO_HEADLINE);
        assertGt(site.pendingWithdrawals(bob), 0, "the unaccrued remainder is paid to the taker");
        _assertSolvent();
    }

    /// A longer poison is a BIGGER bounty for whoever breaks it, which is counter-intuitive and is
    /// why the 365-day ceiling is safe (spec §2.5.4).
    function test_longerPoisonForfeitsMore() public {
        _claimAndList(alice, HERO_HEADLINE, 30 days);
        _rent(alice, HERO_HEADLINE, 30 days);
        (,,, uint256 longPrepaid,) = _rentalOf(HERO_HEADLINE);

        _claimAndList(bob, NAV_LINK_1, 30 days);
        _rent(bob, NAV_LINK_1, 1 days);
        (,,, uint256 shortPrepaid,) = _rentalOf(NAV_LINK_1);

        assertGt(longPrepaid, shortPrepaid * 10, "a 30-day self-rental locks far more into escrow");
    }

    // -----------------------------------------------------------------
    // §2.4 — what a purchase does to a rental
    // -----------------------------------------------------------------

    function test_saleSettlesRentToTheOutgoingOwnerBeforeOwnershipMoves() public {
        _claimAndList(alice, HERO_HEADLINE, 30 days);
        _rent(advertiser, HERO_HEADLINE, 10 days);

        vm.warp(block.timestamp + 5 days);
        uint256 accrued = site.accruedRent(HERO_HEADLINE);
        assertGt(accrued, 0);

        _take(bob, HERO_HEADLINE);
        // Alice cannot choose when she is taken, so rent she had already EARNED must not travel to
        // the buyer.
        assertGe(site.pendingWithdrawals(alice), accrued, "earned rent settled to the outgoing owner");
        _assertSolvent();
    }

    function test_saleKillsTheListingButNotTheRental() public {
        _claimAndList(alice, HERO_HEADLINE, 30 days);
        _rent(advertiser, HERO_HEADLINE, 10 days);

        vm.warp(block.timestamp + COOLDOWN_SECS);
        _take(bob, HERO_HEADLINE);

        (uint192 rate,,) = site.listings(HERO_HEADLINE);
        assertEq(rate, 0, "the new owner is not renting out at a rate they never chose");

        (address tenant,, uint64 expiry,,) = _rentalOf(HERO_HEADLINE);
        assertEq(tenant, advertiser, "the tenant keeps their term -- a tenancy a take could destroy is unsellable");
        assertGt(expiry, block.timestamp);
        assertTrue(site.canEdit(HERO_HEADLINE, advertiser), "and keeps edit rights");
        assertFalse(site.canEdit(HERO_HEADLINE, bob), "the new owner is locked out for the term");
    }

    /// Because the listing clears on sale, the inherited tenant cannot extend until the NEW owner
    /// actively re-lists. The new owner decides whether the arrangement continues.
    function test_inheritedTenantCannotExtendUntilTheNewOwnerRelists() public {
        _claimAndList(alice, HERO_HEADLINE, 30 days);
        _rent(advertiser, HERO_HEADLINE, 10 days);
        vm.warp(block.timestamp + COOLDOWN_SECS);
        _take(bob, HERO_HEADLINE);

        vm.prank(advertiser);
        vm.expectRevert(RentalsLib.NotForRent.selector);
        site.extendRental(HERO_HEADLINE, 5 days, 1);

        uint256 rate = _fairRatePerDay(HERO_HEADLINE);
        _list(bob, HERO_HEADLINE, rate, 30 days);
        _extend(advertiser, HERO_HEADLINE, 5 days);
        (,, uint64 expiry,,) = _rentalOf(HERO_HEADLINE);
        assertEq(expiry, uint64(block.timestamp + 5 days), "extension works once the new owner re-lists");
        _assertSolvent();
    }

    /// A reachable, legal state that the UI must handle: `owner == tenant`.
    function test_aTenantMayTakeThePositionTheyRent() public {
        _claimAndList(alice, HERO_HEADLINE, 30 days);
        _rent(advertiser, HERO_HEADLINE, 10 days);
        vm.warp(block.timestamp + COOLDOWN_SECS);
        _take(advertiser, HERO_HEADLINE);

        assertEq(site.ownerOf(uint256(HERO_HEADLINE)), advertiser, "owns it");
        assertEq(site.userOf(uint256(HERO_HEADLINE)), advertiser, "and rents it, simultaneously");
        assertTrue(site.canEdit(HERO_HEADLINE, advertiser));
    }

    // -----------------------------------------------------------------
    // §5 — the encumbrance guard replaces a `maxRentalExpiry` parameter
    // -----------------------------------------------------------------

    function test_aRentalAppearingBetweenQuoteAndSubmitRevertsTermsChanged() public {
        _claimAndList(alice, HERO_HEADLINE, 30 days);
        vm.warp(block.timestamp + COOLDOWN_SECS);

        // Bob quotes an unencumbered position...
        (, uint256 charged) = site.quote(HERO_HEADLINE);
        bytes32 staleTerms = site.encumbranceHash(HERO_HEADLINE);

        // ...a tenancy is created before his transaction lands...
        _rent(advertiser, HERO_HEADLINE, 10 days);

        // ...and he is not forced to inherit an encumbrance he never priced in.
        vm.prank(bob);
        vm.expectRevert(SlotSite.TermsChanged.selector);
        site.buy{ value: _pay(bob, charged) }(HERO_HEADLINE, charged, staleTerms, block.timestamp);
    }

    function test_accrualAloneMovesTheEncumbranceHash() public {
        _claimAndList(alice, HERO_HEADLINE, 30 days);
        _rent(advertiser, HERO_HEADLINE, 10 days);

        bytes32 before = site.encumbranceHash(HERO_HEADLINE);
        vm.warp(block.timestamp + 1 days);
        vm.prank(keeper);
        site.claimRent(HERO_HEADLINE);
        assertTrue(before != site.encumbranceHash(HERO_HEADLINE), "claimed changes what a buyer inherits");
    }

    /// §2.4.2 — the number that makes an encumbered position legible.
    function test_unaccruedRentIsReadableForNetCost() public {
        _claimAndList(alice, HERO_HEADLINE, 30 days);
        uint256 cost = _rent(advertiser, HERO_HEADLINE, 10 days);
        uint256 net = cost - (cost * (PROTOCOL_RENT_BPS + SITE_RENT_BPS)) / 10_000;
        assertEq(site.unaccruedRent(HERO_HEADLINE), net, "a buyer inherits the whole stream at t=0");

        vm.warp(block.timestamp + 5 days);
        assertApproxEqAbs(site.unaccruedRent(HERO_HEADLINE), net / 2, 2, "half consumed at the midpoint");
    }

    // -----------------------------------------------------------------
    // §2.3 — the rules that close specific holes
    // -----------------------------------------------------------------

    /// Otherwise the owner overwrites the tenant's content the moment it is paid for, and the whole
    /// thing is unsellable.
    function test_ownerIsLockedOutOfEditForTheTerm() public {
        _claimAndList(alice, HERO_HEADLINE, 30 days);
        _rent(advertiser, HERO_HEADLINE, 10 days);

        vm.prank(alice);
        vm.expectRevert(SlotSite.NotSlotEditor.selector);
        site.edit(HERO_HEADLINE, CREATIVE);
        assertFalse(site.canEdit(HERO_HEADLINE, alice));
    }

    /// Without this an owner front-runs a rental by raising the rate, exactly as `maxPrice` guards
    /// `buy`.
    function test_expectedRateGuardsAgainstAnOwnerRepricingUnderATenant() public {
        uint256 rate = _claimAndList(alice, HERO_HEADLINE, 30 days);
        _list(alice, HERO_HEADLINE, rate * 2, 30 days);

        vm.prank(advertiser);
        vm.expectRevert(RentalsLib.RateChanged.selector);
        site.rent{ value: _pay(advertiser, rate * 10) }(HERO_HEADLINE, 5 days, rate);
    }

    /// Cap the TOTAL and a tenant extends repeatedly in one block and holds a year. Capping the
    /// remaining window is what makes the safety property exact.
    function test_extensionCapsTheRemainingWindowNotTheTotal() public {
        _claimAndList(alice, HERO_HEADLINE, 30 days);
        _rent(advertiser, HERO_HEADLINE, 20 days);

        // A second 20-day top-up in the same block would be 40 days total if the cap were on the
        // total; it is rejected because the REMAINING window may not exceed maxRentalTerm.
        vm.warp(block.timestamp + 25 days); // let it lapse so we can measure cleanly
        vm.prank(keeper);
        site.endRental(HERO_HEADLINE);

        _rent(advertiser, HERO_HEADLINE, 20 days);
        _extend(advertiser, HERO_HEADLINE, 30 days);
        (,, uint64 expiry,,) = _rentalOf(HERO_HEADLINE);
        assertEq(expiry - uint64(block.timestamp), 30 days, "remaining window is exactly the new term");

        // Zero value on purpose. `TermTooLong` fires in the library BEFORE any collection, and
        // overfunding here from an account that has already spent produces a bare `EvmError` with no
        // custom error -- which is what an out-of-funds CALL looks like and reads exactly like a
        // broken revert check. (The token variant hid this, because there `_pay` returns 0.)
        uint256 rate2 = _listedRate();
        vm.prank(advertiser);
        vm.expectRevert(RentalsLib.TermTooLong.selector);
        site.extendRental(HERO_HEADLINE, MAX_RENTAL_TERM + 1, rate2);
    }

    /// Settle-then-restart: what was earned is flushed, the unaccrued remainder rolls forward
    /// because it was never earned.
    function test_extensionIsSettleThenRestart() public {
        _claimAndList(alice, HERO_HEADLINE, 30 days);
        uint256 cost = _rent(advertiser, HERO_HEADLINE, 10 days);
        uint256 net = cost - (cost * (PROTOCOL_RENT_BPS + SITE_RENT_BPS)) / 10_000;

        vm.warp(block.timestamp + 5 days);
        uint256 carryExpected = site.unaccruedRent(HERO_HEADLINE);
        uint256 cost2 = _extend(advertiser, HERO_HEADLINE, 10 days);
        uint256 net2 = cost2 - (cost2 * (PROTOCOL_RENT_BPS + SITE_RENT_BPS)) / 10_000;

        (,,, uint256 prepaid, uint256 claimed) = _rentalOf(HERO_HEADLINE);
        assertEq(claimed, 0, "the clock restarts");
        assertApproxEqAbs(prepaid, carryExpected + net2, 2, "unaccrued remainder rolled forward");
        assertApproxEqAbs(site.pendingWithdrawals(alice), net - carryExpected, 2, "earned half was flushed");
        _assertSolvent();
    }

    /// The rate is the CURRENT listing's, so an incumbent cannot lock in a cheap rate forever. This
    /// is also the owner's escape valve: delist and extension becomes impossible.
    function test_delistingEndsTheRelationshipAtTheTermBoundary() public {
        _claimAndList(alice, HERO_HEADLINE, 30 days);
        _rent(advertiser, HERO_HEADLINE, 10 days);
        _list(alice, HERO_HEADLINE, 0, 0); // delist

        vm.prank(advertiser);
        vm.expectRevert(RentalsLib.NotForRent.selector);
        site.extendRental(HERO_HEADLINE, 5 days, 1);
    }

    /// §2.6 — expired is NOT ended. A lapsed-but-uncleared term takes the position off the rental
    /// market entirely, for everyone, until someone calls `endRental`. This is why the keeper is
    /// load-bearing for the MECHANISM, not just for content hygiene.
    function test_expiredIsNotEnded() public {
        _claimAndList(alice, HERO_HEADLINE, 30 days);
        _rent(advertiser, HERO_HEADLINE, 1 days);
        vm.warp(block.timestamp + 2 days);

        assertEq(site.userOf(uint256(HERO_HEADLINE)), address(0), "reads as no live tenant");

        uint256 rate = _listedRate();
        uint256 value = _pay(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(RentalsLib.RentalActive.selector);
        site.rent{ value: value }(HERO_HEADLINE, 1 days, rate);

        vm.prank(keeper);
        site.endRental(HERO_HEADLINE); // permissionless
        _rent(bob, HERO_HEADLINE, 1 days);
        (address tenant,,,,) = _rentalOf(HERO_HEADLINE);
        assertEq(tenant, bob, "re-rentable once cleared");
    }

    function test_endRentalBeforeExpiryReverts() public {
        _claimAndList(alice, HERO_HEADLINE, 30 days);
        _rent(advertiser, HERO_HEADLINE, 10 days);
        vm.prank(keeper);
        vm.expectRevert(RentalsLib.RentalActive.selector);
        site.endRental(HERO_HEADLINE);
    }

    /// §2.5.3 — sub-day terms are the point of taking seconds rather than whole days.
    function test_subDayTermsArePriceable() public {
        uint256 rate = _claimAndList(alice, HERO_HEADLINE, 7 days);
        uint256 cost = _rent(advertiser, HERO_HEADLINE, 6 hours);
        assertEq(cost, rate / 4, "six hours is a quarter of the daily rate");
        _assertSolvent();
    }

    function test_dustTermsAreRejected() public {
        _claimAndList(alice, HERO_HEADLINE, 7 days);
        uint256 rate = _listedRate();
        uint256 value = _pay(advertiser, 1 ether);
        vm.prank(advertiser);
        vm.expectRevert(RentalsLib.TermTooLong.selector);
        site.rent{ value: value }(HERO_HEADLINE, 59 minutes, rate);
    }

    /// The anti-poison floor, anchored to the EFFECTIVE floor rather than basePrice so headroom does
    /// not become negligible on exactly the expensive positions where poisoning pays.
    function test_rateFloorRejectsARateZeroPoison() public {
        _claim(alice, HERO_HEADLINE);
        (uint256 effectiveFloor,) = site.quote(HERO_HEADLINE);
        uint256 minRate = (effectiveFloor * MIN_RENT_BPS) / 10_000;

        vm.prank(alice);
        vm.expectRevert(RentalsLib.RateBelowFloor.selector);
        site.listForRent(HERO_HEADLINE, minRate - 1, 7 days);

        _list(alice, HERO_HEADLINE, minRate, 7 days);
        (uint192 rate,,) = site.listings(HERO_HEADLINE);
        assertEq(rate, minRate, "exactly at the floor is legal");
    }

    function test_cannotRentAnUnclaimedPosition() public {
        uint256 unclaimedValue = _pay(advertiser, 1 ether);
        vm.prank(advertiser);
        vm.expectRevert(SlotSite.NotSlotOwner.selector);
        site.rent{ value: unclaimedValue }(HERO_HEADLINE, 1 days, 1);
    }

    function test_onlyTheOwnerMayList() public {
        _claim(alice, HERO_HEADLINE);
        uint256 rate = _fairRatePerDay(HERO_HEADLINE); // hoisted: see the note in the base fixture
        vm.prank(bob);
        vm.expectRevert(SlotSite.NotSlotOwner.selector);
        site.listForRent(HERO_HEADLINE, rate, 7 days);
    }

    /// Permissionless and always pays the owner, so a UI restriction would be a rule the contract
    /// does not have.
    function test_claimRentIsPermissionlessAndPaysTheOwner() public {
        _claimAndList(alice, HERO_HEADLINE, 30 days);
        _rent(advertiser, HERO_HEADLINE, 10 days);
        vm.warp(block.timestamp + 3 days);

        vm.prank(carol); // a stranger
        site.claimRent(HERO_HEADLINE);
        assertGt(site.pendingWithdrawals(alice), 0, "paid the owner, not the caller");
        assertEq(site.pendingWithdrawals(carol), 0);
    }

    function test_pausedGatesRentButNotClaim() public {
        _claimAndList(alice, HERO_HEADLINE, 30 days);
        _rent(advertiser, HERO_HEADLINE, 10 days);
        vm.warp(block.timestamp + 3 days);

        vm.prank(siteOwner);
        site.setPaused(true);

        uint256 pausedValue = _pay(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(SlotSite.Paused.selector);
        site.rent{ value: pausedValue }(NAV_LINK_1, 1 days, 1);

        // Already-earned money is not a new value transfer.
        vm.prank(keeper);
        site.claimRent(HERO_HEADLINE);
        assertGt(site.pendingWithdrawals(alice), 0);
    }

    function _listedRate() internal view returns (uint256) {
        (uint192 rate,,) = site.listings(HERO_HEADLINE);
        return rate;
    }
}

/// @notice Every rental assertion again, settled in a 6-decimal ERC-20. The token branch touches
/// every money path (§1.2), so nothing about money is proven until it passes twice.
contract SlotSiteRentalsTokenTest is SlotSiteRentalsTest {
    function USE_TOKEN() internal pure override returns (bool) {
        return true;
    }
}
