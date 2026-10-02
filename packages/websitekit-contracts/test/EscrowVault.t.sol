// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Attestor } from "../src/Attestor.sol";
import { EscrowFactory } from "../src/EscrowFactory.sol";
import { EscrowVault } from "../src/EscrowVault.sol";
import { SlotSite } from "../src/SlotSite.sol";
import { SlotSiteBase, MockToken } from "./SlotSiteBase.t.sol";

/// @notice `EscrowVault` against `docs/escrow_contract.md` §10, on both settlement paths.
///
/// Every board here is created through `EscrowFactory`, because that is the only path that binds a
/// vault and the only path production will have. The base `site` from `SlotSiteBase` is unpinned
/// and is deliberately not used — an escrow test against a board whose publisher can repoint the
/// pipe would be testing nothing.
///
/// Money figures are written as fractions of the floor `f`, matching §5's running example: a claim
/// at the floor sends `0.95f` to the vault (the protocol keeps `0.05f`); a take at `1.4f` pays the
/// displaced owner `1.15f`, the protocol `0.05f`, and the vault `0.2f`.
///
/// The rules the design was found open to are each broken on purpose below — a claim inside the
/// delay, a claim on a slot bought after the mark, a second claim in one episode, a `clearDark`
/// while live — and each has a test that fails with the guard deleted (§11, build order step 2).
abstract contract EscrowVaultBase is SlotSiteBase {
    Attestor internal registry;
    EscrowFactory internal escrowFactory;
    SlotSite internal esite;
    EscrowVault internal vault;

    address internal attestorKey = makeAddr("attestor");
    address internal outsider = makeAddr("outsider");

    uint64 internal constant WINDOW = 14 days;
    uint64 internal constant CLAIM_DELAY = 12 hours;
    uint64 internal constant MIN_TRANSITION = 6 hours;

    uint256 internal constant T0 = 1_800_000_000;

    function setUp() public virtual override {
        super.setUp();
        vm.warp(T0);

        registry = new Attestor(address(this), attestorKey);
        address[] memory tokens = new address[](2);
        tokens[0] = address(0);
        tokens[1] = address(token);
        escrowFactory = new EscrowFactory(address(this), factory, address(registry), _params(), tokens);

        (esite, vault) = _escrowed(_defaultConfig());
    }

    function _params() internal view returns (EscrowVault.Params memory) {
        return EscrowVault.Params({
            windowSecs: WINDOW,
            claimDelaySecs: CLAIM_DELAY,
            minTransitionSecs: MIN_TRANSITION,
            minBooking: uint128(_floor() / 1000)
        });
    }

    /// @dev Through the ESCROW factory, which is the only path that pins and binds.
    function _escrowed(SlotSite.SiteConfig memory cfg) internal returns (SlotSite s, EscrowVault v) {
        (bytes32[] memory keys, uint256[] memory floors) = _defaultSlots();
        (address siteAddr, address vaultAddr) = escrowFactory.createEscrowedSite(siteOwner, cfg, keys, floors);
        s = SlotSite(payable(siteAddr));
        v = EscrowVault(payable(vaultAddr));

        address[6] memory funded = [alice, bob, carol, advertiser, keeper, siteOwner];
        for (uint256 i = 0; i < funded.length; i++) {
            vm.prank(funded[i]);
            token.approve(address(s), type(uint256).max);
            vm.prank(funded[i]);
            token.approve(address(v), type(uint256).max);
        }
    }

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    function _claimOn(address buyer, bytes32 key) internal returns (uint256 charged) {
        (charged,) = esite.quote(key);
        bytes32 terms = esite.encumbranceHash(key);
        vm.prank(buyer);
        esite.buy{ value: _pay(buyer, charged) }(key, charged, terms, block.timestamp);
    }

    function _takeOn(address buyer, bytes32 key) internal returns (uint256 charged) {
        (, charged) = esite.quote(key);
        bytes32 terms = esite.encumbranceHash(key);
        vm.prank(buyer);
        esite.buy{ value: _pay(buyer, charged) }(key, charged, terms, block.timestamp);
    }

    function _held(address who) internal view returns (uint256) {
        return USE_TOKEN() ? token.balanceOf(who) : who.balance;
    }

    /// @dev Value arriving at the vault the way a royalty or a stray transfer would.
    function _sendToVault(uint256 amount) internal {
        if (USE_TOKEN()) {
            token.mint(address(vault), amount);
        } else {
            vm.deal(outsider, outsider.balance + amount);
            vm.prank(outsider);
            (bool ok,) = address(vault).call{ value: amount }("");
            require(ok, "send");
        }
    }

    function _fundReserve(address from, uint256 amount) internal {
        vm.prank(from);
        vault.fundReserve{ value: USE_TOKEN() ? 0 : amount }(amount);
    }

    /// @dev A mark follows a crawl and never lands in the block of a sale, so an hour passes first.
    /// Without it every purchase in a test shares the mark's timestamp and is refused as bought
    /// during the blackout - which is the rule working, not the rule under test.
    function _mark() internal {
        vm.warp(block.timestamp + 1 hours);
        vm.prank(attestorKey);
        vault.markDark();
    }

    function _clear() internal {
        vm.prank(attestorKey);
        vault.clearDark();
    }

    /// @dev Approve the vault and claim, as the holder. The approval is the surrender's consent.
    function _surrender(address holder, bytes32 key) internal returns (uint256 paid) {
        vm.prank(holder);
        esite.setApprovalForAll(address(vault), true);
        vm.prank(holder);
        paid = vault.claim(key, 0);
    }

    /// @dev The ledger has to add up after every operation: booked money is exactly the deposits,
    /// and the balance covers everything the vault has spoken for.
    function _assertLedger() internal view {
        uint256 sum;
        uint256 n = vault.depositCount();
        for (uint256 i = 0; i < n; i++) {
            sum += vault.depositAt(i).amount;
        }
        assertEq(sum, vault.bookedTotal(), "deposits != bookedTotal");
        assertGe(_held(address(vault)), vault.bookedTotal() + vault.pendingTotal() + vault.reserve(), "balance short");
        assertEq(
            _held(address(vault)),
            vault.bookedTotal() + vault.pendingTotal() + vault.reserve() + vault.unbooked(),
            "unbooked does not close the ledger"
        );
    }

    // -----------------------------------------------------------------
    // Bind — the guarantee a stranger can check
    // -----------------------------------------------------------------

    function test_bindIsBothDirectionsAndPinned() public view {
        assertEq(address(vault.site()), address(esite));
        assertEq(esite.treasury(), address(vault));
        assertTrue(esite.treasuryPinned());
        assertEq(escrowFactory.vaultOf(address(esite)), address(vault));
        assertEq(vault.settlementToken(), USE_TOKEN() ? address(token) : address(0));
        assertEq(vault.windowSecs(), WINDOW);
        assertEq(vault.claimDelaySecs(), CLAIM_DELAY);
    }

    /// The caller's `treasury` and `pinTreasury` are overwritten, never read. An escrowed board
    /// whose money went anywhere but its vault would be a badge with nothing behind it.
    function test_factoryOverwritesTreasuryAndPin() public {
        SlotSite.SiteConfig memory cfg = _defaultConfig();
        cfg.treasury = carol;
        cfg.pinTreasury = false;
        (SlotSite s, EscrowVault v) = _escrowed(cfg);
        assertEq(s.treasury(), address(v));
        assertTrue(s.treasuryPinned());
    }

    function test_bindRefusesEveryoneButTheFactory() public {
        vm.expectRevert(EscrowVault.NotFactory.selector);
        vault.bind(address(esite), _params());
    }

    function test_bindRefusesASecondTime() public {
        EscrowVault.Params memory p = _params();
        vm.prank(address(escrowFactory));
        vm.expectRevert(EscrowVault.AlreadyBound.selector);
        vault.bind(address(esite), p);
    }

    function test_factoryRefusesATokenOffTheAllowlist() public {
        MockToken other = new MockToken();
        SlotSite.SiteConfig memory cfg = _defaultConfig();
        cfg.settlementToken = address(other);
        (bytes32[] memory keys, uint256[] memory floors) = _defaultSlots();
        vm.expectRevert(EscrowFactory.TokenNotAllowed.selector);
        escrowFactory.createEscrowedSite(siteOwner, cfg, keys, floors);
    }

    function test_paramsAreCopiedAtBindAndAChangeReachesOnlyTheNextBoard() public {
        EscrowVault.Params memory p = _params();
        p.windowSecs = 30 days;
        escrowFactory.setParams(p);
        assertEq(vault.windowSecs(), WINDOW, "an existing vault must not move");
        (, EscrowVault next) = _escrowed(_defaultConfig());
        assertEq(next.windowSecs(), 30 days);
    }

    // -----------------------------------------------------------------
    // Book — balance-delta, to the owner, above the dust line
    // -----------------------------------------------------------------

    function test_bookSweepsTheSiteAndStampsTheOwner() public {
        uint256 f = _floor();
        _claimOn(alice, HERO_HEADLINE);
        assertEq(esite.treasuryBalance(), (f * 95) / 100, "site holds the publisher's cut");

        (uint256 id, uint256 amount) = vault.book();
        assertEq(id, 0);
        assertEq(amount, (f * 95) / 100);
        assertEq(esite.treasuryBalance(), 0, "swept");

        EscrowVault.Deposit memory d = vault.depositAt(0);
        assertEq(d.amount, amount);
        assertEq(d.bookedAt, uint64(block.timestamp));
        assertEq(d.darkAtBooking, 0);
        assertEq(d.beneficiary, siteOwner);
        _assertLedger();
    }

    function test_bookTwiceBooksNothingTheSecondTime() public {
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        (, uint256 again) = vault.book();
        assertEq(again, 0);
        assertEq(vault.depositCount(), 1);
    }

    /// Anyone can send one unit and call `book()`. Below the line it accumulates instead of
    /// becoming a deposit `claim` would have to walk.
    function test_dustStaysUnbookedUntilItCrossesTheLine() public {
        uint256 dust = vault.minBooking() - 1;
        _sendToVault(dust);
        (, uint256 amount) = vault.book();
        assertEq(amount, 0);
        assertEq(vault.depositCount(), 0);
        assertEq(vault.unbooked(), dust);

        _sendToVault(1);
        (, amount) = vault.book();
        assertEq(amount, dust + 1, "the whole accumulation books at once");
        _assertLedger();
    }

    /// Credited money waits in the vault's own balance. A `book()` that mistook it for fresh inbound
    /// would book a publisher's release a second time, to whoever owns the board today.
    function test_bookExcludesCreditedMoney() public {
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        vm.warp(block.timestamp + WINDOW);
        vault.release(0);
        assertGt(vault.pendingTotal(), 0);

        (, uint256 again) = vault.book();
        assertEq(again, 0, "pending is not inbound");
        assertEq(vault.depositCount(), 1);
        _assertLedger();
    }

    /// A stray transfer in the settlement token — an ERC-2981 royalty paid in it — is publisher
    /// revenue and gets what publisher revenue gets.
    function test_bookTreatsAnyInboundAsADeposit() public {
        uint256 royalty = _unit();
        _sendToVault(royalty);
        (, uint256 amount) = vault.book();
        assertEq(amount, royalty);
        assertEq(vault.depositAt(0).beneficiary, siteOwner);
    }

    /// `_bookRentPayment` credits `treasuryBalance` with the publisher's rent cut, and that line is
    /// frozen. Rent income arrives at the vault like any sale (§8 item 10).
    function test_rentRevenueLandsInThePool() public {
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        // Hoisted: a `quote` inside the argument list would spend the prank on the read.
        (uint256 effectiveFloor,) = esite.quote(HERO_HEADLINE);
        uint256 fair = (effectiveFloor * 164) / 10_000;
        vm.prank(alice);
        esite.listForRent(HERO_HEADLINE, fair, 30 days);
        (uint192 rate,,) = esite.listings(HERO_HEADLINE);
        uint256 cost = uint256(rate);
        vm.prank(advertiser);
        esite.rent{ value: _pay(advertiser, cost) }(HERO_HEADLINE, 1 days, rate);

        uint256 owed = esite.treasuryBalance();
        assertGt(owed, 0, "the publisher's rent cut is in the site");
        (, uint256 amount) = vault.book();
        assertEq(amount, owed);
        _assertLedger();
    }

    // -----------------------------------------------------------------
    // Release — maturity, at the boundary
    // -----------------------------------------------------------------

    function test_releaseWaitsForTheWholeWindow() public {
        _claimOn(alice, HERO_HEADLINE);
        (, uint256 amount) = vault.book();

        vm.warp(T0 + WINDOW - 1);
        assertFalse(vault.mature(0));
        vm.expectRevert(EscrowVault.NotMature.selector);
        vault.release(0);

        vm.warp(T0 + WINDOW);
        assertTrue(vault.mature(0));
        vault.release(0);
        assertEq(vault.pending(siteOwner), amount);
        assertEq(vault.bookedTotal(), 0);

        uint256 before = _held(siteOwner);
        vault.withdrawFor(siteOwner);
        assertEq(_held(siteOwner) - before, amount, "paid through the pull ledger");
        assertEq(vault.pendingTotal(), 0);
        _assertLedger();
    }

    function test_releaseTwiceRevertsAndWithdrawTwiceReverts() public {
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        vm.warp(T0 + WINDOW);
        vault.release(0);
        vm.expectRevert(EscrowVault.NothingToRelease.selector);
        vault.release(0);
        vault.withdrawFor(siteOwner);
        vm.expectRevert(EscrowVault.NothingToWithdraw.selector);
        vault.withdrawFor(siteOwner);
    }

    /// §5's table, row 1: dark from day 3 and never restored never matures. Property 2.
    function test_aBoardThatStaysDarkNeverPaysThePublisher() public {
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        vm.warp(T0 + 3 days);
        _mark();
        vm.warp(T0 + 400 days);
        assertFalse(vault.mature(0));
        vm.expectRevert(EscrowVault.NotMature.selector);
        vault.release(0);
    }

    /// §5's table, row 2: the re-add attack. Dark days 3–13 owes ten days back, so the deposit
    /// matures on day 24 rather than day 14.
    function test_reAddingTheTagResumesTheClockWhereItStopped() public {
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        vm.warp(T0 + 3 days - 1 hours);
        _mark();
        assertEq(vault.darkSince(), T0 + 3 days);
        vm.warp(T0 + 13 days);
        _clear();
        assertEq(vault.darkAccrued(), 10 days);

        vm.warp(T0 + 14 days);
        assertFalse(vault.mature(0), "day 14 is no longer the date");
        vm.warp(T0 + 24 days - 1);
        assertFalse(vault.mature(0));
        vm.warp(T0 + 24 days);
        assertTrue(vault.mature(0));
        vault.release(0);
    }

    /// §5's table, row 4 — the one the first draft had wrong. Matured on day 14, dark on day 16:
    /// the publisher's, releasable while dark, and claimable by nobody.
    function test_moneyThatMaturedBeforeTheLightsWentOutIsThePublishers() public {
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        vm.warp(T0 + 16 days);
        _mark();
        assertTrue(vault.mature(0), "as of darkSince, not as of now");
        assertEq(vault.immaturePool(), 0);

        vm.warp(block.timestamp + CLAIM_DELAY);
        vm.prank(alice);
        esite.setApprovalForAll(address(vault), true);
        vm.prank(alice);
        vm.expectRevert(EscrowVault.NothingToClaim.selector);
        vault.claim(HERO_HEADLINE, 0);

        vault.release(0);
        assertEq(vault.pending(siteOwner), vault.pendingTotal());
    }

    /// A deposit booked INSIDE a blackout carries the running episode in its snapshot and matures
    /// `windowSecs` after the lights come back, not after they went out.
    function test_aDepositBookedWhileDarkMaturesAWindowAfterTheClear() public {
        vm.warp(T0 - 1 hours);
        _mark();
        assertEq(vault.darkSince(), T0);
        vm.warp(T0 + 1 days);
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        assertEq(vault.depositAt(0).darkAtBooking, 1 days, "includes the running episode");
        assertFalse(vault.mature(0));

        vm.warp(T0 + 5 days);
        _clear();
        vm.warp(T0 + 5 days + WINDOW - 1);
        assertFalse(vault.mature(0));
        vm.warp(T0 + 5 days + WINDOW);
        assertTrue(vault.mature(0));
    }

    /// `renounceOwnership` is never surfaced and is in frozen bytecode. A deposit stamped with
    /// nobody must not become a credit nobody can withdraw.
    function test_releaseRefusesAZeroBeneficiary() public {
        vm.prank(siteOwner);
        esite.renounceOwnership();
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        assertEq(vault.depositAt(0).beneficiary, address(0));
        vm.warp(T0 + WINDOW);
        vm.expectRevert(EscrowVault.ZeroBeneficiary.selector);
        vault.release(0);
    }

    // -----------------------------------------------------------------
    // Handover — the stamp is taken at booking (§6, §8 item 13)
    // -----------------------------------------------------------------

    function test_depositsStampWhoeverOwnsTheBoardWhenBooked() public {
        _claimOn(alice, HERO_HEADLINE);
        vault.book();

        _claimOn(bob, HERO_IMAGE);
        vm.prank(carol);
        esite.requestOwnershipHandover();
        vm.prank(siteOwner);
        esite.completeOwnershipHandover(carol);
        vault.book();

        assertEq(vault.depositAt(0).beneficiary, siteOwner, "booked before the handover");
        assertEq(vault.depositAt(1).beneficiary, carol, "booked after it");
        // And the pin held through the handover: the new owner cannot repoint the pipe either.
        vm.prank(carol);
        vm.expectRevert(SlotSite.TreasuryPinned.selector);
        esite.setTreasury(carol);
    }

    // -----------------------------------------------------------------
    // The dark path — guarded in both directions, rate-limited, the attestor's alone
    // -----------------------------------------------------------------

    function test_onlyTheAttestorMarksOrClears() public {
        vm.prank(siteOwner);
        vm.expectRevert(EscrowVault.NotAttestor.selector);
        vault.markDark();
        _mark();
        vm.warp(block.timestamp + MIN_TRANSITION);
        vm.prank(alice);
        vm.expectRevert(EscrowVault.NotAttestor.selector);
        vault.clearDark();
    }

    function test_markWhileDarkReverts() public {
        _mark();
        vm.warp(block.timestamp + MIN_TRANSITION);
        vm.prank(attestorKey);
        vm.expectRevert(EscrowVault.AlreadyDark.selector);
        vault.markDark();
    }

    /// The brick: `now − 0` into `darkAccrued` and nothing on the board ever matures.
    function test_clearWhileLiveReverts() public {
        vm.prank(attestorKey);
        vm.expectRevert(EscrowVault.NotDark.selector);
        vault.clearDark();
        assertEq(vault.darkAccrued(), 0);
    }

    function test_transitionsAreSpacedOnChain() public {
        _mark();
        vm.warp(block.timestamp + MIN_TRANSITION - 1);
        vm.prank(attestorKey);
        vm.expectRevert(EscrowVault.TransitionTooSoon.selector);
        vault.clearDark();
        vm.warp(block.timestamp + 1);
        _clear();
        vm.prank(attestorKey);
        vm.expectRevert(EscrowVault.TransitionTooSoon.selector);
        vault.markDark();
    }

    function test_theKeyRotatesBehindTheRegistry() public {
        address fresh = makeAddr("fresh");
        registry.setAttestor(fresh);
        vm.prank(attestorKey);
        vm.expectRevert(EscrowVault.NotAttestor.selector);
        vault.markDark();
        vm.prank(fresh);
        vault.markDark();
        assertTrue(vault.isDark());
    }

    /// No attestor means nobody can mark, and the vault degrades to a payout delay. Fail-open.
    function test_noAttestorMeansNobody() public {
        registry.setAttestor(address(0));
        vm.prank(address(0));
        vm.expectRevert(EscrowVault.NotAttestor.selector);
        vault.markDark();
        vm.prank(attestorKey);
        vm.expectRevert(EscrowVault.NotAttestor.selector);
        vault.markDark();
    }

    // -----------------------------------------------------------------
    // Claim — a surrender, after a delay, for a position that predates the mark
    // -----------------------------------------------------------------

    function test_claimSurrendersTheSlotForThePublishersCut() public {
        uint256 f = _floor();
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        _mark();
        vm.warp(block.timestamp + CLAIM_DELAY);

        assertEq(vault.claimable(HERO_HEADLINE), (f * 95) / 100);
        uint256 paid = _surrender(alice, HERO_HEADLINE);
        assertEq(paid, (f * 95) / 100, "95% without a reserve - s.5's table, row 1");
        assertEq(vault.pending(alice), paid);
        assertEq(esite.ownerOfOrZero(HERO_HEADLINE), address(vault), "the slot is the vault's now");
        assertEq(vault.depositAt(0).amount, 0);
        assertEq(vault.claimedEpoch(HERO_HEADLINE), vault.darkSince());
        _assertLedger();

        uint256 before = _held(alice);
        vault.withdrawFor(alice);
        assertEq(_held(alice) - before, paid);
    }

    function test_claimBooksOnEntry() public {
        _claimOn(alice, HERO_HEADLINE);
        // No book() — the publisher never swept. Unbooked money must still be claimable.
        _mark();
        vm.warp(block.timestamp + CLAIM_DELAY);
        uint256 paid = _surrender(alice, HERO_HEADLINE);
        assertEq(paid, (_floor() * 95) / 100);
        assertEq(vault.depositCount(), 1, "booked, then drained");
    }

    /// The reserve is what makes a first buyer whole rather than 95% whole: the pool first, then
    /// the reserve for the remainder, and never more than `lastPrice`.
    function test_claimPaysTheFullPriceFromTheReserve() public {
        uint256 f = _floor();
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        _fundReserve(keeper, f);
        assertEq(vault.unbooked(), 0, "reserve is not inbound");
        _mark();
        vm.warp(block.timestamp + CLAIM_DELAY);

        uint256 paid = _surrender(alice, HERO_HEADLINE);
        assertEq(paid, f, "whole");
        assertEq(vault.reserve(), f - (f * 5) / 100, "only the missing 5% came from the reserve");
        assertEq(vault.bookedTotal(), 0, "the pool was spent first");
        _assertLedger();
    }

    function test_claimBeforeTheDelayReverts() public {
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        _mark();
        vm.warp(block.timestamp + CLAIM_DELAY - 1);
        vm.prank(alice);
        esite.setApprovalForAll(address(vault), true);
        vm.prank(alice);
        vm.expectRevert(EscrowVault.NotClaimable.selector);
        vault.claim(HERO_HEADLINE, 0);
        assertEq(vault.claimable(HERO_HEADLINE), 0);
    }

    function test_claimWhileLiveReverts() public {
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        vm.prank(alice);
        esite.setApprovalForAll(address(vault), true);
        vm.prank(alice);
        vm.expectRevert(EscrowVault.NotClaimable.selector);
        vault.claim(HERO_HEADLINE, 0);
    }

    /// `buy` is permissionless on chain. A slot claimed at the floor WHILE dark — which our
    /// checkout refuses and the contract does not — mints no claim against anybody else's money.
    function test_aSlotBoughtDuringTheBlackoutIsNotCovered() public {
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        _mark();
        vm.warp(block.timestamp + 1 hours);
        _claimOn(bob, HERO_IMAGE);
        vm.warp(block.timestamp + CLAIM_DELAY);

        vm.prank(bob);
        esite.setApprovalForAll(address(vault), true);
        vm.prank(bob);
        vm.expectRevert(EscrowVault.BoughtDuringBlackout.selector);
        vault.claim(HERO_IMAGE, 0);
        assertEq(vault.claimable(HERO_IMAGE), 0);
        // Alice, who was there when the lights went out, still is.
        assertGt(vault.claimable(HERO_HEADLINE), 0);
    }

    /// The boundary: a purchase in the same second as the mark is after it.
    function test_aPurchaseInTheMarkingBlockIsAfterTheMark() public {
        _mark();
        _claimOn(bob, HERO_IMAGE);
        vm.warp(block.timestamp + CLAIM_DELAY);
        vm.prank(bob);
        esite.setApprovalForAll(address(vault), true);
        vm.prank(bob);
        vm.expectRevert(EscrowVault.BoughtDuringBlackout.selector);
        vault.claim(HERO_IMAGE, 0);
    }

    /// The self-take ratchet: while dark, a take moves `lastPurchaseTs` past the mark, so the new
    /// holder cannot claim and the displaced one no longer holds. The pool is untouched.
    function test_aTakeDuringTheBlackoutLeavesNobodyWithAClaimOnThatSlot() public {
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        uint256 pool = vault.immaturePool();
        vm.warp(block.timestamp + COOLDOWN_SECS);
        _mark();
        vm.warp(block.timestamp + 1 hours);
        _takeOn(carol, HERO_HEADLINE);
        vm.warp(block.timestamp + CLAIM_DELAY);

        vm.prank(carol);
        esite.setApprovalForAll(address(vault), true);
        vm.prank(carol);
        vm.expectRevert(EscrowVault.BoughtDuringBlackout.selector);
        vault.claim(HERO_HEADLINE, 0);

        // The slot-level refusal precedes the holder-level one: alice no longer holds it, and the
        // position itself was bought inside the episode, so she is refused for the same reason.
        vm.prank(alice);
        esite.setApprovalForAll(address(vault), true);
        vm.prank(alice);
        vm.expectRevert(EscrowVault.BoughtDuringBlackout.selector);
        vault.claim(HERO_HEADLINE, 0);

        assertEq(vault.immaturePool(), pool, "nothing left the pool");
    }

    function test_claimTwiceInOneEpisodeReverts() public {
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        _mark();
        vm.warp(block.timestamp + CLAIM_DELAY);
        _surrender(alice, HERO_HEADLINE);
        // The vault holds it now; a second claim by anyone, the vault's own operator included, is
        // refused on the epoch before it is refused on the holder.
        vm.prank(alice);
        vm.expectRevert(EscrowVault.AlreadyClaimedThisEpisode.selector);
        vault.claim(HERO_HEADLINE, 0);
    }

    /// The floor a claimant sets, and the reason it exists: a surrender cannot be undone and the
    /// pool is first-come-first-served, so without it a holder who is second on a contested board
    /// hands the slot in for whatever the block happens to hold. `escrow_mainnet.md` E-4 measured
    /// $0.589474 paid against $1.30 quoted one block earlier.
    function test_aClaimBelowTheCallersFloorIsRefused() public {
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        _mark();
        vm.warp(block.timestamp + CLAIM_DELAY);
        uint256 offered = vault.claimable(HERO_HEADLINE);
        assertGt(offered, 0);

        vm.prank(alice);
        esite.setApprovalForAll(address(vault), true);
        vm.prank(alice);
        vm.expectRevert(EscrowVault.BelowMinimum.selector);
        vault.claim(HERO_HEADLINE, offered + 1);

        // Refused means REFUSED: the slot is still hers and nothing was credited.
        assertEq(esite.ownerOfOrZero(HERO_HEADLINE), alice);
        assertEq(vault.pending(alice), 0);
    }

    /// At the boundary, not in the middle of the branch — a floor equal to the offer is accepted,
    /// one unit above it is not, and the test above pins the other side.
    function test_aFloorExactlyEqualToTheOfferIsAccepted() public {
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        _mark();
        vm.warp(block.timestamp + CLAIM_DELAY);
        uint256 offered = vault.claimable(HERO_HEADLINE);

        vm.prank(alice);
        esite.setApprovalForAll(address(vault), true);
        vm.prank(alice);
        uint256 paid = vault.claim(HERO_HEADLINE, offered);
        assertEq(paid, offered);
        assertEq(vault.pending(alice), offered);
    }

    /// Zero is what every caller passed before the parameter existed, and it must keep meaning
    /// "no floor" rather than "refuse everything" or "refuse nothing above zero".
    function test_aZeroFloorMeansNoFloor() public {
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        _mark();
        vm.warp(block.timestamp + CLAIM_DELAY);
        vm.prank(alice);
        esite.setApprovalForAll(address(vault), true);
        vm.prank(alice);
        assertEq(vault.claim(HERO_HEADLINE, 0), vault.pending(alice));
        assertGt(vault.pending(alice), 0);
    }

    /// **The floor is checked AFTER the cap, which is the decision worth pinning.** A floor is a
    /// promise about what the CALLER is credited, not about what the vault happens to be holding —
    /// so on a board whose pool exceeds one slot's price, a floor above that slot's cap must be
    /// refused rather than quietly satisfied by money the caller can never reach.
    ///
    /// **TWO sales, because with one the pool is smaller than the cap and the two readings agree.**
    /// A mutation checking `pool + reserve` instead of the credited amount survived the first
    /// version of this test for exactly that reason: an assertion that two things differ has to use
    /// an input on which they can.
    function test_theFloorIsAgainstWhatIsCreditedNotWhatThePoolHolds() public {
        _claimOn(alice, HERO_HEADLINE);
        _claimOn(bob, HERO_IMAGE);
        vault.book();
        _mark();
        vm.warp(block.timestamp + CLAIM_DELAY);

        uint256 cap = esite.slotOf(HERO_HEADLINE).lastPrice;
        uint256 held = vault.immaturePool() + vault.reserve();
        // The input the two readings disagree on: the vault holds more than this slot ever cost.
        assertGt(held, cap);
        assertEq(vault.claimable(HERO_HEADLINE), cap);

        vm.prank(alice);
        esite.setApprovalForAll(address(vault), true);
        // Above her cap and below what the vault holds — refused, because she can never be credited
        // more than her own slot's price however much is in the pool.
        vm.prank(alice);
        vm.expectRevert(EscrowVault.BelowMinimum.selector);
        vault.claim(HERO_HEADLINE, cap + 1);

        // And at the cap it goes through.
        vm.prank(alice);
        assertEq(vault.claim(HERO_HEADLINE, cap), cap);
    }

    function test_claimOnAnUnclaimedSlotReverts() public {
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        _mark();
        vm.warp(block.timestamp + CLAIM_DELAY);
        vm.prank(bob);
        vm.expectRevert(EscrowVault.NothingToClaim.selector);
        vault.claim(HERO_IMAGE, 0);
    }

    function test_onlyTheHolderOrTheirOperatorClaims() public {
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        _mark();
        vm.warp(block.timestamp + CLAIM_DELAY);
        vm.prank(alice);
        esite.setApprovalForAll(address(vault), true);

        vm.prank(bob);
        vm.expectRevert(EscrowVault.NotHolder.selector);
        vault.claim(HERO_HEADLINE, 0);

        // An operator alice approved may claim on her behalf — and it is still alice who is paid.
        vm.prank(alice);
        esite.setApprovalForAll(bob, true);
        vm.prank(bob);
        uint256 paid = vault.claim(HERO_HEADLINE, 0);
        assertEq(vault.pending(alice), paid);
        assertEq(vault.pending(bob), 0);
    }

    /// Without the vault approved, the surrender itself is what fails — the holder has consented to
    /// nothing and nothing is credited.
    function test_claimWithoutApprovingTheVaultFails() public {
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        _mark();
        vm.warp(block.timestamp + CLAIM_DELAY);
        vm.prank(alice);
        vm.expectRevert();
        vault.claim(HERO_HEADLINE, 0);
        assertEq(vault.pending(alice), 0);
        assertEq(esite.ownerOfOrZero(HERO_HEADLINE), alice);
    }

    /// §5's resale example. Money carries over rather than settling, and the second buyer is
    /// covered for `1.15f` of the `1.4f` they paid — 82%.
    function test_resaleCarriesTheMoneyOverToTheNewHolder() public {
        uint256 f = _floor();
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        vm.warp(block.timestamp + COOLDOWN_SECS);
        uint256 takePrice = _takeOn(bob, HERO_HEADLINE);
        assertEq(takePrice, (f * 14) / 10);
        vault.book();
        assertEq(vault.immaturePool(), (f * 95) / 100 + (f * 20) / 100, "0.95f + 0.2f");

        _mark();
        vm.warp(block.timestamp + CLAIM_DELAY);
        uint256 paid = _surrender(bob, HERO_HEADLINE);
        assertEq(paid, (f * 115) / 100, "the whole pool, under the 1.4f cap");
        // Alice already left whole: 1.15f in her site ledger, never escrowed.
        assertEq(esite.pendingWithdrawals(alice), (f * 115) / 100);
        _assertLedger();
    }

    /// The draining rule as proposed: first come, capped per slot at `lastPrice`. Written down
    /// rather than hidden — the second claimant gets what is left.
    function test_claimsDrainFirstComeFirstServedUnderEachCap() public {
        uint256 f = _floor();
        _claimOn(alice, HERO_HEADLINE); // floor f
        _claimOn(bob, NAV_LINK_1); // floor 2f
        vault.book();
        assertEq(vault.immaturePool(), (f * 95) / 100 + (f * 190) / 100);

        _mark();
        vm.warp(block.timestamp + CLAIM_DELAY);
        uint256 bobPaid = _surrender(bob, NAV_LINK_1);
        assertEq(bobPaid, 2 * f, "capped at what bob paid");
        uint256 alicePaid = _surrender(alice, HERO_HEADLINE);
        assertEq(alicePaid, (f * 285) / 100 - 2 * f, "the remainder, under her own cap");
        assertEq(vault.immaturePool(), 0);
        _assertLedger();
    }

    /// Mature deposits are the publisher's whatever else happens. Only immature ones drain.
    function test_claimNeverTouchesAMatureDeposit() public {
        uint256 f = _floor();
        _claimOn(alice, HERO_HEADLINE);
        vault.book(); // deposit 0, will mature
        vm.warp(block.timestamp + WINDOW);
        _claimOn(bob, HERO_IMAGE);
        vault.book(); // deposit 1, fresh
        _mark();
        vm.warp(block.timestamp + CLAIM_DELAY);

        uint256 paid = _surrender(bob, HERO_IMAGE);
        assertEq(paid, (f * 5 * 95) / 100, "bob's own sale only");
        assertEq(vault.depositAt(0).amount, (f * 95) / 100, "alice's sale is the publisher's");
        vault.release(0);
    }

    /// The vault as holder. When the surrendered slot is taken, the payout returns through `book()`
    /// as a fresh deposit to the publisher — a claimed slot's next sale refills the pool.
    function test_aSurrenderedSlotsNextSaleRefillsThePool() public {
        uint256 f = _floor();
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        _mark();
        vm.warp(block.timestamp + CLAIM_DELAY);
        _surrender(alice, HERO_HEADLINE);
        vm.warp(block.timestamp + MIN_TRANSITION);
        _clear();

        _takeOn(carol, HERO_HEADLINE);
        assertEq(esite.pendingWithdrawals(address(vault)), (f * 115) / 100, "the site owes the vault the payout");
        (, uint256 amount) = vault.book();
        assertEq(amount, (f * 115) / 100 + (f * 20) / 100, "payout plus the publisher's cut of the take");
        assertEq(vault.depositAt(1).beneficiary, siteOwner);
        assertEq(esite.pendingWithdrawals(address(vault)), 0);
        _assertLedger();
    }

    /// A second episode is a second claim: the ledger is per `darkSince`, so a slot that came back
    /// into the market and went dark again is covered again with nothing to reset.
    function test_theClaimLedgerIsPerEpisode() public {
        _claimOn(alice, HERO_HEADLINE);
        vault.book();
        _mark();
        vm.warp(block.timestamp + CLAIM_DELAY);
        _surrender(alice, HERO_HEADLINE);
        vm.warp(block.timestamp + MIN_TRANSITION);
        _clear();

        _takeOn(carol, HERO_HEADLINE);
        vault.book();
        vm.warp(block.timestamp + MIN_TRANSITION);
        _mark();
        vm.warp(block.timestamp + CLAIM_DELAY);
        uint256 paid = _surrender(carol, HERO_HEADLINE);
        assertGt(paid, 0);
    }

    // -----------------------------------------------------------------
    // Foreign value — swept to the owner, never booked
    // -----------------------------------------------------------------

    function test_aForeignTokenIsSweptToTheOwner() public {
        MockToken foreign = new MockToken();
        foreign.mint(address(vault), 123e6);
        vault.sweepForeign(address(foreign));
        assertEq(foreign.balanceOf(siteOwner), 123e6);
        vm.expectRevert(EscrowVault.NothingToSweep.selector);
        vault.sweepForeign(address(foreign));
    }

    function test_theSettlementTokenIsNotForeign() public {
        address settlement = vault.settlementToken();
        vm.expectRevert(EscrowVault.NotForeign.selector);
        vault.sweepForeign(settlement);
    }

    // -----------------------------------------------------------------
    // The reserve
    // -----------------------------------------------------------------

    function test_reserveIsOnlyWithdrawableByTheFactoryOwnerWhileLive() public {
        uint256 f = _floor();
        _fundReserve(keeper, f);
        assertEq(vault.reserve(), f);

        vm.prank(alice);
        vm.expectRevert(EscrowVault.NotReserveOwner.selector);
        vault.withdrawReserve(f, alice);

        _mark();
        vm.expectRevert(EscrowVault.ReserveLocked.selector);
        vault.withdrawReserve(f, keeper);
        vm.warp(block.timestamp + MIN_TRANSITION);
        _clear();

        uint256 before = _held(keeper);
        vault.withdrawReserve(f, keeper);
        assertEq(_held(keeper) - before, f);
        assertEq(vault.reserve(), 0);
        _assertLedger();
    }

    function test_reserveIsNeverReleasedToThePublisher() public {
        _fundReserve(keeper, _floor());
        (, uint256 amount) = vault.book();
        assertEq(amount, 0);
        assertEq(vault.depositCount(), 0);
    }
}

contract EscrowVaultNativeTest is EscrowVaultBase {
    /// Native value on a native board is never foreign.
    function test_nativeIsNotForeignOnANativeBoard() public {
        vm.expectRevert(EscrowVault.NotForeign.selector);
        vault.sweepForeign(address(0));
    }

    /// The pull ledger is what makes a holder that cannot receive value payable at all: the credit
    /// lands, and a refusing holder is a refusing WITHDRAW rather than a claim that reverts.
    function test_aHolderThatRefusesValueIsStillCredited() public {
        RefusingHolder holder = new RefusingHolder();
        vm.deal(address(holder), 10 ether);
        (uint256 price,) = esite.quote(HERO_HEADLINE);
        bytes32 terms = esite.encumbranceHash(HERO_HEADLINE);
        holder.buy(esite, HERO_HEADLINE, price, terms);
        vault.book();
        _mark();
        vm.warp(block.timestamp + CLAIM_DELAY);
        holder.approveAndClaim(esite, vault, HERO_HEADLINE);
        assertGt(vault.pending(address(holder)), 0, "credited");
        vm.expectRevert(EscrowVault.TransferFailed.selector);
        vault.withdrawFor(address(holder));
    }
}

contract EscrowVaultTokenTest is EscrowVaultBase {
    function USE_TOKEN() internal pure override returns (bool) {
        return true;
    }

    /// The common royalty case: a marketplace pays in native to `royaltyInfo`'s receiver, which is
    /// this vault, on a board that settles in a token. It is swept to the owner, never booked.
    function test_nativeRoyaltyOnATokenBoardIsSweptToTheOwner() public {
        vm.deal(outsider, 1 ether);
        vm.prank(outsider);
        (bool ok,) = address(vault).call{ value: 1 ether }("");
        assertTrue(ok, "the vault must accept native or a royalty would revert the sale");
        (, uint256 amount) = vault.book();
        assertEq(amount, 0, "native is not inbound on a token board");

        uint256 before = siteOwner.balance;
        vault.sweepForeign(address(0));
        assertEq(siteOwner.balance - before, 1 ether);
    }

    function test_fundReserveRefusesNativeOnATokenBoard() public {
        vm.deal(keeper, 1 ether);
        vm.prank(keeper);
        vm.expectRevert(EscrowVault.NativeNotAccepted.selector);
        vault.fundReserve{ value: 1 }(1);
    }
}

/// @notice A holder with no `receive()`, for the native suite.
contract RefusingHolder {
    function buy(SlotSite s, bytes32 key, uint256 price, bytes32 terms) external {
        s.buy{ value: price }(key, price, terms, block.timestamp);
    }

    function approveAndClaim(SlotSite s, EscrowVault v, bytes32 key) external {
        s.setApprovalForAll(address(v), true);
        v.claim(key, 0);
    }
}
