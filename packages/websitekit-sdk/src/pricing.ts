/**
 * The TypeScript twin of `packages/websitekit-contracts/src/Pricing.sol`.
 *
 * Structurally identical to the Solidity, line for line: same order of operations, same truncation
 * points, same loop bound. That is not a style preference — a single price divergence makes every
 * buy transaction revert, because the client quotes one number and the chain charges another.
 *
 * Three rules this file exists to hold, all of them learned the expensive way in the v1 codebase:
 *
 *   1. **Native `BigInt`, never a decimal library.** `decimal.js`/`big.js` implement their own
 *      rounding rules that are not guaranteed to match Rust or Solidity integer truncation
 *      op-for-op, and the library then becomes an unverified third party in the parity chain.
 *      Anything arriving as a `BN` from a contract client converts at the boundary
 *      (`BigInt(bn.toString())`) and the arithmetic happens here.
 *   2. **The decay loop stays iterative.** `decayed * decayBps / 10_000` truncates once per
 *      iteration, so `basePrice * 0.9^n` drifts from what the chain will actually charge. Never
 *      refactor it to a closed-form power, however tempting `Math.pow` looks in a UI projection.
 *   3. **uint256 is not arbitrary precision, and `BigInt` is.** This is the one place the twin
 *      cannot be a literal transcription: Solidity 0.8's checked arithmetic reverts where `BigInt`
 *      would happily carry on to a number the chain can never hold. So every multiply and every
 *      subtract goes through a guard that throws instead. Without them the twin silently disagrees
 *      with the chain at exactly the inputs an attacker would look for first.
 */

export const BPS_DENOMINATOR = 10_000n;
export const SECONDS_PER_WEEK = 604_800n;

const U256_MAX = (1n << 256n) - 1n;

/**
 * Thrown where Solidity's checked arithmetic would revert. Distinct from `RangeError` so a caller
 * can tell "this input overflows the chain's word size" from "you passed a negative week count",
 * and never silently caught alongside ordinary validation errors.
 */
export class PricingOverflowError extends RangeError {
  constructor(op: string) {
    super(`websitekit/pricing: ${op} overflows uint256 — the chain would revert here`);
    this.name = 'PricingOverflowError';
  }
}

/** `a * b`, reverting exactly where Solidity's checked multiply does. */
function mul(a: bigint, b: bigint): bigint {
  const result = a * b;
  if (result > U256_MAX) throw new PricingOverflowError('multiply');
  return result;
}

/**
 * `a - b`, reverting exactly where Solidity's checked subtract does. Named rather than inlined
 * because an unguarded `-` here is precisely how the site's own cut would silently wrap to a huge
 * positive number under a config the contract would have rejected.
 */
function sub(a: bigint, b: bigint): bigint {
  if (b > a) throw new PricingOverflowError('subtract');
  return a - b;
}

/** `amount * bps / 10_000` — one guarded multiply, one truncating divide, in that order. */
function bpsOf(amount: bigint, bps: bigint): bigint {
  return mul(amount, bps) / BPS_DENOMINATOR;
}

export interface TakeQuote {
  /** What a taker pays to displace the current owner. */
  price: bigint;
  /** `max(decayed, basePrice)` — what a first claim pays, and what the whole split is keyed to. */
  effectiveFloor: bigint;
}

/**
 * Mirrors `Pricing.computeTakePrice`.
 *
 * A never-claimed slot has `lastPrice === 0n`, which decays to zero and hands `basePrice` straight
 * to the `max()`. There is deliberately no branch for it — a branch here is a place the two
 * implementations can disagree.
 *
 * @param maxDecayWeeks The site's decay horizon. A parameter rather than a constant because
 * websitekit sites choose their own; pass `52n` and this is byte-identical to v1's function.
 */
export function computeTakePrice(
  lastPrice: bigint,
  basePrice: bigint,
  elapsedWeeks: bigint,
  decayBps: bigint,
  takeBps: bigint,
  maxDecayWeeks: bigint,
): TakeQuote {
  const clampedWeeks = elapsedWeeks > maxDecayWeeks ? maxDecayWeeks : elapsedWeeks;
  let decayed = lastPrice;
  for (let i = 0n; i < clampedWeeks; i++) {
    decayed = mul(decayed, decayBps) / BPS_DENOMINATOR;
  }
  const effectiveFloor = decayed > basePrice ? decayed : basePrice;
  const price = mul(effectiveFloor, takeBps) / BPS_DENOMINATOR;
  return { price, effectiveFloor };
}

/**
 * Mirrors `Pricing.resolveReversionBase` — spec §3.
 *
 * The reversion base is the owner's posted ask when they have one, and what they paid otherwise.
 *
 * **This is why every pre-v2 take-price vector is still valid.** The ask enters pricing as the BASE
 * that `computeTakePrice` reverts from, not as a multiplier applied to its result, so with no ask
 * posted (`askFloor === 0n`) the value handed downstream is `lastPrice` unchanged and pricing
 * behaves exactly as it did before §3 existed. A multiplier would have invalidated the whole
 * existing grid; this is the design choice that did not.
 *
 * Not a list price, and not what a buyer pays. It is cleared on every sale — a new owner inherits no
 * ask — so a UI that renders it as an asking price is showing something the contract does not mean.
 */
export function resolveReversionBase(askFloor: bigint, lastPrice: bigint): bigint {
  return askFloor !== 0n ? askFloor : lastPrice;
}

/**
 * Mirrors `Pricing.askCeiling` — spec §3.2. The highest ask an owner may post.
 *
 * Anchored to `lastPrice`, which moves only on a sale, or to `basePrice` when that is higher.
 * **Never to the effective floor**, which is downstream of the ask itself once one is posted:
 * anchoring there would let each ask raise the ceiling for the next and compound into an unbounded
 * ratchet. Anchoring to a value the ask cannot influence is what bounds it.
 *
 * `maxAskBps` is clamped below at `10_000` and has no upper clamp, so a large anchor can overflow
 * the multiply. Throws where the chain reverts, like every other guarded multiply here.
 */
export function askCeiling(lastPrice: bigint, basePrice: bigint, maxAskBps: bigint): bigint {
  const anchor = lastPrice > basePrice ? lastPrice : basePrice;
  return bpsOf(anchor, maxAskBps);
}

export interface Split {
  /** The effective floor on a claim, the take price on a take. This is what `lastPrice` records. */
  charged: bigint;
  /** To the displaced owner. `0n` on a claim; there is nobody to pay. */
  payout: bigint;
  /** To the protocol treasury, on every buy including claims. */
  protocolCut: bigint;
  /** Whatever remains, to the site. */
  siteCut: bigint;
}

/**
 * Mirrors `Pricing.computeSplit`. Every leg is keyed to `effectiveFloor`, never to `charged` or to
 * a stale `lastPrice` — a displaced owner is paid against what the slot is worth now, not against
 * what they happened to pay for it.
 *
 * Throws where the contract would revert, which for `siteCut` means any config with
 * `takeBps <= payoutBps + protocolBps`. `SlotSite._validateConfig` makes that unreachable on-chain;
 * this function does not re-validate, so a caller inventing a config gets a throw rather than a
 * number no clone could ever produce.
 */
export function computeSplit(
  effectiveFloor: bigint,
  price: bigint,
  isUnclaimed: boolean,
  payoutBps: bigint,
  protocolBps: bigint,
): Split {
  const charged = isUnclaimed ? effectiveFloor : price;
  const payout = isUnclaimed ? 0n : bpsOf(effectiveFloor, payoutBps);
  const protocolCut = bpsOf(effectiveFloor, protocolBps);
  const siteCut = sub(sub(charged, payout), protocolCut);
  return { charged, payout, protocolCut, siteCut };
}

/**
 * Mirrors `SlotSite._computeElapsedWeeks`. Truncates toward zero, which equals floor because both
 * operands are non-negative. The contract's `uint256` subtraction reverts on underflow; this throws
 * for the same input rather than returning a negative week count that would run the loop zero times
 * and quietly quote the undecayed price.
 */
export function computeElapsedWeeks(nowTs: bigint, lastPurchaseTs: bigint): bigint {
  if (nowTs < lastPurchaseTs) {
    throw new RangeError('websitekit/pricing: nowTs must be >= lastPurchaseTs');
  }
  return (nowTs - lastPurchaseTs) / SECONDS_PER_WEEK;
}

/**
 * A site's take economics, in the SDK's own vocabulary.
 *
 * **`reversionBps`, not `decayBps`.** The rename is recorded in `CLAUDE.md`: the mechanism is
 * bounded below by the publisher's floor, so it is mean reversion of the takeover price rather than
 * loss of value, and "decay" told users the wrong story about what holding a slot costs them. The
 * positional parameters of `computeTakePrice` keep the old names on purpose — they mirror
 * `Pricing.sol`'s signature exactly, and that correspondence is what the parity harness checks.
 */
export interface SiteEconomics {
  takeBps: bigint;
  payoutBps: bigint;
  reversionBps: bigint;
  maxReversionWeeks: bigint;
  protocolBps: bigint;
}

export interface BuyBreakdown extends TakeQuote, Split {}

/**
 * What a buy costs and where the money goes, composed from the same two primitives `SlotSite._buy`
 * composes and in the same order. This is what a confirm dialog should render — one call, so a UI
 * cannot show a price derived one way and a payout derived another.
 */
export function computeBuyBreakdown(
  lastPrice: bigint,
  basePrice: bigint,
  elapsedWeeks: bigint,
  economics: SiteEconomics,
  isUnclaimed: boolean,
): BuyBreakdown {
  const quote = computeTakePrice(
    lastPrice,
    basePrice,
    elapsedWeeks,
    economics.reversionBps,
    economics.takeBps,
    economics.maxReversionWeeks,
  );
  const split = computeSplit(
    quote.effectiveFloor,
    quote.price,
    isUnclaimed,
    economics.payoutBps,
    economics.protocolBps,
  );
  return { ...quote, ...split };
}
