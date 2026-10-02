/**
 * The chains this SDK knows how to name, which is a different list from the ones it has addresses
 * for.
 *
 * **A CHAIN is not a DEPLOYMENT, and conflating them is what made the platform single-chain.**
 * `addresses.ts` records what we put on a chain — an implementation, a factory, a reader, a
 * protocol cut. This file records the chain itself: an id, a name, an endpoint, an explorer, and
 * whether the money on it is real. The first is a fact about our deploy; the second is a fact about
 * the network, true before we arrive and true if we never do.
 *
 * Until 2026-09-18 there was only the first, and `apps/platform/lib/chain.ts` therefore derived its
 * chain id FROM `ROBINHOOD_TESTNET` — a `Deployment`. That is a perfectly good way to keep an
 * address set from drifting away from the chain it was deployed to, and it has one consequence
 * nobody intended: **there was no way to name a chain we had not deployed to.** So the seam the
 * mainnet move needs was not fifteen literals to sweep, it was this type not existing.
 *
 * **`chainFor` answering and `deploymentFor` throwing is the correct pair, not a gap.** A chain can
 * be real before anything of ours is on it — 4663 was, from 2026-09-18 until the deploy on
 * 2026-09-21. A caller that only needs to know where to send an `eth_call` can be told; a caller
 * that needs our factory address must be refused, by name, at the moment it asks, rather than
 * quietly transacting against another chain's addresses.
 */

export interface Chain {
  id: number;
  /**
   * What a person is told they are on. Shown by `testnetNotice` and by the deposit screen, which is
   * why it is a NAME and never the id — `lib/auth.ts` → `NEVER_SHOW` withholds a chain id as a
   * value, and a network's name is not on that list.
   */
  name: string;
  /**
   * The PUBLIC endpoint, safe to read from a browser and therefore never a keyed one. A deployment
   * that holds a private endpoint overrides this; see `apps/platform/lib/chain.ts`.
   */
  rpcUrl: string;
  explorer: string;
  /**
   * Whether the money on this chain is real.
   *
   * **Read by more than the bar that announces it.** `testnetNotice` removes itself on false,
   * `floorPosture` refuses `CSAM_MATCH=none-testnet-only` on false, and `sponsorshipFor` treats it
   * as "is this the chain where we can conjure gas". So this is not a display flag — it is the one
   * boolean several safety rules are derived from, which is the argument for deriving it here once
   * rather than asking each caller to infer it from an id.
   */
  testnet: boolean;
}

/** Robinhood Chain testnet — free money, a mintable stand-in dollar, and every seeded example board. */
export const ROBINHOOD_TESTNET_CHAIN: Chain = {
  id: 46630,
  name: 'Robinhood Chain Testnet',
  rpcUrl: 'https://rpc.testnet.chain.robinhood.com',
  explorer: 'https://explorer.testnet.chain.robinhood.com',
  testnet: true,
};

/**
 * Robinhood Chain mainnet. The v2 protocol is deployed here (2026-09-21) and so is render escrow
 * (2026-09-22) — see `ROBINHOOD_MAINNET` and `ROBINHOOD_MAINNET_ESCROW` in `addresses.ts`.
 *
 * Every value here was MEASURED rather than guessed, because three documents in this repo said this
 * chain did not exist. `eth_chainId` answers `0x1237` on the `rpc.mainnet.…` host; the bare
 * `rpc.chain.robinhood.com` resolves and refuses TLS, so the host below is the working one and not
 * the obvious one. The explorer is recorded as its CANONICAL address: `explorer.mainnet.chain
 * .robinhood.com` answers 301 to `robinhoodchain.blockscout.com`, and recording the redirect would
 * put a hop in front of every link this SDK builds.
 */
export const ROBINHOOD_MAINNET_CHAIN: Chain = {
  id: 4663,
  name: 'Robinhood Chain',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  explorer: 'https://robinhoodchain.blockscout.com',
  testnet: false,
};

export const CHAINS: Record<number, Chain> = {
  [ROBINHOOD_TESTNET_CHAIN.id]: ROBINHOOD_TESTNET_CHAIN,
  [ROBINHOOD_MAINNET_CHAIN.id]: ROBINHOOD_MAINNET_CHAIN,
};

/**
 * The chain with this id, or a refusal naming the ones there are.
 *
 * **It throws rather than falling back**, and the direction matters: an unrecognised id is somebody
 * asking for a network we cannot describe, and the only fallback available would be the testnet —
 * which is to say, telling a caller who asked for mainnet that they are on testnet and letting them
 * find out later. `deploymentFor` has refused on the same argument since v1.
 */
export function chainFor(id: number): Chain {
  const chain = CHAINS[id];
  if (!chain) {
    throw new Error(
      `websitekit: chain ${id} is unknown. Known chains: ${Object.keys(CHAINS).join(', ')}.`,
    );
  }
  return chain;
}
