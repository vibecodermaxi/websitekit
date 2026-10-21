// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { ERC721 } from "solady/tokens/ERC721.sol";
import { Ownable } from "solady/auth/Ownable.sol";

/// @notice What the collection asks of any board implementation, now or later: to be set up from
/// bytes only it reads, and to say which token it settles in. Nothing else of a board's shape is
/// fixed here, so a later implementation may take a different set-up (2026-10-20).
interface IImageBoardInit {
    function initialize(uint256 boardTokenId, address creator, bytes calldata config) external;
    function settlementToken() external view returns (address);
    /// The board token's metadata, built on chain (spec §13.8): every implementation answers it.
    function boardURI() external view returns (string memory);
}

/// @notice Every image board as one NFT, in one collection — the Boards collection (decided
/// 2026-10-09, `docs/IMAGE-BOARD-SPEC.md` §1 and §13). Creating a board clones one `ImageBoard`
/// implementation and mints the board's token to its seller in the same transaction. Each board is
/// also a collection of its own, whose tokens are its blocks (2026-10-21).
///
/// **Metadata is computed on chain** (2026-10-21): `tokenURI` is the board's own `boardURI()`, built
/// by its implementation's renderer. There is no base URI and nothing to repoint.
///
/// **Marketplaces are told when a board changes** (ERC-4906): a board this collection created calls
/// `boardChanged` on every buy and edit, and this emits `MetadataUpdate` for its token. Only a
/// registered board can — otherwise anyone could spam the signal for any token.
///
/// **The owner's powers, and only these:** which settlement tokens NEW boards may use, and which
/// implementation NEW boards are cloned from (`setImplementation`, 2026-10-20). The owner has no
/// reach into an existing board, its blocks, its money or its metadata: a board is a clone of the
/// implementation it was created from, for good (`implementationOf`). `setBaseURI` is gone
/// (2026-10-21). **Ownership moves only by the two-step handover** (`requestOwnershipHandover`, then
/// `completeOwnershipHandover` within 48 hours): the one-step transfer and renouncing revert, so the
/// powers can be neither sent to a mistyped address nor thrown away.
///
/// **Why the implementation can change for new boards** (2026-10-20): a board's code is fixed when
/// it is cloned, so a feature added later can only ever reach boards created after it. Without
/// this, every such feature would need a second collection — a second NFT collection on every
/// marketplace, and boards split between them. The set-up a board takes is opaque bytes here, so a
/// later implementation may take a different one.
///
/// **Its name, symbol and collection metadata are the deployer's, not this source's** (2026-10-12):
/// the protocol's bytecode names no product, as `SlotSite`'s name and symbol are `createSite`
/// arguments. All three are fixed at deployment; there is no setter. A board's own symbol is this
/// one's with its token id.
///
contract ImageBoardCollection is ERC721, Ownable {
    /// @notice ERC-2981, paid to the board's creator on every resale of its NFT. A constant.
    uint256 public constant ROYALTY_BPS = 500;
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    bytes4 internal constant INTERFACE_ID_ERC2981 = 0x2a55205a;
    bytes4 internal constant INTERFACE_ID_ERC4906 = 0x49064906;

    /// @notice What the next board is cloned from. Changing it changes no existing board.
    address public implementation;
    mapping(address => bool) public tokenAllowed;
    /// @notice ERC-7572: this collection's own metadata, fixed at deployment.
    string public contractURI;
    string private _name;
    string private _symbol;

    /// @notice Tokens run from 1; `boardCount` is the last one minted.
    uint256 public boardCount;
    mapping(uint256 => address) public boardOf;
    mapping(address => uint256) public tokenOfBoard;
    /// @notice Who the board was created for — the royalty's recipient, whoever holds it later.
    mapping(uint256 => address) public creatorOf;
    /// @notice The implementation a board was cloned from: its rules, for good.
    mapping(uint256 => address) public implementationOf;

    error ZeroAddress();
    error TokenNotAllowed();
    error NotABoard();
    error EmptyName();
    error NotAContract();
    error HandoverOnly();

    event BoardCreated(address indexed seller, address indexed board, uint256 indexed tokenId, address creator);
    event TokenAllowed(address indexed token, bool allowed);
    /// @notice New boards are cloned from `implementation` from now on. Existing boards are unchanged.
    event ImplementationSet(address indexed implementation);
    /// ERC-4906.
    event MetadataUpdate(uint256 _tokenId);

    constructor(
        string memory name_,
        string memory symbol_,
        address owner_,
        address implementation_,
        address[] memory tokens,
        string memory contractURI_
    ) {
        if (owner_ == address(0)) revert ZeroAddress();
        if (bytes(name_).length == 0 || bytes(symbol_).length == 0) revert EmptyName();
        _name = name_;
        _symbol = symbol_;
        _initializeOwner(owner_);
        _setImplementation(implementation_);
        contractURI = contractURI_;
        for (uint256 i = 0; i < tokens.length; i++) {
            tokenAllowed[tokens[i]] = true;
            emit TokenAllowed(tokens[i], true);
        }
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    // ---------------------------------------------------------------------
    // Creating a board
    // ---------------------------------------------------------------------

    /// @notice We deploy and pay; the seller owns the board's NFT having signed nothing. `seller` is
    /// explicit for that reason. `_mint`, not `_safeMint`: no callback into the seller mid-create.
    /// `config` is the current implementation's set-up, ABI-encoded; only the board reads it.
    function createBoardFor(address seller, bytes calldata config) external returns (address board, uint256 tokenId) {
        if (seller == address(0)) revert ZeroAddress();
        tokenId = ++boardCount;
        address impl = implementation;
        board = Clones.clone(impl);
        boardOf[tokenId] = board;
        tokenOfBoard[board] = tokenId;
        creatorOf[tokenId] = seller;
        implementationOf[tokenId] = impl;
        // Same transaction, so no uninitialized clone exists for someone else to claim.
        IImageBoardInit(board).initialize(tokenId, seller, config);
        // Asked of the board once it is set up: the set-up's shape is the implementation's.
        if (!tokenAllowed[IImageBoardInit(board).settlementToken()]) revert TokenNotAllowed();
        _mint(seller, tokenId);
        emit BoardCreated(seller, board, tokenId, msg.sender);
    }

    /// @notice A board's picture changed: a block was bought, given a new picture, or a tenant's
    /// picture lapsed (`poke`). Callable by a board this collection created, and announced for that
    /// board's token only.
    function boardChanged() external {
        uint256 tokenId = tokenOfBoard[msg.sender];
        if (tokenId == 0) revert NotABoard();
        emit MetadataUpdate(tokenId);
    }

    // ---------------------------------------------------------------------
    // The owner's two powers
    // ---------------------------------------------------------------------

    /// @notice Boards created from now on are clones of `implementation_`; boards that exist keep
    /// the one they were created from. Refuses an address with no code — zero included — which
    /// would make every later create fail.
    function setImplementation(address implementation_) external onlyOwner {
        _setImplementation(implementation_);
    }

    function _setImplementation(address implementation_) internal {
        if (implementation_.code.length == 0) revert NotAContract();
        implementation = implementation_;
        emit ImplementationSet(implementation_);
    }

    function allowToken(address token, bool allowed) external onlyOwner {
        tokenAllowed[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    /// @dev The one-step transfer would let a mistyped address take the powers; the handover makes
    /// the new owner ask first. Renouncing would end `allowToken` and `setImplementation` for good.
    function transferOwnership(address) public payable override {
        revert HandoverOnly();
    }

    function renounceOwnership() public payable override {
        revert HandoverOnly();
    }

    // ---------------------------------------------------------------------
    // ERC-721 metadata / ERC-2981
    // ---------------------------------------------------------------------

    function tokenURI(uint256 id) public view override returns (string memory) {
        if (!_exists(id)) revert TokenDoesNotExist();
        return IImageBoardInit(boardOf[id]).boardURI();
    }

    function royaltyInfo(uint256 id, uint256 salePrice) external view returns (address, uint256) {
        return (creatorOf[id], (salePrice * ROYALTY_BPS) / BPS_DENOMINATOR);
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == INTERFACE_ID_ERC2981 || interfaceId == INTERFACE_ID_ERC4906
            || super.supportsInterface(interfaceId);
    }
}
