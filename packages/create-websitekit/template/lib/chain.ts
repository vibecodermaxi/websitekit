import { defineChain } from 'viem';

/**
 * Robinhood Chain testnet — websitekit's launch chain (§10.5).
 *
 * Defined here rather than imported from `viem/chains` because viem does not ship it. One chain at
 * v1, deliberately: every additional chain needs its own implementation deploy, its own audit
 * sign-off and its own address, and multi-chain is a support surface rather than a feature.
 */
export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    // Blockscout, not Etherscan — and it detects EIP-1167 proxies, so verifying the implementation
    // once gives every cloned site a readable contract page.
    default: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com' },
  },
  testnet: true,
});
