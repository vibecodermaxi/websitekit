// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SlotSite } from "./SlotSite.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/// @notice Deploys sites as EIP-1167 clones of one audited `SlotSite` implementation.
///
/// Uses OpenZeppelin's `Clones` rather than Solady's `LibClone` for one reason: OZ emits the
/// canonical EIP-1167 runtime bytecode, which is what Blockscout and Etherscan pattern-match to
/// auto-detect a minimal proxy. Verifying the implementation once then gives EVERY site a readable,
/// verified contract page — confirmed to survive library linking on testnet (spec §11.4).
///
/// **The factory is not frozen the way `SlotSite` is.** A new factory can be deployed pointing at
/// the same implementation, and sites created by the old one are unaffected. That asymmetry is why a
/// mistake here is cheap and a mistake in the implementation is not.
contract SlotFactory {
    /// @notice The implementation every site is cloned from. Immutable: a factory that could be
    /// repointed is an admin key over the economics of sites it has not created yet.
    address public immutable implementation;

    /// @notice The `RentalsLib` address the implementation was linked against, recorded for
    /// auditability. §11.4 flags a new deploy-time failure mode: the library address is baked into
    /// the implementation's bytecode, so a wrong link means arbitrary behaviour with no revert.
    /// Checking it here catches the cheap version of that mistake (a zero address, or an EOA); the
    /// deploy script must additionally assert this codehash matches the library it just deployed,
    /// and the test suite exercises a rental through a clone, which is what proves the link is live.
    address public immutable rentalsLib;
    bytes32 public immutable rentalsLibCodehash;

    error ZeroAddress();
    error LibraryHasNoCode();

    event SiteCreated(address indexed owner, address indexed site, address indexed creator);

    constructor(address implementation_, address rentalsLib_) {
        if (implementation_ == address(0) || rentalsLib_ == address(0)) revert ZeroAddress();
        if (rentalsLib_.code.length == 0) revert LibraryHasNoCode();
        implementation = implementation_;
        rentalsLib = rentalsLib_;
        rentalsLibCodehash = rentalsLib_.codehash;
    }

    function createSite(SlotSite.SiteConfig calldata cfg, bytes32[] calldata keys, uint256[] calldata floors)
        external
        returns (address site)
    {
        return _create(msg.sender, cfg, keys, floors);
    }

    /// @notice We deploy the clone and pay the gas; the publisher owns it having signed nothing.
    /// This is the path the non-technical product depends on entirely — see spec §10.3.
    ///
    /// Ownership is assigned directly rather than through a two-step accept: the whole point is that
    /// the recipient has not signed anything yet, so a handshake would defeat it. The griefing this
    /// admits amounts to an unwanted empty site, which is noise rather than harm, and
    /// `SiteCreated.creator` is how a directory filters it.
    function createSiteFor(
        address owner,
        SlotSite.SiteConfig calldata cfg,
        bytes32[] calldata keys,
        uint256[] calldata floors
    ) external returns (address site) {
        return _create(owner, cfg, keys, floors);
    }

    function _create(
        address owner,
        SlotSite.SiteConfig calldata cfg,
        bytes32[] calldata keys,
        uint256[] calldata floors
    ) internal returns (address site) {
        if (owner == address(0)) revert ZeroAddress();
        site = Clones.clone(implementation);
        // Deploy and initialize in one transaction, so there is no window in which an uninitialized
        // clone exists for someone else to claim.
        SlotSite(payable(site)).initialize(owner, cfg, keys, floors);
        emit SiteCreated(owner, site, msg.sender);
    }
}
