// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { RentalsLib } from "../../src/RentalsLib.sol";

/// @notice Proves the four properties the library split depends on (PROTOCOL-SPEC §11.4).
/// These are architectural guarantees, not feature tests — if any of them breaks, the split is
/// wrong, not just buggy.
contract Host {
    mapping(bytes32 => RentalsLib.Listing) public listings;
    mapping(bytes32 => RentalsLib.Rental) public rentals;
    mapping(address => uint256) public pending;
    uint256 public escrow;

    function doList(bytes32 key, uint256 rate, uint64 dur) external {
        RentalsLib.list(listings[key], key, rate, dur, 30 days, 1e18, 25, 2500);
    }

    function doOpen(bytes32 key, uint64 dur, uint256 rate) external returns (uint256 cost, uint16 fee) {
        (cost, fee) = RentalsLib.open(rentals[key], listings[key], key, dur, rate, bytes32("snapshot"));
        // The HOST books the money — the library returned an amount and moved nothing.
        uint256 net = cost - (cost * fee) / 10_000;
        rentals[key].prepaid = net;
        escrow += net;
    }

    function doClaim(bytes32 key, address owner_) external returns (uint256 delta) {
        delta = RentalsLib.claim(rentals[key]);
        if (delta > 0) {
            escrow -= delta;
            pending[owner_] += delta;
        }
    }
}

contract LibraryStorageTest is Test {
    Host host;
    bytes32 constant KEY = keccak256("hero.headline");

    function setUp() public {
        host = new Host();
        vm.warp(1_000_000);
    }

    /// A delegatecalled library mutates the HOST's mapping-of-struct storage.
    function test_libraryWritesHostStorage() public {
        host.doList(KEY, 3e15, 7 days);
        (uint192 rate, uint64 maxDur, uint16 fee) = host.listings(KEY);
        assertEq(rate, 3e15, "listing written into host storage");
        assertEq(maxDur, 7 days);
        assertEq(fee, 2500, "fee snapshotted at list time (spec 2.5.1)");
    }

    /// `msg.sender` inside the library is the ORIGINAL caller, so tenant attribution is correct.
    function test_msgSenderIsTheOriginalCaller() public {
        host.doList(KEY, 3e15, 7 days);
        host.doOpen(KEY, 2 days, 3e15);
        (address tenant,, uint64 expiry,,,) = host.rentals(KEY);
        assertEq(tenant, address(this), "tenant is the EOA/contract that called the host, not the host");
        assertEq(expiry, uint64(block.timestamp + 2 days));
    }

    /// Cost is `ratePerDay * durationSecs / 86400` — sub-day terms are expressible (spec 2.5.3).
    function test_subDayTermsArePriceable() public {
        host.doList(KEY, 3e15, 7 days);
        (uint256 cost,) = host.doOpen(KEY, 6 hours, 3e15);
        assertEq(cost, 3e15 / 4, "six hours is a quarter of the daily rate");
    }

    /// The library computes, the HOST moves the money. This is the load-bearing rule of the split.
    function test_libraryNeverMovesMoneyTheHostDoes() public {
        host.doList(KEY, 3e15, 7 days);
        (uint256 cost, uint16 fee) = host.doOpen(KEY, 4 days, 3e15);
        uint256 net = cost - (cost * fee) / 10_000;
        assertEq(host.escrow(), net, "host escrowed the net");

        vm.warp(block.timestamp + 2 days);
        uint256 paid = host.doClaim(KEY, address(0xBEEF));
        assertApproxEqAbs(paid, net / 2, 1, "half the term accrued, linear in seconds");
        assertEq(host.pending(address(0xBEEF)), paid, "credited the OWNER in the host's ledger");
        assertEq(host.escrow(), net - paid, "escrow drawn down by exactly what was paid out");
    }

    /// Events emitted by the library are attributed to the HOST's address, so an indexer watching
    /// the site sees them.
    function test_eventsAreAttributedToTheHost() public {
        vm.expectEmit(true, true, false, false, address(host));
        emit RentalsLib.RentalListed(KEY, address(this), 3e15, 7 days);
        host.doList(KEY, 3e15, 7 days);
    }
}
