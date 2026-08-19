import { defineChain } from 'viem';

/**
 * Robinhood Chain testnet — websitekit's launch chain (§10.5).
 *
 * Defined here rather than imported from `viem/chains` because viem does not ship it.
 */
export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    // The public RPC, not the Alchemy key in the repo root .env — this one is read from a browser
    // and from a build that will eventually run somewhere public.
    default: { http: ['https://rpc.testnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com' },
  },
  testnet: true,
});
