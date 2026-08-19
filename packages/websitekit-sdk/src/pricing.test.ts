/**
 * Unit coverage for the parts of `pricing.ts` the Solidity grid does not reach.
 *
 * The parity harness sweeps ~2,400 rows of `computeTakePrice` and `computeSplit` against the real
 * library, so re-asserting those here would be noise. What it cannot reach: `computeElapsedWeeks`
 * (the contract computes it from `block.timestamp`, not from a vector), `computeBuyBreakdown`'s
 * composition order, and the error types a caller actually branches on.
 */
import { describe, it, expect } from 'vitest';
import {
  computeTakePrice,
  computeSplit,
  computeElapsedWeeks,
  computeBuyBreakdown,
  PricingOverflowError,
  SECONDS_PER_WEEK,
  type SiteEconomics,
} from './pricing';

const DEFAULTS: SiteEconomics = {
  takeBps: 14_000n,
  payoutBps: 11_500n,
  reversionBps: 9_000n,
  maxReversionWeeks: 52n,
  protocolBps: 500n,
};

describe('computeElapsedWeeks', () => {
  it('floors to whole weeks', () => {
    expect(computeElapsedWeeks(SECONDS_PER_WEEK - 1n, 0n)).toBe(0n);
    expect(computeElapsedWeeks(SECONDS_PER_WEEK, 0n)).toBe(1n);
    expect(computeElapsedWeeks(SECONDS_PER_WEEK * 3n + 1n, 0n)).toBe(3n);
  });

  /**
   * The contract's `uint256` subtraction reverts here. Returning a negative count instead would run
   * the decay loop zero times and quietly quote the undecayed price — a silent overcharge rather
   * than a failure.
   */
  it('throws rather than returning a negative week count', () => {
    expect(() => computeElapsedWeeks(0n, 1n)).toThrow(RangeError);
  });

  it('is exact across a clock that has not moved', () => {
    expect(computeElapsedWeeks(1_700_000_000n, 1_700_000_000n)).toBe(0n);
  });
});

describe('computeBuyBreakdown', () => {
  /**
   * A first claim charges the effective floor, not the take price. Getting this backwards makes
   * every first purchase 1.4x too expensive and ratchets `lastPrice` up before anyone has competed
   * for the slot.
   */
  it('charges the floor on a claim and the take price on a take', () => {
    const floor = 10_000_000_000_000_000n; // 0.01 ether

    const claim = computeBuyBreakdown(0n, floor, 0n, DEFAULTS, true);
    expect(claim.charged).toBe(floor);
    expect(claim.payout).toBe(0n);

    const take = computeBuyBreakdown(floor, floor, 0n, DEFAULTS, false);
    expect(take.charged).toBe(take.price);
    expect(take.charged).toBe((floor * 14_000n) / 10_000n);
  });

  /**
   * The floor guarantee — what actually survives every input.
   *
   * NOT "being taken is a profit event": the payout is keyed to the CURRENT effective floor, not to
   * what the displaced holder paid, and reversion separates the two. The invariant campaign measured
   * 33 of 73 takes crediting the displaced owner less than they paid. This case buys at the floor
   * with no reversion elapsed, so the two coincide here — which is exactly why it is not evidence
   * for the stronger claim.
   */
  it('pays a displaced owner more than the effective floor the take is keyed to', () => {
    const floor = 10_000_000_000_000_000n;
    const take = computeBuyBreakdown(floor, floor, 0n, DEFAULTS, false);
    expect(take.payout).toBeGreaterThan(floor);
    expect(take.payout).toBe((floor * 11_500n) / 10_000n);
  });

  it('conserves the charged amount across the three legs', () => {
    const floor = 33_333_333_333_333_333n; // deliberately not divisible
    for (const isUnclaimed of [true, false]) {
      const b = computeBuyBreakdown(floor, floor, 3n, DEFAULTS, isUnclaimed);
      expect(b.payout + b.protocolCut + b.siteCut).toBe(b.charged);
    }
  });

  /**
   * The composition order that matters: the split is keyed to the DECAYED floor, so a stale slot
   * pays its owner less than a fresh one. Keying it to `lastPrice` instead would pay out against a
   * number nobody would pay today.
   */
  it('keys the split to the decayed floor, not to lastPrice', () => {
    const lastPrice = 10_000_000_000_000_000n;
    const fresh = computeBuyBreakdown(lastPrice, 1n, 0n, DEFAULTS, false);
    const stale = computeBuyBreakdown(lastPrice, 1n, 10n, DEFAULTS, false);

    expect(stale.effectiveFloor).toBeLessThan(fresh.effectiveFloor);
    expect(stale.payout).toBeLessThan(fresh.payout);
    expect(stale.payout).toBe((stale.effectiveFloor * 11_500n) / 10_000n);
  });
});

describe('the uint256 guards', () => {
  it('throws PricingOverflowError, not a bare RangeError, on a multiply the chain cannot hold', () => {
    const max = (1n << 256n) - 1n;
    expect(() => computeTakePrice(max, 0n, 0n, 9_000n, 14_000n, 52n)).toThrow(PricingOverflowError);
  });

  /**
   * `takeBps <= payoutBps + protocolBps` underflows the site's own cut. `SlotSite._validateConfig`
   * makes it unreachable on-chain; a caller inventing a config off-chain must get a throw rather
   * than a wrapped, enormous `siteCut`.
   */
  it('throws on a config the contract would have rejected', () => {
    expect(() => computeSplit(1_000n, 1_100n, false, 11_000n, 500n)).toThrow(PricingOverflowError);
  });

  it('does not throw anywhere inside the admissible space', () => {
    const floor = (1n << 128n) - 1n;
    const { price, effectiveFloor } = computeTakePrice(floor, floor, 5n, 9_000n, 30_000n, 52n);
    expect(() => computeSplit(effectiveFloor, price, false, 20_000n, 1_000n)).not.toThrow();
  });
});

describe('the decay loop', () => {
  /**
   * Pinned because this is the single most tempting thing in the file to "simplify", and the
   * closed form is a genuinely different number — truncation compounds once per iteration.
   */
  it('is not the closed form', () => {
    const lastPrice = 1_000_000_007n;
    const { effectiveFloor } = computeTakePrice(lastPrice, 0n, 10n, 9_000n, 10_000n, 52n);
    const closedForm = (lastPrice * 9n ** 10n) / 10n ** 10n;
    expect(effectiveFloor).not.toBe(closedForm);
    expect(effectiveFloor).toBeLessThan(closedForm);
  });

  it('clamps at the site horizon rather than the elapsed time', () => {
    const a = computeTakePrice(1_000_000n, 0n, 8n, 9_000n, 10_000n, 8n);
    const b = computeTakePrice(1_000_000n, 0n, 999n, 9_000n, 10_000n, 8n);
    expect(a.effectiveFloor).toBe(b.effectiveFloor);
  });

  it('never falls below the floor', () => {
    const { effectiveFloor } = computeTakePrice(1_000n, 5_000n, 52n, 9_000n, 14_000n, 52n);
    expect(effectiveFloor).toBe(5_000n);
  });
});
