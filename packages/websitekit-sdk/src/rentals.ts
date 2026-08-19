/**
 * The TypeScript twin of the rent arithmetic in
 * `packages/websitekit-contracts/src/RentalsLib.sol` — spec §2.
 *
 * Structurally identical to the Solidity, line for line: same order of operations, same truncation
 * points, same guard placement. The same rule that governs `pricing.ts` governs this file, for the
 * same reason — a client that computes a rent cost the chain disagrees with produces a transaction
 * that reverts, and one that computes an *accrual* the chain disagrees with produces something
 * worse: a UI that tells an owner they are owed money they are not.
 *
 * Native `BigInt` only, never a decimal library: `decimal.js`/`big.js` implement their own rounding
 * rules with no guarantee of matching Solidity integer truncation op-for-op, which would make the
 * library an unverified third party in the parity chain.
 *
 * Everything here is swept against the chain by `pricing.v2-parity.test.ts` through
 * `script/GenV2Vectors.s.sol`, including the rows where checked arithmetic reverts — `BigInt` has no
 * word size, so without the guards the twin would return a perfectly reasonable-looking number for
 * inputs the chain refuses.
 */

import { BPS_DENOMINATOR, PricingOverflowError } from './pricing';

/** Seconds in a day. Rent rates are quoted per day; durations are in seconds (§2.5.3). */
export const SECONDS_PER_DAY = 86_400n;

/** The shortest term the contract will open or extend (§2.5.3). */
export const MIN_RENTAL_DURATION = 3_600n;

const U256_MAX = (1n << 256n) - 1n;

/** `a * b`, throwing exactly where Solidity's checked multiply reverts. */
function mul(a: bigint, b: bigint): bigint {
  const result = a * b;
  if (result > U256_MAX) throw new PricingOverflowError('multiply');
  return result;
}

/** `a - b`, throwing exactly where Solidity's checked subtract reverts. */
function sub(a: bigint, b: bigint): bigint {
  if (b > a) throw new PricingOverflowError('subtract');
  return a - b;
}

export interface Accrual {
  /** Rent the owner has earned so far, whether or not it has been claimed. */
  accrued: bigint;
  /**
   * The part of the escrow not yet earned — **what a buyer inherits.**
   *
   * §2.4.2 calls surfacing this the single highest-value client change in the release: without it an
   * encumbered position reads as unbuyable, when it is actually being sold at a discount to the
   * income stream it carries. Effective cost to a buyer is `takePrice - unaccrued`.
   */
  unaccrued: bigint;
}

/**
 * Mirrors `RentalsLib.accruedOf`. Linear accrual over the term, with no segment history — which is
 * what lets `extendRental` settle and restart with a single formula instead of a schedule.
 *
 * `expiry === 0n` means **no tenancy**, not "a term that ended at the epoch", and it has to be
 * checked first: without that guard a cleared rental divides by zero rather than returning nothing.
 *
 * The clamp `end = min(nowTs, expiry)` is what stops a term earning past its expiry, and it is also
 * what makes accrual reach exactly `prepaid` once the term has lapsed — the property `endRental`
 * relies on to drain escrow to zero, since it refuses to run any earlier.
 *
 * @param nowTs Seconds since the epoch. Pass the CHAIN's timestamp where you have one; a wall-clock
 * `Date.now()/1000` drifts from it, and this function is the difference between two timestamps
 * rather than a duration, so the drift lands straight in the result.
 */
export function accruedOf(prepaid: bigint, start: bigint, expiry: bigint, nowTs: bigint): bigint {
  if (expiry === 0n) return 0n;
  const end = nowTs < expiry ? nowTs : expiry;
  if (end <= start) return 0n;
  return mul(prepaid, end - start) / (expiry - start);
}

/**
 * Both legs at once. Prefer this to calling `accruedOf` and subtracting by hand: the identity
 * `accrued + unaccrued === prepaid` holds exactly, and computing the two independently is how a
 * caller ends up rendering a total that does not add up.
 */
export function accrual(prepaid: bigint, start: bigint, expiry: bigint, nowTs: bigint): Accrual {
  const accrued = accruedOf(prepaid, start, expiry, nowTs);
  return { accrued, unaccrued: sub(prepaid, accrued) };
}

/**
 * Mirrors `RentalsLib.rentCost`. Gross rent for a term.
 *
 * The RATE is per day and the DURATION is in seconds (§2.5.3) — the rate stays per-day because a
 * per-second rate truncates to zero on a 6-decimal token for any cheap position. This is the one
 * place those units meet, and the place where a short term on a cheap position costs literally
 * nothing. That is admissible rather than a bug, so callers must not assume a positive cost.
 */
export function rentCost(ratePerDay: bigint, durationSecs: bigint): bigint {
  return mul(ratePerDay, durationSecs) / SECONDS_PER_DAY;
}

export interface RentSplit {
  /** To the protocol treasury. */
  protocolCut: bigint;
  /** To the site's treasury, at the rate snapshotted on the listing when it was written. */
  siteCut: bigint;
  /** Escrowed, and streamed to whoever owns the position as it accrues. */
  net: bigint;
}

/**
 * Mirrors `RentalsLib.rentSplit` — spec §2.5.
 *
 * **Both cuts are keyed to the GROSS cost, so the two truncations are independent**, and `net` is
 * what remains after both rather than a third percentage of anything. Deriving it as a subtraction
 * is what makes the three legs sum to `cost` exactly — which is in turn what lets the contract's
 * escrow total reconcile against the sum of its live tenancies.
 *
 * `feeBps` is the site's cut **as snapshotted on the listing**, not the site's current
 * `siteRentBps`. That distinction is the whole reason `siteRentBps` can be freely mutable (§2.5.1)
 * without letting a publisher advertise 0% and raise it before anyone rents — so read it from the
 * listing, never from site config.
 *
 * Throws where the contract reverts, which here means any `protocolRentBps + feeBps > 10_000`. The
 * contract clamps the total to `[1_000, 4_000]` and re-checks it at list time; this does not
 * re-validate, so a caller inventing a split gets a throw rather than a number no site can produce.
 */
export function rentSplit(cost: bigint, protocolRentBps: bigint, feeBps: bigint): RentSplit {
  const protocolCut = mul(cost, protocolRentBps) / BPS_DENOMINATOR;
  const siteCut = mul(cost, feeBps) / BPS_DENOMINATOR;
  return { protocolCut, siteCut, net: sub(sub(cost, protocolCut), siteCut) };
}

/**
 * What a tenant pays and where it goes, composed the way `SlotSite.rent` composes it.
 *
 * One call, so a confirm dialog cannot show a cost derived one way and an escrow figure derived
 * another.
 */
export interface RentQuote extends RentSplit {
  /** Gross, and what the tenant is actually charged. */
  cost: bigint;
}

export function quoteRent(
  ratePerDay: bigint,
  durationSecs: bigint,
  protocolRentBps: bigint,
  feeBps: bigint,
): RentQuote {
  const cost = rentCost(ratePerDay, durationSecs);
  return { cost, ...rentSplit(cost, protocolRentBps, feeBps) };
}
