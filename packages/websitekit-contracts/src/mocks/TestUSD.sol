// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title TestUSD — a mintable settlement token for testnets and local chains.
 * @notice NOT A PRODUCTION TOKEN. Anyone can mint it, so a unit of it is worth exactly nothing.
 *
 * @dev This exists because a token-settled board could not be exercised on a real chain by anyone
 * who did not already hold the token. Chain 46630's USDG (`0x7E95…`) is a Paxos-shaped contract
 * whose `mint` and `increaseSupplyToAddress` are role-gated and whose roles we do not hold, so a
 * board settling in it is a board nobody can buy from. Native settlement was not the answer:
 * `PIVOT-MAP` #25 settles that the managed platform issues dollar-denominated boards only, because
 * a native board cannot show dollars without the price feed the design refuses.
 *
 * So the stand-in is the answer, and its `mint` being permissionless IS the faucet — there is no
 * separate faucet contract, no role to administer, and no funded dispenser to keep topped up.
 *
 * **What this must NOT become.** `test/SlotSiteBase.t.sol`'s `MockToken` is the same shape and is
 * deliberately not reused here: it carries `freeze(address)` and `setReturnsNothing(bool)`, both
 * permissionless, which model the issuer-freeze and USDT-return surfaces that `SafeERC20` exists to
 * absorb. Under `vm.prank` those are a test instrument. Deployed to a public chain they are a
 * griefing switch a stranger could throw at the relayer or at any live board, permanently. This
 * contract is the standard-behaviour subset, and the two files should stay separate for that reason.
 *
 * **Why OpenZeppelin's `ERC20` rather than a hand-rolled one.** It holds no real value, but it does
 * hold state that boards settle against, and a bespoke `transferFrom` is a place to put a bug for
 * no gain. The protocol contracts are hand-written because they had to fit under EIP-170; this has
 * no such constraint.
 *
 * **`decimals` is a constructor argument and is the parameter that matters.** §11.2: `minFloor` is
 * `10 ** (decimals - 4)`, so a token deployed at 18 decimals against floors written for 6 is wrong
 * by 1e12 — and silently correct on a native board, which is what makes the mistake survivable long
 * enough to reach a deploy. Deploy the stand-in with the decimals of the token it stands in for.
 */
contract TestUSD is ERC20 {
    /**
     * @dev Whole units mintable in one call.
     *
     * Not a scarcity measure — the supply is unbounded across calls and is meant to be. It exists
     * so a single `mint(to, type(uint256).max)` cannot park `totalSupply` one increment below
     * overflow and make every subsequent mint revert, which would brick the faucet for everyone
     * else at the cost of one transaction. Reaching the same state through this cap takes on the
     * order of 1e65 calls.
     */
    uint256 public constant MAX_MINT_WHOLE_UNITS = 1_000_000;

    uint8 private immutable _decimals;

    /// @notice The raw-unit ceiling on one `mint`, derived from this token's own decimals.
    uint256 public immutable maxMintPerCall;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
        maxMintPerCall = MAX_MINT_WHOLE_UNITS * (10 ** uint256(decimals_));
    }

    /// @dev `ERC20` hardcodes 18; a settlement stand-in that cannot be 6 is useless here.
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /**
     * @notice Mints to any address, for anyone who asks. This is the faucet.
     * @dev `to` is explicit rather than `msg.sender`, on this repo's standing check: if a function
     * confers a right, the beneficiary must be nameable separately from whoever pays the gas. Here
     * that is what lets the platform's relayer fund a buyer's account in one call.
     */
    function mint(address to, uint256 amount) external {
        require(amount <= maxMintPerCall, "TestUSD: over the per-call cap");
        _mint(to, amount);
    }
}
