/**
 * Where websitekit actually lives, in one place.
 *
 * The site shipped with exactly one link in it — an in-page `#examples` anchor — so a visitor
 * convinced by the pitch had nowhere to go. These are the two destinations that matter: the source,
 * and the packages.
 */
export const GITHUB_URL = 'https://github.com/vibecodermaxi/websitekit';

export interface PackageLink {
  name: string;
  url: string;
  blurb: string;
}

/**
 * Published 2026-08-20. `create-websitekit` is deliberately first: it is the only one a reader
 * should type, because the other two arrive as its dependencies.
 */
export const PACKAGES: PackageLink[] = [
  {
    name: 'create-websitekit',
    url: 'https://www.npmjs.com/package/create-websitekit',
    blurb: 'Scaffolds a Next.js board that renders against the shared demo site with no credentials.',
  },
  {
    name: '@websitekit/sdk',
    url: 'https://www.npmjs.com/package/@websitekit/sdk',
    blurb: 'Reads, writes and pricing. Takes your viem client; ships no wallet of its own.',
  },
  {
    name: '@websitekit/react',
    url: 'https://www.npmjs.com/package/@websitekit/react',
    blurb: '<Slot>, useSlot, useBuy, <BuyDialog>. Renders a position by key.',
  },
];

/** The one command the quick start asks for. */
export const CREATE_COMMAND = 'npm create websitekit my-site';
