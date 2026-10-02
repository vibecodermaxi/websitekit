import { describe, it, expect, vi } from 'vitest';
import type { Address, PublicClient } from 'viem';

import {
  NATIVE_CURRENCY,
  ROBINHOOD_MAINNET_USDG,
  ROBINHOOD_TESTNET_TUSD,
  readSettlementCurrency,
  settlementTokenFor,
} from './settlement';
import { DEMO_SITE, DEMO_SITE_MAINNET, demoSiteFor } from './addresses';

const NATIVE = '0x0000000000000000000000000000000000000000' as Address;
const OTHER = '0x5555555555555555555555555555555555555555' as Address;

/** A client that throws on any read, for the paths that must answer without asking the chain. */
const silent = {
  readContract: vi.fn(() => {
    throw new Error('must not read');
  }),
} as unknown as PublicClient;

describe('settlementTokenFor', () => {
  it('names real USDG on mainnet and the mintable stand-in on testnet', () => {
    expect(settlementTokenFor(4663)).toBe(ROBINHOOD_MAINNET_USDG);
    expect(settlementTokenFor(4663).mintable).toBe(false);
    expect(settlementTokenFor(46630)).toBe(ROBINHOOD_TESTNET_TUSD);
    expect(settlementTokenFor(46630).mintable).toBe(true);
  });

  /** Both are six decimals, so a floor written once means the same dollars on either chain. */
  it('keeps both chains at six decimals', () => {
    expect(ROBINHOOD_MAINNET_USDG.decimals).toBe(6);
    expect(ROBINHOOD_TESTNET_TUSD.decimals).toBe(6);
  });

  it('refuses an unknown chain rather than defaulting to native', () => {
    expect(() => settlementTokenFor(1)).toThrow(/no settlement token is recorded for chain 1/);
  });
});

describe('readSettlementCurrency', () => {
  it('answers native without a request', async () => {
    expect(await readSettlementCurrency(silent, NATIVE)).toEqual(NATIVE_CURRENCY);
  });

  /** Case-insensitive: the table is lowercase and a checksummed address must still match. */
  it('answers a known token from the table, whatever its case', async () => {
    const checksummed = '0x5FC5360D0400A0FD4F2AF552ADD042D716F1D168' as Address;
    expect(await readSettlementCurrency(silent, checksummed)).toEqual({ symbol: 'USDG', decimals: 6 });
  });

  it('reads an unknown token from the chain, at the block it was given', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'decimals' ? 8 : 'WBTC',
    );
    const client = { readContract } as unknown as PublicClient;
    expect(await readSettlementCurrency(client, OTHER, 123n)).toEqual({ symbol: 'WBTC', decimals: 8 });
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: OTHER, blockNumber: 123n }));
  });
});

describe('demoSiteFor', () => {
  it('names each chain its own demo board, never the other one', () => {
    expect(demoSiteFor(46630)).toBe(DEMO_SITE);
    expect(demoSiteFor(4663)).toBe(DEMO_SITE_MAINNET);
    expect(DEMO_SITE_MAINNET).not.toBe(DEMO_SITE);
  });

  /** Never the testnet board on another chain: a mainnet page reading it gets an empty board. */
  it('answers undefined for a chain with no seeded demo', () => {
    expect(demoSiteFor(1)).toBeUndefined();
  });
});
