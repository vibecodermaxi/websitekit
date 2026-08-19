import { describe, it, expect } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  DEFAULT_DEADLINE_SECS,
  DEFAULT_SLIPPAGE_BPS,
  InvalidEconomicsError,
  isNativeSettlement,
  buildBuy,
  buildBuyFrom,
  buildCreateSite,
  buildRegisterSlots,
  buildSetAsk,
  buildListForRent,
  buildDelist,
  buildRent,
  buildExtendRental,
  buildApproveSettlement,
  buildSweepTreasury,
} from './writes';
import { slotKey } from './keys';

const SITE = '0x1111111111111111111111111111111111111111' as Address;
const FACTORY = '0x2222222222222222222222222222222222222222' as Address;
const ALICE = '0x3333333333333333333333333333333333333333' as Address;
const BOB = '0x4444444444444444444444444444444444444444' as Address;
const TOKEN = '0x5555555555555555555555555555555555555555' as Address;
const NATIVE = '0x0000000000000000000000000000000000000000' as Address;
const TERMS = `0x${'ab'.repeat(32)}` as Hex;
const NOW = 1_800_000_000n;

const BASE = {
  site: SITE,
  key: 'hero.headline',
  charged: 1_000_000n,
  settlementToken: NATIVE,
  expectedTerms: TERMS,
  now: NOW,
};

const ECONOMICS = {
  takeBps: 14_000n,
  payoutBps: 11_500n,
  reversionBps: 9_700n,
  maxReversionWeeks: 52n,
  cooldownSecs: 900n,
};

const RENTALS = { siteRentBps: 2_500n, maxRentalTerm: 2_592_000n, minRentBps: 25n };
const FLOOR_POLICY = { floorDeltaBps: 2_000n, floorChangeCooldown: 86_400n, maxAskBps: 40_000n };

const SITE_BASE = {
  factory: FACTORY,
  name: 'S',
  symbol: 'S',
  baseTokenURI: '',
  treasury: ALICE,
  settlementToken: NATIVE,
  economics: ECONOMICS,
  rentals: RENTALS,
  floorPolicy: FLOOR_POLICY,
};

describe('buildBuy', () => {
  it('builds `buy` when nobody else is named, and `buyFor` when someone is', () => {
    expect(buildBuy(BASE).functionName).toBe('buy');
    expect(buildBuy({ ...BASE, recipient: ALICE }).functionName).toBe('buyFor');
  });

  /**
   * §10.7. The recipient is the FIRST argument of `buyFor`, and a builder that dropped it or put it
   * last would produce a transaction where the payer silently owns the slot — the exact failure
   * that killed one implementation in the sibling repo.
   */
  it('puts the recipient first in buyFor and hashes the key', () => {
    const request = buildBuy({ ...BASE, recipient: ALICE });
    expect(request.args[0]).toBe(ALICE);
    expect(request.args[1]).toBe(slotKey('hero.headline'));
  });

  it('applies the default slippage headroom and deadline', () => {
    const request = buildBuy(BASE);
    const expectedMax = BASE.charged + (BASE.charged * DEFAULT_SLIPPAGE_BPS) / 10_000n;

    expect(request.args[1]).toBe(expectedMax);
    expect(request.args[3]).toBe(NOW + DEFAULT_DEADLINE_SECS);
  });

  /**
   * `msg.value` is `maxPrice`, not the quote. The contract reverts `InsufficientPayment` when value
   * is below the price it actually computes, and that price can legitimately have moved up to
   * `maxPrice` since the quote. The excess is credited to the payer's pull ledger, not lost.
   */
  it('sends maxPrice as value on a native site, not the quoted price', () => {
    const request = buildBuy(BASE);
    expect(request.value).toBe(request.args[1]);
    expect(request.value).toBeGreaterThan(BASE.charged);
  });

  /**
   * **The v2 trap.** A token site pulls via `transferFrom` and reverts `NativeNotAccepted` on any
   * non-zero `msg.value`. Sending the price as value there is not "harmlessly redundant" — it fails
   * every purchase on the site, and the same builder call is correct on a native site, so the bug
   * only appears once someone deploys against USDG.
   */
  it('sends zero value on a token site, whatever the price', () => {
    const request = buildBuy({ ...BASE, settlementToken: TOKEN });
    expect(request.value).toBe(0n);
    // The price still travels — as `maxPrice`, which is also what the allowance has to cover.
    expect(request.args[1]).toBeGreaterThan(BASE.charged);
  });

  it('honours an explicit maxPrice over the slippage default', () => {
    const request = buildBuy({ ...BASE, maxPrice: 5_000_000n, slippageBps: 9_999n });
    expect(request.args[1]).toBe(5_000_000n);
    expect(request.value).toBe(5_000_000n);
  });

  /** A maxPrice under the quote reverts `SlippageExceeded` on chain. Catching it here is free. */
  it('refuses a maxPrice below the quoted price', () => {
    expect(() => buildBuy({ ...BASE, maxPrice: BASE.charged - 1n })).toThrow(RangeError);
  });

  it('allows zero slippage for a caller who wants an exact-or-nothing buy', () => {
    const request = buildBuy({ ...BASE, slippageBps: 0n });
    expect(request.args[1]).toBe(BASE.charged);
  });

  it('honours an absolute deadline', () => {
    expect(buildBuy({ ...BASE, deadline: 42n }).args[3]).toBe(42n);
  });
});

describe('buildBuyFrom', () => {
  /**
   * The whole reason this wrapper exists. `buy`'s deadline is compared against `block.timestamp`,
   * not the client's clock — a wall-clock deadline reverts `DeadlineExpired` on any chain whose
   * timestamps drift from the caller's system time, with nothing in the UI able to explain it. This
   * was found by the anvil end-to-end suite, not by reasoning, which is what that suite is for.
   */
  it('measures the deadline from the chain clock, not Date.now()', () => {
    const chainNow = 1n; // a chain far behind the wall clock, as any test fork is
    const request = buildBuyFrom(
      SITE,
      { slot: { key: 'hero.headline', charged: 1_000_000n }, expectedTerms: TERMS, now: chainNow },
      NATIVE,
    );

    expect(request.args[3]).toBe(chainNow + DEFAULT_DEADLINE_SECS);
    expect(request.args[3]).toBeLessThan(BigInt(Math.floor(Date.now() / 1000)));
  });

  it('carries the context through and still accepts a recipient', () => {
    const request = buildBuyFrom(
      SITE,
      { slot: { key: 'hero.headline', charged: 7n }, expectedTerms: TERMS, now: NOW },
      NATIVE,
      { recipient: ALICE },
    );
    expect(request.functionName).toBe('buyFor');
    expect(request.args[0]).toBe(ALICE);
  });

  it('carries the settlement branch through', () => {
    const context = { slot: { key: 'hero.headline', charged: 7n }, expectedTerms: TERMS, now: NOW };
    expect(buildBuyFrom(SITE, context, TOKEN).value).toBe(0n);
    expect(buildBuyFrom(SITE, context, NATIVE).value).toBeGreaterThan(0n);
  });
});

describe('the settlement branch', () => {
  it('reads the zero address as native and anything else as a token', () => {
    expect(isNativeSettlement(NATIVE)).toBe(true);
    expect(isNativeSettlement(TOKEN)).toBe(false);
    // Checksummed and lowercase forms of the zero address are the same address.
    expect(isNativeSettlement('0x0000000000000000000000000000000000000000' as Address)).toBe(true);
  });

  it('approves the SITE as spender, for the amount asked and no more', () => {
    const request = buildApproveSettlement(TOKEN, SITE, 1_234n);
    expect(request.address).toBe(TOKEN);
    expect(request.args).toEqual([SITE, 1_234n]);
  });

  /** A native site has nothing to approve, and a UI that offered the step would confuse the user. */
  it('refuses to build an approval for a native site', () => {
    expect(() => buildApproveSettlement(NATIVE, SITE, 1n)).toThrow(/settles natively/);
  });
});

describe('the ask (§3)', () => {
  it('hashes the key and passes the ask through', () => {
    const request = buildSetAsk(SITE, 'hero.headline', 5n);
    expect(request.functionName).toBe('setAsk');
    expect(request.args).toEqual([slotKey('hero.headline'), 5n]);
  });

  /** Zero clears the ask and falls back to `lastPrice`; it is not an invalid input. */
  it('accepts zero as the clear-the-ask sentinel', () => {
    expect(buildSetAsk(SITE, 'hero.headline', 0n).args[1]).toBe(0n);
  });
});

describe('rentals (§2)', () => {
  it('lists with a per-day rate and a duration in seconds', () => {
    const request = buildListForRent(SITE, 'hero.headline', 100n, 86_400n);
    expect(request.functionName).toBe('listForRent');
    expect(request.args).toEqual([slotKey('hero.headline'), 100n, 86_400n]);
  });

  /** Delisting is a zero-rate listing, not a separate entry point. */
  it('delists by listing at a zero rate', () => {
    const request = buildDelist(SITE, 'hero.headline');
    expect(request.functionName).toBe('listForRent');
    expect(request.args).toEqual([slotKey('hero.headline'), 0n, 0n]);
  });

  /**
   * `expectedRatePerDay` is the rental path's `maxPrice`: without it an owner front-runs a tenancy
   * by raising the rate between the quote and the transaction, and the contract reverts
   * `RateChanged` on any mismatch.
   */
  it('carries the expected rate so the owner cannot front-run the rate', () => {
    const request = buildRent({
      site: SITE,
      key: 'hero.headline',
      durationSecs: 86_400n,
      expectedRatePerDay: 100n,
      settlementToken: NATIVE,
      cost: 100n,
    });
    expect(request.args[2]).toBe(100n);
    expect(request.value).toBe(100n);
  });

  it('sends the cost as value natively and nothing on a token site', () => {
    const options = {
      site: SITE,
      key: 'hero.headline',
      durationSecs: 86_400n,
      expectedRatePerDay: 100n,
      cost: 100n,
    };
    expect(buildRent({ ...options, settlementToken: NATIVE }).value).toBe(100n);
    expect(buildRent({ ...options, settlementToken: TOKEN }).value).toBe(0n);
    expect(buildExtendRental({ ...options, settlementToken: TOKEN }).value).toBe(0n);
  });

  it('extends through its own entry point, not by renting again', () => {
    const request = buildExtendRental({
      site: SITE,
      key: 'hero.headline',
      durationSecs: 3_600n,
      expectedRatePerDay: 100n,
      settlementToken: NATIVE,
      cost: 4n,
    });
    expect(request.functionName).toBe('extendRental');
  });
});

describe('buildSweepTreasury', () => {
  /** Permissionless and pays `treasury`, never the caller — so it takes no account argument at all. */
  it('takes no beneficiary, because it cannot pay one', () => {
    const request = buildSweepTreasury(SITE);
    expect(request.functionName).toBe('sweepTreasury');
    expect(request.args).toEqual([]);
  });
});

describe('buildRegisterSlots', () => {
  it('pairs keys with floors in order', () => {
    const request = buildRegisterSlots(SITE, { 'hero.headline': 10n, 'nav.link.1': 20n });
    expect(request.args[0]).toEqual([slotKey('hero.headline'), slotKey('nav.link.1')]);
    expect(request.args[1]).toEqual([10n, 20n]);
  });

  it('refuses a zero floor, which would be free to claim and free to hold', () => {
    expect(() => buildRegisterSlots(SITE, { 'hero.headline': 0n })).toThrow(RangeError);
  });
});

describe('buildCreateSite', () => {
  it('builds `createSite` by default and `createSiteFor` when an owner is named', () => {
    expect(buildCreateSite(SITE_BASE).functionName).toBe('createSite');

    const forOther = buildCreateSite({ ...SITE_BASE, owner: BOB });
    expect(forOther.functionName).toBe('createSiteFor');
    expect(forOther.args[0]).toBe(BOB);
  });

  /**
   * The settlement token is frozen at deploy with no setter, and it also fixes `minFloor` via the
   * token's decimals. Getting it into the config tuple at the right position is the difference
   * between a native site and a token one.
   */
  it('carries the settlement token into the config', () => {
    const request = buildCreateSite({ ...SITE_BASE, settlementToken: TOKEN });
    const config = request.args[0] as { settlementToken: Address };
    expect(config.settlementToken).toBe(TOKEN);
  });

  /**
   * These clamps duplicate the contract's `_validateConfig`, and this is the one place duplicating a
   * contract rule is right: the contract's version is the authority and reverts, but a revert costs
   * a deploy transaction and produces an error selector rather than a sentence.
   */
  it.each([
    [{ economics: { ...ECONOMICS, payoutBps: 9_999n } }, 'payout below principal'],
    [{ economics: { ...ECONOMICS, takeBps: 30_001n } }, 'take above the ceiling'],
    [{ economics: { ...ECONOMICS, takeBps: 11_500n } }, 'take not above payout'],
    [{ economics: { ...ECONOMICS, reversionBps: 0n } }, 'zero reversion'],
    [{ economics: { ...ECONOMICS, reversionBps: 10_001n } }, 'reversion above one'],
    [{ economics: { ...ECONOMICS, maxReversionWeeks: 53n } }, 'horizon past 52 weeks'],
    [{ economics: { ...ECONOMICS, cooldownSecs: 604_801n } }, 'cooldown past 7 days'],
    [{ floorPolicy: { ...FLOOR_POLICY, floorDeltaBps: 0n } }, 'a floor lever that cannot move'],
    [{ floorPolicy: { ...FLOOR_POLICY, floorDeltaBps: 2_001n } }, 'floor delta past ±20%'],
    [{ floorPolicy: { ...FLOOR_POLICY, floorChangeCooldown: 86_399n } }, 'floor cooldown under 24h'],
    [{ floorPolicy: { ...FLOOR_POLICY, maxAskBps: 9_999n } }, 'an ask cap below the owner’s own cost'],
    [{ rentals: { ...RENTALS, siteRentBps: 4_001n } }, 'site rent past the total-fee ceiling'],
    [{ rentals: { ...RENTALS, maxRentalTerm: 3_599n } }, 'a rental term under one hour'],
    [{ rentals: { ...RENTALS, maxRentalTerm: 31_536_001n } }, 'a rental term past 365 days'],
    [{ rentals: { ...RENTALS, minRentBps: 0n } }, 'no anti-poisoning rate floor'],
    [{ rentals: { ...RENTALS, minRentBps: 10_001n } }, 'a rate floor above the whole position'],
    [{ royaltyBps: 1_001n }, 'royalty past 10%'],
  ] as Array<[Partial<typeof SITE_BASE> & { royaltyBps?: bigint }, string]>)('rejects %#: %s', (overrides) => {
    expect(() => buildCreateSite({ ...SITE_BASE, ...overrides })).toThrow(InvalidEconomicsError);
  });

  it('rejects open registration without a default floor', () => {
    expect(() => buildCreateSite({ ...SITE_BASE, openRegistration: true })).toThrow(InvalidEconomicsError);
  });

  it('registers the board in the same call as the deploy', () => {
    const request = buildCreateSite({ ...SITE_BASE, slots: { 'hero.headline': 10n } });
    expect(request.args[1]).toEqual([slotKey('hero.headline')]);
    expect(request.args[2]).toEqual([10n]);
  });
});
