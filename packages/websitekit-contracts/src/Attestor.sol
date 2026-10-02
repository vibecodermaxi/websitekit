// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Ownable } from "solady/auth/Ownable.sol";

/// @notice The referee's address, held behind one indirection so it can be rotated.
///
/// `EscrowVault` is an EIP-1167 clone and clones share their implementation's immutables, so an
/// `address immutable attestor` could only ever be rotated by deploying a new vault implementation
/// — safe, since a dead key marks nothing and everything releases (the vault fails OPEN), but it
/// would cost every future board. The vault therefore holds THIS contract's address immutably and
/// reads `attestor()` on every privileged call, so the trust anchor stays still while the key moves.
///
/// **Zero is a legal value and means nobody.** With no attestor no vault can be marked dark, every
/// deposit matures on its clock, and the scheme degrades to a payout delay. That is the fail-open
/// property the design rests on, expressed as the registry's own empty state rather than as a
/// special case in the vault.
contract Attestor is Ownable {
    address public attestor;

    event AttestorSet(address indexed attestor);

    constructor(address owner_, address attestor_) {
        _initializeOwner(owner_);
        attestor = attestor_;
        emit AttestorSet(attestor_);
    }

    function setAttestor(address attestor_) external onlyOwner {
        attestor = attestor_;
        emit AttestorSet(attestor_);
    }
}
