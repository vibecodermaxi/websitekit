import { defineSite } from '@websitekit/sdk';
import { chain, demoSite, deployment, settlement } from './lib/chain';

/**
 * Every ownable region of this page, and what it costs to claim one.
 *
 * A slot key is a permanent on-chain identity: `keccak256("hero.headline")` is the ERC-721 token
 * id, forever. Renaming a key does not rename a slot — it points at a different, unregistered one
 * and orphans whatever the old key holds. Add and retire keys freely before you deploy; treat them
 * as frozen afterwards.
 *
 * Floors are decimal strings in DOLLARS, not numbers, so `0.20` never passes through a JS float.
 * Boards created from this project settle in USDG on mainnet and in the tUSD stand-in on testnet —
 * both six decimals, so the same string is the same number of dollars on either.
 */
const site = (process.env.NEXT_PUBLIC_WEBSITEKIT_SITE as `0x${string}` | undefined) ?? demoSite;
if (!site) {
  throw new Error(
    `There is no shared demo board on ${chain.name} yet. Deploy your own with \`pnpm deploy:site\`, ` +
      'set NEXT_PUBLIC_WEBSITEKIT_SITE to a board you want to read, or set ' +
      'NEXT_PUBLIC_WEBSITEKIT_CHAIN_ID=46630 to read the testnet demo.',
  );
}

export default defineSite({
  // Both written into .env by `pnpm deploy:site`. Until you run it, this renders the SHARED DEMO
  // BOARD — already claimed and priced across two owners, with slots left open, two taken once and
  // one under a live tenancy. `pnpm dev` therefore works with no credential at all, which is the
  // point: an empty board teaches nothing about the mechanic, and neither does a setup wizard.
  //
  // The keys below match that board exactly, because the page renders BY KEY.
  address: site,

  // Every read goes through `SlotReader` — a separate, deliberately REPLACEABLE deployment, which
  // is why it is an address you hold rather than one baked into the SDK. The published one is the
  // default; override it in .env to adopt a newer reader without waiting for an SDK release.
  reader:
    (process.env.NEXT_PUBLIC_WEBSITEKIT_READER as `0x${string}` | undefined) ?? deployment.reader!,

  chain,

  // Decimals of the settlement token the floors below are parsed against — 6 for USDG and tUSD.
  // Prices on the PAGE are formatted from the board's own token, read from the chain, so a board
  // that settles in something else still shows its own currency correctly.
  //
  // It also fixes `minFloor`, which the contract derives as `10 ** (decimals - 4)` — $0.0001 at six
  // decimals (§11.2). Every floor below is well clear of it; one that is not reverts `InvalidFloor`
  // and takes the whole `createSite` down with it.
  decimals: settlement.decimals,

  // Where content bytes come from. Defaults to this project's own route, which serves the files in
  // `content/` — no credentials, works offline. Point it at a pinning gateway or your own bucket
  // when you have one; whatever it returns is hash-checked before it renders.
  contentUrl: (cid) => `/api/content/${cid}`,

  slots: {
    'nav.logo': { kind: 'text', floor: '2.00' },
    'nav.link.1': { kind: 'link', floor: '1.00' },
    'nav.link.2': { kind: 'link', floor: '1.00' },
    'nav.link.3': { kind: 'link', floor: '1.00' },
    'nav.cta': { kind: 'link', floor: '3.00' },

    'hero.eyebrow': { kind: 'text', floor: '0.50' },
    'hero.headline': { kind: 'text', floor: '5.00' },
    'hero.subhead': { kind: 'text', floor: '2.00' },
    'hero.image': { kind: 'image', floor: '4.00' },

    'feature.1.title': { kind: 'text', floor: '0.80' },
    'feature.1.body': { kind: 'text', floor: '0.40' },
    'feature.2.title': { kind: 'text', floor: '0.80' },
    'feature.2.body': { kind: 'text', floor: '0.40' },
    'feature.3.title': { kind: 'text', floor: '0.80' },
    'feature.3.body': { kind: 'text', floor: '0.40' },

    'footer.note': { kind: 'text', floor: '0.20' },
  },
});
