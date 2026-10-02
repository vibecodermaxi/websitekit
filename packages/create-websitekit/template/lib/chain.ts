import { defineChain } from 'viem';
import {
  chainFor,
  deploymentFor,
  demoSiteFor,
  settlementTokenFor,
  ROBINHOOD_MAINNET_CHAIN,
} from '@websitekit/sdk';

/**
 * Which chain this project runs against, and everything that follows from it.
 *
 * **Robinhood Chain mainnet by default — the money is real.** Set `NEXT_PUBLIC_WEBSITEKIT_CHAIN_ID`
 * to `46630` for the testnet, where the settlement dollar is a stand-in anybody can mint.
 *
 * Nothing here is a literal of this project's. The chain, the protocol addresses, the settlement
 * token and the demo board all come from `@websitekit/sdk`, so adopting a new deployment is an SDK
 * upgrade rather than an edit — and an id the SDK does not know THROWS, rather than quietly running
 * against the other network. On a chain where the money is real, a typo falling back to the testnet
 * is the failure that would go unnoticed longest.
 */
const raw = process.env.NEXT_PUBLIC_WEBSITEKIT_CHAIN_ID;
const id = raw ? Number(raw) : ROBINHOOD_MAINNET_CHAIN.id;

const record = chainFor(id);

export const chain = defineChain({
  id: record.id,
  name: record.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [record.rpcUrl] } },
  // Blockscout detects EIP-1167 clones, so the implementation verified once gives every site a
  // readable contract page.
  blockExplorers: { default: { name: 'Blockscout', url: record.explorer } },
  testnet: record.testnet,
});

/** The factory, the implementation and the replaceable reader on this chain. */
export const deployment = deploymentFor(id);

/** What boards created from this project settle in: USDG on mainnet, the tUSD stand-in on testnet. */
export const settlement = settlementTokenFor(id);

/** The shared board `pnpm dev` renders before you have deployed your own, if this chain has one. */
export const demoSite = demoSiteFor(id);
