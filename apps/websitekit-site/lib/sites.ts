import { deploymentFor, exampleSitesFor, settlementTokenFor, defineSite } from '@websitekit/sdk';

import { exampleChain } from './chain';

/** Resolved once, and loudly: a mainnet page with no recorded boards is a build failure, not a blank page. */
const SITES = exampleSitesFor(exampleChain.id);
if (!SITES) throw new Error(`no example boards are recorded for ${exampleChain.name}`);
const EXAMPLE_SITES = SITES as Record<'dispatch' | 'devconf' | 'remoteroles' | 'vaultline', `0x${string}`>;

/**
 * The four example boards, as `defineSite` configs.
 *
 * Keys and floors mirror `packages/websitekit-sdk/scripts/seed-examples.ts` and
 * `seed-example-extras.ts`, which are what registered them on-chain. Floors here are display
 * metadata only — every price on the page is read from the chain, so a floor that drifts out of sync
 * with the contract shows up as nothing at all, which is exactly the sort of quiet wrong that this
 * comment exists to warn the next editor about. Change one, change both.
 *
 * **Floors are in dollars — $2 for each board's most prominent slot, $1 for the rest.** The boards
 * settle in USDG on Robinhood Chain mainnet, six decimals, and `decimals` below is what the floors
 * are parsed against. Prices on the page are read from the chain and formatted at the same decimals.
 *
 * `kind` is not cosmetic: it decides how `<Slot>` decodes a payload. `link` is JSON
 * `{ href, label }`, `text` is UTF-8.
 */

const common = {
  chain: exampleChain,
  decimals: settlementTokenFor(exampleChain.id).decimals,
  /**
   * Every read goes through `SlotReader` — a separate, deliberately REPLACEABLE deployment rather
   * than an address baked into the SDK (§11.4). v1 read the board out of the site itself, which is
   * why this argument is new and why it is required rather than defaulted.
   */
  reader: deploymentFor(exampleChain.id).reader!,
  contentUrl: (cid: string) => `/api/content/${cid}`,
};

export const dispatch = defineSite({
  ...common,
  address: EXAMPLE_SITES.dispatch,
  slots: {
    // The three "extras" — registered after launch and left open on purpose. These are what the
    // page advertises, because these are what a real publisher would actually be willing to sell.
    'announce.bar': { kind: 'link', floor: '1.00' },
    'nav.link.1': { kind: 'link', floor: '1.00' },
    'footer.link.1': { kind: 'link', floor: '1.00' },

    'masthead.title': { kind: 'text', floor: '1.00' },
    'masthead.tagline': { kind: 'text', floor: '1.00' },
    'sponsor.primary': { kind: 'link', floor: '2.00' },
    'issue.latest.sponsor': { kind: 'link', floor: '1.00' },
    'issue.prev.sponsor': { kind: 'link', floor: '1.00' },
    'recommended.1': { kind: 'link', floor: '1.00' },
    'recommended.2': { kind: 'link', floor: '1.00' },
    'recommended.3': { kind: 'link', floor: '1.00' },
    'footer.credit': { kind: 'text', floor: '1.00' },
  },
});

export const devconf = defineSite({
  ...common,
  address: EXAMPLE_SITES.devconf,
  slots: {
    'announce.bar': { kind: 'link', floor: '1.00' },
    'nav.link.1': { kind: 'link', floor: '1.00' },
    'footer.link.1': { kind: 'link', floor: '1.00' },

    'sponsor.headline': { kind: 'link', floor: '2.00' },
    'sponsor.gold.1': { kind: 'link', floor: '1.00' },
    'sponsor.gold.2': { kind: 'link', floor: '1.00' },
    'sponsor.gold.3': { kind: 'link', floor: '1.00' },
    'sponsor.silver.1': { kind: 'link', floor: '1.00' },
    'sponsor.silver.2': { kind: 'link', floor: '1.00' },
    'booth.1': { kind: 'text', floor: '1.00' },
    'booth.2': { kind: 'text', floor: '1.00' },
    'schedule.note': { kind: 'text', floor: '1.00' },
  },
});

export const remoteroles = defineSite({
  ...common,
  address: EXAMPLE_SITES.remoteroles,
  slots: {
    'nav.link.1': { kind: 'link', floor: '1.00' },
    'footer.link.2': { kind: 'link', floor: '1.00' },

    'banner.top': { kind: 'link', floor: '2.00' },
    'featured.1': { kind: 'link', floor: '1.00' },
    'featured.2': { kind: 'link', floor: '1.00' },
    'featured.3': { kind: 'link', floor: '1.00' },
    'featured.4': { kind: 'link', floor: '1.00' },
    'featured.5': { kind: 'link', floor: '1.00' },
    'category.design.sponsor': { kind: 'link', floor: '1.00' },
    'category.eng.sponsor': { kind: 'link', floor: '1.00' },
    'footer.link.1': { kind: 'link', floor: '1.00' },
  },
});

export const vaultline = defineSite({
  ...common,
  address: EXAMPLE_SITES.vaultline,
  slots: {
    'nav.link.1': { kind: 'link', floor: '1.00' },
    'footer.link.2': { kind: 'link', floor: '1.00' },

    'announce.bar': { kind: 'link', floor: '2.00' },
    'hero.headline': { kind: 'text', floor: '2.00' },
    'hero.sub': { kind: 'text', floor: '1.00' },
    'hero.cta': { kind: 'link', floor: '1.00' },
    'integration.1': { kind: 'link', floor: '1.00' },
    'integration.2': { kind: 'link', floor: '1.00' },
    'integration.3': { kind: 'link', floor: '1.00' },
    'integration.4': { kind: 'link', floor: '1.00' },
    'ecosystem.1': { kind: 'link', floor: '1.00' },
    'ecosystem.2': { kind: 'link', floor: '1.00' },
    'ecosystem.3': { kind: 'link', floor: '1.00' },
    'audit.note': { kind: 'text', floor: '1.00' },
    'footer.link.1': { kind: 'link', floor: '1.00' },
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
