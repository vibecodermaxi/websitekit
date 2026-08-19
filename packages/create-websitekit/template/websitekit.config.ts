import { DEMO_SITE, ROBINHOOD_TESTNET, defineSite } from '@websitekit/sdk';
import { robinhoodTestnet } from './lib/chain';

/**
 * Every ownable region of this page, and what it costs to claim one.
 *
 * A slot key is a permanent on-chain identity: `keccak256("hero.headline")` is the ERC-721 token
 * id, forever. Renaming a key does not rename a slot — it points at a different, unregistered one
 * and orphans whatever the old key holds. Add and retire keys freely before you deploy; treat them
 * as frozen afterwards.
 *
 * Floors are decimal strings, not numbers, so `0.002` never passes through a JS float. They are
 * parsed against `decimals` below — the SETTLEMENT token's, not always 18. A site settling in
 * 6-decimal USDG that leaves this at the default parses every floor 1e12 too high.
 */
export default defineSite({
  // Both written into .env by `pnpm deploy:site`. Until you run it, this renders the SHARED DEMO
  // BOARD — already claimed and priced across two owners, with slots left open, two taken once and
  // one under a live tenancy. `pnpm dev` therefore works with no credential at all, which is the
  // point: an empty board teaches nothing about the mechanic, and neither does a setup wizard.
  //
  // The keys below match that board exactly, because the page renders BY KEY.
  address: (process.env.NEXT_PUBLIC_WEBSITEKIT_SITE as `0x${string}` | undefined) ?? DEMO_SITE,

  // Every read goes through `SlotReader` — a separate, deliberately REPLACEABLE deployment, which
  // is why it is an address you hold rather than one baked into the SDK. The published one is the
  // default; override it in .env to adopt a newer reader without waiting for an SDK release.
  reader:
    (process.env.NEXT_PUBLIC_WEBSITEKIT_READER as `0x${string}` | undefined) ?? ROBINHOOD_TESTNET.reader!,

  chain: robinhoodTestnet,

  // Decimals of the settlement token this site was deployed with. 18 is native; USDG is 6.
  //
  // It also fixes the site's `minFloor`, which the contract derives as `10 ** (decimals - 4)` —
  // 0.0001 natively, 100 units on 6-decimal USDG (§11.2). Every floor below is well clear of it;
  // one that is not reverts `InvalidFloor` and takes the whole `createSite` down with it.
  decimals: 18,

  // Where content bytes come from. Defaults to this project's own route, which serves the files in
  // `content/` — no credentials, works offline. Point it at a pinning gateway or your own bucket
  // when you have one; whatever it returns is hash-checked before it renders.
  contentUrl: (cid) => `/api/content/${cid}`,

  slots: {
    'nav.logo': { kind: 'text', floor: '0.002' },
    'nav.link.1': { kind: 'link', floor: '0.001' },
    'nav.link.2': { kind: 'link', floor: '0.001' },
    'nav.link.3': { kind: 'link', floor: '0.001' },
    'nav.cta': { kind: 'link', floor: '0.003' },

    'hero.eyebrow': { kind: 'text', floor: '0.0005' },
    'hero.headline': { kind: 'text', floor: '0.005' },
    'hero.subhead': { kind: 'text', floor: '0.002' },
    'hero.image': { kind: 'image', floor: '0.004' },

    'feature.1.title': { kind: 'text', floor: '0.0008' },
    'feature.1.body': { kind: 'text', floor: '0.0004' },
    'feature.2.title': { kind: 'text', floor: '0.0008' },
    'feature.2.body': { kind: 'text', floor: '0.0004' },
    'feature.3.title': { kind: 'text', floor: '0.0008' },
    'feature.3.body': { kind: 'text', floor: '0.0004' },

    'footer.note': { kind: 'text', floor: '0.0002' },
  },
});
