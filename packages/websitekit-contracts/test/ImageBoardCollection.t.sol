// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Ownable } from "solady/auth/Ownable.sol";

import { ImageBoard } from "../src/ImageBoard.sol";
import { IImageBoardInit, ImageBoardCollection } from "../src/ImageBoardCollection.sol";
import { ImageBoardBase } from "./ImageBoardBase.t.sol";

/// @notice A later board implementation with a set-up of a different shape, standing in for any
/// feature added after the first deployment: what `setImplementation` exists for (2026-10-20).
contract BoardV2 is IImageBoardInit {
    struct ConfigV2 {
        address settlementToken;
        string motto;
    }

    address public collection;
    uint256 public boardTokenId;
    address public settlementToken;
    address public creator;
    string public motto;

    function initialize(uint256 boardTokenId_, address creator_, bytes calldata config) external {
        require(collection == address(0), "initialized");
        collection = msg.sender;
        boardTokenId = boardTokenId_;
        creator = creator_;
        ConfigV2 memory cfg = abi.decode(config, (ConfigV2));
        settlementToken = cfg.settlementToken;
        motto = cfg.motto;
    }

    function version() external pure returns (uint256) {
        return 2;
    }

    function changed() external {
        ImageBoardCollection(collection).boardChanged();
    }
}

/// @notice The collection's third power: which implementation NEW boards are cloned from. Existing
/// boards keep theirs, and the set-up a board takes is the implementation's own.
contract ImageBoardCollectionTest is ImageBoardBase {
    BoardV2 internal v2;

    event ImplementationSet(address indexed implementation);
    event MetadataUpdate(uint256 _tokenId);

    function setUp() public override {
        super.setUp();
        v2 = new BoardV2();
    }

    function _v2Config(address token) internal pure returns (bytes memory) {
        return abi.encode(BoardV2.ConfigV2({ settlementToken: token, motto: "later" }));
    }

    function test_eachBoardRecordsTheImplementationItWasClonedFrom() public view {
        assertEq(collection.implementation(), address(implementation));
        assertEq(collection.implementationOf(1), address(implementation));
    }

    function test_aNewImplementationReachesNewBoardsOnly() public {
        vm.expectEmit(true, false, false, false, address(collection));
        emit ImplementationSet(address(v2));
        collection.setImplementation(address(v2));
        assertEq(collection.implementation(), address(v2));

        // A board of another shape, through the same collection, its NFT in the same series.
        (address made, uint256 id) = collection.createBoardFor(alice, _v2Config(address(usd)));
        assertEq(id, 2);
        assertEq(collection.ownerOf(id), alice);
        assertEq(collection.implementationOf(id), address(v2));
        assertEq(BoardV2(made).version(), 2);
        assertEq(BoardV2(made).motto(), "later");
        assertEq(BoardV2(made).creator(), alice);
        vm.expectEmit(false, false, false, true, address(collection));
        emit MetadataUpdate(id);
        BoardV2(made).changed();

        // The first board is untouched: its own code, still buying, still paying its holder.
        assertEq(collection.implementationOf(1), address(implementation));
        uint256 before = board.pendingWithdrawals(seller);
        _buy(alice, alice, 0, 0, 2, 2);
        assertGt(board.pendingWithdrawals(seller), before);
    }

    function test_onlyTheOwnerSetsTheImplementation() public {
        vm.prank(alice);
        vm.expectRevert(Ownable.Unauthorized.selector);
        collection.setImplementation(address(v2));
        assertEq(collection.implementation(), address(implementation));
    }

    /// Nothing, or an address with no code, would make every later create fail.
    function test_anImplementationMustBeAContract() public {
        vm.expectRevert(ImageBoardCollection.NotAContract.selector);
        collection.setImplementation(address(0));
        vm.expectRevert(ImageBoardCollection.NotAContract.selector);
        collection.setImplementation(makeAddr("no code"));
        address[] memory tokens = new address[](0);
        vm.expectRevert(ImageBoardCollection.NotAContract.selector);
        new ImageBoardCollection("N", "S", address(this), makeAddr("no code"), tokens, "");
    }

    /// The allowlist is asked of the board once it is set up, whatever shape its set-up had.
    function test_theTokenIsCheckedWhateverTheImplementation() public {
        collection.setImplementation(address(v2));
        vm.expectRevert(ImageBoardCollection.TokenNotAllowed.selector);
        collection.createBoardFor(alice, _v2Config(makeAddr("other token")));
    }

    /// The current implementation's set-up, in a later one's shape, is refused, not misread.
    function test_aSetUpOfTheWrongShapeIsRefused() public {
        vm.expectRevert();
        collection.createBoardFor(alice, _v2Config(address(usd)));
        assertEq(collection.boardCount(), 1);
    }
}
