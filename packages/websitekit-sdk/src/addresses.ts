/**
 * Deployed websitekit addresses, per chain.
 *
 * One chain at v1 and said out loud (§7.9): every chain needs its own implementation deploy, its
 * own audit sign-off and its own address here. Multi-chain is a support surface, not a feature.
 *
 * **The implementation address is the one that matters.** A site is an EIP-1167 clone of it, so
 * verifying `SlotSite` ONCE on Blockscout gives every site cloned from it a readable, verified
 * contract page — which is the reason §4 rules out clone-with-immutable-args despite it being
 * cheaper per read.
 */
import type { Address } from 'viem';

export interface Deployment {
  chainId: number;
  /** Which contract generation this deployment is. v2 adds rentals, the ask and token settlement. */
  version: 1 | 2;
  /** The audited `SlotSite` every site on this chain is a clone of. */
  implementation: Address;
  /** `createSite` / `createSiteFor` live here. Not frozen — a new factory can point at the same
   *  implementation without stranding anyone (§10.8). */
  factory: Address;
  /**
   * The convenience-view periphery every read goes through. **v2 only**, and deliberately
   * replaceable: a new reader can be deployed and adopted without touching a single site (§11.4).
   * Absent on a v1 deployment, which carried its batch view inside the site itself.
   */
  reader?: Address;
  /**
   * `RentalsLib`, recorded for auditability. v2 only. The implementation delegatecalls an address
   * baked into its own bytecode, so a wrong link is arbitrary behaviour with no revert — a deploy
   * script must assert this matches the library it just deployed.
   */
  rentalsLib?: Address;
  /** Basis points of every buy taken by the protocol. An `immutable` in the implementation, so no
   *  clone can strip it. */
  protocolBps: bigint;
  explorer: string;
}

/**
 * **The live deployment** — the availability revision, deployed 2026-08-19. Unaudited, testnet
 * only. Adds the per-slot listing toggle (§10.4): `setAvailability`, the `SlotUnavailable` claim
 * gate, and `available` on `slotOf`/`SlotView`.
 *
 * Verified after deploy rather than assumed: the factory's recorded `rentalsLibCodehash` matches
 * the deployed library, and — the check that actually matters — a real tenancy was opened through
 * a clone by `scripts/smoke-deployment.ts`. §11.4's failure mode is that a mislinked library is
 * silent, so the codehash check alone proves only what the factory *records*, not what the
 * implementation's bytecode delegatecalls into.
 */
export const ROBINHOOD_TESTNET: Deployment = {
  chainId: 46630,
  version: 2,
  implementation: '0x1c93c952d727212614ae9b0ac8858749989fb525',
  factory: '0x9e793f52874b8d078571cd6c8d9930c532d6a953',
  reader: '0xbfa2e543737a0da41284989a4a9ac41e93ddd683',
  rentalsLib: '0xcf398fd9e1e28bbde42fd9e8f294a5aabc907ccc',
  protocolBps: 500n,
  explorer: 'https://explorer.testnet.chain.robinhood.com',
};

/**
 * The first v2 deployment, superseded by the availability revision above on the same day.
 * `slotOf`/`SlotView` changed shape with the revision, so this SDK cannot read boards cloned from
 * this implementation — same status as v1, kept for the same reason: provenance, and the fact that
 * the clones still exist on chain. Its boards: demo `0x66f39ad15dF3d155E988B115B3c8823206d0f96A`,
 * dispatch `0x34d45D8cA6530D4b42CcE4155F906Ba79B8AadDe`, devconf
 * `0x3235b0482f0e5BE7a3f72c5f529288586D190A0e`, remoteroles
 * `0xAc23DBa44852C7B2cF5a3855E5f554613c7E73dd`, vaultline
 * `0x214BE6cfC4a91313cdB2A66eb2Cb3fe65f4c8571`, smoke
 * `0xAe4Ff520d05C13C613d36F145e625Bc883e0B5b6`. Ledger: `scripts/examples.r1.json`.
 */
export const ROBINHOOD_TESTNET_R1: Deployment = {
  chainId: 46630,
  version: 2,
  implementation: '0xE6a15a21e6F10E6F65E4D9bCe5563eC36F941F16',
  factory: '0xb6d68573229212cb1b9b6f2dfe56bebbcc4bee81',
  reader: '0x4b91f09ee6f4c6ac0c468c09e68c721f07501352',
  rentalsLib: '0x7471ec2e0a6EDD4a0d362097668f0201CA230CEa',
  protocolBps: 500n,
  explorer: 'https://explorer.testnet.chain.robinhood.com',
};

/**
 * The v1 deployment, kept for the record and reachable by nothing in this package.
 *
 * Its implementation source was deleted with the rename and the SDK no longer carries its ABI, so
 * these addresses cannot be read through this codebase — they are here so that `DEMO_SITE_V1` and
 * `EXAMPLE_SITES_V1` below have a provenance rather than being five unexplained addresses. The
 * sources are in git history at `84c88d3^` if one ever needs recovering.
 */
export const ROBINHOOD_TESTNET_V1: Deployment = {
  chainId: 46630,
  version: 1,
  implementation: '0x4F3715BD138E452cf09125cd3C0d1E6139e57f2c',
  factory: '0x6C15Dd530594EeB5a66760a783f09f84272d3511',
  protocolBps: 500n,
  explorer: 'https://explorer.testnet.chain.robinhood.com',
};

/**
 * The first site created through the v2 factory, by `scripts/smoke-deployment.ts`.
 *
 * Kept as evidence rather than as a demo: it carries one claimed slot with a live tenancy on it,
 * which is the state that proves the delegatecalled library works on this chain. It is not the
 * scaffold's demo board and is not seeded to be interesting to look at.
 */
export const SMOKE_TEST_SITE: Address = '0x183F25b8b27abE9D8F994718818652aA14080283';

export const DEPLOYMENTS: Record<number, Deployment> = {
  [ROBINHOOD_TESTNET.chainId]: ROBINHOOD_TESTNET,
};

/**
 * The shared demo board the `create-websitekit` scaffold renders out of the box (§6). **v2, seeded
 * 2026-08-19 by `scripts/seed-demo.ts`.**
 *
 * Claimed and priced across two owners, with two slots left open, one under a live TENANCY, two
 * already taken once — and one (`nav.link.3`) registered but marked UNAVAILABLE, so the board
 * carries every state a real publisher's board can be in, including §10.4's off-market one. The
 * encumbered position is the number §2.4.2 exists for: `hero.image` costs 0.00028 to take and
 * ~0.0002716 net of the rent stream you inherit with it.
 *
 * Its keys match the scaffold's `websitekit.config.ts` exactly, because the page renders BY KEY.
 */
export const DEMO_SITE: Address = '0xed706C671D1060D7e40D3188918F2Fb1888a8d7d';

/** The v1 demo board. Unreachable from this package — kept so the record is not silently dropped. */
export const DEMO_SITE_V1: Address = '0xf770C72D4D72e375aed6fDd7c1670fc439757241';

/**
 * Example boards, deployed to answer "would this work for my site?" — which the demo board cannot,
 * because its shape is inherited and it is the only shape the docs show. **v2, seeded 2026-08-19.**
 *
 * They differ in the two things that actually vary between real sites: the slot layout, and the
 * economics chosen at `createSite`. Read them with `readSiteTerms` and the take multipliers come
 * back 1.4x, 2x, 1.3x and 1.6x — same implementation, four different markets. Their reversion tails
 * span 26, 4, 8 and 52 weeks, the last being the contract's ceiling.
 *
 * **v2 gave them a second axis.** Each also carries rent economics, and those vary as deliberately
 * as the take economics do: the conference takes the largest cut of rent (40%) over the shortest
 * term (14 days), and the job board the smallest cut (15%) over a 30-day hiring window, because
 * renting IS the product there. Unlike take economics, rent terms stay freely mutable for the site's
 * whole life (§2.5.1).
 *
 * Seeded by `scripts/seed-examples.ts`, their peripheral open slots added by
 * `scripts/seed-example-extras.ts`, and content written by `scripts/seed-example-content.ts`.
 * `scripts/examples.json` is the ledger those scripts actually read; this constant is the published
 * copy of it.
 */
export const EXAMPLE_SITES = {
  /** A newsletter archive. Slow reversion (0.95/week over 26 weeks) — an archive holds its value. */
  dispatch: '0xE0d1cF918a53eB92Ec672fa93530601ef4758Aa7',
  /** A conference site. 2x takes, and a 4-week reversion tail because the event has a date. */
  devconf: '0xB1A7262F3eD2e54F4d950c5Ae76A24D726156932',
  /** A job board. The fastest reversion of the four (0.85/week over 8 weeks) — listings churn. */
  remoteroles: '0xa7aea56116E6d478B501E2d75828A286e9E7C489',
  /** A DeFi protocol page. 1.6x takes, and `maxReversionWeeks: 52` — the contract's ceiling. */
  vaultline: '0x67E2A12B023c7715Ae98ea30563Bb86BEE57D89a',
} as const satisfies Record<string, Address>;

/**
 * The v1 example boards. Unreachable from this package — their implementation source is deleted and
 * the SDK no longer carries their ABI. Kept as provenance, and because they still exist on chain.
 *
 * They carry a stale `baseTokenURI` pointing at `https://slotkit.dev/...`, from before the rename.
 * Never fixed, and now never worth fixing.
 */
export const EXAMPLE_SITES_V1 = {
  dispatch: '0x895Fb4Ba710b0f495983A582b5c9013ccC33736c',
  devconf: '0xA7f8Dba26F82cc1deD9a63F28932eC87128834F0',
  remoteroles: '0x8c0d776ece615Ba01bE5038b95aA9Df5F3411f99',
  vaultline: '0xE41addf32313915F98b6cE5c63B6db8d0D6B092e',
} as const satisfies Record<string, Address>;

export function deploymentFor(chainId: number): Deployment {
  const deployment = DEPLOYMENTS[chainId];
  if (!deployment) {
    throw new Error(
      `websitekit: no deployment on chain ${chainId}. Deployed chains: ${Object.keys(DEPLOYMENTS).join(', ')}.`,
    );
  }
  return deployment;
}
