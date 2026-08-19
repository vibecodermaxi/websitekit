/**
 * Writes real content onto the demo board, and commits the bytes into the scaffold.
 *
 * **Why this is separate from `seed-demo.ts`, and why it matters.** That script gave the demo site
 * owners, prices and a take history — everything §6 asks for except the one thing a visitor can
 * actually see. Every slot still rendered its `fallback`, so a board that was 13/16 claimed looked
 * pixel-identical to one nobody had touched. The mechanic was there and invisible.
 *
 * Content needs somewhere retrievable by hash (§3's first honest caveat: reads are backend-free,
 * writes are not). Rather than take a pinning-service credential the scaffold cannot ship, the bytes
 * are written into `packages/create-websitekit/template/content/` and served by the template's own
 * `/api/content/[cid]` route. That is §3's middle tier — the dev's own upload route — and it means a
 * freshly scaffolded project shows real content with no credentials and no network beyond the chain.
 *
 *   set -a && . ./.env && set +a
 *   pnpm --filter @websitekit/sdk exec tsx scripts/seed-content.ts
 *
 * **Who may write is READ, not inferred.** In v2 a live tenancy moves the content gate to the
 * TENANT and locks the owner out entirely (§2.3), so "owned by an address we hold a key for" is no
 * longer the same question as "that key can edit it". `readCanEdit` is the contract's own answer and
 * is the only one that stays right.
 *
 * **Gas is budgeted before the first send**, for the reason spelled out at the top of
 * `seed-example-content.ts`: an edit moves no value, so a content run looks free, and a wallet that
 * runs dry fails its gas ESTIMATE — which viem reports as `execution reverted`, indistinguishable
 * from the contract refusing the edit.
 */
import type { Address } from 'viem';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ContentKind, buildEdit, encodeContent, encodeText, readCanEdit, readSlots } from '../src/index';
import {
  EDIT_GAS,
  demoSite,
  deployer,
  deployerWallet,
  ensureFunded,
  publicClient,
  refFor,
  send,
  taker,
  takerWallet,
} from './lib/chain';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contentDir = path.resolve(__dirname, '../../create-websitekit/template/content');

const link = (href: string, label: string) =>
  encodeContent(ContentKind.Link, new TextEncoder().encode(JSON.stringify({ href, label })));

/**
 * Deliberately NOT the scaffold's fallback copy. If the seeded content matched the fallbacks, the
 * page would look the same whether the hash gate worked or silently failed — the one thing this
 * seeding exists to make visible.
 */
const CONTENT: Record<string, ReturnType<typeof encodeText>> = {
  'nav.logo': encodeText('Meridian'),
  'nav.link.1': link('https://example.com/platform', 'Platform'),
  'nav.link.2': link('https://example.com/changelog', 'Changelog'),
  'nav.cta': link('https://example.com/signup', 'Get started'),
  'hero.eyebrow': encodeText('Owned by someone else'),
  'hero.headline': encodeText('Every word here belongs to a stranger.'),
  'hero.subhead': encodeText(
    'This headline is on-chain property. Buy it, rewrite it, and get paid when the next person takes it.',
  ),
  'feature.1.title': encodeText('Bought, not written'),
  'feature.1.body': encodeText('Someone paid for this sentence. It changes when they sell.'),
  'feature.2.title': encodeText('Priced by the market'),
  'feature.2.body': encodeText('Every slot reverts toward its floor until somebody wants it again.'),
  'footer.note': encodeText('© whoever currently owns the footer.'),
};

mkdirSync(contentDir, { recursive: true });

const site = demoSite();
const ref = refFor(site);
const wallets = {
  [deployer().address.toLowerCase()]: deployerWallet(),
  [taker().address.toLowerCase()]: takerWallet(),
};

console.log(`demo board ${site}`);

// --- plan ------------------------------------------------------------------
//
// The bytes go to disk regardless of what the chain does. They are addressed by hash, so an orphaned
// file is inert — whereas a hash on-chain with no bytes behind it is a permanently blank slot, which
// is the failure worth avoiding.

const plan: { key: string; content: ReturnType<typeof encodeText>; writer: string }[] = [];
let skipped = 0;

for (const slot of await readSlots(publicClient, ref, Object.keys(CONTENT))) {
  const content = CONTENT[slot.key]!;
  writeFileSync(path.join(contentDir, `${content.cid}.bin`), content.bytes);

  if (!slot.owner) {
    console.log(`  skip  ${slot.key.padEnd(18)} unclaimed`);
    skipped++;
    continue;
  }
  if (slot.contentHash === content.hash) {
    console.log(`  ok    ${slot.key.padEnd(18)} already written`);
    continue;
  }

  // Ask the contract who may write, rather than assuming it is the owner: a live tenancy moves the
  // gate to the tenant (§2.3), and this board deliberately carries one.
  let writer: string | undefined;
  for (const address of Object.keys(wallets)) {
    if (await readCanEdit(publicClient, site, slot.key, address as Address)) {
      writer = address;
      break;
    }
  }
  if (!writer) {
    const holder = slot.isRented ? `rented by ${slot.tenant}` : `owned by ${slot.owner}`;
    console.log(`  skip  ${slot.key.padEnd(18)} ${holder} — no key that may edit it`);
    skipped++;
    continue;
  }
  plan.push({ key: slot.key, content, writer });
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
for (const edit of plan) {
  const wallet = wallets[edit.writer]!;
  await send(wallet, `edit ${edit.key}`, {
    ...buildEdit(site, edit.key, edit.content.hash),
    account: wallet.account,
  });
  console.log(`  write ${edit.key.padEnd(18)} ${edit.content.cid}`);
  written++;
}

console.log(`\n  ${written} written, ${skipped} skipped`);
console.log(`  bytes in ${path.relative(process.cwd(), contentDir)}`);
