/**
 * Transaction builders — the write half of the SDK.
 *
 * Every function here returns a request object for viem's `writeContract`/`simulateContract` rather
 * than sending anything. The SDK never owns a wallet, never picks a nonce and never decides when to
 * submit; that belongs to the app.
 *
 * **Two things these builders refuse to guess.**
 *
 * `expectedTerms` is required on every buy, with no bypass sentinel, because it has to reflect the
 * state the buyer was actually shown. A builder that read it fresh at submit time would defeat the
 * guard it exists to be — it would pick up the very change it should be rejecting. Read it with
 * `readBuyContext` (or `readEncumbrance`) in its own step and pass it in.
 *
 * `settlementToken` is required on every builder that moves money, because the two settlement paths
 * are not interchangeable and getting it wrong is not a warning. A native-shaped call against a
 * token site reverts `NativeNotAccepted`; a token-shaped call against a native site reverts
 * `InsufficientPayment` having sent nothing. Pass `readSiteTerms().settlementToken` through — the
 * builders set `value` from it, and there is no default, because a default would silently be right
 * for one kind of site and wrong for the other.
 */
import type { Abi, Address, Hex } from 'viem';

import slotFactoryAbiJson from './abi/SlotFactory.json';
import { SLOT_SITE_ABI } from './reads';
import { slotKey, slotKeys } from './keys';

export const SLOT_FACTORY_ABI = slotFactoryAbiJson as Abi;

/** What viem's `writeContract` / `simulateContract` take. */
export interface CallRequest<TName extends string, TArgs extends readonly unknown[]> {
  address: Address;
  abi: Abi;
  functionName: TName;
  args: TArgs;
  value?: bigint;
}

/**
 * How long a buy stays valid after it is built. Short, because the whole point of a deadline is
 * that a transaction stuck in the mempool through a price move should expire rather than land at a
 * price nobody agreed to.
 */
export const DEFAULT_DEADLINE_SECS = 300n;

/**
 * Slippage headroom applied to the quoted price when the caller does not supply an explicit
 * `maxPrice`. Zero would be correct and unusable: the quote is read a block or two before the
 * transaction lands, and any reversion boundary crossed in between changes the number.
 *
 * 1% is enough to absorb ordinary drift and far too little to absorb a take, which costs at least
 * 1.4x. A buyer who is displaced mid-flight gets `SlippageExceeded` rather than paying the new
 * owner's take price.
 */
export const DEFAULT_SLIPPAGE_BPS = 100n;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * `0x0` is native settlement; anything else is an ERC-20 whose `msg.value` must be exactly zero.
 *
 * Exported because the same question governs whether a UI needs an approval step, and answering it
 * twice in two places is how the two answers drift.
 */
export function isNativeSettlement(settlementToken: Address): boolean {
  return settlementToken.toLowerCase() === ZERO_ADDRESS;
}

/** `msg.value` for a call that pays `amount`. Zero on the token path — the site pulls instead. */
function payment(settlementToken: Address, amount: bigint): bigint {
  return isNativeSettlement(settlementToken) ? amount : 0n;
}

export interface BuildBuyOptions {
  site: Address;
  key: string;
  /**
   * What the caller was quoted — `SlotState.charged`. Used to derive `maxPrice` and `value` when
   * neither is given explicitly.
   *
   * **Not `netCost`.** The contract charges the gross price; the inherited rent arrives separately
   * as it accrues. Quoting the net figure here underfunds the call and reverts.
   */
  charged: bigint;
  /** `0x0` for native, the ERC-20 address otherwise. See the module note — there is no default. */
  settlementToken: Address;
  /** A freshly-read `encumbranceHash(key)` for the state the buyer was shown. Required. */
  expectedTerms: Hex;
  /** Overrides the derived `charged + slippage`. */
  maxPrice?: bigint;
  /** Basis points of headroom over `charged`. Ignored when `maxPrice` is given. */
  slippageBps?: bigint;
  /** Absolute unix seconds. Overrides `deadlineSecs`. */
  deadline?: bigint;
  /** Seconds from `now`. */
  deadlineSecs?: bigint;
  /**
   * The clock the deadline is measured from.
   *
   * **This should be the CHAIN's clock, not the client's.** `buy` compares its deadline against
   * `block.timestamp`; those are close on most chains and are not the same number. A user whose
   * system clock is ten minutes slow, or a chain whose timestamps lag, gets `DeadlineExpired` on
   * every purchase with nothing in the UI able to explain why. `buildBuyFrom` supplies it from a
   * pinned block; this defaults to `Date.now()` only so the builder stays usable without a client.
   */
  now?: bigint;
  /**
   * Who ends up OWNING the slot. Omit and the payer owns it (`buy`); supply it and the payer is
   * merely paying (`buyFor`).
   */
  recipient?: Address;
}

interface ResolvedBuy {
  maxPrice: bigint;
  deadline: bigint;
  /**
   * Sent as `msg.value` on a native site, and zero on a token site.
   *
   * Native: equal to `maxPrice`, not to `charged`. The contract reverts `InsufficientPayment` when
   * `msg.value` is below the price it actually computes, and that price can legitimately have moved
   * up to `maxPrice` since the quote. Overpayment is not lost — it is credited to the PAYER's pull
   * ledger, which is also what lets a relayer forward change back to whoever funded it.
   *
   * Token: the site pulls exactly the computed price via `transferFrom`, so there is no change
   * ledger on that path at all — but the ALLOWANCE still has to cover `maxPrice` for the same
   * reason the native value does.
   */
  value: bigint;
}

function resolveBuy(options: BuildBuyOptions): ResolvedBuy {
  const { charged, maxPrice, slippageBps = DEFAULT_SLIPPAGE_BPS, deadline, deadlineSecs, now } = options;

  const resolvedMax = maxPrice ?? charged + (charged * slippageBps) / 10_000n;
  if (resolvedMax < charged) {
    throw new RangeError(
      `websitekit/writes: maxPrice ${resolvedMax} is below the quoted price ${charged} — this reverts SlippageExceeded`,
    );
  }

  const nowSecs = now ?? BigInt(Math.floor(Date.now() / 1000));
  const resolvedDeadline = deadline ?? nowSecs + (deadlineSecs ?? DEFAULT_DEADLINE_SECS);

  return {
    maxPrice: resolvedMax,
    deadline: resolvedDeadline,
    value: payment(options.settlementToken, resolvedMax),
  };
}

/**
 * Builds a `buy` or a `buyFor` depending on whether `recipient` is given.
 *
 * §10.7 is why `buyFor` exists at all: `slot.owner = msg.sender` has already killed one
 * implementation in the sibling repo, and the implementation is frozen per clone. It unlocks
 * sponsored and gasless purchases (the case a non-technical product depends on entirely), gifting,
 * and a cross-site batch router.
 */
export function buildBuy(
  options: BuildBuyOptions,
):
  | CallRequest<'buy', [Hex, bigint, Hex, bigint]>
  | CallRequest<'buyFor', [Address, Hex, bigint, Hex, bigint]> {
  const { maxPrice, deadline, value } = resolveBuy(options);
  const key = slotKey(options.key);

  if (options.recipient) {
    return {
      address: options.site,
      abi: SLOT_SITE_ABI,
      functionName: 'buyFor',
      args: [options.recipient, key, maxPrice, options.expectedTerms, deadline],
      value,
    };
  }

  return {
    address: options.site,
    abi: SLOT_SITE_ABI,
    functionName: 'buy',
    args: [key, maxPrice, options.expectedTerms, deadline],
    value,
  };
}

/**
 * The path to reach for. Takes a `BuyContext` — quote, encumbrance and chain clock all read at one
 * pinned block — so the ways a buy can be built wrong are unavailable by construction: no torn read
 * between the quote and the terms, no wall-clock deadline, no forgotten `expectedTerms`.
 *
 * @example
 * const terms = await readSiteTerms(client, ref);
 * const context = await readBuyContext(client, ref, 'hero.headline');
 * await walletClient.writeContract(buildBuyFrom(ref.site, context, terms.settlementToken));
 */
export function buildBuyFrom(
  site: Address,
  context: { slot: { key: string; charged: bigint }; expectedTerms: Hex; now: bigint },
  settlementToken: Address,
  options: Pick<BuildBuyOptions, 'maxPrice' | 'slippageBps' | 'deadline' | 'deadlineSecs' | 'recipient'> = {},
) {
  return buildBuy({
    site,
    key: context.slot.key,
    charged: context.slot.charged,
    settlementToken,
    expectedTerms: context.expectedTerms,
    now: context.now,
    ...options,
  });
}

/**
 * Writes a slot's content hash. The bytes have to be stored somewhere retrievable by hash BEFORE
 * this lands — §3's first honest caveat is that reads are backend-free but writes are not. A hash
 * on-chain whose bytes were never uploaded is a permanently blank slot that looks exactly like a
 * bug in the SDK.
 *
 * During a live tenancy the TENANT is the only address this succeeds for; the owner is locked out
 * (§2.3). Check with `readCanEdit` rather than inferring from ownership.
 */
export function buildEdit(site: Address, key: string, contentHash: Hex): CallRequest<'edit', [Hex, Hex]> {
  return { address: site, abi: SLOT_SITE_ABI, functionName: 'edit', args: [slotKey(key), contentHash] };
}

/**
 * Grants or revokes delegated editing. Pass the zero address to revoke.
 *
 * The grant dies on its own when the slot changes hands, so this does not need pairing with a
 * cleanup call — but it also does not survive a take, so a slot bought back has to be re-granted.
 */
export function buildSetEditor(
  site: Address,
  key: string,
  editor: Address,
): CallRequest<'setEditor', [Hex, Address]> {
  return { address: site, abi: SLOT_SITE_ABI, functionName: 'setEditor', args: [slotKey(key), editor] };
}

// ---------------------------------------------------------------------------
// The ask — §3
// ---------------------------------------------------------------------------

/**
 * Posts the owner's **reversion base**: the price the slot reverts *from* over time.
 *
 * **This is not a list price and not what a buyer pays.** Nothing is for sale at `askFloor`; a
 * buyer still pays `takeBps` of the effective floor. What the ask does is stop reversion dragging
 * the position down to its floor while the owner still wants it — reversion is the abandonment
 * handler, and the ask is how a present, rational owner opts out of being treated as absent.
 *
 * Bounds the contract enforces: at least the slot's floor, and at most
 * `max(lastPrice, floor) * maxAskBps / 10_000`. Compute the ceiling with `askCeiling` from
 * `./pricing` to disable the control rather than letting the transaction revert `AskAboveCap`.
 *
 * Pass `0n` to clear it and fall back to `lastPrice`. A sale clears it automatically — a new owner
 * inherits no ask.
 */
export function buildSetAsk(site: Address, key: string, askFloor: bigint): CallRequest<'setAsk', [Hex, bigint]> {
  return { address: site, abi: SLOT_SITE_ABI, functionName: 'setAsk', args: [slotKey(key), askFloor] };
}

// ---------------------------------------------------------------------------
// Rentals — §2
// ---------------------------------------------------------------------------

/**
 * Lists a position for rent. Owner only.
 *
 * `ratePerDay` is per DAY; `maxDurationSecs` is in SECONDS (§2.5.3). The asymmetry is deliberate —
 * seconds make the fast-rotation regime expressible at all, while a per-second RATE would truncate
 * to zero on a 6-decimal token for any cheap position.
 *
 * Two contract rules worth knowing before the revert explains them: the rate must be at least
 * `minRentBps` of the position's *effective floor* (the anti-poisoning floor), and the term must sit
 * between one hour and the site's `maxRentalTerm`. Listing SNAPSHOTS the site's rent cut, which is
 * what lets `siteRentBps` stay freely mutable without a publisher baiting listings at 0%.
 *
 * A sale clears the listing but NOT an active tenancy: the new owner should not be renting out at a
 * rate they never chose, while the tenant keeps the term they paid for.
 */
export function buildListForRent(
  site: Address,
  key: string,
  ratePerDay: bigint,
  maxDurationSecs: bigint,
): CallRequest<'listForRent', [Hex, bigint, bigint]> {
  if (ratePerDay < 0n || maxDurationSecs < 0n) {
    throw new RangeError('websitekit/writes: rate and duration must be non-negative');
  }
  return {
    address: site,
    abi: SLOT_SITE_ABI,
    functionName: 'listForRent',
    args: [slotKey(key), ratePerDay, maxDurationSecs],
  };
}

/**
 * Withdraws a listing. Also the owner's escape valve from an incumbent tenant: `extendRental` needs
 * a live listing, so delisting means the arrangement ends cleanly at the current term's boundary
 * rather than rolling on at a rate the owner has come to regret.
 */
export function buildDelist(site: Address, key: string): CallRequest<'listForRent', [Hex, bigint, bigint]> {
  return { address: site, abi: SLOT_SITE_ABI, functionName: 'listForRent', args: [slotKey(key), 0n, 0n] };
}

export interface BuildRentOptions {
  site: Address;
  key: string;
  /** Seconds. At least one hour, at most the listing's `maxDurationSecs`. */
  durationSecs: bigint;
  /**
   * The rate the tenant was shown, from `readListing().ratePerDay`.
   *
   * Required and exact — the contract reverts `RateChanged` on any mismatch. This is the rental
   * path's `maxPrice`: without it an owner front-runs a rental by raising the rate between the quote
   * and the transaction.
   */
  expectedRatePerDay: bigint;
  settlementToken: Address;
  /** What the term costs. Compute with `quoteRent`/`rentCost` from `./rentals`. */
  cost: bigint;
}

/**
 * Opens a tenancy. Anyone may rent; the position must be owned (there is nobody to pay otherwise)
 * and must not already carry a tenancy — including a lapsed one that has not been cleared, which is
 * what makes `buildEndRental` load-bearing rather than housekeeping.
 */
export function buildRent(options: BuildRentOptions): CallRequest<'rent', [Hex, bigint, bigint]> {
  return {
    address: options.site,
    abi: SLOT_SITE_ABI,
    functionName: 'rent',
    args: [slotKey(options.key), options.durationSecs, options.expectedRatePerDay],
    value: payment(options.settlementToken, options.cost),
  };
}

/**
 * Extends a live tenancy. Current tenant only, and the term must not have lapsed.
 *
 * Three rules that surprise people: the cap applies to the REMAINING window rather than the total,
 * so no buyer ever inherits more than `maxRentalTerm` however many extensions preceded them; the
 * rate charged is the CURRENT listing's, not the one originally paid; and the unearned remainder of
 * the old term rolls forward into the new one rather than being refunded.
 */
export function buildExtendRental(options: BuildRentOptions): CallRequest<'extendRental', [Hex, bigint, bigint]> {
  return {
    address: options.site,
    abi: SLOT_SITE_ABI,
    functionName: 'extendRental',
    args: [slotKey(options.key), options.durationSecs, options.expectedRatePerDay],
    value: payment(options.settlementToken, options.cost),
  };
}

/**
 * Sweeps earned rent into the owner's pull ledger. Permissionless, and always credits the CURRENT
 * owner rather than the caller — so a keeper can run it for a whole directory without the SDK
 * needing to care who signs.
 *
 * Reverts `NothingToWithdraw` when nothing has accrued since the last sweep. Note a take settles
 * rent on the way through, so this often finds nothing on an actively-traded position.
 */
export function buildClaimRent(site: Address, key: string): CallRequest<'claimRent', [Hex]> {
  return { address: site, abi: SLOT_SITE_ABI, functionName: 'claimRent', args: [slotKey(key)] };
}

/**
 * Clears a lapsed tenancy and restores the owner's content hash. Permissionless once the term has
 * expired.
 *
 * **This is load-bearing for the mechanism, not just for tidiness.** `rent` refuses to open against
 * a lapsed-but-uncleared term, so until someone calls this the position has left the rental market
 * entirely — for everyone, indefinitely — and the expired tenant's content is still on the page.
 * A directory-wide keeper running this is infrastructure, not a nicety (§2.7).
 */
export function buildEndRental(site: Address, key: string): CallRequest<'endRental', [Hex]> {
  return { address: site, abi: SLOT_SITE_ABI, functionName: 'endRental', args: [slotKey(key)] };
}

// ---------------------------------------------------------------------------
// Registration and the publisher levers
// ---------------------------------------------------------------------------

/**
 * Registers slots. Site-owner only, and slots are closed by default — §7.5, without which anyone
 * who reads the site's repo buys `hero.headline` at floor before launch.
 *
 * `slotKeys` validates the whole batch and rejects duplicates before anything is sent, because
 * `registerSlots` reverts `SlotAlreadyRegistered` on the second occurrence — after the first has
 * already been written.
 *
 * Floors must be at least the site's `minFloor`, which is derived from the settlement token's
 * decimals (§11.2) and is therefore 1e14 on an 18-decimal chain and 100 units on 6-decimal USDG.
 * Parse them with `parseFloor` from `./config`, never with `parseEther`.
 */
export function buildRegisterSlots(
  site: Address,
  slots: Readonly<Record<string, bigint>>,
): CallRequest<'registerSlots', [Hex[], bigint[]]> {
  const names = Object.keys(slots);
  const keys = slotKeys(names);
  const floors = names.map((name) => {
    const floor = slots[name]!;
    if (floor <= 0n) {
      throw new RangeError(`websitekit/writes: "${name}" has floor ${floor} — a zero floor is free to claim`);
    }
    return floor;
  });
  return { address: site, abi: SLOT_SITE_ABI, functionName: 'registerSlots', args: [keys, floors] };
}

/** Moves a slot's floor, within the site's `floorDeltaBps` band and `floorChangeCooldown`. */
export function buildSetFloor(site: Address, key: string, floor: bigint): CallRequest<'setFloor', [Hex, bigint]> {
  return { address: site, abi: SLOT_SITE_ABI, functionName: 'setFloor', args: [slotKey(key), floor] };
}

/**
 * The publisher's listing toggle (§10.4): a registered slot with availability off cannot be
 * CLAIMED, and nothing else changes — takes and rentals on owned positions are deliberately
 * untouched, because "unpublish" ends where somebody paid. Registration is permanent; this is the
 * reversible half, and it is a batch call because a dashboard toggles boards, not keys.
 *
 * Legal on claimed slots (where it is inert until the position somehow empties), so a batch cannot
 * be raced into reverting by a claim landing mid-flight.
 */
export function buildSetAvailability(
  site: Address,
  keys: readonly string[],
  available: boolean,
): CallRequest<'setAvailability', [Hex[], boolean]> {
  return { address: site, abi: SLOT_SITE_ABI, functionName: 'setAvailability', args: [slotKeys(keys), available] };
}

/**
 * Changes the take economics. Owner only, and **one-directional once the first position is
 * claimed** (§6.1): `takeBps` may only fall, `payoutBps` may only rise, reversion may only get
 * slower, its horizon shorter, and the cooldown shorter. Before that first claim anything goes.
 *
 * The asymmetry with `buildSetRentalTerms` is the whole design: take economics bind a holder who
 * cannot exit, so they may only move in the direction that cannot strand one. Read `termsLocked`
 * from `readSiteTerms` to know which regime a site is in.
 */
export function buildSetEconomics(
  site: Address,
  economics: SiteEconomicsConfig,
): CallRequest<'setEconomics', [bigint, bigint, bigint, bigint, bigint]> {
  return {
    address: site,
    abi: SLOT_SITE_ABI,
    functionName: 'setEconomics',
    args: [
      economics.takeBps,
      economics.payoutBps,
      economics.reversionBps,
      economics.maxReversionWeeks,
      economics.cooldownSecs,
    ],
  };
}

/**
 * Changes the rental terms. Owner only, and **freely mutable in both directions even after the
 * lock** — because rent binds nobody involuntarily. An owner who dislikes a new rate simply does not
 * list, and a live tenancy is unaffected: the fee was taken at `rent` time and the site's cut is
 * snapshotted per listing. That recourse is exactly what take economics lack (§2.5.1).
 */
export function buildSetRentalTerms(
  site: Address,
  terms: { siteRentBps: bigint; maxRentalTerm: bigint; minRentBps: bigint },
): CallRequest<'setRentalTerms', [bigint, bigint, bigint]> {
  return {
    address: site,
    abi: SLOT_SITE_ABI,
    functionName: 'setRentalTerms',
    args: [terms.siteRentBps, terms.maxRentalTerm, terms.minRentBps],
  };
}

/** Tightens the floor lever and the ask cap. After the lock these may only tighten, never loosen. */
export function buildSetFloorPolicy(
  site: Address,
  policy: { floorDeltaBps: bigint; floorChangeCooldown: bigint; maxAskBps: bigint },
): CallRequest<'setFloorPolicy', [bigint, bigint, bigint]> {
  return {
    address: site,
    abi: SLOT_SITE_ABI,
    functionName: 'setFloorPolicy',
    args: [policy.floorDeltaBps, policy.floorChangeCooldown, policy.maxAskBps],
  };
}

/** Repoints the ERC-721 metadata base. Owner only, no redeploy. */
export function buildSetBaseTokenURI(site: Address, uri: string): CallRequest<'setBaseTokenURI', [string]> {
  return { address: site, abi: SLOT_SITE_ABI, functionName: 'setBaseTokenURI', args: [uri] };
}

// ---------------------------------------------------------------------------
// The pull ledger
// ---------------------------------------------------------------------------

/** Claims a pending balance. Permissionless and pays the account that is owed, never the caller. */
export function buildWithdrawFor(site: Address, account: Address): CallRequest<'withdrawFor', [Address]> {
  return { address: site, abi: SLOT_SITE_ABI, functionName: 'withdrawFor', args: [account] };
}

/** Moves part of the site's treasury. Owner only. */
export function buildWithdrawTreasury(site: Address, amount: bigint): CallRequest<'withdrawTreasury', [bigint]> {
  return { address: site, abi: SLOT_SITE_ABI, functionName: 'withdrawTreasury', args: [amount] };
}

/**
 * Sweeps the whole treasury to the site's `treasury` address. Permissionless, and pays `treasury`
 * rather than the caller — so it grants no authority, on identical reasoning to `withdrawFor`.
 *
 * This is what lets a managed publisher's revenue arrive on a schedule without them ever signing
 * anything (§10.4). Full sweep rather than partial so nobody can grief with dust.
 */
export function buildSweepTreasury(site: Address): CallRequest<'sweepTreasury', []> {
  return { address: site, abi: SLOT_SITE_ABI, functionName: 'sweepTreasury', args: [] };
}

// ---------------------------------------------------------------------------
// ERC-20 settlement
// ---------------------------------------------------------------------------

/** The two entries of ERC-20 the token settlement path actually needs. */
export const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

/**
 * Approves the site to pull settlement funds. Only needed on a token site — check with
 * `isNativeSettlement` first, and skip the whole step when it returns true.
 *
 * The site pulls exactly what it computes, so the allowance must cover `maxPrice` rather than the
 * quoted price: the same reason the native path sends `maxPrice` as `msg.value`.
 *
 * Deliberately NOT defaulted to an infinite approval. An unbounded allowance on a frozen contract
 * that can never be patched is a standing risk the user did not ask for, and the amount is knowable
 * exactly at the point of the call.
 */
export function buildApproveSettlement(
  settlementToken: Address,
  site: Address,
  amount: bigint,
): CallRequest<'approve', [Address, bigint]> {
  if (isNativeSettlement(settlementToken)) {
    throw new Error(
      'websitekit/writes: this site settles natively — there is nothing to approve. Guard with `isNativeSettlement`.',
    );
  }
  return { address: settlementToken, abi: ERC20_ABI as Abi, functionName: 'approve', args: [site, amount] };
}

// ---------------------------------------------------------------------------
// Deploying a site
// ---------------------------------------------------------------------------

/**
 * The take economics a site starts with. Mutable before the first claim and a one-way ratchet after
 * it (§6.1) — so this is a starting point rather than a permanent choice, which is a real change
 * from v1 where every field here was frozen at `initialize()` forever.
 */
export interface SiteEconomicsConfig {
  /** 1.4x is `14_000`. Must exceed `payoutBps + protocolBps`, and is capped at `30_000`. */
  takeBps: bigint;
  /** 1.15x is `11_500`. Must be at least `10_000` — a site can only monetize the spread. */
  payoutBps: bigint;
  /** Per-week reversion. `9_700` is 0.97 (the Standard profile); `10_000` is none at all. */
  reversionBps: bigint;
  /** Capped at 52. */
  maxReversionWeeks: bigint;
  /** Minimum seconds between takes on one slot. Capped at 7 days. */
  cooldownSecs: bigint;
}

/** The rental policy. Freely mutable for the site's whole life (§2.5.1). */
export interface SiteRentalConfig {
  /** The site's cut of rent. `siteRentBps + protocolRentBps` must land in `[1_000, 4_000]`. */
  siteRentBps: bigint;
  /** The longest term the site will allow, in seconds. One hour to 365 days. */
  maxRentalTerm: bigint;
  /** Anti-poisoning rate floor, in bps of a position's effective floor, per day. `1..10_000`. */
  minRentBps: bigint;
}

/** The floor lever and the ask cap. May only tighten after the first claim. */
export interface SiteFloorPolicyConfig {
  /** How far one `setFloor` may move a floor. `1..2_000`. */
  floorDeltaBps: bigint;
  /** Seconds between floor changes. At least 24 hours. */
  floorChangeCooldown: bigint;
  /** Ceiling on an owner's ask, in bps of `max(lastPrice, floor)`. At least `10_000`. */
  maxAskBps: bigint;
}

export interface BuildCreateSiteOptions {
  factory: Address;
  name: string;
  symbol: string;
  baseTokenURI: string;
  treasury: Address;
  /**
   * `0x0` for native, or the ERC-20 to settle in. **Frozen at deploy with no setter, ever** —
   * changing it would orphan every balance on the ledger. It also fixes `minFloor`, which is derived
   * from the token's decimals.
   */
  settlementToken: Address;
  economics: SiteEconomicsConfig;
  rentals: SiteRentalConfig;
  floorPolicy: SiteFloorPolicyConfig;
  /** Registered in the same transaction as the deploy, so one tx produces a working board. */
  slots?: Readonly<Record<string, bigint>>;
  royaltyBps?: bigint;
  /** §7.5. Leave off unless the site genuinely wants a free-for-all key namespace. */
  openRegistration?: boolean;
  /** Floor an auto-registered key gets. Required when `openRegistration` is on. */
  defaultFloor?: bigint;
  /**
   * Who owns the SITE. Omit and the sender owns it (`createSite`); supply it and the sender is
   * merely paying (`createSiteFor`) — §10.8, the same trap as `buyFor` one level up.
   */
  owner?: Address;
}

/** The v2 `SiteConfig` struct, in the contract's field order. */
interface SiteConfigTuple {
  name: string;
  symbol: string;
  baseTokenURI: string;
  treasury: Address;
  settlementToken: Address;
  takeBps: bigint;
  payoutBps: bigint;
  reversionBps: bigint;
  maxReversionWeeks: bigint;
  cooldownSecs: bigint;
  defaultFloor: bigint;
  floorDeltaBps: bigint;
  floorChangeCooldown: bigint;
  maxAskBps: bigint;
  minRentBps: bigint;
  siteRentBps: bigint;
  maxRentalTerm: bigint;
  openRegistration: boolean;
  royaltyBps: bigint;
}

/**
 * Builds `createSite` or `createSiteFor`.
 *
 * The clamps below are duplicated from the contract's `_validateConfig` on purpose, and this is the
 * one place in the SDK where duplicating a contract rule is right: the contract's version is the
 * authority and reverts, but a revert here costs a deploy transaction and produces an error selector
 * rather than a sentence. Catching it locally turns "your site failed to deploy" into "payoutBps
 * must be at least 10_000 so a displaced owner gets their principal back".
 */
export function buildCreateSite(
  options: BuildCreateSiteOptions,
):
  | CallRequest<'createSite', [SiteConfigTuple, Hex[], bigint[]]>
  | CallRequest<'createSiteFor', [Address, SiteConfigTuple, Hex[], bigint[]]> {
  const { economics, rentals, floorPolicy, slots = {}, royaltyBps = 0n } = options;
  const openRegistration = options.openRegistration ?? false;
  const defaultFloor = options.defaultFloor ?? 0n;

  assertSiteConfig(options, openRegistration, defaultFloor, royaltyBps);

  const names = Object.keys(slots);
  const keys = slotKeys(names);
  const floors = names.map((name) => slots[name]!);

  const config: SiteConfigTuple = {
    name: options.name,
    symbol: options.symbol,
    baseTokenURI: options.baseTokenURI,
    treasury: options.treasury,
    settlementToken: options.settlementToken,
    takeBps: economics.takeBps,
    payoutBps: economics.payoutBps,
    reversionBps: economics.reversionBps,
    maxReversionWeeks: economics.maxReversionWeeks,
    cooldownSecs: economics.cooldownSecs,
    defaultFloor,
    floorDeltaBps: floorPolicy.floorDeltaBps,
    floorChangeCooldown: floorPolicy.floorChangeCooldown,
    maxAskBps: floorPolicy.maxAskBps,
    minRentBps: rentals.minRentBps,
    siteRentBps: rentals.siteRentBps,
    maxRentalTerm: rentals.maxRentalTerm,
    openRegistration,
    royaltyBps,
  };

  if (options.owner) {
    return {
      address: options.factory,
      abi: SLOT_FACTORY_ABI,
      functionName: 'createSiteFor',
      args: [options.owner, config, keys, floors],
    };
  }

  return {
    address: options.factory,
    abi: SLOT_FACTORY_ABI,
    functionName: 'createSite',
    args: [config, keys, floors],
  };
}

export class InvalidEconomicsError extends Error {
  constructor(message: string) {
    super(`websitekit/writes: ${message}`);
    this.name = 'InvalidEconomicsError';
  }
}

const ONE_HOUR = 3_600n;
const ONE_DAY = 86_400n;
const SEVEN_DAYS = 604_800n;
const ONE_YEAR = 31_536_000n;

/**
 * Mirrors the contract's clamps, minus the two it cannot know.
 *
 * `protocolBps` and `protocolRentBps` are immutables in the implementation and are not derivable
 * from a config object, so `takeBps > payoutBps + protocolBps` and the rent-fee band are only
 * PARTIALLY checkable here — both are completed on-chain. What is checked is everything that does
 * not depend on them, which is where the mistakes actually are.
 */
function assertSiteConfig(
  options: BuildCreateSiteOptions,
  openRegistration: boolean,
  defaultFloor: bigint,
  royaltyBps: bigint,
): void {
  const e = options.economics;
  if (e.payoutBps < 10_000n) {
    throw new InvalidEconomicsError(
      `payoutBps must be at least 10_000 so a displaced owner gets their principal back, got ${e.payoutBps}`,
    );
  }
  if (e.takeBps > 30_000n) {
    throw new InvalidEconomicsError(`takeBps is capped at 30_000 (3x), got ${e.takeBps}`);
  }
  if (e.takeBps <= e.payoutBps) {
    throw new InvalidEconomicsError(
      `takeBps (${e.takeBps}) must exceed payoutBps (${e.payoutBps}) plus the implementation's protocolBps`,
    );
  }
  if (e.reversionBps === 0n || e.reversionBps > 10_000n) {
    throw new InvalidEconomicsError(`reversionBps must be in 1..10_000, got ${e.reversionBps}`);
  }
  if (e.maxReversionWeeks > 52n) {
    throw new InvalidEconomicsError(`maxReversionWeeks is capped at 52, got ${e.maxReversionWeeks}`);
  }
  if (e.cooldownSecs > SEVEN_DAYS) {
    throw new InvalidEconomicsError(`cooldownSecs is capped at 7 days, got ${e.cooldownSecs}`);
  }

  const f = options.floorPolicy;
  if (f.floorDeltaBps === 0n || f.floorDeltaBps > 2_000n) {
    throw new InvalidEconomicsError(`floorDeltaBps must be in 1..2_000 (±20%), got ${f.floorDeltaBps}`);
  }
  if (f.floorChangeCooldown < ONE_DAY) {
    throw new InvalidEconomicsError(`floorChangeCooldown must be at least 24h, got ${f.floorChangeCooldown}s`);
  }
  if (f.maxAskBps < 10_000n) {
    throw new InvalidEconomicsError(
      `maxAskBps must be at least 10_000, or an owner could not ask their own cost, got ${f.maxAskBps}`,
    );
  }

  const r = options.rentals;
  // Only the site's own share is checkable here; the band is on the TOTAL including protocolRentBps.
  if (r.siteRentBps > 4_000n) {
    throw new InvalidEconomicsError(
      `siteRentBps alone exceeds the 4_000 ceiling on the total rent fee, got ${r.siteRentBps}`,
    );
  }
  if (r.maxRentalTerm < ONE_HOUR || r.maxRentalTerm > ONE_YEAR) {
    throw new InvalidEconomicsError(
      `maxRentalTerm must be between 1 hour and 365 days in SECONDS, got ${r.maxRentalTerm}`,
    );
  }
  if (r.minRentBps === 0n || r.minRentBps > 10_000n) {
    throw new InvalidEconomicsError(`minRentBps must be in 1..10_000, got ${r.minRentBps}`);
  }

  if (royaltyBps > 1_000n) {
    throw new InvalidEconomicsError(`royaltyBps is capped at 1_000 (10%), got ${royaltyBps}`);
  }
  if (openRegistration && defaultFloor <= 0n) {
    throw new InvalidEconomicsError('openRegistration needs a non-zero defaultFloor, or every key is free');
  }
}

/**
 * The EIP-712 payload an owner signs to delegate editing without transacting.
 *
 * The domain binds the CLONE's address, not the implementation's — without that, a signature scoped
 * to one site would be replayable on every other site cloned from the same bytecode, which is every
 * site on the chain. `name` is the site's ERC-721 name, which has no setter and so cannot move under
 * a signature already in flight.
 */
export function editorGrantTypedData(options: {
  site: Address;
  chainId: number;
  siteName: string;
  key: string;
  editor: Address;
  /** The owner's current `editorNonces(owner)`. Read it; do not assume zero. */
  nonce: bigint;
  deadline: bigint;
}) {
  return {
    domain: {
      name: options.siteName,
      version: '1',
      chainId: options.chainId,
      verifyingContract: options.site,
    },
    types: {
      EditorGrant: [
        { name: 'key', type: 'bytes32' },
        { name: 'editor', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'EditorGrant' as const,
    message: {
      key: slotKey(options.key),
      editor: options.editor,
      nonce: options.nonce,
      deadline: options.deadline,
    },
  };
}

/**
 * Relays a grant the owner signed. The submitter pays the gas and gains nothing — the grant records
 * the OWNER as grantor, so a relayer cannot make itself the editor by relaying.
 */
export function buildSetEditorWithSig(
  site: Address,
  key: string,
  editor: Address,
  deadline: bigint,
  signature: Hex,
): CallRequest<'setEditorWithSig', [Hex, Address, bigint, Hex]> {
  return {
    address: site,
    abi: SLOT_SITE_ABI,
    functionName: 'setEditorWithSig',
    args: [slotKey(key), editor, deadline, signature],
  };
}
