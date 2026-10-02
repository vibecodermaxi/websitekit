import { defineChain } from 'viem';
import { ROBINHOOD_TESTNET_CHAIN as record } from '@websitekit/sdk';

/**
 * Robinhood Chain testnet, where the four example boards are seeded.
 *
 * Built from the SDK's chain record rather than written out here, so the rpc and the explorer have
 * one source. The rpc is the PUBLIC one — this is read from a browser and from a public build.
 */
export const robinhoodTestnet = defineChain({
  id: record.id,
  name: record.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [record.rpcUrl] } },
  blockExplorers: { default: { name: 'Blockscout', url: record.explorer } },
  testnet: record.testnet,
});
