/**
 * Moves every example board's OPEN slots out to the edges of the page.
 *
 * The boards ship with their unclaimed slots in the middle of the content — an empty listing row, a
 * missing ecosystem card. That reads as a broken site rather than as an available one, and it
 * advertises the wrong thing: a site owner evaluating websitekit should see that the parts they would
 * actually be willing to sell are the extras — an announcement strip, a nav link, a footer link —
 * not their headline.
 *
 *   set -a && . ./.env && set +a
 *   pnpm --filter @websitekit/sdk exec tsx scripts/seed-example-extras.ts
 *
 * Two operations, in this order:
 *
 *   1. REGISTER the new peripheral slots and leave them unclaimed. Slot registration is in the
 *      freely-mutable set, so this is legal on a live board — unlike renaming, which would point at
 *      a different, unregistered slot and orphan whoever owned the old one.
 *   2. CLAIM the mid-content slots that were open, so they stop being what the page advertises.
 *
 * Idempotent on both halves: registering an existing key reverts, so already-registered extras are
 * skipped, and an already-owned slot is never re-bought.
 *
 * **This is also the only script that exercises `registerSlots` against a LIVE board**, which is why
 * it stays a separate pass rather than being folded into `seed-examples.ts` now that the boards are
 * redeployed. A capability nothing exercises is a capability nobody finds out is broken.
 */
import { formatEther } from 'viem';

import { buildRegisterSlots, readSiteTerms, readSlots } from '../src/index';
import {
  balanceOf,
  buy,
  deployer,
  deployerWallet,
  ensureFunded,
  exampleSites,
  floor,
  MIN_FLOOR,
  publicClient,
  refFor,
  send,
  taker,
  takerWallet,
} from './lib/chain';

interface Plan {
  /** New peripheral slots to register and leave OPEN — the ones the page advertises. */
  extras: Record<string, bigint>;
  /** Slots currently open in the middle of the content, to be claimed so they stop advertising. */
  fill: string[];
}

/** Floors clear `minFloor` (1e14) like every other floor in this directory — see `floor()`. */
const PLANS: Record<string, Plan> = {
  dispatch: {
    extras: { 'announce.bar': floor('0.0001'), 'nav.link.1': floor('0.0001'), 'footer.link.1': floor('0.0001') },
    fill: ['recommended.3', 'issue.prev.sponsor'],
  },
  devconf: {
    extras: { 'announce.bar': floor('0.0001'), 'nav.link.1': floor('0.0001'), 'footer.link.1': floor('0.0001') },
    fill: ['sponsor.silver.2', 'booth.2'],
  },
  remoteroles: {
    // `banner.top` is already this board's announcement strip and is claimed, so it gets a nav and
    // a second footer link instead.
    extras: { 'nav.link.1': floor('0.0001'), 'footer.link.2': floor('0.0001') },
    fill: ['featured.4', 'featured.5', 'category.design.sponsor'],
  },
  vaultline: {
    // `announce.bar` likewise already exists here and is owned.
    extras: { 'nav.link.1': floor('0.0001'), 'footer.link.2': floor('0.0001') },
    fill: ['integration.4', 'ecosystem.3'],
  },
};

const SITES = exampleSites();

console.log(`deployer ${deployer().address}  ${await balanceOf(deployer().address)} ETH`);
console.log(`taker    ${taker().address}  ${await balanceOf(taker().address)} ETH`);

// Budget before spending, as everywhere else here: a run that dies part-way leaves some boards with
// their open slots moved to the edges and some without, which is worse than either state alone.
// `run-reclaim` first if the deployer is short — most of a seeding run's spend is parked in the
// sites' own treasuries rather than burned.
const GAS_PAD = 400_000n * 200_000_000n;
const fills = Object.values(PLANS).reduce((sum, plan) => sum + plan.fill.length, 0);
const registrations = Object.keys(PLANS).length;
console.log('\nbudget:');
await ensureFunded(deployer(), GAS_PAD * BigInt(registrations + 2), 'deployer');
await ensureFunded(taker(), (MIN_FLOOR + GAS_PAD) * BigInt(fills) + GAS_PAD, 'taker');

let spent = 0n;

for (const [slug, plan] of Object.entries(PLANS)) {
  const site = SITES[slug];
  if (!site) {
    console.log(`\n${slug} — not in examples.json or EXAMPLE_SITES, skipping`);
    continue;
  }
  const ref = refFor(site);
  const terms = await readSiteTerms(publicClient, ref);
  console.log(`\n${slug}  ${site}`);

  // 1. Register the extras that do not exist yet.
  const extraKeys = Object.keys(plan.extras);
  const existing = await readSlots(publicClient, ref, extraKeys);
  const missing = Object.fromEntries(
    extraKeys
      .filter((key) => !existing.find((slot) => slot.key === key)?.registered)
      .map((key) => [key, plan.extras[key]!]),
  );

  if (Object.keys(missing).length) {
    await send(deployerWallet(), `registerSlots ${slug}`, {
      ...buildRegisterSlots(site, missing),
      account: deployer(),
    });
    for (const key of Object.keys(missing)) {
      console.log(`  open   ${key.padEnd(24)} floor ${formatEther(missing[key]!)} — left unclaimed on purpose`);
    }
  } else {
    console.log('  extras already registered');
  }

  // 2. Claim the mid-content slots that were open. The taker pays: these are pure value transfers
  //    rather than deploys, and the deployer is the treasury on every one of these boards anyway.
  const fill = await readSlots(publicClient, ref, plan.fill);
  for (const slot of fill) {
    if (slot.owner) {
      console.log(`  ok     ${slot.key.padEnd(24)} already owned`);
      continue;
    }
    const charged = await buy(takerWallet(), ref, slot.key, terms.settlementToken);
    spent += charged;
    console.log(`  filled ${slot.key.padEnd(24)} ${formatEther(charged)} ETH`);
  }
}

console.log(`\n  spent ${formatEther(spent)} ETH filling mid-content slots`);
console.log(`  deployer ${await balanceOf(deployer().address)} ETH`);
console.log(`  taker    ${await balanceOf(taker().address)} ETH`);
