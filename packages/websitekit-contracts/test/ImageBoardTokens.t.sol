// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Base64 } from "solady/utils/Base64.sol";
import { LibString } from "solady/utils/LibString.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { IERC721Metadata } from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import { IERC2981 } from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import { ImageBoard, IERC5646 } from "../src/ImageBoard.sol";
import { ImageBoardStorage } from "../src/ImageBoardStorage.sol";
import { ImageBoardExtension } from "../src/ImageBoardExtension.sol";
import { ImageBoardRenderer } from "../src/ImageBoardRenderer.sol";
import { ImageBoardReads } from "./ImageBoardReads.sol";
import { ImageBoardBase } from "./ImageBoardBase.t.sol";

using ImageBoardReads for ImageBoard;

/// ERC-4907, declared so its interface id is computed here, never copied from the source under test.
interface IERC4907 {
    function setUser(uint256 tokenId, address user, uint64 expires) external;
    function userOf(uint256 tokenId) external view returns (address);
    function userExpires(uint256 tokenId) external view returns (uint256);
}

/// ERC-173 — which the board must NOT claim: it has `owner()` but no `transferOwnership`.
interface IERC173 {
    function owner() external view returns (address);
    function transferOwnership(address newOwner) external;
}

contract Receiver {
    bytes4 public answer;
    bytes public lastData;
    address public lastOperator;

    constructor(bytes4 answer_) {
        answer = answer_;
    }

    function onERC721Received(address operator, address, uint256, bytes calldata data) external returns (bytes4) {
        lastOperator = operator;
        lastData = data;
        return answer;
    }
}

contract NoHook { }

/// @notice The token generation (`IMAGE-BOARD-SPEC.md` §13, 2026-10-21): every block an ERC-721 in its
/// board's own collection, the standards around it, `poke` and the change counter, and the metadata
/// the renderer builds — parsed as JSON, never compared as a string, so escaping is checked by a
/// reader rather than by the writer's own idea of it. CIDs are checked against values computed
/// outside Solidity (Python's `base64.b32encode`), an independent encoder.
contract ImageBoardTokensTest is ImageBoardBase {
    uint256 internal constant HOUR = 3_600;
    uint256 internal constant RATE = 1_000_003;

    address internal carol = makeAddr("carol");
    address internal tenant = makeAddr("tenant");

    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event Approval(address indexed owner, address indexed approved, uint256 indexed id);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event UpdateUser(uint256 indexed tokenId, address indexed user, uint64 expires);
    event MetadataUpdate(uint256 _tokenId);

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _offer(uint256 id, address owner_) internal {
        vm.prank(owner_);
        board.listForRent(id, RATE, 30 days);
    }

    function _rent(uint256 id, address payer, address user, uint64 duration) internal {
        vm.prank(payer);
        board.rent(id, user, duration, RATE);
    }

    function _json(string memory uri) internal pure returns (string memory) {
        bytes memory u = bytes(uri);
        bytes memory prefix = "data:application/json;base64,";
        for (uint256 i = 0; i < prefix.length; i++) {
            require(u[i] == prefix[i], "not a base64 JSON data URI");
        }
        bytes memory rest = new bytes(u.length - prefix.length);
        for (uint256 i = 0; i < rest.length; i++) {
            rest[i] = u[prefix.length + i];
        }
        return string(Base64.decode(string(rest)));
    }

    function _trait(string memory json, string memory name_) internal view returns (uint256) {
        (bool found, uint256 i) = _traitAt(json, name_);
        require(found, string.concat("no trait ", name_));
        return vm.parseJsonUint(json, string.concat(".attributes[", vm.toString(i), "].value"));
    }

    function _hasTrait(string memory json, string memory name_) internal view returns (bool found) {
        (found,) = _traitAt(json, name_);
    }

    function _traitAt(string memory json, string memory name_) internal view returns (bool, uint256) {
        for (uint256 i = 0; vm.keyExistsJson(json, string.concat(".attributes[", vm.toString(i), "]")); i++) {
            string memory t = vm.parseJsonString(json, string.concat(".attributes[", vm.toString(i), "].trait_type"));
            if (keccak256(bytes(t)) == keccak256(bytes(name_))) return (true, i);
        }
        return (false, 0);
    }

    // ---------------------------------------------------------------------
    // Minting and balances
    // ---------------------------------------------------------------------

    function test_aBuyMintsEachBlockToTheRecipient() public {
        vm.expectEmit(address(board));
        emit Transfer(address(0), bob, 1);
        _buy(alice, bob, 0, 0, 1, 1);
        assertEq(board.ownerOf(1), bob);
        assertEq(board.balanceOf(bob), 1);
        assertEq(board.balanceOf(alice), 0, "the payer is not the owner");

        ImageBoardStorage.Rect[] memory two = new ImageBoardStorage.Rect[](2);
        two[0] = ImageBoardStorage.Rect(2, 0, 1, 1);
        two[1] = ImageBoardStorage.Rect(4, 0, 2, 2);
        vm.prank(alice);
        board.buyBlocks(bob, two, type(uint256).max, block.timestamp);
        assertEq(board.balanceOf(bob), 3);
    }

    /// A take mints the taker a new token and moves none: the covered block stays its owner's.
    function test_aTakeMintsANewTokenAndMovesNone() public {
        uint256 a = _buy(alice, alice, 0, 0, 2, 2);
        vm.warp(block.timestamp + HOUR);
        uint256 b = _buy(bob, bob, 1, 1, 2, 2);
        assertEq(board.ownerOf(a), alice);
        assertEq(board.ownerOf(b), bob);
        assertEq(board.balanceOf(alice), 1);
        assertEq(board.balanceOf(bob), 1);
    }

    /// No receiver hook on a buy: a contract that refuses tokens still receives a bought block.
    function test_aBuyToAContractAsksItNothing() public {
        Receiver refuses = new Receiver(bytes4(0xdeadbeef));
        uint256 id = _buy(alice, address(refuses), 0, 0, 1, 1);
        assertEq(board.ownerOf(id), address(refuses));
        assertEq(refuses.lastOperator(), address(0), "it was asked");
    }

    function test_theZeroAddressHasNoBalance() public {
        vm.expectRevert(ImageBoardStorage.ZeroAddress.selector);
        board.balanceOf(address(0));
    }

    // ---------------------------------------------------------------------
    // Approvals
    // ---------------------------------------------------------------------

    function test_anApprovedAddressMovesTheBlockOnce() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        vm.expectEmit(address(board));
        emit Approval(alice, carol, id);
        vm.prank(alice);
        board.approve(carol, id);
        assertEq(board.getApproved(id), carol);

        vm.prank(carol);
        board.transferFrom(alice, bob, id);
        assertEq(board.ownerOf(id), bob);
        assertEq(board.getApproved(id), address(0), "an approval dies with the change of owner");
        vm.prank(carol);
        vm.expectRevert(ImageBoardStorage.NotAuthorized.selector);
        board.transferFrom(bob, carol, id);
    }

    function test_anOperatorMovesAndApprovesEveryBlockOfItsOwner() public {
        uint256 a = _buy(alice, alice, 0, 0, 1, 1);
        uint256 b = _buy(alice, alice, 1, 0, 1, 1);
        vm.expectEmit(address(board));
        emit ApprovalForAll(alice, carol, true);
        vm.prank(alice);
        board.setApprovalForAll(carol, true);
        assertTrue(board.isApprovedForAll(alice, carol));

        vm.prank(carol);
        board.transferFrom(alice, bob, a);
        vm.prank(carol);
        board.approve(tenant, b);
        vm.prank(tenant);
        board.transferFrom(alice, bob, b);
        assertEq(board.balanceOf(bob), 2);

        vm.prank(alice);
        board.setApprovalForAll(carol, false);
        assertFalse(board.isApprovedForAll(alice, carol));
    }

    function test_onlyTheOwnerOrAnOperatorApproves() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        vm.prank(bob);
        vm.expectRevert(ImageBoardStorage.NotAuthorized.selector);
        board.approve(bob, id);
        // Not the board's holder either.
        vm.prank(seller);
        vm.expectRevert(ImageBoardStorage.NotAuthorized.selector);
        board.approve(seller, id);
    }

    function test_getApprovedOfAnUnsoldBlockReverts() public {
        vm.expectRevert(ImageBoardStorage.NoSuchBlock.selector);
        board.getApproved(1);
    }

    /// An approval moves a block and nothing else.
    function test_anApprovalGrantsNothingButTheMove() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        vm.startPrank(alice);
        board.approve(carol, id);
        board.setApprovalForAll(carol, true);
        vm.stopPrank();

        vm.startPrank(carol);
        vm.expectRevert(ImageBoardStorage.NotBlockEditor.selector);
        board.edit(id, keccak256("x"));
        vm.expectRevert(ImageBoardStorage.NotBlockOwner.selector);
        board.setEditor(id, carol);
        vm.expectRevert(ImageBoardStorage.NotBlockOwner.selector);
        board.listBlock(id, 1_000_000);
        vm.expectRevert(ImageBoardStorage.NotBlockOwner.selector);
        board.listForRent(id, RATE, 1 days);
        vm.stopPrank();
    }

    /// A resale changes the owner too, so it ends an approval as a transfer does.
    function test_aResaleEndsTheApproval() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        vm.startPrank(alice);
        board.approve(carol, id);
        board.listBlock(id, 1_000_000);
        vm.stopPrank();
        vm.prank(bob);
        board.buyListedBlock(id, bob, 1_000_000);
        assertEq(board.getApproved(id), address(0));
        assertEq(board.balanceOf(alice), 0);
        assertEq(board.balanceOf(bob), 1);
    }

    /// A transfer to oneself is allowed by the standard, and is a change of owner like any other.
    function test_aTransferToSelfEndsTheListingAndTheGrant() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        vm.startPrank(alice);
        board.listBlock(id, 1_000_000);
        board.setEditor(id, carol);
        board.transferFrom(alice, alice, id);
        vm.stopPrank();
        assertEq(board.listPrice(id), 0);
        assertEq(board.editorOf(id), address(0));
        assertEq(board.balanceOf(alice), 1);
    }

    // ---------------------------------------------------------------------
    // safeTransferFrom
    // ---------------------------------------------------------------------

    function test_aSafeTransferAsksAContractAndUndoesOnARefusal() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        Receiver takes = new Receiver(Receiver.onERC721Received.selector);
        vm.prank(alice);
        board.safeTransferFrom(alice, address(takes), id, "hi");
        assertEq(board.ownerOf(id), address(takes));
        assertEq(takes.lastData(), "hi");
        assertEq(takes.lastOperator(), alice);

        uint256 other = _buy(alice, alice, 1, 0, 1, 1);
        Receiver refuses = new Receiver(bytes4(0xdeadbeef));
        vm.prank(alice);
        vm.expectRevert(ImageBoardStorage.UnsafeRecipient.selector);
        board.safeTransferFrom(alice, address(refuses), other);
        assertEq(board.ownerOf(other), alice, "a refusal undoes the move");

        NoHook none = new NoHook();
        vm.prank(alice);
        vm.expectRevert();
        board.safeTransferFrom(alice, address(none), other);

        vm.prank(alice);
        board.safeTransferFrom(alice, bob, other);
        assertEq(board.ownerOf(other), bob, "an account is not asked");
    }

    // ---------------------------------------------------------------------
    // Rent across a transfer by an operator
    // ---------------------------------------------------------------------

    /// An operator's transfer settles the tenancy exactly as the owner's gift does: what streamed
    /// while alice owned it is hers, measured across the call.
    function test_anOperatorsTransferSettlesRentAsAGiftDoes() public {
        uint256 id = _buy(alice, alice, 0, 0, 2, 2);
        _offer(id, alice);
        _rent(id, bob, tenant, 4 days);
        uint256 prepaid = board.rentalOf(id).prepaid;
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        board.setApprovalForAll(carol, true);

        uint256 before = board.pendingWithdrawals(alice);
        vm.prank(carol);
        board.transferFrom(alice, bob, id);
        assertEq(board.pendingWithdrawals(alice) - before, (prepaid * 1 days) / 4 days);
        (uint192 rate,) = board.rentListing(id);
        assertEq(rate, 0, "the offer was alice's");
        assertEq(board.userOf(id), tenant, "the tenancy survives");
    }

    // ---------------------------------------------------------------------
    // The collection's face: name, symbol, owner, royalty, interfaces
    // ---------------------------------------------------------------------

    function test_theCollectionIsNamedForTheBoardAndItsSymbolIsTheCollectionsWithItsToken() public view {
        assertEq(board.name(), "Test board");
        assertEq(board.symbol(), "TIMG-1");
    }

    /// `owner()` is whoever holds the board's NFT, and follows it.
    function test_theOwnerIsTheBoardsHolder() public {
        assertEq(board.owner(), seller);
        vm.prank(seller);
        collection.transferFrom(seller, carol, 1);
        assertEq(board.owner(), carol);
    }

    function test_theRoyaltyIsTheResaleRoyaltyToTheBoardsHolderNow() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        (address to, uint256 amount) = board.royaltyInfo(id, 1_000_003);
        assertEq(to, seller);
        assertEq(amount, 50_000);
        vm.prank(seller);
        collection.transferFrom(seller, carol, 1);
        (to,) = board.royaltyInfo(id, 1_000_003);
        assertEq(to, carol);
    }

    function test_theInterfacesAnsweredAreTheOnesImplemented() public view {
        assertTrue(board.supportsInterface(type(IERC165).interfaceId), "ERC-165");
        assertTrue(board.supportsInterface(type(IERC721).interfaceId), "ERC-721");
        assertTrue(board.supportsInterface(type(IERC721Metadata).interfaceId), "metadata");
        assertTrue(board.supportsInterface(type(IERC2981).interfaceId), "ERC-2981");
        assertTrue(board.supportsInterface(type(IERC4907).interfaceId), "ERC-4907");
        assertTrue(board.supportsInterface(0x49064906), "ERC-4906");
        assertTrue(board.supportsInterface(type(IERC5646).interfaceId), "ERC-5646");
        assertFalse(board.supportsInterface(type(IERC173).interfaceId), "ERC-173 has no transferOwnership here");
        assertFalse(board.supportsInterface(0xffffffff));
    }

    // ---------------------------------------------------------------------
    // ERC-4907
    // ---------------------------------------------------------------------

    function test_theTenantIsTheUserWhileTheTermLastsAndSurvivesATransfer() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        _offer(id, alice);
        uint256 expires = block.timestamp + 2 days;
        vm.expectEmit(address(board));
        emit UpdateUser(id, tenant, uint64(expires));
        _rent(id, bob, tenant, 2 days);
        assertEq(board.userOf(id), tenant);
        assertEq(board.userExpires(id), expires);

        vm.prank(alice);
        board.transferFrom(alice, carol, id);
        assertEq(board.userOf(id), tenant, "unlike ERC-4907's reference, a transfer keeps the user");

        _offer(id, carol);
        usd.mint(tenant, 1e12);
        vm.prank(tenant);
        usd.approve(address(board), type(uint256).max);
        vm.expectEmit(address(board));
        emit UpdateUser(id, tenant, uint64(block.timestamp + 3 days));
        vm.prank(tenant);
        board.extendRental(id, 3 days, RATE);

        vm.warp(block.timestamp + 3 days);
        assertEq(board.userOf(id), address(0), "a lapsed term has no user");
    }

    function test_aUserIsMadeOnlyByAPaidTerm() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        vm.prank(alice);
        vm.expectRevert(ImageBoardStorage.NotAuthorized.selector);
        board.setUser(id, tenant, uint64(block.timestamp + 1 days));
    }

    // ---------------------------------------------------------------------
    // ERC-5646
    // ---------------------------------------------------------------------

    function test_theFingerprintMovesWithEveryChangeAnOrderShouldSee() public {
        uint256 id = _buy(alice, alice, 0, 0, 2, 2);
        bytes32 f = board.getStateFingerprint(id);

        vm.warp(block.timestamp + HOUR);
        assertEq(board.getStateFingerprint(id), f, "time alone is not a change");

        vm.prank(alice);
        board.listBlock(id, 1_000_000);
        assertTrue(board.getStateFingerprint(id) != f, "a listing");
        f = board.getStateFingerprint(id);

        vm.prank(alice);
        board.edit(id, keccak256("picture"));
        assertTrue(board.getStateFingerprint(id) != f, "a picture");
        f = board.getStateFingerprint(id);

        _offer(id, alice);
        assertTrue(board.getStateFingerprint(id) != f, "a rent offer");
        f = board.getStateFingerprint(id);

        _rent(id, bob, tenant, 2 days);
        assertTrue(board.getStateFingerprint(id) != f, "a term");
        f = board.getStateFingerprint(id);

        _buy(bob, bob, 1, 1, 1, 1);
        assertTrue(board.getStateFingerprint(id) != f, "a take");

        // A take of a block with no offer, listing or term to end: only what it holds moves.
        uint256 plain = _buy(alice, alice, 6, 0, 2, 2);
        vm.warp(block.timestamp + HOUR);
        f = board.getStateFingerprint(plain);
        _buy(bob, bob, 6, 0, 1, 1);
        assertTrue(board.getStateFingerprint(plain) != f, "a take alone");
    }

    // ---------------------------------------------------------------------
    // The change counter, MetadataUpdate and poke
    // ---------------------------------------------------------------------

    function test_theCounterCountsWhatChangesTheDrawnBoardAndNothingElse() public {
        assertEq(board.changes(), 0);
        ImageBoardStorage.Rect[] memory two = new ImageBoardStorage.Rect[](2);
        two[0] = ImageBoardStorage.Rect(0, 0, 2, 2);
        two[1] = ImageBoardStorage.Rect(4, 0, 1, 1);
        vm.prank(alice);
        board.buyBlocks(alice, two, type(uint256).max, block.timestamp);
        assertEq(board.changes(), 1, "one buy, however many rectangles");

        vm.prank(alice);
        board.edit(1, keccak256("p"));
        assertEq(board.changes(), 2);

        vm.prank(alice);
        board.transferFrom(alice, bob, 2);
        vm.prank(seller);
        board.lowerPrices(9_000);
        vm.prank(bob);
        board.listBlock(2, 1_000_000);
        assertEq(board.changes(), 2, "a transfer, a price cut and a listing draw nothing new");

        vm.prank(alice);
        board.buyListedBlock(2, alice, 1_000_000);
        assertEq(board.changes(), 2, "nor does a resale");

        _offer(1, alice);
        _rent(1, bob, tenant, 1 days);
        assertEq(board.changes(), 2, "a term starting shows the owner's picture still");
        vm.prank(tenant);
        board.editRented(1, keccak256("t"));
        assertEq(board.changes(), 3);

        vm.warp(block.timestamp + HOUR);
        _buy(bob, bob, 1, 1, 1, 1);
        assertEq(board.changes(), 4, "a take");
    }

    function test_editsTermsAndTakesAnnounceTheBlocksTheyChange() public {
        uint256 a = _buy(alice, alice, 0, 0, 2, 1);
        uint256 b = _buy(alice, alice, 2, 0, 2, 1);

        vm.expectEmit(address(board));
        emit MetadataUpdate(a);
        vm.prank(alice);
        board.edit(a, keccak256("p"));

        _offer(a, alice);
        vm.expectEmit(address(board));
        emit MetadataUpdate(a);
        _rent(a, bob, tenant, 1 days);

        vm.warp(block.timestamp + HOUR);
        vm.expectEmit(address(board));
        emit MetadataUpdate(a);
        vm.expectEmit(address(board));
        emit MetadataUpdate(b);
        _buy(bob, bob, 1, 0, 2, 1);
    }

    function test_pokeAnnouncesALapsedTenantPictureOncePerTerm() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        _offer(id, alice);
        _rent(id, bob, tenant, 1 days);

        vm.expectRevert(ImageBoardStorage.NotLapsed.selector);
        board.poke(id);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(ImageBoardStorage.NotLapsed.selector);
        board.poke(id); // lapsed, but no tenant picture was ever showing

        _rent(id, bob, tenant, 1 days);
        vm.prank(tenant);
        board.editRented(id, keccak256("t"));
        vm.warp(block.timestamp + 1 days - 1);
        vm.expectRevert(ImageBoardStorage.NotLapsed.selector);
        board.poke(id);
        vm.warp(block.timestamp + 1);

        uint256 before = board.changes();
        vm.expectEmit(address(board));
        emit MetadataUpdate(id);
        vm.expectEmit(address(collection));
        emit MetadataUpdate(1);
        vm.prank(carol);
        board.poke(id);
        assertEq(board.changes(), before + 1);

        vm.expectRevert(ImageBoardStorage.NotLapsed.selector);
        board.poke(id);

        // A new term clears the mark: its own end can be announced.
        _rent(id, bob, tenant, 1 days);
        vm.prank(tenant);
        board.editRented(id, keccak256("t2"));
        vm.warp(block.timestamp + 1 days);
        board.poke(id);
    }

    function test_aNeverRentedBlockCannotBePoked() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        vm.expectRevert(ImageBoardStorage.NotLapsed.selector);
        board.poke(id);
    }

    // ---------------------------------------------------------------------
    // Metadata
    // ---------------------------------------------------------------------

    function test_anUnsoldBlockHasNoMetadata() public {
        vm.expectRevert(ImageBoardStorage.NoSuchBlock.selector);
        board.tokenURI(1);
    }

    function test_aBlocksMetadata() public {
        uint256 id = _buy(alice, alice, 3, 2, 4, 2);
        string memory json = _json(board.tokenURI(id));
        assertEq(vm.parseJsonString(json, ".name"), "Test board #1");
        assertFalse(vm.keyExistsJson(json, ".image"), "no picture yet");
        assertEq(
            vm.parseJsonString(json, ".animation_url"),
            string.concat("ipfs://bafyrendererpage/?chain=31337&board=", LibString.toHexStringChecksummed(address(board)), "&block=1")
        );
        assertEq(_trait(json, "Column"), 3);
        assertEq(_trait(json, "Row"), 2);
        assertEq(_trait(json, "Columns"), 4);
        assertEq(_trait(json, "Rows"), 2);
        assertEq(_trait(json, "Squares"), 8);
        assertEq(_trait(json, "Squares left"), 8);
        assertEq(_trait(json, "Cooldown ends"), block.timestamp + HOUR);
        assertEq(_trait(json, "Take price"), renderer.takePrice(address(board), id));
        assertFalse(_hasTrait(json, "Rented until"));

        // sha256("hello"), whose raw-block CID is well known.
        vm.prank(alice);
        board.edit(id, 0x2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824);
        json = _json(board.tokenURI(id));
        assertEq(vm.parseJsonString(json, ".image"), "ipfs://bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq");
    }

    /// During a term the block shows the tenant's picture, and says until when.
    function test_aRentedBlocksMetadataShowsTheTenantsPicture() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        vm.prank(alice);
        board.edit(id, 0x2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824);
        _offer(id, alice);
        _rent(id, bob, tenant, 1 days);
        vm.prank(tenant);
        board.editRented(id, SOURCE_HASH);
        string memory json = _json(board.tokenURI(id));
        assertEq(vm.parseJsonString(json, ".image"), "ipfs://bafkreih6j6dzkfug4yrzqsc32dn7yzcmflwdiz3stujzm2kihmqold6oum");
        assertEq(_trait(json, "Rented until"), block.timestamp + 1 days);

        vm.warp(block.timestamp + 1 days);
        json = _json(board.tokenURI(id));
        assertEq(vm.parseJsonString(json, ".image"), "ipfs://bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq", "the owner's again");
        assertFalse(_hasTrait(json, "Rented until"));
    }

    function test_theBoardTokensMetadata() public {
        _buy(alice, alice, 0, 0, 2, 2);
        string memory json = _json(collection.tokenURI(1));
        assertEq(vm.parseJsonString(json, ".name"), "Test board");
        assertFalse(vm.keyExistsJson(json, ".description"), "none was given");
        assertEq(vm.parseJsonString(json, ".image"), "https://example.com/i/boards/1?v=1");
        assertEq(
            vm.parseJsonString(json, ".animation_url"),
            string.concat("ipfs://bafyrendererpage/?chain=31337&board=", LibString.toHexStringChecksummed(address(board)))
        );
        assertEq(_trait(json, "Width"), 300);
        assertEq(_trait(json, "Height"), 671);
        assertEq(_trait(json, "Cell size"), 10);
        assertEq(_trait(json, "Squares"), 2010);
        assertEq(_trait(json, "Squares free"), 2006);
        assertEq(_trait(json, "Blocks"), 1);
    }

    function test_theBoardsCollectionMetadata() public {
        string memory json = _json(board.contractURI());
        assertEq(vm.parseJsonString(json, ".name"), "Test board");
        assertEq(vm.parseJsonString(json, ".image"), "ipfs://bafkreifbwlb5jzpwa4mcsosllrwx5d4qugzmhvhf6ydrqkj2jnog27upsa");

        ImageBoardStorage.Config memory cfg = _config(300, 300, 10);
        cfg.description = "A board with a description.";
        _use(_create(cfg));
        json = _json(board.contractURI());
        assertEq(vm.parseJsonString(json, ".description"), "A board with a description.");
    }

    /// A name is the creator's and may hold anything: a reader must get back exactly what was set.
    function test_anyNameSurvivesAsJson() public {
        ImageBoardStorage.Config memory cfg = _config(300, 300, 10);
        string memory awkward = string(abi.encodePacked('Quote " back \\ slash / new', bytes1(0x0a), "line tab", bytes1(0x09), "ctl", bytes1(0x01), " end"));
        cfg.name = awkward;
        cfg.description = awkward;
        _use(_create(cfg));
        _buy(alice, alice, 0, 0, 1, 1);
        assertEq(vm.parseJsonString(_json(board.tokenURI(1)), ".name"), string.concat(awkward, " #1"));
        assertEq(vm.parseJsonString(_json(board.contractURI()), ".description"), awkward);
        assertEq(vm.parseJsonString(_json(collection.tokenURI(board.boardTokenId())), ".name"), awkward);
    }

    function _use(ImageBoard b) internal {
        board = b;
        usd.mint(carol, 1_000_000 * 1e6);
        address[3] memory buyers = [alice, bob, carol];
        for (uint256 i = 0; i < buyers.length; i++) {
            vm.prank(buyers[i]);
            usd.approve(address(b), type(uint256).max);
        }
    }

    // ---------------------------------------------------------------------
    // Addresses
    // ---------------------------------------------------------------------

    /// Values from Python's `base64.b32encode`, lowercased and unpadded: an encoder that is not this one.
    function test_cidsMatchAnIndependentEncoder() public view {
        assertEq(renderer.cidOf(hex"01"), "bae");
        assertEq(renderer.cidOf(hex"0102"), "baeba");
        assertEq(renderer.cidOf(hex"0102030405"), "baebagbaf");
        assertEq(renderer.cidOf(SOURCE_CID), "bafkreifbwlb5jzpwa4mcsosllrwx5d4qugzmhvhf6ydrqkj2jnog27upsa");
        assertEq(renderer.rawCid(SOURCE_HASH), "bafkreih6j6dzkfug4yrzqsc32dn7yzcmflwdiz3stujzm2kihmqold6oum");
    }

    // ---------------------------------------------------------------------
    // The take price is what the board charges
    // ---------------------------------------------------------------------

    /// A block's take price is exactly what a buy of its squares pays for them — so a block holding
    /// its whole rectangle is priced like a buy of it, and after a take inside it, the two blocks'
    /// prices sum to a buy of the old rectangle. With zones, so a cell's own price matters.
    function test_theTakePriceIsWhatABuyPays() public {
        ImageBoardStorage.Config memory cfg = _config(300, 300, 10);
        cfg.zones = new ImageBoardStorage.Zone[](1);
        cfg.zones[0] = ImageBoardStorage.Zone({ col: 2, row: 0, cols: 3, rows: 3, cellPrice: 30_011 });
        _use(_create(cfg));
        uint256 a = _buy(alice, alice, 0, 0, 4, 3);
        vm.warp(block.timestamp + 3 weeks);
        assertEq(renderer.takePrice(address(board), a), board.quote(0, 0, 4, 3));

        uint256 b = _buy(bob, bob, 1, 1, 2, 2);
        vm.warp(block.timestamp + 2 weeks);
        assertEq(
            renderer.takePrice(address(board), a) + renderer.takePrice(address(board), b), board.quote(0, 0, 4, 3)
        );

        // A block with nothing left is priced at nothing.
        vm.warp(block.timestamp + HOUR);
        _buy(carol, carol, 1, 1, 2, 2);
        assertEq(renderer.takePrice(address(board), b), 0);
    }

    // ---------------------------------------------------------------------
    // The set-up's new fields
    // ---------------------------------------------------------------------

    function test_theNameDescriptionAndSourceAreChecked() public {
        ImageBoardStorage.Config memory cfg = _config(300, 300, 10);
        cfg.name = "";
        _refused(cfg);
        cfg.name = string(new bytes(101));
        _refused(cfg);
        cfg.name = string(new bytes(100));
        _create(cfg);

        cfg = _config(300, 300, 10);
        cfg.description = string(new bytes(1_001));
        _refused(cfg);
        cfg.description = string(new bytes(1_000));
        _create(cfg);

        cfg = _config(300, 300, 10);
        cfg.sourceCid = "";
        _refused(cfg);
        cfg.sourceCid = hex"0055";
        _refused(cfg);
        cfg.sourceCid = abi.encodePacked(hex"01", new bytes(64));
        _refused(cfg);
        cfg.sourceCid = abi.encodePacked(hex"01", new bytes(63));
        _create(cfg);
    }

    function _refused(ImageBoardStorage.Config memory cfg) internal {
        vm.expectRevert(ImageBoardStorage.InvalidConfig.selector);
        collection.createBoardFor(seller, abi.encode(cfg));
    }

    // ---------------------------------------------------------------------
    // The extension and the implementation
    // ---------------------------------------------------------------------

    /// Called directly, the extension runs on its own empty storage: nothing to set up, nothing to rent.
    function test_theExtensionAloneHoldsNoBoard() public {
        ImageBoardExtension ext = ImageBoardExtension(implementation.extension());
        vm.expectRevert(ImageBoardStorage.AlreadyInitialized.selector);
        ext.initialize(1, alice, abi.encode(_config(300, 300, 10)));
        vm.expectRevert(ImageBoardStorage.NotForRent.selector);
        ext.rent(1, alice, 1 days, RATE);
        assertEq(ext.collection(), address(0));
    }

    /// The board reads its protocol terms from its extension, so the two cannot disagree.
    function test_theBoardsProtocolTermsAreItsExtensions() public {
        ImageBoardExtension ext = new ImageBoardExtension(300, carol);
        ImageBoard impl = new ImageBoard(address(ext), address(renderer));
        assertEq(impl.protocolBps(), 300);
        assertEq(impl.protocolTreasury(), carol);
        vm.expectRevert(ImageBoardStorage.ZeroAddress.selector);
        new ImageBoard(address(ext), makeAddr("no renderer"));
    }
}
