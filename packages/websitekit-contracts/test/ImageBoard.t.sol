// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { ImageBoard } from "../src/ImageBoard.sol";
import { ImageBoardCollection } from "../src/ImageBoardCollection.sol";
import { ImageBoardBase } from "./ImageBoardBase.t.sol";

/// @notice `ImageBoard` against `docs/IMAGE-BOARD-SPEC.md`. The invariants live in
/// `ImageBoard.invariant.t.sol`; this file pins each rule at its boundary.
contract ImageBoardTest is ImageBoardBase {
    // ---------------------------------------------------------------------
    // Creation
    // ---------------------------------------------------------------------

    /// §2's example: 300×671 at 10 px is 30×67; the 1 px strip at the bottom is not a row.
    function test_theGridIsWholeCellsFromTheTopLeft() public view {
        (uint16 cols, uint16 rows) = board.gridSize();
        assertEq(cols, 30);
        assertEq(rows, 67);
        assertEq(board.seller(), seller);
        assertEq(board.cellPrice(), CELL_PRICE);
        assertEq(board.imageHash(), keccak256("original image bytes"));
    }

    function test_eachCellSizeDerivesItsOwnGrid() public {
        (uint16 c15, uint16 r15) = _create(_config(300, 671, 15)).gridSize();
        assertEq(c15, 20);
        assertEq(r15, 44); // 671 / 15 = 44.7
        (uint16 c20, uint16 r20) = _create(_config(299, 671, 20)).gridSize();
        assertEq(c20, 14); // 299 / 20 = 14.95
        assertEq(r20, 33);
    }

    function test_onlyTenFifteenOrTwentyPixelCells() public {
        ImageBoard.Config memory cfg = _config(300, 300, 12);
        vm.expectRevert(ImageBoard.InvalidConfig.selector);
        collection.createBoardFor(seller, cfg);

        cfg.cellSize = 5;
        vm.expectRevert(ImageBoard.InvalidConfig.selector);
        collection.createBoardFor(seller, cfg);
    }

    /// One storage word per row: 256 cells across is the limit, 257 is refused.
    function test_atMost256CellsAcross() public {
        (uint16 cols,) = _create(_config(2569, 100, 10)).gridSize();
        assertEq(cols, 256);

        ImageBoard.Config memory cfg = _config(2570, 100, 10);
        vm.expectRevert(ImageBoard.InvalidConfig.selector);
        collection.createBoardFor(seller, cfg);
    }

    function test_anImageSmallerThanOneCellIsRefused() public {
        ImageBoard.Config memory narrow = _config(9, 100, 10);
        vm.expectRevert(ImageBoard.InvalidConfig.selector);
        collection.createBoardFor(seller, narrow);

        ImageBoard.Config memory short_ = _config(100, 9, 10);
        vm.expectRevert(ImageBoard.InvalidConfig.selector);
        collection.createBoardFor(seller, short_);
    }

    /// 1,000 rows. The bound is on ROWS, not pixels: 10,009 px at 10 is still 1,000 rows, and
    /// 20,019 px at 20 is too.
    function test_atMost1000RowsDown() public {
        (, uint16 rows) = _create(_config(100, 10_009, 10)).gridSize();
        assertEq(rows, 1_000);
        (, rows) = _create(_config(100, 20_019, 20)).gridSize();
        assertEq(rows, 1_000);

        ImageBoard.Config memory cfg = _config(100, 10_010, 10);
        vm.expectRevert(ImageBoard.InvalidConfig.selector);
        collection.createBoardFor(seller, cfg);

        cfg = _config(100, 15_015, 15);
        vm.expectRevert(ImageBoard.InvalidConfig.selector);
        collection.createBoardFor(seller, cfg);
    }

    function test_aZeroPriceOrHashOrSellerIsRefused() public {
        ImageBoard.Config memory cfg = _config(300, 300, 10);
        cfg.cellPrice = 0;
        vm.expectRevert(ImageBoard.InvalidConfig.selector);
        collection.createBoardFor(seller, cfg);

        cfg = _config(300, 300, 10);
        cfg.imageHash = bytes32(0);
        vm.expectRevert(ImageBoard.InvalidConfig.selector);
        collection.createBoardFor(seller, cfg);

        cfg = _config(300, 300, 10);
        vm.expectRevert(ImageBoardCollection.ZeroAddress.selector);
        collection.createBoardFor(address(0), cfg);
    }

    function test_aTokenNotAllowedIsRefused() public {
        ImageBoard.Config memory cfg = _config(300, 300, 10);
        cfg.settlementToken = makeAddr("some other token");
        vm.expectRevert(ImageBoardCollection.TokenNotAllowed.selector);
        collection.createBoardFor(seller, cfg);
    }

    function test_onlyTheCollectionOwnerChangesTheAllowlist() public {
        vm.prank(alice);
        vm.expectRevert();
        collection.allowToken(makeAddr("t"), true);
    }

    function test_aBoardCannotBeInitializedTwice() public {
        ImageBoard.Config memory cfg = _config(300, 300, 10);
        vm.expectRevert(ImageBoard.AlreadyInitialized.selector);
        board.initialize(1, seller, cfg);
    }

    function test_theImplementationCannotBeInitialized() public {
        ImageBoard.Config memory cfg = _config(300, 300, 10);
        vm.expectRevert(ImageBoard.AlreadyInitialized.selector);
        implementation.initialize(1, seller, cfg);
    }

    // ---------------------------------------------------------------------
    // Buying
    // ---------------------------------------------------------------------

    /// The standing check: the beneficiary is named separately from whoever pays.
    function test_theBlockGoesToTheRecipientNotThePayer() public {
        uint256 id = _buy(alice, bob, 0, 0, 2, 3);
        assertEq(board.ownerOf(id), bob);
        assertEq(board.ownerOf(id + 1), address(0), "an id never sold has no owner");
    }

    function test_theChargeIsCellsTimesPriceAndTheCutRoundsDown() public {
        uint256 before = usd.balanceOf(alice);
        _buy(alice, alice, 4, 5, 3, 1); // 3 cells → 30,009; 500 bps of it is 1,500.45
        assertEq(before - usd.balanceOf(alice), 30_009, "charged cells x price");
        assertEq(board.pendingWithdrawals(protocol), 1_500, "the protocol cut rounds down");
        assertEq(board.pendingWithdrawals(seller), 28_509, "the seller gets the rest");
        assertEq(usd.balanceOf(address(board)), 30_009, "the board holds exactly what it owes");
    }

    function test_theBlockIsRecordedWithItsShape() public {
        uint256 id = _buy(alice, alice, 7, 9, 4, 2);
        ImageBoard.Block memory b = board.blockOf(id);
        assertEq(b.col, 7);
        assertEq(b.row, 9);
        assertEq(b.cols, 4);
        assertEq(b.rows, 2);
        assertEq(b.version, 0);
        assertEq(board.rowBits(9), uint256(0xF) << 7);
        assertEq(board.rowBits(10), uint256(0xF) << 7);
        assertEq(board.rowBits(8), 0);
        assertEq(board.rowBits(11), 0);
    }

    function test_blockIdsCountFromOne() public {
        assertEq(_buy(alice, alice, 0, 0, 1, 1), 1);
        assertEq(_buy(alice, alice, 1, 0, 1, 1), 2);
        assertEq(board.blockCount(), 2);
    }

    /// The whole grid is a legal block when it is under the buy's cell cap (2,010 cells here).
    function test_aBlockMayBeTheWholeGrid() public {
        uint256 id = _buy(alice, alice, 0, 0, 30, 67);
        assertEq(board.ownerOf(id), alice);
        assertEq(board.freeCells(), 0);
        assertEq(board.blockError(0, 0, 1, 1), ImageBoard.CoolingDown.selector);
    }

    /// 256 across exercises the all-ones mask, where `1 << 256` would be zero.
    function test_aBlock256CellsWideTakesTheWholeRowWord() public {
        board = _create(_config(2560, 30, 10));
        vm.prank(alice);
        usd.approve(address(board), type(uint256).max);
        _buy(alice, alice, 0, 1, 256, 1);
        assertEq(board.rowBits(1), type(uint256).max);
        assertEq(board.rowBits(0), 0);
    }

    function test_aBlockEndingAtTheGridEdgeIsAllowed() public {
        _buy(alice, alice, 29, 66, 1, 1); // the bottom-right cell
        _buy(alice, alice, 28, 0, 2, 1); // flush with the right edge
    }

    function test_oneCellPastTheGridIsRefused() public {
        vm.prank(alice);
        vm.expectRevert(ImageBoard.OutsideGrid.selector);
        board.buyBlocks(alice, _one(29, 0, 2, 1), type(uint256).max, block.timestamp); // into the unsold strip on the right

        vm.prank(alice);
        vm.expectRevert(ImageBoard.OutsideGrid.selector);
        board.buyBlocks(alice, _one(0, 66, 1, 2), type(uint256).max, block.timestamp); // below the last whole row

        vm.prank(alice);
        vm.expectRevert(ImageBoard.OutsideGrid.selector);
        board.buyBlocks(alice, _one(30, 0, 1, 1), type(uint256).max, block.timestamp);
    }

    /// uint16 arithmetic would wrap here; the bound is computed wide.
    function test_aRectangleThatWouldWrapIsOutsideTheGrid() public {
        vm.prank(alice);
        vm.expectRevert(ImageBoard.OutsideGrid.selector);
        board.buyBlocks(alice, _one(type(uint16).max, 0, 2, 1), type(uint256).max, block.timestamp);
    }

    function test_anEmptyBlockIsRefused() public {
        vm.prank(alice);
        vm.expectRevert(ImageBoard.EmptyBlock.selector);
        board.buyBlocks(alice, _one(0, 0, 0, 1), type(uint256).max, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(ImageBoard.EmptyBlock.selector);
        board.buyBlocks(alice, _one(0, 0, 1, 0), type(uint256).max, block.timestamp);
    }

    /// One sold cell still in its cooldown refuses the buy; a second later it is for sale.
    function test_oneCornerCellInItsCooldownIsRefused() public {
        _buy(alice, alice, 10, 10, 3, 3);
        vm.warp(block.timestamp + 3_600 - 1);
        vm.prank(bob);
        vm.expectRevert(ImageBoard.CoolingDown.selector);
        board.buyBlocks(bob, _one(12, 12, 3, 3), type(uint256).max, block.timestamp); // shares only (12, 12)

        vm.warp(block.timestamp + 1);
        uint256 id = _buy(bob, bob, 12, 12, 3, 3);
        assertEq(board.ownerOf(id), bob);
    }

    function test_touchingEdgesIsAllowed() public {
        _buy(alice, alice, 10, 10, 3, 3);
        _buy(bob, bob, 13, 10, 2, 3); // right
        _buy(bob, bob, 10, 13, 3, 2); // below
        _buy(bob, bob, 7, 10, 3, 3); // left
        _buy(bob, bob, 10, 7, 3, 3); // above
    }

    /// Whole or nothing: the refused buy's FREE rows must not be marked either.
    function test_aRefusedBuyChangesNothing() public {
        _buy(alice, alice, 5, 6, 1, 1);
        uint256 row5 = board.rowBits(5);
        uint256 balance = usd.balanceOf(bob);

        vm.prank(bob);
        vm.expectRevert(ImageBoard.CoolingDown.selector);
        board.buyBlocks(bob, _one(4, 5, 3, 3), type(uint256).max, block.timestamp); // rows 5 and 7 are free; row 6 collides

        assertEq(board.rowBits(5), row5);
        assertEq(board.rowBits(7), 0);
        assertEq(board.blockCount(), 1);
        assertEq(usd.balanceOf(bob), balance);
    }

    function test_aZeroRecipientIsRefused() public {
        vm.prank(alice);
        vm.expectRevert(ImageBoard.ZeroAddress.selector);
        board.buyBlocks(address(0), _one(0, 0, 1, 1), type(uint256).max, block.timestamp);
    }

    function test_aPayerWithoutAllowanceIsRefused() public {
        address stranger = makeAddr("stranger");
        usd.mint(stranger, 1e6);
        vm.prank(stranger);
        vm.expectRevert();
        board.buyBlocks(stranger, _one(0, 0, 1, 1), type(uint256).max, block.timestamp);
    }

    /// `blockError` is the one gate: whatever it says, the buy does.
    function test_blockErrorNamesExactlyWhatTheBuyRefusesWith() public {
        _buy(alice, alice, 0, 0, 2, 2);
        assertEq(board.blockError(1, 1, 2, 2), ImageBoard.CoolingDown.selector);
        assertEq(board.blockError(29, 0, 2, 1), ImageBoard.OutsideGrid.selector);
        assertEq(board.blockError(0, 0, 0, 1), ImageBoard.EmptyBlock.selector);
        assertEq(board.blockError(2, 0, 2, 2), bytes4(0));
    }

    function test_quoteIsCellsTimesPrice() public view {
        assertEq(board.quote(5, 7, 3, 4), 12 * CELL_PRICE);
        assertEq(board.zones().length, 0, "a board made with no zones has none");
    }

    // ---------------------------------------------------------------------
    // Permit
    // ---------------------------------------------------------------------

    function test_aPermitBuyNeedsNoPriorApproval() public {
        vm.prank(alice);
        usd.approve(address(board), 0);

        uint256 total = board.quote(0, 0, 2, 2);
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(alicePk, address(board), total, block.timestamp + 1 hours);
        vm.prank(alice);
        uint256 id = board.buyBlocksWithPermit(bob, _one(0, 0, 2, 2), total, block.timestamp + 1 hours, v, r, s);

        assertEq(board.ownerOf(id), bob);
        assertEq(usd.allowance(alice, address(board)), 0, "the permit was for exactly the total");
    }

    /// Someone replays the permit first. The buy must still land: the allowance is there.
    function test_aFrontRunPermitDoesNotBlockTheBuy() public {
        vm.prank(alice);
        usd.approve(address(board), 0);

        uint256 total = board.quote(0, 0, 1, 1);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(alicePk, address(board), total, deadline);
        usd.permit(alice, address(board), total, deadline, v, r, s); // the griefer

        vm.prank(alice);
        uint256 id = board.buyBlocksWithPermit(alice, _one(0, 0, 1, 1), total, deadline, v, r, s);
        assertEq(board.ownerOf(id), alice);
    }

    function test_aBadPermitWithNoAllowanceIsRefused() public {
        vm.prank(alice);
        usd.approve(address(board), 0);

        uint256 deadline = block.timestamp + 1 hours;
        uint256 total = board.quote(0, 0, 1, 1);
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(bobPk, address(board), total, deadline);
        vm.prank(alice);
        vm.expectRevert();
        board.buyBlocksWithPermit(alice, _one(0, 0, 1, 1), total, deadline, v, r, s);
    }

    // ---------------------------------------------------------------------
    // Content and editors
    // ---------------------------------------------------------------------

    function test_theOwnerEditsAndTheVersionCounts() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        vm.prank(alice);
        board.edit(id, keccak256("one"));
        vm.prank(alice);
        board.edit(id, keccak256("two"));
        ImageBoard.Block memory b = board.blockOf(id);
        assertEq(b.contentHash, keccak256("two"));
        assertEq(b.version, 2);
    }

    function test_anyoneElseCannotEdit() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        vm.prank(bob);
        vm.expectRevert(ImageBoard.NotBlockEditor.selector);
        board.edit(id, keccak256("x"));

        vm.prank(alice);
        vm.expectRevert(ImageBoard.NotBlockOwner.selector);
        board.edit(99, keccak256("x"));
    }

    function test_aGrantedEditorCanEdit() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        vm.prank(alice);
        board.setEditor(id, relayer);
        vm.prank(relayer);
        board.edit(id, keccak256("by the editor"));
        assertEq(board.blockOf(id).version, 1);
        assertEq(board.editorOf(id), relayer);
    }

    function test_onlyTheOwnerGrants() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        vm.prank(bob);
        vm.expectRevert(ImageBoard.NotBlockOwner.selector);
        board.setEditor(id, bob);
    }

    /// A→B→A: a grant keyed only on the grantor would come back to life here.
    function test_aGrantDiesOnTransferAndStaysDead() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        vm.prank(alice);
        board.setEditor(id, relayer);

        vm.prank(alice);
        board.transferBlock(id, bob);
        assertFalse(board.canEdit(id, relayer), "the new owner did not grant it");

        vm.prank(bob);
        board.transferBlock(id, alice);
        assertFalse(board.canEdit(id, relayer), "and it does not revive on return");
        assertEq(board.editorOf(id), address(0));

        vm.prank(relayer);
        vm.expectRevert(ImageBoard.NotBlockEditor.selector);
        board.edit(id, keccak256("x"));
    }

    function test_aSignedGrantWorksOnceAndNotAfterItsDeadline() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _grantSig(alicePk, id, relayer, 0, deadline);

        board.setEditorWithSig(id, relayer, deadline, sig);
        assertTrue(board.canEdit(id, relayer));

        vm.expectRevert(ImageBoard.InvalidSignature.selector);
        board.setEditorWithSig(id, relayer, deadline, sig); // the nonce moved on

        bytes memory late = _grantSig(alicePk, id, bob, 1, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(ImageBoard.DeadlineExpired.selector);
        board.setEditorWithSig(id, bob, deadline, late);
    }

    function test_aGrantSignedBySomeoneElseIsRefused() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _grantSig(bobPk, id, bob, 0, deadline);
        vm.expectRevert(ImageBoard.InvalidSignature.selector);
        board.setEditorWithSig(id, bob, deadline, sig);
    }

    function _grantSig(uint256 pk, uint256 id, address editor, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("EditorGrant(uint256 blockId,address editor,uint256 nonce,uint256 deadline)"),
                id,
                editor,
                nonce,
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", board.DOMAIN_SEPARATOR(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    // ---------------------------------------------------------------------
    // Royalty, metadata, withdrawals
    // ---------------------------------------------------------------------

    function test_aBlockIsNotAToken() public view {
        // No ERC-721 on the board: nothing for a marketplace to list per block.
        (bool ok,) = address(board).staticcall(abi.encodeWithSignature("supportsInterface(bytes4)", bytes4(0x80ac58cd)));
        assertFalse(ok, "a board answers supportsInterface");
        (ok,) = address(board).staticcall(abi.encodeWithSignature("balanceOf(address)", alice));
        assertFalse(ok, "a board answers balanceOf");
    }

    function test_withdrawForPaysTheAccountWhoeverCalls() public {
        _buy(alice, alice, 0, 0, 10, 10);
        uint256 owedSeller = board.pendingWithdrawals(seller);
        uint256 owedProtocol = board.pendingWithdrawals(protocol);

        vm.prank(relayer);
        board.withdrawFor(seller);
        vm.prank(relayer);
        board.withdrawFor(protocol);

        assertEq(usd.balanceOf(seller), owedSeller);
        assertEq(usd.balanceOf(protocol), owedProtocol);
        assertEq(usd.balanceOf(relayer), 0);
        assertEq(usd.balanceOf(address(board)), 0);
    }

    function test_withdrawingNothingIsRefused() public {
        vm.expectRevert(ImageBoard.NothingToWithdraw.selector);
        board.withdrawFor(seller);
    }

    // ---------------------------------------------------------------------
    // The board's NFT
    // ---------------------------------------------------------------------

    event MetadataUpdate(uint256 _tokenId);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    function test_creatingABoardMintsItsNFTToTheSeller() public {
        assertEq(collection.ownerOf(1), seller);
        assertEq(collection.boardOf(1), address(board));
        assertEq(collection.tokenOfBoard(address(board)), 1);
        assertEq(board.collection(), address(collection));
        assertEq(board.boardTokenId(), 1);
        assertEq(board.seller(), seller);

        (address second, uint256 id) = collection.createBoardFor(alice, _config(300, 300, 10));
        assertEq(id, 2, "board tokens count from one");
        assertEq(collection.ownerOf(2), alice);
        assertEq(collection.boardOf(2), second);
        assertEq(collection.boardCount(), 2);
        assertEq(collection.balanceOf(seller), 1);
    }

    /// The standing check: whoever pays gas to create is not who receives the board.
    function test_theBoardGoesToTheSellerNotTheCreator() public {
        vm.prank(relayer);
        (, uint256 id) = collection.createBoardFor(alice, _config(300, 300, 10));
        assertEq(collection.ownerOf(id), alice);
        assertEq(collection.balanceOf(relayer), 0);
        assertEq(collection.creatorOf(id), alice);
    }

    /// Proceeds follow the NFT from the next sale on; what was credited before stays put.
    function test_saleProceedsGoToWhoeverHoldsTheBoardAtTheSale() public {
        _buy(alice, alice, 0, 0, 1, 1);
        uint256 before = board.pendingWithdrawals(seller);
        assertGt(before, 0);

        address carol = makeAddr("carol");
        vm.prank(seller);
        collection.transferFrom(seller, carol, 1);
        assertEq(board.seller(), carol);

        _buy(alice, alice, 1, 0, 1, 1);
        assertEq(board.pendingWithdrawals(seller), before, "the old holder keeps only what was already theirs");
        assertEq(board.pendingWithdrawals(carol), before, "the new holder is paid for the next square");
    }

    function test_aBuyAndAnEditTellMarketplacesTheBoardChanged() public {
        vm.expectEmit(address(collection));
        emit MetadataUpdate(1);
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);

        vm.expectEmit(address(collection));
        emit MetadataUpdate(1);
        vm.prank(alice);
        board.edit(id, keccak256("x"));
    }

    function test_onlyABoardOfThisCollectionCanSayItChanged() public {
        vm.prank(alice);
        vm.expectRevert(ImageBoardCollection.NotABoard.selector);
        collection.boardChanged();

        // A clone of the same implementation, initialized by someone else, is not one of ours.
        ImageBoard stray = ImageBoard(Clones.clone(address(implementation)));
        vm.prank(alice);
        stray.initialize(1, alice, _config(300, 300, 10));
        vm.prank(alice);
        vm.expectRevert(ImageBoardCollection.NotABoard.selector);
        collection.boardChanged();
        assertEq(stray.collection(), alice);
    }

    function test_theRoyaltyIsFivePercentToTheCreatorWhoeverHoldsTheBoard() public {
        vm.prank(seller);
        collection.transferFrom(seller, alice, 1);
        (address to, uint256 amount) = collection.royaltyInfo(1, 1_000_001);
        assertEq(to, seller, "the creator, not the holder");
        assertEq(amount, 50_000);
        assertTrue(collection.supportsInterface(0x2a55205a), "ERC-2981");
        assertTrue(collection.supportsInterface(0x49064906), "ERC-4906");
        assertTrue(collection.supportsInterface(0x80ac58cd), "ERC-721");
    }

    function test_tokenURIIsTheBasePlusTheBoardsToken() public {
        assertEq(collection.tokenURI(1), "https://example.com/b/1");
    }

    /// 2026-10-12: the name and symbol are the deployer's, so the source names no product.
    function test_theNameAndSymbolAreTheDeployersAndBothAreRequired() public {
        assertEq(collection.name(), "Test Image Boards");
        assertEq(collection.symbol(), "TIMG");
        address[] memory tokens = new address[](0);
        ImageBoardCollection other = new ImageBoardCollection("Another", "ANO", address(this), address(implementation), tokens, "");
        assertEq(other.name(), "Another");
        assertEq(other.symbol(), "ANO");
        vm.expectRevert(ImageBoardCollection.EmptyName.selector);
        new ImageBoardCollection("", "ANO", address(this), address(implementation), tokens, "");
        vm.expectRevert(ImageBoardCollection.EmptyName.selector);
        new ImageBoardCollection("Another", "", address(this), address(implementation), tokens, "");
    }

    /// 2026-10-12: grants are signed under "Image Board", version 1, with the board as verifier —
    /// pinned here because a wallet shows the name, and the SDK's `BOARD_DOMAIN_NAME` must agree.
    function test_theSigningDomainNamesNoProduct() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Image Board"),
                keccak256("1"),
                block.chainid,
                address(board)
            )
        );
        assertEq(board.DOMAIN_SEPARATOR(), expected);
    }

    function test_unknownTokenURIReverts() public {
        vm.expectRevert(bytes4(keccak256("TokenDoesNotExist()")));
        collection.tokenURI(2);
    }

    function test_onlyTheOwnerMovesTheBaseURIAndEveryTokenIsRefreshed() public {
        vm.prank(alice);
        vm.expectRevert();
        collection.setBaseURI("https://elsewhere.example/");

        vm.expectEmit(address(collection));
        emit BatchMetadataUpdate(1, type(uint256).max);
        collection.setBaseURI("https://new.example/b/");
        assertEq(collection.tokenURI(1), "https://new.example/b/1");
    }

    // ---------------------------------------------------------------------
    // Moving a block
    // ---------------------------------------------------------------------

    event BlockTransferred(uint256 indexed blockId, address indexed from, address indexed to);

    function test_theOwnerGivesABlockAway() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        vm.expectEmit(address(board));
        emit BlockTransferred(id, alice, bob);
        vm.prank(alice);
        board.transferBlock(id, bob);
        assertEq(board.ownerOf(id), bob);
        assertTrue(board.canEdit(id, bob));
        assertFalse(board.canEdit(id, alice));
    }

    function test_nobodyElseMovesABlock() public {
        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        vm.prank(bob);
        vm.expectRevert(ImageBoard.NotBlockOwner.selector);
        board.transferBlock(id, bob);

        // Not the board's holder either: owning the board is not owning its blocks.
        vm.prank(seller);
        vm.expectRevert(ImageBoard.NotBlockOwner.selector);
        board.transferBlock(id, seller);

        // Nor an editor the owner named.
        vm.prank(alice);
        board.setEditor(id, relayer);
        vm.prank(relayer);
        vm.expectRevert(ImageBoard.NotBlockOwner.selector);
        board.transferBlock(id, relayer);
        assertEq(board.ownerOf(id), alice);
    }

    function test_anUnsoldBlockCannotBeMovedOrGivenToNobody() public {
        vm.prank(alice);
        vm.expectRevert(ImageBoard.NotBlockOwner.selector);
        board.transferBlock(1, alice);

        uint256 id = _buy(alice, alice, 0, 0, 1, 1);
        vm.prank(alice);
        vm.expectRevert(ImageBoard.ZeroAddress.selector);
        board.transferBlock(id, address(0));

    }
}
