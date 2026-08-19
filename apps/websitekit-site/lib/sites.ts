import { EXAMPLE_SITES, ROBINHOOD_TESTNET, defineSite } from '@websitekit/sdk';

import { robinhoodTestnet } from './chain';

/**
 * The four example boards, as `defineSite` configs.
 *
 * Keys and floors mirror `packages/websitekit-sdk/scripts/seed-examples.ts` and
 * `seed-example-extras.ts`, which are what registered them on-chain. Floors here are display
 * metadata only — every price on the page is read from the chain, so a floor that drifts out of sync
 * with the contract shows up as nothing at all, which is exactly the sort of quiet wrong that this
 * comment exists to warn the next editor about. Change one, change both.
 *
 * **Every floor is 0.0001 or 0.0002.** v2 derives `minFloor` from the settlement token's decimals —
 * `10 ** (decimals - 4)`, so 1e14 on a native site (§11.2) — and v1's board ran from 4e12 to 1.5e14.
 * Every value below the minimum reverts `InvalidFloor` now, so the boards were redeployed with a 2x
 * spread rather than v1's 37x. That is a testnet funding constraint, not a claim about what a real
 * board should charge.
 *
 * `kind` is not cosmetic: it decides how `<Slot>` decodes a payload. `link` is JSON
 * `{ href, label }`, `text` is UTF-8.
 */

const common = {
  chain: robinhoodTestnet,
  /**
   * Every read goes through `SlotReader` — a separate, deliberately REPLACEABLE deployment rather
   * than an address baked into the SDK (§11.4). v1 read the board out of the site itself, which is
   * why this argument is new and why it is required rather than defaulted.
   */
  reader: ROBINHOOD_TESTNET.reader!,
  contentUrl: (cid: string) => `/api/content/${cid}`,
};

export const dispatch = defineSite({
  ...common,
  address: EXAMPLE_SITES.dispatch,
  slots: {
    // The three "extras" — registered after launch and left open on purpose. These are what the
    // page advertises, because these are what a real publisher would actually be willing to sell.
    'announce.bar': { kind: 'link', floor: '0.0001' },
    'nav.link.1': { kind: 'link', floor: '0.0001' },
    'footer.link.1': { kind: 'link', floor: '0.0001' },

    'masthead.title': { kind: 'text', floor: '0.0001' },
    'masthead.tagline': { kind: 'text', floor: '0.0001' },
    'sponsor.primary': { kind: 'link', floor: '0.0002' },
    'issue.latest.sponsor': { kind: 'link', floor: '0.0001' },
    'issue.prev.sponsor': { kind: 'link', floor: '0.0001' },
    'recommended.1': { kind: 'link', floor: '0.0001' },
    'recommended.2': { kind: 'link', floor: '0.0001' },
    'recommended.3': { kind: 'link', floor: '0.0001' },
    'footer.credit': { kind: 'text', floor: '0.0001' },
  },
});

export const devconf = defineSite({
  ...common,
  address: EXAMPLE_SITES.devconf,
  slots: {
    'announce.bar': { kind: 'link', floor: '0.0001' },
    'nav.link.1': { kind: 'link', floor: '0.0001' },
    'footer.link.1': { kind: 'link', floor: '0.0001' },

    'sponsor.headline': { kind: 'link', floor: '0.0002' },
    'sponsor.gold.1': { kind: 'link', floor: '0.0001' },
    'sponsor.gold.2': { kind: 'link', floor: '0.0001' },
    'sponsor.gold.3': { kind: 'link', floor: '0.0001' },
    'sponsor.silver.1': { kind: 'link', floor: '0.0001' },
    'sponsor.silver.2': { kind: 'link', floor: '0.0001' },
    'booth.1': { kind: 'text', floor: '0.0001' },
    'booth.2': { kind: 'text', floor: '0.0001' },
    'schedule.note': { kind: 'text', floor: '0.0001' },
  },
});

export const remoteroles = defineSite({
  ...common,
  address: EXAMPLE_SITES.remoteroles,
  slots: {
    'nav.link.1': { kind: 'link', floor: '0.0001' },
    'footer.link.2': { kind: 'link', floor: '0.0001' },

    'banner.top': { kind: 'link', floor: '0.0002' },
    'featured.1': { kind: 'link', floor: '0.0001' },
    'featured.2': { kind: 'link', floor: '0.0001' },
    'featured.3': { kind: 'link', floor: '0.0001' },
    'featured.4': { kind: 'link', floor: '0.0001' },
    'featured.5': { kind: 'link', floor: '0.0001' },
    'category.design.sponsor': { kind: 'link', floor: '0.0001' },
    'category.eng.sponsor': { kind: 'link', floor: '0.0001' },
    'footer.link.1': { kind: 'link', floor: '0.0001' },
  },
});

export const vaultline = defineSite({
  ...common,
  address: EXAMPLE_SITES.vaultline,
  slots: {
    'nav.link.1': { kind: 'link', floor: '0.0001' },
    'footer.link.2': { kind: 'link', floor: '0.0001' },

    'announce.bar': { kind: 'link', floor: '0.0002' },
    'hero.headline': { kind: 'text', floor: '0.0002' },
    'hero.sub': { kind: 'text', floor: '0.0001' },
    'hero.cta': { kind: 'link', floor: '0.0001' },
    'integration.1': { kind: 'link', floor: '0.0001' },
    'integration.2': { kind: 'link', floor: '0.0001' },
    'integration.3': { kind: 'link', floor: '0.0001' },
    'integration.4': { kind: 'link', floor: '0.0001' },
    'ecosystem.1': { kind: 'link', floor: '0.0001' },
    'ecosystem.2': { kind: 'link', floor: '0.0001' },
    'ecosystem.3': { kind: 'link', floor: '0.0001' },
    'audit.note': { kind: 'text', floor: '0.0001' },
    'footer.link.1': { kind: 'link', floor: '0.0001' },
  },
});

/** What each example claims to be, for the banner that tells a visitor what they are looking at. */
export interface ExampleMeta {
  slug: string;
  site: string;
  premise: string;
  /** The frozen economics, as `readSiteTerms` would return them. Shown, not computed. */
  terms: string;
  /** Why those economics, in one sentence. This is the whole reason four boards exist. */
  why: string;
  config: typeof dispatch;
}

export const EXAMPLES: ExampleMeta[] = [
  {
    slug: 'dispatch',
    site: 'The Weekly Dispatch',
    premise: 'A newsletter archive',
    terms: 'take 1.4× · payout 1.15× · reversion 0.95/week over 26 weeks · rent fee 25% · terms to 90 days',
    why: 'The slowest reversion of the four, because an archive keeps earning long after the send — a sponsor holds most of their position for months rather than weeks, and books it by the month too.',
    config: dispatch,
  },
  {
    slug: 'devconf',
    site: 'DevConf Autumn',
    premise: 'A conference site',
    terms: 'take 2× · payout 1.2× · reversion 0.9/week over 4 weeks · rent fee 40% · terms to 14 days',
    why: 'The steepest take premium, because sponsor tiers are an auction already — and a 4-week reversion tail, because a dated event has no use for a price that takes a year to come back down. It also takes the largest cut of rent, over the shortest terms.',
    config: devconf,
  },
  {
    slug: 'remoteroles',
    site: 'Remote Roles',
    premise: 'A job board',
    terms: 'take 1.3× · payout 1.1× · reversion 0.85/week over 8 weeks · rent fee 15% · terms to 30 days',
    why: 'The lowest take premium and the fastest reversion: friction is the enemy when you want turnover, and a listing nobody refreshes is back at floor inside two months. It takes the smallest cut of rent of the four, because renting is the product here.',
    config: remoteroles,
  },
  {
    slug: 'vaultline',
    site: 'Vaultline',
    premise: 'A DeFi protocol',
    terms: 'take 1.6× · payout 1.2× · reversion 0.9/week over 52 weeks · rent fee 30% · terms to 365 days',
    why: 'Ecosystem placement is already bought and sold off-chain, at BD-deal pace. Steep takes because an integrations row is genuinely contested, and the longest reversion tail the contract allows — an ecosystem page is a long game, which is why its rental terms run to the full 365 days as well.',
    config: vaultline,
  },
];

export function exampleFor(slug: string): ExampleMeta | undefined {
  return EXAMPLES.find((example) => example.slug === slug);
}
