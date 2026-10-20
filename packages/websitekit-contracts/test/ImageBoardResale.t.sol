// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ImageBoard } from "../src/ImageBoard.sol";
import { ImageBoardReads } from "./ImageBoardReads.sol";
import { ImageBoardCollection } from "../src/ImageBoardCollection.sol";
import { ImageBoardBase } from "./ImageBoardBase.t.sol";


using ImageBoardReads for ImageBoard;
/// @notice Reselling a block, whole, inside the board (`docs/IMAGE-BOARD-SPEC.md` §7a, decided
/// 2026-10-11): each rule at its boundary. The money and ownership properties are also in the
/// invariant suite; this file pins the edges.
///
/// The listed price does not divide evenly by 20, so the 500 bps cut and the 500 bps royalty both
/// round on it: a split tested at round figures cannot tell floor from round from ceil.
contract ImageBoardResaleTest is ImageBoardBase {
    uint256 internal constant PRICE = 1_000_003;

    address internal carol = makeAddr("carol");
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        usd.mint(carol, 1_000_000 * 1e6);
        vm.prank(carol);
        usd.approve(address(board), type(uint256).max);
        // Alice pays, Bob owns.
        id = _buy(alice, bob, 2, 3, 4, 2);
    }

    function _list(uint256 price) internal {
        vm.prank(bob);
        board.listBlock(id, price);
    }

    // ---------------------------------------------------------------------
    // Listing
    // ---------------------------------------------------------------------

    function test_theOwnerListsAndCanChangeThePrice() public {
        vm.expectEmit(address(board));
        emit ImageBoard.BlockListed(id, bob, PRICE);
        _list(PRICE);
        assertEq(board.listPrice(id), PRICE);
        _list(PRICE + 1);
        assertEq(board.listPrice(id), PRICE + 1);
    }

    /// Nobody but the block's owner — not the payer who bought it for them, not the board's holder,
    /// not the block's editor — can put it up for sale.
    function test_onlyTheOwnerLists() public {
        vm.prank(bob);
        board.setEditor(id, carol);
        address[4] memory others = [alice, seller, carol, relayer];
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(ImageBoard.NotBlockOwner.selector);
            board.listBlock(id, PRICE);
        }
        assertEq(board.listPrice(id), 0);
    }

    function test_anUnsoldBlockCannotBeListed() public {
        vm.prank(bob);
        vm.expectRevert(ImageBoard.NotBlockOwner.selector);
        board.listBlock(id + 1, PRICE);
    }

    /// Zero is "not listed", so it cannot be a price.
    function test_aZeroPriceIsRefused() public {
        vm.prank(bob);
        vm.expectRevert(ImageBoard.InvalidPrice.selector);
        board.listBlock(id, 0);
    }

    function test_theOwnerDelists() public {
        _list(PRICE);
        vm.expectEmit(address(board));
        emit ImageBoard.BlockDelisted(id, bob);
        vm.prank(bob);
        board.delistBlock(id);
        assertEq(board.listPrice(id), 0);

        vm.prank(carol);
        vm.expectRevert(ImageBoard.NotListed.selector);
        board.buyListedBlock(id, carol, PRICE);
    }

    function test_onlyTheOwnerDelistsAndOnlyWhatIsListed() public {
        vm.prank(bob);
        vm.expectRevert(ImageBoard.NotListed.selector);
        board.delistBlock(id);

        _list(PRICE);
        vm.prank(seller);
        vm.expectRevert(ImageBoard.NotBlockOwner.selector);
        board.delistBlock(id);
        assertEq(board.listPrice(id), PRICE);
    }

    // ---------------------------------------------------------------------
    // Buying a listed block
    // ---------------------------------------------------------------------

    /// The whole of a resale's money, measured across the call: the payer pays the price, the board
    /// holds it, and the three credits add up to it exactly.
    function test_aResaleMovesTheBlockAndSplitsThePrice() public {
        _list(PRICE);
        (uint256 cut, uint256 royalty, uint256 toOwner) = board.resaleSplit(PRICE);
        assertEq(cut, 50_000); // 1,000,003 × 500 / 10,000 = 50,000.15, floored
        assertEq(royalty, 50_000);
        assertEq(toOwner, 900_003);

        uint256 payerBefore = usd.balanceOf(carol);
        uint256 boardBefore = usd.balanceOf(address(board));
        uint256 ownerOwed = board.pendingWithdrawals(bob);
        uint256 holderOwed = board.pendingWithdrawals(seller);
        uint256 protocolOwed = board.pendingWithdrawals(protocol);

        vm.expectEmit(address(board));
        emit ImageBoard.BlockTransferred(id, bob, alice);
        vm.expectEmit(address(board));
        emit ImageBoard.BlockResold(id, carol, alice, bob, PRICE, cut, royalty, seller);
        vm.prank(carol);
        board.buyListedBlock(id, alice, PRICE);

        assertEq(board.ownerOf(id), alice, "the block goes to the recipient, not the payer");
        assertEq(payerBefore - usd.balanceOf(carol), PRICE);
        assertEq(usd.balanceOf(address(board)) - boardBefore, PRICE);
        assertEq(board.pendingWithdrawals(bob) - ownerOwed, toOwner);
        assertEq(board.pendingWithdrawals(seller) - holderOwed, royalty);
        assertEq(board.pendingWithdrawals(protocol) - protocolOwed, cut);
    }

    /// The royalty follows the board's NFT, as a first sale's proceeds do.
    function test_theRoyaltyGoesToWhoeverHoldsTheBoardAtTheResale() public {
        _list(PRICE);
        uint256 tokenId = board.boardTokenId();
        vm.prank(seller);
        collection.transferFrom(seller, relayer, tokenId);
        uint256 sellerOwed = board.pendingWithdrawals(seller);

        vm.prank(carol);
        board.buyListedBlock(id, carol, PRICE);

        (, uint256 royalty,) = board.resaleSplit(PRICE);
        assertEq(board.pendingWithdrawals(relayer), royalty);
        assertEq(board.pendingWithdrawals(seller), sellerOwed, "the earlier holder gains nothing");
    }

    /// A block owner who also holds the board is credited both shares.
    function test_anOwnerWhoHoldsTheBoardIsCreditedBothShares() public {
        uint256 own = _buy(alice, seller, 10, 10, 1, 1);
        vm.prank(seller);
        board.listBlock(own, PRICE);
        uint256 before = board.pendingWithdrawals(seller);
        vm.prank(carol);
        board.buyListedBlock(own, carol, PRICE);
        (, uint256 royalty, uint256 toOwner) = board.resaleSplit(PRICE);
        assertEq(board.pendingWithdrawals(seller) - before, royalty + toOwner);
    }

    /// The owner can change the price while a buy is on its way; the buy names the price it agreed
    /// to and refuses any other, higher or lower.
    function test_aBuyAtAPriceThatChangedIsRefused() public {
        _list(PRICE);
        vm.prank(carol);
        vm.expectRevert(ImageBoard.PriceChanged.selector);
        board.buyListedBlock(id, carol, PRICE - 1);

        vm.prank(carol);
        vm.expectRevert(ImageBoard.PriceChanged.selector);
        board.buyListedBlock(id, carol, PRICE + 1);
    }

    function test_aBlockNotListedCannotBeBought() public {
        vm.prank(carol);
        vm.expectRevert(ImageBoard.NotListed.selector);
        board.buyListedBlock(id, carol, PRICE);
        // An id never sold has no owner and no listing.
        vm.prank(carol);
        vm.expectRevert(ImageBoard.NotListed.selector);
        board.buyListedBlock(id + 1, carol, PRICE);
    }

    function test_aZeroRecipientIsRefused() public {
        _list(PRICE);
        vm.prank(carol);
        vm.expectRevert(ImageBoard.ZeroAddress.selector);
        board.buyListedBlock(id, address(0), PRICE);
    }

    function test_aRefusedResaleChangesNothing() public {
        _list(PRICE);
        uint256 boardBefore = usd.balanceOf(address(board));
        address broke = makeAddr("broke");
        vm.prank(broke);
        vm.expectRevert();
        board.buyListedBlock(id, broke, PRICE);

        assertEq(board.ownerOf(id), bob);
        assertEq(board.listPrice(id), PRICE);
        assertEq(usd.balanceOf(address(board)), boardBefore);
        assertEq(board.pendingWithdrawals(bob), 0);
    }

    // ---------------------------------------------------------------------
    // What a change of owner ends
    // ---------------------------------------------------------------------

    function test_aSaleEndsTheListing() public {
        _list(PRICE);
        vm.prank(carol);
        board.buyListedBlock(id, carol, PRICE);
        assertEq(board.listPrice(id), 0);

        vm.prank(alice);
        vm.expectRevert(ImageBoard.NotListed.selector);
        board.buyListedBlock(id, alice, PRICE);
    }

    /// A gift ends the listing too — and handing it back does not revive it: a listing names the
    /// price its CURRENT owner set, never one an earlier owner did.
    function test_aGiftEndsTheListingAndHandingItBackDoesNotReviveIt() public {
        _list(PRICE);
        vm.prank(bob);
        board.transferBlock(id, carol);
        assertEq(board.listPrice(id), 0);

        vm.prank(carol);
        board.transferBlock(id, bob);
        assertEq(board.listPrice(id), 0);

        vm.prank(alice);
        vm.expectRevert(ImageBoard.NotListed.selector);
        board.buyListedBlock(id, alice, PRICE);
    }

    function test_aSaleEndsTheOldOwnersEditorGrant() public {
        vm.prank(bob);
        board.setEditor(id, relayer);
        _list(PRICE);
        vm.prank(carol);
        board.buyListedBlock(id, carol, PRICE);
        assertEq(board.editorOf(id), address(0));
        assertFalse(board.canEdit(id, relayer));
        assertTrue(board.canEdit(id, carol));
    }

    /// The new owner owns it fully: they can list it again, at their own price.
    function test_theNewOwnerCanListItAgain() public {
        _list(PRICE);
        vm.prank(carol);
        board.buyListedBlock(id, carol, PRICE);
        vm.prank(carol);
        board.listBlock(id, PRICE * 2);
        vm.prank(alice);
        board.buyListedBlock(id, alice, PRICE * 2);
        assertEq(board.ownerOf(id), alice);
    }

    /// A resale changes who owns the block and nothing about the block: its cells, its shape, its
    /// picture and the board's count are as they were.
    function test_aResaleLeavesTheBlockAndItsPictureAsTheyWere() public {
        vm.prank(bob);
        board.edit(id, keccak256("bob's picture"));
        ImageBoard.Block memory before = board.blockOf(id);
        uint256 rowBefore = board.rowBits(3);
        uint256 countBefore = board.blockCount();

        _list(PRICE);
        vm.prank(carol);
        board.buyListedBlock(id, carol, PRICE);

        ImageBoard.Block memory afterSale = board.blockOf(id);
        assertEq(afterSale.contentHash, before.contentHash);
        assertEq(afterSale.version, before.version);
        assertEq(afterSale.col, before.col);
        assertEq(afterSale.cols, before.cols);
        assertEq(board.rowBits(3), rowBefore);
        assertEq(board.blockCount(), countBefore);
    }

    // ---------------------------------------------------------------------
    // Permit, and the split at its edges
    // ---------------------------------------------------------------------

    function test_aPermitResaleNeedsNoPriorApproval() public {
        _list(PRICE);
        uint256 pk = 0xCA401;
        address buyer = vm.addr(pk);
        usd.mint(buyer, PRICE);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, address(board), PRICE, deadline);
        vm.prank(buyer);
        board.buyListedBlockWithPermit(id, buyer, PRICE, deadline, v, r, s);
        assertEq(board.ownerOf(id), buyer);
        assertEq(usd.balanceOf(buyer), 0);
    }

    /// Someone who replays the permit first cannot make the resale revert.
    function test_aFrontRunPermitDoesNotBlockTheResale() public {
        _list(PRICE);
        uint256 pk = 0xCA402;
        address buyer = vm.addr(pk);
        usd.mint(buyer, PRICE);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, address(board), PRICE, deadline);
        usd.permit(buyer, address(board), PRICE, deadline, v, r, s);
        vm.prank(buyer);
        board.buyListedBlockWithPermit(id, buyer, PRICE, deadline, v, r, s);
        assertEq(board.ownerOf(id), buyer);
    }

    /// Both shares round down, so the owner's remainder makes the three sum to the price — at the
    /// prices where a share is zero, and at the first where it is not.
    function test_theSplitAlwaysSumsToThePrice() public view {
        uint256[5] memory prices = [uint256(1), 19, 20, 39, 40];
        uint256[5] memory shares = [uint256(0), 0, 1, 1, 2];
        for (uint256 i = 0; i < prices.length; i++) {
            (uint256 cut, uint256 royalty, uint256 toOwner) = board.resaleSplit(prices[i]);
            assertEq(cut, shares[i]);
            assertEq(royalty, shares[i]);
            assertEq(cut + royalty + toOwner, prices[i]);
        }
    }

    /// Every other test runs at a 500 bps protocol cut, which is also the royalty — where a split
    /// that used one rate for both would pass. A 300 bps implementation tells them apart.
    function test_theCutAndTheRoyaltyAreDifferentRates() public {
        ImageBoard impl = new ImageBoard(300, protocol);
        address[] memory tokens = new address[](1);
        tokens[0] = address(usd);
        ImageBoardCollection c = new ImageBoardCollection("Test Image Boards", "TIMG", address(this), address(impl), tokens, "");
        (address b,) = c.createBoardFor(seller, abi.encode(_config(300, 300, 10)));
        (uint256 cut, uint256 royalty, uint256 toOwner) = ImageBoard(b).resaleSplit(PRICE);
        assertEq(cut, 30_000); // 1,000,003 × 300 / 10,000 = 30,000.09
        assertEq(royalty, 50_000);
        assertEq(toOwner, PRICE - 80_000);
    }

    /// The protocol's cut and the royalty come out of one price, so together they cannot exceed it.
    function test_anImplementationWhoseCutLeavesNoRoomForTheRoyaltyIsRefused() public {
        vm.expectRevert(ImageBoard.InvalidConfig.selector);
        new ImageBoard(9_501, protocol);
        new ImageBoard(9_500, protocol);
    }
}
