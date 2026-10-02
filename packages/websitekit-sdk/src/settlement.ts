/**
 * What a site's money is denominated in — the token every board on a chain should settle in, and
 * how to read the currency of a board that already exists.
 *
 * **Identity is the ADDRESS, never the symbol.** On Robinhood Chain the fake `usdg` has more holders
 * than the real one and every impersonator answers `DOMAIN_SEPARATOR()`, so an entry here was
 * confirmed against the issuer's documentation before it was written. `settlementToken` is frozen at
 * `createSite`, so a wrong address here is not a bad constant — it is inventory that has to be
 * replaced.
 *
 * **`mintable` is the half that is easy to drop.** "Is this a testnet" and "can anybody conjure this
 * money" are different questions, and only the second decides whether a faucet path may exist.
 */
import type { Address, PublicClient } from 'viem';

import { ROBINHOOD_MAINNET_CHAIN, ROBINHOOD_TESTNET_CHAIN } from './chains';
import { isNativeSettlement } from './writes';

export interface SettlementToken {
  address: Address;
  decimals: number;
  symbol: string;
  /** Whether anybody may mint it. True only for a test stand-in; never for real money. */
  mintable: boolean;
}

/**
 * The real USDG — `Global Dollar`, issued by Paxos, 6 decimals. Confirmed 2026-09-19 against
 * Robinhood's own contract documentation and Paxos's, not merely read off the chain.
 */
export const ROBINHOOD_MAINNET_USDG: SettlementToken = {
  address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  decimals: 6,
  symbol: 'USDG',
  mintable: false,
};

/**
 * `TestUSD` — a permissionlessly mintable stand-in, verified on Blockscout. It exists because the
 * testnet's own USDG is role-gated and nobody outside its issuer can obtain any. Six decimals, so a
 * floor written for mainnet means the same number of dollars here.
 */
export const ROBINHOOD_TESTNET_TUSD: SettlementToken = {
  address: '0x1962c3554eab84a82a56ef97d05357682436170b',
  decimals: 6,
  symbol: 'tUSD',
  mintable: true,
};

export const SETTLEMENT_TOKENS: Record<number, SettlementToken> = {
  [ROBINHOOD_MAINNET_CHAIN.id]: ROBINHOOD_MAINNET_USDG,
  [ROBINHOOD_TESTNET_CHAIN.id]: ROBINHOOD_TESTNET_TUSD,
};

/**
 * The token a new board on this chain should settle in, or a refusal naming the chains there are.
 * Throws rather than falling back to native: a default is silently right on one kind of site and
 * wrong by 1e12 on the other.
 */
export function settlementTokenFor(chainId: number): SettlementToken {
  const token = SETTLEMENT_TOKENS[chainId];
  if (!token) {
    throw new Error(
      `websitekit: no settlement token is recorded for chain ${chainId}. ` +
        `Known chains: ${Object.keys(SETTLEMENT_TOKENS).join(', ')}.`,
    );
  }
  return token;
}

/** What a board's prices are counted in, for showing a person a number. */
export interface SettlementCurrency {
  symbol: string;
  decimals: number;
}

/** Native settlement on every chain this SDK names. */
export const NATIVE_CURRENCY: SettlementCurrency = { symbol: 'ETH', decimals: 18 };

const ERC20_METADATA_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
] as const;

/**
 * The currency of a board, read from its settlement token — `readSiteTerms().settlementToken`.
 *
 * **Decimals are READ, never assumed.** Rendering a 6-decimal amount with 18 shows a $2.00 slot as
 * 0.000000000002, and the reverse shows it as two trillion. A known token answers from the table
 * above with no request; anything else is asked, at `blockNumber` when given so it sits on the same
 * block as the quote it is formatting.
 */
export async function readSettlementCurrency(
  client: PublicClient,
  settlementToken: Address,
  blockNumber?: bigint,
): Promise<SettlementCurrency> {
  if (isNativeSettlement(settlementToken)) return NATIVE_CURRENCY;

  const known = Object.values(SETTLEMENT_TOKENS).find(
    (token) => token.address.toLowerCase() === settlementToken.toLowerCase(),
  );
  if (known) return { symbol: known.symbol, decimals: known.decimals };

  const at = blockNumber === undefined ? {} : { blockNumber };
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address: settlementToken, abi: ERC20_METADATA_ABI, functionName: 'decimals', ...at }),
    client.readContract({ address: settlementToken, abi: ERC20_METADATA_ABI, functionName: 'symbol', ...at }),
  ]);
  return { symbol, decimals: Number(decimals) };
}
