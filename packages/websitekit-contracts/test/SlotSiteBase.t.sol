// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { SlotSite } from "../src/SlotSite.sol";
import { SlotFactory } from "../src/SlotFactory.sol";
import { RentalsLib } from "../src/RentalsLib.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice A 6-decimal settlement token, because that is what USDG is (spec §1.5) and a
/// 6-decimal/18-decimal mix-up is a silent 1e12 bug that the SDK has already shipped once.
/// `returnsFalse` and `returnsNothing` model the two non-standard ERC-20 shapes `SafeERC20` exists
/// to absorb — USDT returns no boolean.
contract MockToken is IERC20 {
    string public name = "Mock Global Dollar";
    string public symbol = "mUSDG";
    uint8 public decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    bool public returnsNothing;
    address public frozen;

    function setReturnsNothing(bool v) external {
        returnsNothing = v;
    }

    /// @notice Models the issuer freeze surface documented in spec §1.5 Finding 5.
    function freeze(address a) external {
        frozen = a;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
        totalSupply += amt;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        _move(msg.sender, to, amt);
        if (returnsNothing) {
            assembly {
                return(0, 0)
            }
        }
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amt, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amt;
        _move(from, to, amt);
        return true;
    }

    function _move(address from, address to, uint256 amt) internal {
        require(from != frozen && to != frozen, "frozen");
        require(balanceOf[from] >= amt, "balance");
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        emit Transfer(from, to, amt);
    }
}

/// @notice Shared v2 fixture.
///
/// Every suite builds sites through the FACTORY, because the clone path is the only path that will
/// exist in production and a directly-deployed implementation differs in exactly the ways that
/// matter (storage-set-once config, no constructor).
///
/// `USE_TOKEN` is overridden by the token suites so the same behavioural tests run against both
/// settlement paths. The ERC-20 branch touches every money path (spec §1.2), so anything asserted
/// about money must be asserted twice.
abstract contract SlotSiteBase is Test {
    SlotSite internal implementation;
    SlotFactory internal factory;
    SlotSite internal site;
    MockToken internal token;

    address internal siteOwner = makeAddr("siteOwner");
    address internal siteTreasury = makeAddr("siteTreasury");
    address internal protocolTreasury = makeAddr("protocolTreasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal advertiser = makeAddr("advertiser");
    address internal keeper = makeAddr("keeper");

    uint256 internal constant PROTOCOL_BPS = 500; // 5%
    uint256 internal constant PROTOCOL_RENT_BPS = 500; // 5%, mirrors the buy path (spec §2.5)
    uint256 internal constant TAKE_BPS = 14_000; // 1.4x
    uint256 internal constant PAYOUT_BPS = 11_500; // 1.15x
    uint256 internal constant REVERSION_BPS = 9_700; // 0.97/wk — the Standard profile (spec §6.4)
    uint256 internal constant MAX_REVERSION_WEEKS = 52;
    uint256 internal constant COOLDOWN_SECS = 900;
    uint256 internal constant SITE_RENT_BPS = 2_500; // 25%
    uint64 internal constant MAX_RENTAL_TERM = 30 days;
    uint256 internal constant MIN_RENT_BPS = 25; // 0.25%/day of effective floor
    uint256 internal constant MAX_ASK_BPS = 40_000; // 4x
    uint256 internal constant FLOOR_DELTA_BPS = 2_000; // +/-20%
    uint256 internal constant FLOOR_CHANGE_COOLDOWN = 24 hours;

    bytes32 internal constant HERO_HEADLINE = keccak256("hero.headline");
    bytes32 internal constant HERO_IMAGE = keccak256("hero.image");
    bytes32 internal constant NAV_LINK_1 = keccak256("nav.link.1");

    function USE_TOKEN() internal view virtual returns (bool) {
        return false;
    }

    function setUp() public virtual {
        token = new MockToken();
        implementation = new SlotSite(PROTOCOL_BPS, PROTOCOL_RENT_BPS, protocolTreasury);
        // `address(RentalsLib)` resolves to the linked library, which is what a clone will
        // delegatecall — so every test in this tree exercises the real link.
        factory = new SlotFactory(address(implementation), address(RentalsLib));

        (bytes32[] memory keys, uint256[] memory floors) = _defaultSlots();
        vm.prank(siteOwner);
        site = SlotSite(payable(factory.createSite(_defaultConfig(), keys, floors)));

        address[6] memory funded = [alice, bob, carol, advertiser, keeper, siteOwner];
        for (uint256 i = 0; i < funded.length; i++) {
            vm.deal(funded[i], 100 ether);
            token.mint(funded[i], 1_000_000e6);
            vm.prank(funded[i]);
            token.approve(address(site), type(uint256).max);
        }
    }

    /// @notice One unit of the settlement currency, so floors read the same in both variants.
    function _unit() internal view returns (uint256) {
        return USE_TOKEN() ? 1e6 : 1e18;
    }

    function _floor() internal view returns (uint256) {
        return _unit() / 100; // $0.01-equivalent
    }

    function _defaultConfig() internal view returns (SlotSite.SiteConfig memory) {
        return SlotSite.SiteConfig({
            name: "Example Site",
            symbol: "EXMPL",
            baseTokenURI: "https://example.com/slot/",
            treasury: siteTreasury,
            settlementToken: USE_TOKEN() ? address(token) : address(0),
            takeBps: TAKE_BPS,
            payoutBps: PAYOUT_BPS,
            reversionBps: REVERSION_BPS,
            maxReversionWeeks: MAX_REVERSION_WEEKS,
            cooldownSecs: COOLDOWN_SECS,
            defaultFloor: 0,
            floorDeltaBps: FLOOR_DELTA_BPS,
            floorChangeCooldown: FLOOR_CHANGE_COOLDOWN,
            maxAskBps: MAX_ASK_BPS,
            minRentBps: MIN_RENT_BPS,
            siteRentBps: SITE_RENT_BPS,
            maxRentalTerm: MAX_RENTAL_TERM,
            openRegistration: false,
            royaltyBps: 500
        });
    }

    function _defaultSlots() internal view returns (bytes32[] memory keys, uint256[] memory floors) {
        keys = new bytes32[](3);
        keys[0] = HERO_HEADLINE;
        keys[1] = HERO_IMAGE;
        keys[2] = NAV_LINK_1;
        floors = new uint256[](3);
        floors[0] = _floor();
        floors[1] = _floor() * 5;
        floors[2] = _floor() * 2;
    }

    function _keys(bytes32 a) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](1);
        out[0] = a;
    }

    function _floors(uint256 a) internal pure returns (uint256[] memory out) {
        out = new uint256[](1);
        out[0] = a;
    }

    // -----------------------------------------------------------------
    // Buy helpers
    //
    // `terms` is read into a local BEFORE the prank, never passed inline. Solidity evaluates call
    // arguments first, so `site.buy(..., site.encumbranceHash(key), ...)` spends the prank on the
    // `encumbranceHash` read and sends the buy from the test contract — which looks exactly like a
    // broken access check rather than a broken test. Same trap for `sha256`, a precompile call.
    // -----------------------------------------------------------------

    function _pay(address who, uint256 amount) internal view returns (uint256 value) {
        who;
        return USE_TOKEN() ? 0 : amount;
    }

    function _claim(address buyer, bytes32 key) internal returns (uint256 charged) {
        (charged,) = site.quote(key);
        bytes32 terms = site.encumbranceHash(key);
        vm.prank(buyer);
        site.buy{ value: _pay(buyer, charged) }(key, charged, terms, block.timestamp);
    }

    function _take(address buyer, bytes32 key) internal returns (uint256 charged) {
        (, charged) = site.quote(key);
        bytes32 terms = site.encumbranceHash(key);
        vm.prank(buyer);
        site.buy{ value: _pay(buyer, charged) }(key, charged, terms, block.timestamp);
    }

    function _edit(address who, bytes32 key, bytes32 hash) internal {
        vm.prank(who);
        site.edit(key, hash);
    }

    // -----------------------------------------------------------------
    // Rental helpers
    // -----------------------------------------------------------------

    /// @notice The fair rate is ~1.64%/day of the effective floor (spec §2.5.2); the anti-poison
    /// floor is `minRentBps`. Tests list at the fair rate unless they are probing the floor.
    function _fairRatePerDay(bytes32 key) internal view returns (uint256) {
        (uint256 effectiveFloor,) = site.quote(key);
        return (effectiveFloor * 164) / 10_000;
    }

    function _list(address owner_, bytes32 key, uint256 ratePerDay, uint64 maxDur) internal {
        vm.prank(owner_);
        site.listForRent(key, ratePerDay, maxDur);
    }

    function _rent(address tenant, bytes32 key, uint64 durationSecs) internal returns (uint256 cost) {
        (uint192 rate,,) = site.listings(key);
        cost = (uint256(rate) * durationSecs) / 86_400;
        vm.prank(tenant);
        site.rent{ value: _pay(tenant, cost) }(key, durationSecs, rate);
    }

    function _extend(address tenant, bytes32 key, uint64 durationSecs) internal returns (uint256 cost) {
        (uint192 rate,,) = site.listings(key);
        cost = (uint256(rate) * durationSecs) / 86_400;
        vm.prank(tenant);
        site.extendRental{ value: _pay(tenant, durationSecs == 0 ? 0 : cost) }(key, durationSecs, rate);
    }

    function _rentalOf(bytes32 key)
        internal
        view
        returns (address tenant, uint64 start, uint64 expiry, uint256 prepaid, uint256 claimed)
    {
        (tenant, start, expiry, prepaid, claimed,) = site.rentals(key);
    }

    // -----------------------------------------------------------------
    // Solvency
    // -----------------------------------------------------------------

    /// @notice §7.1's per-clone solvency invariant, extended for v2's second money path.
    ///
    /// Escrowed rent is money the contract holds on behalf of a tenancy that has not yet accrued, so
    /// it belongs on the owed side alongside the pull ledger and the treasury.
    ///
    /// **Asserted only in tests, never on-chain.** Spec §1.5 Finding 5: the settlement token's
    /// issuer can freeze or wipe an address, which would make an on-chain equality assertion
    /// permanently false and brick every path that checked it.
    function _assertSolvent() internal view {
        address[8] memory accounts =
            [alice, bob, carol, advertiser, keeper, siteOwner, siteTreasury, protocolTreasury];
        uint256 owed = site.treasuryBalance() + site.totalEscrowedRent();
        for (uint256 i = 0; i < accounts.length; i++) {
            owed += site.pendingWithdrawals(accounts[i]);
        }
        uint256 held = USE_TOKEN() ? token.balanceOf(address(site)) : address(site).balance;
        assertEq(owed, held, "site owes more than it holds");
    }
}
