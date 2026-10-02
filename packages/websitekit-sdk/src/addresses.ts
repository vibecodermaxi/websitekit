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

import { ROBINHOOD_MAINNET_CHAIN, ROBINHOOD_TESTNET_CHAIN } from './chains';

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
 * **The live deployment** — the treasury-pin generation, deployed 2026-09-03. Unaudited, testnet
 * only. Its implementation is the first carrying `SiteConfig.pinTreasury`, which is the whole of
 * what render escrow needs from frozen bytecode (`docs/PROTOCOL-SPEC.md` §10.4.1).
 *
 * **A board cannot move between generations and nothing tries to.** `treasury` is frozen at
 * `createSite`, so every board cloned before this one can never be pinned and never be escrowed;
 * they keep working, addressed directly, and `ROBINHOOD_TESTNET_R2` below is where they live.
 * `slotOf`/`SlotView` did not change shape, so ONE SDK reads both generations — which is the
 * difference between this supersession and the R1 one, where it could not.
 *
 * Verified after deploy rather than assumed: the factory's recorded `rentalsLibCodehash` matches
 * the deployed library, and the implementation answers `treasuryPinned()` — the call that
 * distinguishes this generation from the one below, and that `scripts/deploy-escrow.ts` makes
 * before it will deploy anything. §11.4's failure mode is that a mislinked library is silent, so
 * the codehash check alone proves only what the factory *records*, not what the implementation's
 * bytecode delegatecalls into.
 */
export const ROBINHOOD_TESTNET: Deployment = {
  // Both from `chains.ts` rather than repeated here: a chain id and an explorer typed twice are two
  // values that must agree with nothing asserting that they do. The superseded records below keep
  // their literals — they are provenance, frozen, and not read by anything that could drift.
  chainId: ROBINHOOD_TESTNET_CHAIN.id,
  version: 2,
  implementation: '0xf4b359b915f374d9f44ad145831fe9a06cf0d83b',
  factory: '0x95f55c8f81518202f88779bdc377bb077852b0cd',
  reader: '0xb875e236b88c01d73844071742731b64aba91708',
  rentalsLib: '0x029199b4416f3c5bfdc8f65f318cb66a0e5047eb',
  protocolBps: 500n,
  explorer: ROBINHOOD_TESTNET_CHAIN.explorer,
};

/**
 * **Mainnet.** Deployed 2026-09-19 by `scripts/deploy-protocol.ts` against chain 4663, the first
 * websitekit deployment on a chain where the money is real.
 *
 * Same generation as the testnet record above — it carries `SiteConfig.pinTreasury`, so boards
 * created through the escrow factory can be pinned to a vault. Unaudited; there is no audit and
 * none is planned (`docs/mainnet_deployment.md` §2).
 *
 * `protocolTreasury` is `0xC73C881bCe4F986A93d259e654A5279b886c5094`, an `immutable` with no setter
 * on every site ever cloned from this implementation. The link was verified after deploy rather
 * than assumed: the factory records `0x2747A3D8…` for `RentalsLib` and the codehash matches the
 * library that was just deployed — §11.4's failure mode is that a mislinked library is silent.
 */
export const ROBINHOOD_MAINNET: Deployment = {
  chainId: ROBINHOOD_MAINNET_CHAIN.id,
  version: 2,
  implementation: '0x892e2d069942fb92d39aa7abaf421197808c128f',
  factory: '0x939eb0ab90f7c8b3889d8950d54b2edf7a0fb21f',
  reader: '0x806ca3b9108e6facd45a1556e102140387e1bcd9',
  rentalsLib: '0x2747a3d8212b1936d244b6f902947821a5c1a187',
  protocolBps: 500n,
  explorer: ROBINHOOD_MAINNET_CHAIN.explorer,
};

/**
 * Render escrow on MAINNET, deployed 2026-09-22 by `scripts/deploy-escrow.ts` against
 * `ROBINHOOD_MAINNET` above. `docs/mainnet_deployment.md` step 1; `docs/escrow_mainnet.md` E-7
 * steps 2 to 4.
 *
 * **Its vault is byte-identical to the one E-2 and E-4 proved on 46630, and that was checked
 * rather than assumed.** Both runtimes are 11,372 B and differ in exactly six 20-byte runs — three
 * holding `factory`, three holding `registry`, which are the contract's only two immutables, each
 * carrying its own chain's address. Every other byte matches. That is what makes *mainnet runs the
 * bytecode that was proved* a claim anybody can re-check with two `cast code` calls, rather than an
 * inference from a deploy having succeeded.
 *
 * **Params are the settled ones, not the testnet-short ones**: window 1209600s, claim delay
 * 43200s, transition spacing 21600s — E-4, decided 2026-09-18. `minBooking` is **100000**, i.e.
 * $0.10 on 6-decimal USDG, and it is the one parameter E-4 did not settle; testnet ran 1, which on
 * a real token is no threshold at all against the dust that bloats the array `claim` walks.
 *
 * Allowlisted token: real USDG `0x5fc5360D...d168` and nothing else. **The address was confirmed
 * against Robinhood's own documentation on 2026-09-22**, not merely read off the chain, because
 * every impersonator here answers `DOMAIN_SEPARATOR()` and the fake `usdg` has more holders than
 * the real one.
 *
 * **Owned by `0x15e1D12F...05c6`, which is `PLATFORM_ADMINS`** — `setParams`, `allowToken`,
 * `setAttestor` and `withdrawReserve`, for the life of the factory. Worth knowing because
 * `deploy-escrow.ts` says it nowhere: its SIGNER becomes that owner, so a deploy key silently
 * becomes a standing privileged key unless ownership is moved afterwards. It was, on 2026-09-22.
 *
 * **The referee is `ESCROW_ATTESTOR_KEY`, the same key as on testnet**, set with `setAttestor`
 * after the deploy. It is never the relayer — E-0, and `deploy-escrow.ts` refuses that by name,
 * because whoever can both move money and mark a board dark can buy at the floor, mark dark and
 * claim. That is the only key separation here that buys a security property; the reserve funder was
 * merged into the relayer on the same day, since `EscrowVault.fundReserve` is `external payable`
 * with no access control and anyone at all may call it.
 */
export const ROBINHOOD_MAINNET_ESCROW = {
  chainId: ROBINHOOD_MAINNET_CHAIN.id,
  factory: '0x6325e655f01c1c2f5d7f05de230a31a9ddc82513',
  attestor: '0xed0d571da2393cc6701a0d0d3b0fa090aad6987c',
  vault: '0x6891bae1bdcb0ef417aaf38a147619139df69b8f',
} as const satisfies { chainId: number } & Record<'factory' | 'attestor' | 'vault', Address>;

/**
 * Render escrow, **redeployed 2026-09-21** by `scripts/deploy-escrow.ts` against the generation
 * above, to put `claim`'s minimum-out on a chain before mainnet saw it first. The generation it
 * replaced is `ROBINHOOD_TESTNET_ESCROW_R1` below.
 *
 * **Not part of `Deployment`, because none of it is generation-bound.** A vault, its factory and
 * the registry can be redeployed and pointed at any pinned board; the implementation above cannot.
 * Keeping them in a separate record is what stops a redeploy here reading as a new generation.
 *
 * `attestor` is the registry, not the key — the key it names is rotatable with `setAttestor`, and
 * zero means nobody, which is the fail-open property the whole design rests on. `vault` is the
 * implementation every board's vault is an EIP-1167 clone of.
 *
 * Params at deploy: window 3600s, claim delay 900s, transition spacing 600s, minBooking 1. Those
 * are TESTNET-SHORT so the loop can be driven by hand — `docs/escrow_contract.md` §11 settles the
 * real values at 1209600 / 43200 / 21600, and `EscrowFactory.setParams` moves them for boards
 * created after the change. Allowlisted token: TestUSD `0x1962c355…`, and nothing else.
 */
export const ROBINHOOD_TESTNET_ESCROW = {
  chainId: ROBINHOOD_TESTNET_CHAIN.id,
  factory: '0xbe82523ae5d552daf772c4075a38c9b9c202eb86',
  attestor: '0x0fcde0325301bc8328b48ce8e17c7041b19371f2',
  vault: '0x8a09723821523023683ab1dd501147f37e53d8ab',
} as const satisfies { chainId: number } & Record<'factory' | 'attestor' | 'vault', Address>;

/**
 * The escrow generation this superseded, deployed 2026-09-03 and replaced 2026-09-21.
 *
 * **Replaced because `vaultImplementation` is `immutable` and built by the factory's own
 * constructor** — a vault needs its factory's address and a factory needs its implementation's, so
 * one has to create the other and neither can be swapped afterwards. Getting `claim`'s minimum-out
 * onto a chain therefore meant a new factory, not a new vault.
 *
 * Its vault is 11,307 B and carries `claim(bytes32)` with no floor, so a claimant is paid whatever
 * the block holds. Boards bound to it stay bound to it forever; on testnet that is fine and on
 * mainnet it is the reason this was proved here first.
 */
export const ROBINHOOD_TESTNET_ESCROW_R1 = {
  chainId: ROBINHOOD_TESTNET_CHAIN.id,
  factory: '0x9be87b6732a46cecfca4e46fbe65a6c46aedfddf',
  attestor: '0x4ce6109f7b5bf12046299fb4fee49f963b0f06ef',
  vault: '0x38aed6b3eef84aa178d1c8606c824594f61f0006',
} as const satisfies { chainId: number } & Record<'factory' | 'attestor' | 'vault', Address>;

/**
 * The availability revision, deployed 2026-08-19 and **superseded 2026-09-03** by the pin
 * generation above. Still live, still readable by this SDK, and still where every board in
 * `DEMO_SITE`, `EXAMPLE_SITES` and `SMOKE_TEST_SITE` is a clone — so this is not provenance the
 * way `_R1` and `_V1` are. It is the generation the seeded boards are ON.
 *
 * Nothing needs to move. A clone keeps the implementation it was created from forever, the reader
 * is not generation-bound, and the only thing this generation cannot do is carry a pinned
 * treasury — which is to say, be escrowed.
 */
export const ROBINHOOD_TESTNET_R2: Deployment = {
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
  [ROBINHOOD_MAINNET.chainId]: ROBINHOOD_MAINNET,
};

/**
 * Render escrow, by chain — the escrow counterpart to `DEPLOYMENTS`.
 *
 * **Separate map, and `escrowDeploymentFor` returns `undefined` rather than throwing**, because
 * escrow is OPTIONAL in a way a protocol deployment is not: a chain can have boards and no vaults,
 * which is exactly what 4663 was between 2026-09-19 and 2026-09-22, and what any chain is before
 * `deploy-escrow.ts` runs. `deploymentFor` throws for the opposite reason — without a factory and a
 * reader there is nothing to do at all.
 */
export const ESCROW_DEPLOYMENTS: Record<number, { chainId: number; factory: Address; attestor: Address; vault: Address }> = {
  [ROBINHOOD_TESTNET_ESCROW.chainId]: ROBINHOOD_TESTNET_ESCROW,
  [ROBINHOOD_MAINNET_ESCROW.chainId]: ROBINHOOD_MAINNET_ESCROW,
};

export function escrowDeploymentFor(chainId: number) {
  return ESCROW_DEPLOYMENTS[chainId];
}

/**
 * The TESTNET demo board — native ETH, the scaffold's default before mainnet (§6). **v2, seeded
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

/**
 * The mainnet demo board — Northwind, settling in USDG. **Seeded 2026-10-03 by `scripts/seed-demo.ts`
 * and given content by `scripts/seed-content.ts`**, against `ROBINHOOD_MAINNET`.
 *
 * Owned by two demo accounts, with two slots open, one off the market,
 * two taken once and `hero.image` rented for 30 days — so that tenancy LAPSES on 2026-11-02 and the
 * board stops showing an encumbered position until somebody rents it again. Same keys and floors as
 * the scaffold's `websitekit.config.ts`.
 */
export const DEMO_SITE_MAINNET: Address = '0x551Ae25b8964ab79691c62749AA329c1ece5D243';

/**
 * The scaffold's demo board on each chain, keyed by chain id.
 *
 * `demoSiteFor` answers `undefined` for a chain with no entry rather than falling back to another
 * chain's board: a page reading an address from the wrong chain gets an empty board from a contract
 * that is not there, which looks like a broken scaffold rather than a missing seed. The caller
 * decides what to say; the scaffold refuses at import time and names the variable to set.
 */
export const DEMO_SITES: Record<number, Address> = {
  [ROBINHOOD_MAINNET_CHAIN.id]: DEMO_SITE_MAINNET,
  [ROBINHOOD_TESTNET_CHAIN.id]: DEMO_SITE,
};

export function demoSiteFor(chainId: number): Address | undefined {
  return DEMO_SITES[chainId];
}

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
 * The four example boards on MAINNET, settling in USDG. **Seeded 2026-10-03 by
 * `scripts/seed-examples.ts`, content by `scripts/seed-example-content.ts`**, against
 * `ROBINHOOD_MAINNET`. Same layouts and economics as `EXAMPLE_SITES`, in their final shape from the
 * start: every content slot owned across two demo accounts, a couple taken once, and only the edge
 * slots open. Floors $2 for each board's most prominent slot, $1 for the rest.
 */
export const EXAMPLE_SITES_MAINNET = {
  dispatch: '0x6Db93fE0dd003f616081D0e8bDA58da33B464Eef',
  devconf: '0x951B16F06D31707FdE54fe177918C55550BaAaa0',
  remoteroles: '0xc1920ee84B1da603A514f5a5403019b7d1b98627',
  vaultline: '0x50838AfEc1329dF3fA3ACDEd27355ab2af7b4dB8',
} as const satisfies Record<string, Address>;

/**
 * Each chain's example boards, keyed by chain id. Like `demoSiteFor`, `exampleSitesFor` answers
 * `undefined` for a chain with none rather than another chain's boards.
 */
export const EXAMPLE_SITES_BY_CHAIN: Record<number, Record<string, Address>> = {
  [ROBINHOOD_MAINNET_CHAIN.id]: EXAMPLE_SITES_MAINNET,
  [ROBINHOOD_TESTNET_CHAIN.id]: EXAMPLE_SITES,
};

export function exampleSitesFor(chainId: number): Record<string, Address> | undefined {
  return EXAMPLE_SITES_BY_CHAIN[chainId];
}

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
