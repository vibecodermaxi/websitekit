import { notFound } from 'next/navigation';
import { createPublicClient, http } from 'viem';
import { readSiteTerms, readSlots } from '@websitekit/sdk';

import { EXAMPLES, exampleFor } from '../../../lib/sites';
import { resolveContent } from '../../../lib/content';
import { Board } from './board';
import { Ribbon } from './ribbon';
import { Dispatch } from './dispatch';
import { DevConf } from './devconf';
import { RemoteRoles } from './remoteroles';
import { Vaultline } from './vaultline';
import { Earnings } from './earnings';

/**
 * An example board, rendered from the chain on every request.
 *
 * The whole board is ONE read (§5) and it happens here on the server, so the first paint carries
 * real owners and real prices. `revalidate` of a few seconds is the right default — a slot changing
 * hands is not a sub-second concern, and the client polls on focus for the rest.
 */
export const revalidate = 5;

export function generateStaticParams() {
  return EXAMPLES.map((example) => ({ slug: example.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const example = exampleFor(slug);
  if (!example) return {};
  return {
    title: `${example.site} — a websitekit example board`,
    description: example.why,
  };
}

const LAYOUTS: Record<string, () => React.ReactElement> = {
  dispatch: Dispatch,
  devconf: DevConf,
  remoteroles: RemoteRoles,
  vaultline: Vaultline,
};

export default async function ExamplePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const example = exampleFor(slug);
  const Layout = LAYOUTS[slug];
  if (!example || !Layout) notFound();

  const config = example.config;
  const client = createPublicClient({ chain: config.chain, transport: http() });
  // Terms alongside the board. `getTerms()` is one call rather than nine, which is the whole reason
  // it exists on the contract — and the earnings table below is computed from it, not from any
  // multiplier written down in this repo.
  // `config.ref` rather than `config.address`: v2 deleted the site's own batch view and composes it
  // in `SlotReader`, a separate and deliberately replaceable deployment (§11.4). Both reads take the
  // pair.
  const [slots, terms] = await Promise.all([
    readSlots(client, config.ref, config.keys),
    readSiteTerms(client, config.ref),
  ]);

  const initialContent = await resolveContent(
    slots.map((slot) => slot.contentHash).filter((hash): hash is `0x${string}` => hash !== null),
  );

  return (
    <>
      <Ribbon example={example} claimed={slots.filter((slot) => slot.owner).length} total={slots.length} />
      <Board slug={slug} initialSlots={slots} initialContent={initialContent}>
        <Layout />
      </Board>
      <Earnings example={example} slots={slots} terms={terms} />
    </>
  );
}
