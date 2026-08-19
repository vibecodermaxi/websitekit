import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createPublicClient, http } from 'viem';
import { contentHashToCid, readContent, readSlots } from '@websitekit/sdk';
import { Slot } from '@websitekit/react';

import config from '../websitekit.config';
import { Board } from './board';

/**
 * A generic SaaS landing page where every visible element is separately owned.
 *
 * The whole board is ONE chain read, done here on the server (§5). `revalidate` of a few seconds is
 * the right default — a slot changing hands is not a sub-second concern, and the client polls on
 * focus for the rest.
 *
 * Notice how much `fallback` copy is on this page. That is deliberate and it is the product: on day
 * one almost nothing is claimed, and the page still has to be genuinely mistakable for a real
 * anonymous SaaS product. A grid of empty boxes teaches nobody anything.
 */
export const revalidate = 5;

/**
 * Resolves content on the SERVER so the words someone paid for are in the HTML.
 *
 * Without this the page ships `fallback` copy and the browser swaps in real content after hydrating
 * — a visible flash, and worse, a crawler only ever sees the placeholder. On a page whose entire
 * premise is that the headline belongs to somebody, serving the placeholder to search engines is
 * the wrong output.
 *
 * Reads from `content/` directly because that is where this scaffold's storage tier lives. A site
 * fetching from a pinning gateway would `fetch(config.contentUrl(cid))` here instead — the rest is
 * identical, including the verification, which is not optional on either path.
 */
async function resolveContent(hashes: `0x${string}`[]): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  await Promise.all(
    hashes.map(async (hash) => {
      try {
        const bytes = await readFile(path.join(process.cwd(), 'content', `${contentHashToCid(hash)}.bin`));
        // Verified here too. These bytes came off a disk this process does not own in any
        // meaningful sense, and the gate is the gate wherever the bytes came from.
        if (readContent(new Uint8Array(bytes), hash).ok) {
          resolved[hash] = bytes.toString('base64');
        }
      } catch {
        // Missing or unreadable — the slot renders its fallback, which is the designed behaviour
        // for content that is not available, not an error worth failing a page render over.
      }
    }),
  );

  return resolved;
}

export default async function Page() {
  const client = createPublicClient({ chain: config.chain, transport: http() });
  // `config.ref` — the `{ site, reader }` pair — rather than the address alone. v2 deleted the
  // site's own batch view and composes it in `SlotReader`, a separate and deliberately replaceable
  // deployment (§11.4). `defineSite` builds the pair for you; passing `config.address` here reads
  // as correct and hands viem an undefined reader address.
  const slots = await readSlots(client, config.ref, config.keys);

  const initialContent = await resolveContent(
    slots.map((slot) => slot.contentHash).filter((hash): hash is `0x${string}` => hash !== null),
  );

  return (
    <Board initialSlots={slots} initialContent={initialContent}>
      <header className="nav">
        <Slot id="nav.logo" as="strong" fallback="Northwind" />
        <nav>
          <Slot id="nav.link.1" fallback="Product" />
          <Slot id="nav.link.2" fallback="Docs" />
          <Slot id="nav.link.3" fallback="Pricing" />
          <Slot id="nav.cta" className="cta" fallback="Start free" />
        </nav>
      </header>

      <section className="hero">
        <Slot id="hero.eyebrow" as="p" className="eyebrow" fallback="Now in public beta" />
        <Slot id="hero.headline" as="h1" fallback="Ship faster, with less of everything." />
        <Slot
          id="hero.subhead"
          as="p"
          className="subhead"
          fallback="One platform for the work you were already doing in six tabs."
        />
        <Slot id="hero.image" className="hero-image" fallback="/placeholder-hero.svg" />
      </section>

      <section className="features">
        {[1, 2, 3].map((n) => (
          <article key={n}>
            <Slot id={`feature.${n}.title`} as="h3" fallback={DEFAULT_FEATURES[n - 1]!.title} />
            <Slot id={`feature.${n}.body`} as="p" fallback={DEFAULT_FEATURES[n - 1]!.body} />
          </article>
        ))}
      </section>

      <footer>
        <Slot id="footer.note" as="small" fallback="© Northwind. All rights reserved." />
      </footer>
    </Board>
  );
}

const DEFAULT_FEATURES = [
  { title: 'Built for teams', body: 'Roles, audit trails, and the permissions you actually needed.' },
  { title: 'Fast by default', body: 'Sub-second everywhere, without a migration or a rewrite.' },
  { title: 'Open where it counts', body: 'Export anything. Nothing here is a hostage.' },
];
