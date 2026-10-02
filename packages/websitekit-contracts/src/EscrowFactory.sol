// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { Ownable } from "solady/auth/Ownable.sol";

import { EscrowVault } from "./EscrowVault.sol";
import { SlotFactory } from "./SlotFactory.sol";
import { SlotSite } from "./SlotSite.sol";

/// @notice Creates a board and its vault in one transaction, with the board's `treasury` pinned to
/// the vault before the board exists for anyone to touch.
///
/// The order is the guarantee. `treasury` is frozen at `createSite`, so the vault has to exist
/// first; the config is rewritten here with `treasury = vault` and `pinTreasury = true` whatever
/// the caller passed; and `bind` runs last, in the same transaction, so there is no state in which
/// a board is pinned to a vault that has not checked it or a vault claims a board that is not
/// pinned to it. `bind` is `onlyFactory` and this factory binds only a site it has just created —
/// `SlotFactory` keeps no registry, so provenance is this contract's memory.
///
/// **The vault implementation is deployed BY this constructor**, because a vault needs its factory's
/// address as an immutable and a factory needs its implementation's: one has to create the other.
///
/// Policy — the window, the claim delay, the transition spacing, the dust threshold — is the
/// owner's to set here and is copied onto each vault at bind, so a change of policy reaches the
/// next board and never an existing one. Which settlement tokens may be escrowed is also the
/// owner's list: balance-delta booking assumes a token that transfers what it says, and a
/// fee-on-transfer or rebasing token would book the wrong number in one direction or the other.
contract EscrowFactory is Ownable {
    SlotFactory public immutable slotFactory;
    address public immutable vaultImplementation;

    EscrowVault.Params public params;
    mapping(address => bool) public tokenAllowed;
    /// @dev site → vault, so the platform's record is checkable against the chain's.
    mapping(address => address) public vaultOf;

    error ZeroAddress();
    error TokenNotAllowed();
    error InvalidParams();

    event EscrowedSiteCreated(address indexed owner, address indexed site, address indexed vault, address creator);
    event ParamsSet(uint64 windowSecs, uint64 claimDelaySecs, uint64 minTransitionSecs, uint128 minBooking);
    event TokenAllowed(address indexed token, bool allowed);

    constructor(
        address owner_,
        SlotFactory slotFactory_,
        address registry,
        EscrowVault.Params memory params_,
        address[] memory tokens
    ) {
        if (owner_ == address(0) || address(slotFactory_) == address(0)) {
            revert ZeroAddress();
        }
        _initializeOwner(owner_);
        slotFactory = slotFactory_;
        vaultImplementation = address(new EscrowVault(address(this), registry));
        _setParams(params_);
        for (uint256 i = 0; i < tokens.length; i++) {
            tokenAllowed[tokens[i]] = true;
            emit TokenAllowed(tokens[i], true);
        }
    }

    /// @notice Deploys the vault, then the board pinned to it, then binds the two.
    ///
    /// `cfg.treasury` and `cfg.pinTreasury` are overwritten and never read: a caller cannot create an
    /// escrowed board whose money goes anywhere but its own vault. Everything else in the config is
    /// the caller's, exactly as on `SlotFactory.createSiteFor`.
    function createEscrowedSite(
        address owner_,
        SlotSite.SiteConfig calldata cfg,
        bytes32[] calldata keys,
        uint256[] calldata floors
    ) external returns (address site, address vault) {
        if (!tokenAllowed[cfg.settlementToken]) revert TokenNotAllowed();

        vault = Clones.clone(vaultImplementation);

        SlotSite.SiteConfig memory pinned = cfg;
        pinned.treasury = vault;
        pinned.pinTreasury = true;

        site = slotFactory.createSiteFor(owner_, pinned, keys, floors);
        EscrowVault(payable(vault)).bind(site, params);
        vaultOf[site] = vault;
        emit EscrowedSiteCreated(owner_, site, vault, msg.sender);
    }

    function setParams(EscrowVault.Params calldata params_) external onlyOwner {
        _setParams(params_);
    }

    function allowToken(address token, bool allowed) external onlyOwner {
        tokenAllowed[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    function _setParams(EscrowVault.Params memory p) internal {
        if (p.windowSecs == 0) revert InvalidParams();
        params = p;
        emit ParamsSet(p.windowSecs, p.claimDelaySecs, p.minTransitionSecs, p.minBooking);
    }
}
