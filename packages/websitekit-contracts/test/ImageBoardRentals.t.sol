// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ImageBoard } from "../src/ImageBoard.sol";
import { ImageBoardStorage } from "../src/ImageBoardStorage.sol";
import { ImageBoardBase } from "./ImageBoardBase.t.sol";

/// @notice Renting a block (2026-10-20, `docs/IMAGE-BOARD-SPEC.md` §12). The owner lists a daily
/// rate and a longest term; a tenant prepays; 5% goes to the protocol and 5% to the board's holder
/// at that moment; the rest streams to whoever owns the block as the term runs. The tenant's picture
/// is held apart and shown only while the term is live. A take refunds the tenant the unstreamed
/// rent for the cells it takes, and the tenancy carries on over the cells left.
contract ImageBoardRentalsTest is ImageBoardBase {
    uint256 internal constant RATE = 1_000_003; // a day; odd so every split and stream truncates
    address internal carol = makeAddr("carol");
    address internal tenant = makeAddr("tenant");

    uint256 internal id;

    event RentListed(uint256 indexed blockId, address indexed owner, uint256 ratePerDay, uint256 maxDurationSecs);
    event BlockRented(
        uint256 indexed blockId, address indexed tenant, address indexed payer, uint256 expiry, uint256 cost
    );

    function setUp() public override {
        super.setUp();
        // Alice owns a 4 × 5 block — 20 cells — and offers it for up to 30 days.
        id = _buy(alice, alice, 0, 0, 4, 5);
        vm.prank(alice);
        board.listForRent(id, RATE, 30 days);
    }

    function _rentFor(address payer, address who, uint64 secs) internal {
        vm.prank(payer);
        board.rent(id, who, secs, RATE);
    }

    function _net(uint256 cost) internal pure returns (uint256) {
        return cost - (cost * 500) / 10_000 - (cost * 500) / 10_000;
    }

    // ---------------------------------------------------------------------
    // Listing
    // ---------------------------------------------------------------------

    function test_onlyTheOwnerLists() public {
        vm.prank(bob);
        vm.expectRevert(ImageBoardStorage.NotBlockOwner.selector);
        board.listForRent(id, RATE, 1 days);
    }

    function test_aTermFromAnHourToAYear() public {
        vm.startPrank(alice);
        vm.expectRevert(ImageBoardStorage.TermTooLong.selector);
        board.listForRent(id, RATE, 1 hours - 1);
        board.listForRent(id, RATE, 1 hours);
        board.listForRent(id, RATE, 365 days);
        vm.expectRevert(ImageBoardStorage.TermTooLong.selector);
        board.listForRent(id, RATE, 365 days + 1);
        vm.stopPrank();
    }

    function test_aRateOfZeroEndsTheOffer() public {
        vm.expectEmit(true, true, false, true, address(board));
        emit RentListed(id, alice, 0, 0);
        vm.prank(alice);
        board.listForRent(id, 0, 0);
        (uint192 rate,) = board.rentListing(id);
        assertEq(rate, 0);
        vm.prank(bob);
        vm.expectRevert(ImageBoardStorage.NotForRent.selector);
        board.rent(id, bob, 1 days, RATE);
    }

    function test_aBlockWithNoCellsLeftCannotBeOffered() public {
        vm.warp(block.timestamp + 1 days);
        _buy(bob, bob, 0, 0, 4, 5); // takes every cell
        vm.prank(alice);
        vm.expectRevert(ImageBoardStorage.NothingLeft.selector);
        board.listForRent(id, RATE, 1 days);
    }

    // ---------------------------------------------------------------------
    // Renting
    // ---------------------------------------------------------------------

    function test_theTermIsPaidUpFrontAndSplitFiveFiveAndTheRest() public {
        uint256 cost = (RATE * 2 days) / 1 days;
        uint256 treasury = board.pendingWithdrawals(protocol);
        uint256 holder = board.pendingWithdrawals(seller);
        uint256 paid = usd.balanceOf(bob);
        uint256 held = usd.balanceOf(address(board));

        vm.expectEmit(true, true, true, true, address(board));
        emit BlockRented(id, tenant, bob, block.timestamp + 2 days, cost);
        _rentFor(bob, tenant, 2 days);

        assertEq(paid - usd.balanceOf(bob), cost, "the payer paid the term");
        assertEq(usd.balanceOf(address(board)) - held, cost, "the board holds it all");
        assertEq(board.pendingWithdrawals(protocol) - treasury, (cost * 500) / 10_000, "5% to the protocol");
        assertEq(board.pendingWithdrawals(seller) - holder, (cost * 500) / 10_000, "5% to the board's holder");
        ImageBoardStorage.Rental memory t = board.rentalOf(id);
        assertEq(t.tenant, tenant, "the tenant is named, not the payer");
        assertEq(t.prepaid, _net(cost), "the rest is escrowed");
        assertEq(t.expiry, block.timestamp + 2 days);
        assertEq(board.pendingWithdrawals(alice), 0, "nothing streamed yet");
    }

    function test_theRoyaltyGoesToWhoeverHoldsTheBoardWhenItIsRented() public {
        vm.prank(seller);
        collection.transferFrom(seller, carol, 1);
        _rentFor(bob, tenant, 1 days);
        assertEq(board.pendingWithdrawals(carol), (RATE * 500) / 10_000);
    }

    function test_theRateMustBeTheOneAgreed() public {
        vm.prank(bob);
        vm.expectRevert(ImageBoardStorage.RateChanged.selector);
        board.rent(id, bob, 1 days, RATE + 1);
    }

    function test_theTermMustFitTheOffer() public {
        vm.startPrank(bob);
        vm.expectRevert(ImageBoardStorage.TermTooLong.selector);
        board.rent(id, bob, 1 hours - 1, RATE);
        vm.expectRevert(ImageBoardStorage.TermTooLong.selector);
        board.rent(id, bob, 30 days + 1, RATE);
        board.rent(id, bob, 30 days, RATE);
        vm.stopPrank();
    }

    function test_aTenantMustBeNamed() public {
        vm.prank(bob);
        vm.expectRevert(ImageBoardStorage.ZeroAddress.selector);
        board.rent(id, address(0), 1 days, RATE);
    }

    function test_oneTermAtATimeAndANewOneTheMomentItLapses() public {
        vm.prank(alice);
        board.edit(id, keccak256("owner"));
        _rentFor(bob, tenant, 1 days);
        vm.prank(tenant);
        board.editRented(id, keccak256("old tenant"));
        vm.warp(block.timestamp + 1 days - 1);
        vm.prank(bob);
        vm.expectRevert(ImageBoardStorage.RentalActive.selector);
        board.rent(id, bob, 1 days, RATE);

        vm.warp(block.timestamp + 1);
        uint256 prepaid = board.rentalOf(id).prepaid;
        _rentFor(bob, bob, 1 days);
        // The lapsed term's whole stream was its owner's before the new one started.
        assertEq(board.pendingWithdrawals(alice), prepaid);
        assertEq(board.rentalOf(id).tenant, bob);
        assertEq(board.rentalOf(id).tenantHash, bytes32(0), "the old tenant's picture does not carry over");
        assertEq(board.shownHash(id), keccak256("owner"), "the new term shows the owner's until its tenant chooses");
    }

    function test_theOwnerMayRentTheirOwnBlock() public {
        _rentFor(alice, alice, 1 days);
        assertEq(board.rentalOf(id).tenant, alice);
    }

    /// A buyer's agreed price must not buy a block whose term they were not shown.
    function test_aRentalEndsTheResaleListing() public {
        vm.prank(alice);
        board.listBlock(id, 5_000_000);
        _rentFor(alice, alice, 30 days);
        assertEq(board.listPrice(id), 0);
        vm.prank(bob);
        vm.expectRevert(ImageBoardStorage.NotListed.selector);
        board.buyListedBlock(id, bob, 5_000_000);
    }

    function test_aPermitRentNeedsNoPriorApproval() public {
        uint256 pk = 0xCA401;
        address payer = vm.addr(pk);
        usd.mint(payer, 10e6);
        uint256 cost = RATE; // one day
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, address(board), cost, deadline);
        vm.prank(payer);
        board.rentWithPermit(id, payer, 1 days, RATE, deadline, v, r, s);
        assertEq(board.rentalOf(id).tenant, payer);
        assertEq(usd.balanceOf(payer), 10e6 - cost);
    }

    // ---------------------------------------------------------------------
    // The stream
    // ---------------------------------------------------------------------

    function test_rentStreamsByTheSecondAndAnyoneMayClaimItForTheOwner() public {
        _rentFor(bob, tenant, 3 days);
        uint256 prepaid = board.rentalOf(id).prepaid;
        vm.warp(block.timestamp + 1 days);
        vm.prank(carol);
        board.claimRent(_ids(id));
        assertEq(board.pendingWithdrawals(alice), (prepaid * 1 days) / 3 days);
        assertEq(board.pendingWithdrawals(carol), 0, "claiming grants the caller nothing");

        vm.warp(block.timestamp + 5 days); // past the end: it stops at the term's end
        board.claimRent(_ids(id));
        assertEq(board.pendingWithdrawals(alice), prepaid);
        board.claimRent(_ids(id));
        assertEq(board.pendingWithdrawals(alice), prepaid, "a second claim credits nothing more");
    }

    function test_claimingAnUnrentedBlockDoesNothing() public {
        uint256[] memory ids = new uint256[](2);
        ids[0] = id;
        ids[1] = 999;
        board.claimRent(ids);
        assertEq(board.pendingWithdrawals(alice), 0);
    }

    // ---------------------------------------------------------------------
    // Pictures
    // ---------------------------------------------------------------------

    function test_theTenantsPictureShowsOnlyDuringTheTerm() public {
        vm.prank(alice);
        board.edit(id, keccak256("owner"));
        _rentFor(bob, tenant, 1 days);
        assertEq(board.shownHash(id), keccak256("owner"), "until the tenant chooses one");

        vm.prank(tenant);
        board.editRented(id, keccak256("tenant"));
        assertEq(board.shownHash(id), keccak256("tenant"));
        assertEq(board.blockOf(id).contentHash, keccak256("owner"), "the owner's is kept apart");

        // The owner may prepare what shows next, without touching the term.
        vm.prank(alice);
        board.edit(id, keccak256("owner, next"));
        assertEq(board.shownHash(id), keccak256("tenant"));

        // Ends by itself: no transaction.
        vm.warp(block.timestamp + 1 days);
        assertEq(board.shownHash(id), keccak256("owner, next"));
    }

    function test_onlyTheTenantAndOnlyDuringTheTerm() public {
        vm.prank(tenant);
        vm.expectRevert(ImageBoardStorage.RentalExpired.selector);
        board.editRented(id, keccak256("x"));

        _rentFor(bob, tenant, 1 days);
        vm.prank(alice);
        vm.expectRevert(ImageBoardStorage.NotTenant.selector);
        board.editRented(id, keccak256("x"));

        vm.warp(block.timestamp + 1 days);
        vm.prank(tenant);
        vm.expectRevert(ImageBoardStorage.RentalExpired.selector);
        board.editRented(id, keccak256("x"));
    }

    function test_aTenantsEditCountsAsAVersionAndTellsMarketplaces() public {
        _rentFor(bob, tenant, 1 days);
        uint32 before = board.blockOf(id).version;
        vm.prank(tenant);
        board.editRented(id, keccak256("tenant"));
        assertEq(board.blockOf(id).version, before + 1);
    }

    // ---------------------------------------------------------------------
    // Extending
    // ---------------------------------------------------------------------

    function test_anExtensionRestartsTheTermAtTheCurrentRateCarryingWhatIsUnstreamed() public {
        _rentFor(bob, tenant, 2 days);
        uint256 prepaid = board.rentalOf(id).prepaid;
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        board.listForRent(id, RATE * 2, 30 days);

        vm.prank(tenant);
        vm.expectRevert(ImageBoardStorage.RateChanged.selector);
        board.extendRental(id, 3 days, RATE);

        usd.mint(tenant, 100e6);
        vm.prank(tenant);
        usd.approve(address(board), type(uint256).max);
        vm.prank(tenant);
        board.extendRental(id, 3 days, RATE * 2);

        uint256 streamed = (prepaid * 1 days) / 2 days;
        assertEq(board.pendingWithdrawals(alice), streamed, "what streamed is the owner's first");
        ImageBoardStorage.Rental memory t = board.rentalOf(id);
        assertEq(t.expiry, block.timestamp + 3 days, "three days from now, not from the old end");
        assertEq(t.start, block.timestamp);
        assertEq(t.claimed, 0);
        assertEq(t.prepaid, prepaid - streamed + _net(RATE * 2 * 3), "the remainder rolls in");
    }

    function test_onlyTheTenantExtendsALiveTermStillOffered() public {
        _rentFor(bob, tenant, 1 days);
        vm.prank(bob);
        vm.expectRevert(ImageBoardStorage.NotTenant.selector);
        board.extendRental(id, 1 days, RATE);

        vm.prank(alice);
        board.listForRent(id, 0, 0);
        vm.prank(tenant);
        vm.expectRevert(ImageBoardStorage.NotForRent.selector);
        board.extendRental(id, 1 days, RATE);

        vm.warp(block.timestamp + 1 days);
        vm.prank(tenant);
        vm.expectRevert(ImageBoardStorage.RentalExpired.selector);
        board.extendRental(id, 1 days, RATE);
    }

    // ---------------------------------------------------------------------
    // A change of owner
    // ---------------------------------------------------------------------

    function test_aGiftCreditsTheOldOwnerWhatStreamedAndTheTenancySurvives() public {
        _rentFor(bob, tenant, 4 days);
        vm.prank(tenant);
        board.editRented(id, keccak256("tenant"));
        uint256 prepaid = board.rentalOf(id).prepaid;
        vm.warp(block.timestamp + 1 days);

        vm.prank(alice);
        board.transferFrom(alice, carol, id);
        assertEq(board.pendingWithdrawals(alice), (prepaid * 1 days) / 4 days, "earned by alice while she owned it");
        (uint192 rate,) = board.rentListing(id);
        assertEq(rate, 0, "the offer was alice's");
        assertEq(board.shownHash(id), keccak256("tenant"), "the tenant keeps their term");

        vm.warp(block.timestamp + 3 days);
        board.claimRent(_ids(id));
        assertEq(board.pendingWithdrawals(carol), prepaid - (prepaid * 1 days) / 4 days, "the rest is carol's");
    }

    function test_aResaleCreditsTheSellerWhatStreamed() public {
        _rentFor(bob, tenant, 2 days);
        uint256 prepaid = board.rentalOf(id).prepaid;
        vm.warp(block.timestamp + 1 days);
        // A rental ended the earlier listing; this one is put up during the term.
        vm.prank(alice);
        board.listBlock(id, 7_000_000);
        uint256 before = board.pendingWithdrawals(alice);
        vm.prank(bob);
        board.buyListedBlock(id, bob, 7_000_000);
        (,, uint256 toOwner) = board.resaleSplit(7_000_000);
        assertEq(board.pendingWithdrawals(alice) - before, toOwner + (prepaid * 1 days) / 2 days);
        assertEq(board.rentalOf(id).tenant, tenant);
    }

    // ---------------------------------------------------------------------
    // A take of a rented block
    // ---------------------------------------------------------------------

    function test_aTakeRefundsTheTenantForTheCellsTakenAndTheRestStreamsOn() public {
        _rentFor(bob, tenant, 10 days);
        vm.prank(tenant);
        board.editRented(id, keccak256("tenant"));
        uint256 prepaid = board.rentalOf(id).prepaid;
        uint256 expiry = board.rentalOf(id).expiry;
        vm.warp(block.timestamp + 2 days);

        uint256 owner0 = board.pendingWithdrawals(alice);
        _buy(bob, bob, 0, 0, 4, 2); // 8 of the block's 20 cells

        uint256 streamed = (prepaid * 2 days) / 10 days;
        uint256 unstreamed = prepaid - streamed;
        uint256 refund = (unstreamed * 8) / 20;
        assertEq(board.pendingWithdrawals(tenant), refund, "the tenant is refunded for the cells lost");
        assertGe(
            board.pendingWithdrawals(alice) - owner0,
            streamed,
            "the owner keeps what streamed (and the take's payout)"
        );

        ImageBoardStorage.Rental memory t = board.rentalOf(id);
        assertEq(t.prepaid, unstreamed - refund, "the rest streams on");
        assertEq(t.start, block.timestamp);
        assertEq(t.expiry, expiry, "to the same end");
        assertEq(t.claimed, 0);
        assertEq(board.shownHash(id), keccak256("tenant"), "on the cells left");
        (uint192 rate,) = board.rentListing(id);
        assertEq(rate, 0, "the offer was for a bigger block");

        uint256 owner1 = board.pendingWithdrawals(alice);
        vm.warp(expiry);
        board.claimRent(_ids(id));
        assertEq(board.pendingWithdrawals(alice) - owner1, unstreamed - refund, "the rest streamed to the end");
    }

    function test_aTakeOfEveryCellRefundsTheWholeRemainder() public {
        _rentFor(bob, tenant, 10 days);
        uint256 prepaid = board.rentalOf(id).prepaid;
        vm.warp(block.timestamp + 5 days);
        _buy(bob, bob, 0, 0, 4, 5);
        assertEq(board.pendingWithdrawals(tenant), prepaid - (prepaid * 5 days) / 10 days);
        assertEq(board.rentalOf(id).prepaid, 0);
    }

    /// A take ends a rent offer whether or not the block is rented: the rate was for a bigger block.
    function test_aTakeEndsTheRentOfferOfAnUnrentedBlock() public {
        vm.warp(block.timestamp + 1 days);
        _buy(bob, bob, 0, 0, 1, 1);
        (uint192 rate,) = board.rentListing(id);
        assertEq(rate, 0);
        // And touches no tenancy it does not have.
        ImageBoardStorage.Rental memory t = board.rentalOf(id);
        assertEq(t.start, 0);
        assertEq(t.expiry, 0);
    }

    function test_aTakeAfterTheTermRefundsNothing() public {
        _rentFor(bob, tenant, 1 days);
        uint256 prepaid = board.rentalOf(id).prepaid;
        vm.warp(block.timestamp + 2 days);
        uint256 owner0 = board.pendingWithdrawals(alice);
        _buy(bob, bob, 0, 0, 4, 2);
        assertEq(board.pendingWithdrawals(tenant), 0);
        board.claimRent(_ids(id));
        assertGe(board.pendingWithdrawals(alice) - owner0, prepaid, "the lapsed term streamed whole to the owner");
    }

    // ---------------------------------------------------------------------
    // The money adds up
    // ---------------------------------------------------------------------

    /// Everything the board holds is either owed to someone or still streaming.
    function test_theBoardHoldsExactlyWhatIsOwedAndWhatIsUnstreamed() public {
        _rentFor(bob, tenant, 10 days);
        vm.warp(block.timestamp + 3 days);
        _buy(bob, bob, 0, 0, 2, 2);
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        board.transferFrom(alice, carol, id);
        address[6] memory who = [alice, bob, carol, tenant, seller, protocol];
        uint256 owed;
        for (uint256 i = 0; i < who.length; i++) {
            owed += board.pendingWithdrawals(who[i]);
        }
        ImageBoardStorage.Rental memory t = board.rentalOf(id);
        assertEq(usd.balanceOf(address(board)), owed + t.prepaid - t.claimed);
    }

    // ---------------------------------------------------------------------

    function _ids(uint256 one) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = one;
    }
}
