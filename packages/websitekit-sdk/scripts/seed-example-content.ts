/**
 * Writes real content onto the four example boards, and commits the bytes into `apps/websitekit-site`.
 *
 * `seed-examples.ts` gave those boards owners, prices and a take history — everything except the one
 * thing a visitor can actually see. Every slot still rendered its `fallback`, so a board that was
 * 6/9 claimed looked pixel-identical to one nobody had touched. The mechanic was there and invisible.
 *
 * Content needs somewhere retrievable by hash (§3's first honest caveat: reads are backend-free,
 * writes are not). Rather than take a pinning credential, the bytes are written into
 * `apps/websitekit-site/content/` and served by that app's own `/api/content/[cid]` route — §3's middle
 * tier, the dev's own upload route.
 *
 *   set -a && . ./.env && set +a
 *   pnpm --filter @websitekit/sdk exec tsx scripts/seed-example-content.ts
 *
 * **Who may write is READ, not inferred.** v1's rule — "only the owner can edit" — is no longer the
 * whole rule: during a live tenancy the TENANT holds the content gate and the owner is locked out
 * entirely (§2.3). This holds both keys and asks `canEdit` which of them the contract will accept,
 * rather than routing by ownership and discovering the difference as a revert.
 *
 * **It plans the whole run before sending any of it, and budgets gas per WALLET.** Editing costs no
 * value, only gas — which is exactly why the first version had no budget check and ran the taker dry
 * two boards in. An account that cannot afford a transaction fails its gas estimate, and viem
 * surfaces that as `execution reverted` with no revert data: indistinguishable, at the call site,
 * from the contract refusing the edit. It sent me to read `canEdit` on a slot whose `canEdit` was
 * true. Planning first turns a wallet running dry into a message before the first send.
 */
import type { Address } from 'viem';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ContentKind, buildEdit, encodeContent, encodeText, readCanEdit, readSlots } from '../src/index';
import {
  EDIT_GAS,
  deployer,
  deployerWallet,
  ensureFunded,
  exampleSites,
  publicClient,
  refFor,
  send,
  taker,
  takerWallet,
} from './lib/chain';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contentDir = path.resolve(__dirname, '../../../apps/websitekit-site/content');

const link = (href: string, label: string) =>
  encodeContent(ContentKind.Link, new TextEncoder().encode(JSON.stringify({ href, label })));

/**
 * Deliberately NOT the pages' fallback copy.
 *
 * If seeded content matched the fallbacks, each page would look the same whether the hash gate
 * worked or silently failed — which is the one thing this seeding exists to make visible. Every
 * string below is content an owner "bought and wrote"; the fallbacks in the JSX are what the site
 * itself says when nobody has.
 */
const CONTENT: Record<string, Record<string, ReturnType<typeof encodeText>>> = {
  dispatch: {
    'masthead.title': encodeText('The Weekly Dispatch'),
    'masthead.tagline': encodeText('Owned, edited and paid for by whoever wants it most.'),
    'sponsor.primary': link('https://example.com/warpdrive', 'Warpdrive — CI that finishes before you switch tabs'),
    'issue.latest.sponsor': link('https://example.com/tidepool', 'Brought to you by Tidepool Analytics'),
    'recommended.1': link('https://example.com/thelongform', 'The Longform — one essay, every Sunday'),
    'recommended.2': link('https://example.com/nightshift', 'Night Shift — infrastructure, after hours'),
    'recommended.3': link('https://example.com/deadreckoning', 'Dead Reckoning — shipping notes from a solo founder'),
    'issue.prev.sponsor': link('https://example.com/portmap', 'Brought to you by Portmap'),
    'footer.credit': encodeText('© The Weekly Dispatch — this line is owned by a stranger.'),
  },
  devconf: {
    'sponsor.headline': link('https://example.com/hexline', 'Hexline'),
    'sponsor.gold.1': link('https://example.com/portmap', 'Portmap'),
    'sponsor.gold.2': link('https://example.com/quorumdb', 'QuorumDB'),
    'sponsor.gold.3': link('https://example.com/statica', 'Statica'),
    'sponsor.silver.1': link('https://example.com/rellay', 'Rellay'),
    'sponsor.silver.2': link('https://example.com/deadreckoning', 'Dead Reckoning'),
    'booth.1': encodeText('Booth 1 — Portmap. Live migrations, ask us anything.'),
    'booth.2': encodeText('Booth 2 — Rellay. Bring a failing trace, leave with a fix.'),
    'schedule.note': encodeText(
      'Schedule is final. 25-minute talks, two tracks, and a hallway that stays open until they turn the lights off.',
    ),
  },
  remoteroles: {
    'banner.top': link('https://example.com/hexline/careers', 'Hexline is hiring 12 engineers — all remote, all senior'),
    'featured.1': link('https://example.com/jobs/arbor-platform', 'Senior Platform Engineer — Arbor'),
    'featured.2': link('https://example.com/jobs/fieldnote-design', 'Design Engineer — Fieldnote'),
    'featured.3': link('https://example.com/jobs/kestrel-backend', 'Staff Backend Engineer — Kestrel'),
    'featured.4': link('https://example.com/jobs/halden-infra', 'Infrastructure Engineer — Halden'),
    'featured.5': link('https://example.com/jobs/cormorant-design', 'Product Designer — Cormorant'),
    'category.design.sponsor': link('https://example.com/design', 'Design'),
    'category.eng.sponsor': link('https://example.com/eng', 'Engineering'),
    'footer.link.1': link('https://example.com/post', 'Post a role — 30 days, no account'),
  },
  vaultline: {
    'announce.bar': link('https://example.com/hexline/vaults', 'Hexline vaults are live on Vaultline — 11.4% net APY'),
    'hero.headline': encodeText('Somebody bought this headline and wrote it themselves.'),
    'hero.sub': encodeText(
      'Every logo, card and link on this page is a separately owned on-chain slot. The TVL number is not — a protocol that sold its own metrics would be selling the right to lie about them.',
    ),
    'hero.cta': link('https://example.com/app', 'Open app'),
    'integration.1': link('https://example.com/portmap', 'Portmap'),
    'integration.2': link('https://example.com/quorumdb', 'QuorumDB'),
    'integration.3': link('https://example.com/rellay', 'Rellay'),
    'ecosystem.1': link('https://example.com/tidepool', 'Tidepool — vault analytics, built on Vaultline'),
    'ecosystem.2': link('https://example.com/statica', 'Statica — automated rebalancing for LP positions'),
    'ecosystem.3': link('https://example.com/nightshift', 'Night Shift — vault monitoring and alerting'),
    'integration.4': link('https://example.com/halden', 'Halden'),
    'audit.note': encodeText('Audited twice. Contracts immutable, deployer key burned, bug bounty live.'),
    'footer.link.1': link('https://example.com/docs', 'Read the docs'),
  },
};

mkdirSync(contentDir, { recursive: true });

const SITES = exampleSites();
const wallets = {
  [deployer().address.toLowerCase()]: deployerWallet(),
  [taker().address.toLowerCase()]: takerWallet(),
};

interface Edit {
  slug: string;
  site: Address;
  key: string;
  content: ReturnType<typeof encodeText>;
  writer: string;
}

// --- plan ------------------------------------------------------------------
//
// Every byte goes to disk here regardless of what the chain does. Content is addressed by hash, so
// an orphaned file is inert — whereas a hash on-chain with no bytes behind it is a permanently blank
// slot, which is the failure worth avoiding.

const plan: Edit[] = [];
let skipped = 0;

for (const [slug, entries] of Object.entries(CONTENT)) {
  const site = SITES[slug];
  if (!site) {
    console.log(`${slug} — not in examples.json or EXAMPLE_SITES, skipping`);
    continue;
  }
  const slots = await readSlots(publicClient, refFor(site), Object.keys(entries));

  for (const slot of slots) {
    const content = entries[slot.key]!;
    writeFileSync(path.join(contentDir, `${content.cid}.bin`), content.bytes);

    if (!slot.owner) {
      skipped++;
      continue;
    }
    if (slot.contentHash === content.hash) continue;

    let writer: string | undefined;
    for (const address of Object.keys(wallets)) {
      if (await readCanEdit(publicClient, site, slot.key, address as Address)) {
        writer = address;
        break;
      }
    }
    if (!writer) {
      const holder = slot.isRented ? `rented by ${slot.tenant}` : `owned by ${slot.owner}`;
      console.log(`  skip  ${slug}/${slot.key.padEnd(24)} ${holder} — no key that may edit it`);
      skipped++;
      continue;
    }
    plan.push({ slug, site, key: slot.key, content, writer });
  }
}

// --- budget ----------------------------------------------------------------

const byWriter = new Map<string, number>();
for (const edit of plan) byWriter.set(edit.writer, (byWriter.get(edit.writer) ?? 0) + 1);

console.log(`\n${plan.length} edits to write, ${skipped} skipped`);
if (plan.length) {
  console.log('budget:');
  for (const [address, count] of byWriter) {
    const account = address === deployer().address.toLowerCase() ? deployer() : taker();
    const label = account === deployer() ? 'deployer' : 'taker';
    console.log(`  ${label} writes ${count}`);
    await ensureFunded(account, EDIT_GAS * BigInt(count + 1), label);
  }
}

// --- write -----------------------------------------------------------------

let written = 0;
let lastSlug = '';
for (const edit of plan) {
  if (edit.slug !== lastSlug) {
    console.log(`\n${edit.slug}  ${edit.site}`);
    lastSlug = edit.slug;
  }
  const wallet = wallets[edit.writer]!;
  await send(wallet, `edit ${edit.slug}/${edit.key}`, {
    ...buildEdit(edit.site, edit.key, edit.content.hash),
    account: wallet.account,
  });
  console.log(`  write ${edit.key.padEnd(24)} ${edit.content.cid}`);
  written++;
}

console.log(`\n  ${written} written, ${skipped} skipped`);
console.log(`  bytes in ${path.relative(process.cwd(), contentDir)}`);
