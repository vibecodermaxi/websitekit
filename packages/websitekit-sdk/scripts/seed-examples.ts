/**
 * Deploys the four example boards the docs point at, on RH testnet.
 *
 * `seed-demo.ts` seeds ONE board — the generic SaaS landing page the scaffold renders. That shape is
 * inherited, and it is the only shape a prospective site owner can currently see, which makes "would
 * this work for my site?" unanswerable from the docs. These are the answer: four boards that differ
 * in the two things that actually vary between real sites — the slot layout, and the economics
 * chosen at `createSite`.
 *
 *   set -a && . ./.env && set +a          # zsh needs ./.env; a bare `.env` is searched on PATH
 *   pnpm --filter @websitekit/sdk exec tsx scripts/seed-examples.ts
 *
 * **What v2 changed about these boards, beyond names.** Take economics are no longer frozen at
 * `createSite` — they are mutable until the first claim and a one-way ratchet after it (§6.1) — but
 * they are still the thing that distinguishes these four, so they are still chosen deliberately per
 * board. Each board now also carries RENT economics, which v1 had no concept of, and those stay
 * freely mutable for the site's whole life (§2.5.1). The reversion tail that used to be called decay
 * is `reversionBps` / `maxReversionWeeks`.
 *
 * **Re-running is safe.** Every created site is appended to `examples.json` before its board is
 * claimed, and any board already listed there is skipped. A deploy script that is not idempotent is
 * one you can only afford to run when you are certain, and certainty is not what you have while
 * debugging.
 *
 * **The ledger carries the contract generation it was written by, and this refuses to touch another
 * one.** v1's ledger was an untagged `{slug: address}` map, so the first v2 run read it, concluded
 * all four boards already existed, skipped creation and then reverted trying to read v2 terms off a
 * v1 clone. That failure was loud only by luck — `readTerms` happens to be incompatible. Had the
 * generations shared a view, this would have gone on to seed content onto boards nobody can read.
 * The version field is what makes the check structural rather than lucky.
 *
 * Content bytes are NOT seeded here — `seed-example-content.ts` does that, and
 * `seed-example-extras.ts` adds the peripheral open slots afterwards.
 */
import { formatEther, type Address } from 'viem';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ROBINHOOD_TESTNET,
  buildCreateSite,
  readSiteTerms,
  readSlots,
  type SiteEconomicsConfig,
  type SiteRentalConfig,
} from '../src/index';
import {
  FACTORY,
  balanceOf,
  buy,
  deployer,
  deployerWallet,
  ensureFunded,
  floor,
  publicClient,
  refFor,
  send,
  taker,
  takerWallet,
} from './lib/chain';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.join(__dirname, 'examples.json');

const COOLDOWN_SECS = 60n;

/**
 * Every board settles natively and shares one floor policy — the two axes these examples are NOT
 * about. What varies is the take economics, the rent economics and the layout.
 */
const FLOOR_POLICY = { floorDeltaBps: 2_000n, floorChangeCooldown: 86_400n, maxAskBps: 40_000n };
const NATIVE: Address = '0x0000000000000000000000000000000000000000';

interface Board {
  slug: string;
  name: string;
  symbol: string;
  /** What kind of site this is, and why its economics are shaped the way they are. */
  premise: string;
  economics: SiteEconomicsConfig;
  rentals: SiteRentalConfig;
  slots: Record<string, bigint>;
  /** Left unclaimed on purpose — a board with no open slots teaches only half the mechanic. */
  unclaimed: string[];
  /** Claimed by the taker rather than the deployer, so the board has more than one owner. */
  takerClaims: string[];
  /** Taken from the deployer after claiming, so the board shows a payout and a take count above 1. */
  takeFromDeployer: string[];
}

/**
 * **Floors sit at or just above `minFloor` — 1e14, 0.0001 ETH on a native site (§11.2).**
 *
 * v1's boards ran from 4e12 to 1.5e14 and every value under 1e14 now reverts `InvalidFloor`, so the
 * spread here is 2x rather than 37x. That is a testnet funding constraint rather than a statement
 * about what a real board should charge: these have to be claimable many times over out of a faucet.
 * A production board would price the masthead well above the footer and `floor()` would still be the
 * thing asserting it clears the minimum.
 */
const BOARDS: Board[] = [
  {
    slug: 'dispatch',
    name: 'The Weekly Dispatch',
    symbol: 'DSPT',
    premise:
      'A newsletter archive. Sponsorship is the whole business model already, and the archive keeps ' +
      'earning long after the send — so reversion is slow (0.95/week over 26 weeks) and a sponsor ' +
      'who buys the masthead keeps most of their position for months. Rent terms run long for the ' +
      'same reason: a sponsor books an archive by the month, not by the day.',
    economics: {
      takeBps: 14_000n, //          1.4x
      payoutBps: 11_500n, //        1.15x
      reversionBps: 9_500n, //      0.95/week — an archive holds its value
      maxReversionWeeks: 26n,
      cooldownSecs: COOLDOWN_SECS,
    },
    rentals: {
      siteRentBps: 2_000n, //       25% total with the protocol's 500
      maxRentalTerm: 7_776_000n, // 90 days
      minRentBps: 20n,
    },
    slots: {
      'masthead.title': floor('0.0001'),
      'masthead.tagline': floor('0.0001'),
      'sponsor.primary': floor('0.0002'), //  the top banner — the most valuable thing on the page
      'issue.latest.sponsor': floor('0.0001'),
      'issue.prev.sponsor': floor('0.0001'),
      'recommended.1': floor('0.0001'), //    newsletters really do sell these
      'recommended.2': floor('0.0001'),
      'recommended.3': floor('0.0001'),
      'footer.credit': floor('0.0001'),
    },
    unclaimed: ['recommended.3', 'issue.prev.sponsor'],
    takerClaims: ['sponsor.primary', 'recommended.1', 'footer.credit'],
    takeFromDeployer: ['masthead.title'],
  },
  {
    slug: 'devconf',
    name: 'DevConf Autumn',
    symbol: 'DVCF',
    premise:
      'A conference site. Sponsor tiers are already an auction held over email, so the take premium ' +
      'is steep (2x) and the board runs it in public instead. The event has a date, so nothing ' +
      'reverts for long: 4 weeks and it is back at floor. Rent is capped near the length of the ' +
      'event itself — nobody books a booth banner for a quarter.',
    economics: {
      takeBps: 20_000n, //          2x — tiers are contested, and the site keeps the wider spread
      payoutBps: 12_000n, //        1.2x
      reversionBps: 9_000n,
      maxReversionWeeks: 4n, //     a dated event; a long reversion tail is meaningless
      cooldownSecs: COOLDOWN_SECS,
    },
    rentals: {
      siteRentBps: 3_500n, //       40% total — the conference takes the biggest cut of the four
      maxRentalTerm: 1_209_600n, // 14 days
      minRentBps: 50n,
    },
    slots: {
      'sponsor.headline': floor('0.0002'), // title sponsor
      'sponsor.gold.1': floor('0.0001'),
      'sponsor.gold.2': floor('0.0001'),
      'sponsor.gold.3': floor('0.0001'),
      'sponsor.silver.1': floor('0.0001'),
      'sponsor.silver.2': floor('0.0001'),
      'booth.1': floor('0.0001'),
      'booth.2': floor('0.0001'),
      'schedule.note': floor('0.0001'),
    },
    unclaimed: ['sponsor.silver.2', 'booth.2'],
    takerClaims: ['sponsor.gold.1', 'sponsor.gold.2', 'booth.1'],
    takeFromDeployer: ['sponsor.headline'],
  },
  {
    slug: 'remoteroles',
    name: 'Remote Roles',
    symbol: 'RMTR',
    premise:
      'A job board. Listings churn weekly and a stale featured slot is worse than an empty one, so ' +
      'reversion is the fastest of the four (0.85/week over 8 weeks) — a listing nobody refreshes ' +
      'falls back to floor inside two months and reopens to the next employer. Rent is the natural ' +
      'primitive here: an employer wants the slot for a hiring window, not forever.',
    economics: {
      takeBps: 13_000n, //          1.3x — low friction, because churn is the point
      payoutBps: 11_000n,
      reversionBps: 8_500n, //      0.85/week — the fastest of the four
      maxReversionWeeks: 8n,
      cooldownSecs: COOLDOWN_SECS,
    },
    rentals: {
      siteRentBps: 1_000n, //       15% total — the lowest of the four, because renting IS the product
      maxRentalTerm: 2_592_000n, // 30 days, a hiring window
      minRentBps: 30n,
    },
    slots: {
      'banner.top': floor('0.0002'),
      'featured.1': floor('0.0001'),
      'featured.2': floor('0.0001'),
      'featured.3': floor('0.0001'),
      'featured.4': floor('0.0001'),
      'featured.5': floor('0.0001'),
      'category.design.sponsor': floor('0.0001'),
      'category.eng.sponsor': floor('0.0001'),
      'footer.link.1': floor('0.0001'),
    },
    unclaimed: ['featured.4', 'featured.5', 'category.design.sponsor'],
    takerClaims: ['featured.1', 'banner.top', 'footer.link.1'],
    takeFromDeployer: ['featured.2', 'category.eng.sponsor'],
  },
  {
    slug: 'vaultline',
    name: 'Vaultline',
    symbol: 'VLTL',
    premise:
      'A DeFi protocol landing page. Ecosystem placement is already bought and sold off-chain, in ' +
      'Telegram, at BD-deal pace — this puts it on-chain at market pace. The take premium is steep ' +
      '(1.6x) because an integrations row is genuinely contested, and the reversion tail is the full ' +
      '52 weeks the contract allows: an ecosystem page is a long game, and a partner who bought in a ' +
      'year ago should still be paying for the position they hold.',
    economics: {
      takeBps: 16_000n, //          1.6x — placement is contested, and the protocol keeps the spread
      payoutBps: 12_000n, //        1.2x
      reversionBps: 9_000n,
      maxReversionWeeks: 52n, //    the contract's ceiling — the longest tail of the four boards
      cooldownSecs: COOLDOWN_SECS,
    },
    rentals: {
      siteRentBps: 2_500n, //       30% total
      maxRentalTerm: 31_536_000n, // 365 days, the contract's ceiling — a long game here too
      minRentBps: 10n,
    },
    slots: {
      'announce.bar': floor('0.0002'), //   the strip above everything; the most-seen pixels on the page
      'hero.headline': floor('0.0002'),
      'hero.sub': floor('0.0001'),
      'hero.cta': floor('0.0001'),
      'integration.1': floor('0.0001'),
      'integration.2': floor('0.0001'),
      'integration.3': floor('0.0001'),
      'integration.4': floor('0.0001'),
      'ecosystem.1': floor('0.0001'),
      'ecosystem.2': floor('0.0001'),
      'ecosystem.3': floor('0.0001'),
      'audit.note': floor('0.0001'),
      'footer.link.1': floor('0.0001'),
    },
    unclaimed: ['integration.4', 'ecosystem.3'],
    takerClaims: ['announce.bar', 'integration.1', 'ecosystem.1', 'footer.link.1'],
    takeFromDeployer: ['hero.headline', 'ecosystem.2'],
  },
];

// ---------------------------------------------------------------------------

interface Ledger {
  version: 2;
  chainId: number;
  sites: Record<string, Address>;
}

const LEDGER_VERSION = 2;

function loadLedger(): Ledger {
  if (!existsSync(LEDGER)) {
    return { version: LEDGER_VERSION, chainId: ROBINHOOD_TESTNET.chainId, sites: {} };
  }
  const raw = JSON.parse(readFileSync(LEDGER, 'utf-8')) as Partial<Ledger>;
  if (raw.version !== LEDGER_VERSION) {
    throw new Error(
      `${path.basename(LEDGER)} is a v${raw.version ?? 1} ledger — its boards are clones of a different ` +
        'implementation and cannot be read by this SDK. Move it aside before seeding a new generation.',
    );
  }
  if (raw.chainId !== ROBINHOOD_TESTNET.chainId) {
    throw new Error(`${path.basename(LEDGER)} is for chain ${raw.chainId}, not ${ROBINHOOD_TESTNET.chainId}`);
  }
  return { version: LEDGER_VERSION, chainId: raw.chainId, sites: raw.sites ?? {} };
}

const ledger = loadLedger();

console.log(`factory  ${FACTORY}  (from the environment — never deployed here)`);
console.log(`deployer ${deployer().address}  ${await balanceOf(deployer().address)} ETH`);
console.log(`taker    ${taker().address}  ${await balanceOf(taker().address)} ETH\n`);

// Budget the whole run before spending any of it — see the note in `seed-demo.ts`.
const GAS_PAD = 400_000n * 200_000_000n;
let takerNeeds = 0n;
let deployerNeeds = 0n;
for (const board of BOARDS) {
  if (ledger.sites[board.slug]) continue;
  for (const [key, value] of Object.entries(board.slots)) {
    if (board.unclaimed.includes(key)) continue;
    if (board.takerClaims.includes(key)) takerNeeds += value + GAS_PAD;
    else deployerNeeds += value + GAS_PAD;
  }
  for (const key of board.takeFromDeployer) {
    takerNeeds += (board.slots[key]! * board.economics.takeBps) / 10_000n + GAS_PAD;
  }
  deployerNeeds += GAS_PAD * 3n; // the createSite itself
}
console.log('budget:');
await ensureFunded(deployer(), deployerNeeds, 'deployer');
await ensureFunded(taker(), takerNeeds, 'taker');

let spent = 0n;
const created: { board: Board; site: Address }[] = [];

// 1. Create every board that does not already exist, and register its slots in the same tx.
for (const board of BOARDS) {
  let site = ledger.sites[board.slug];

  if (site) {
    console.log(`\n${board.name} — already at ${site}, checking its board`);
  } else {
    const createRequest = buildCreateSite({
      factory: FACTORY,
      name: board.name,
      symbol: board.symbol,
      baseTokenURI: `https://websitekit.org/examples/${board.slug}/slot/`,
      treasury: deployer().address,
      settlementToken: NATIVE,
      economics: board.economics,
      rentals: board.rentals,
      floorPolicy: FLOOR_POLICY,
      slots: board.slots,
    });

    const { result } = await publicClient.simulateContract({ ...createRequest, account: deployer() } as never);
    await send(deployerWallet(), `createSite ${board.slug}`, { ...createRequest, account: deployer() });

    site = result as Address;
    ledger.sites[board.slug] = site;
    writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
    console.log(`\n${board.name}  ${site}`);
  }

  const ref = refFor(site);
  const terms = await readSiteTerms(publicClient, ref);

  // 2. Claim, so the board is alive. Skips anything already owned, so a run that died halfway
  //    through a board resumes it rather than abandoning it half-claimed.
  const before = await readSlots(publicClient, ref, Object.keys(board.slots));
  const owned = new Set(before.filter((slot) => slot.owner).map((slot) => slot.key));
  let claimedHere = 0;

  for (const key of Object.keys(board.slots)) {
    if (board.unclaimed.includes(key) || owned.has(key)) continue;
    const isTaker = board.takerClaims.includes(key);
    const charged = await buy(isTaker ? takerWallet() : deployerWallet(), ref, key, terms.settlementToken);
    spent += charged;
    claimedHere++;
    console.log(
      `  claimed ${key.padEnd(26)} ${formatEther(charged).padStart(10)} ETH  by ${isTaker ? 'taker' : 'deployer'}`,
    );
  }

  // Only worth a take pass if this run actually claimed something; an already-taken board would
  // otherwise be taken again on every re-run, walking its prices up forever.
  if (claimedHere) created.push({ board, site });
}

// 3. Take — once, after a single shared cooldown rather than one per board.
if (created.length) {
  console.log(`\nwaiting out the ${COOLDOWN_SECS}s cooldown before taking…`);
  await new Promise((resolve) => setTimeout(resolve, Number(COOLDOWN_SECS) * 1_000 + 5_000));

  for (const { board, site } of created) {
    const ref = refFor(site);
    const terms = await readSiteTerms(publicClient, ref);
    for (const key of board.takeFromDeployer) {
      const charged = await buy(takerWallet(), ref, key, terms.settlementToken);
      spent += charged;
      console.log(`  taken   ${`${board.slug}/${key}`.padEnd(34)} ${formatEther(charged).padStart(10)} ETH  by taker`);
    }
  }
}

// 4. Read every board back through the reader and prove it looks right.
for (const board of BOARDS) {
  const site = ledger.sites[board.slug]!;
  const rows = await readSlots(publicClient, refFor(site), Object.keys(board.slots));
  const terms = await readSiteTerms(publicClient, refFor(site));
  console.log(
    `\n${board.name}  ${site}` +
      `\n  take ${Number(terms.takeBps) / 10_000}x  reversion ${Number(terms.reversionBps) / 10_000}/wk over ` +
      `${terms.maxReversionWeeks}w  rent fee ${Number(terms.siteRentBps + terms.protocolRentBps) / 100}%  ` +
      `max term ${Number(terms.maxRentalTerm) / 86_400}d`,
  );
  for (const slot of rows) {
    const owner = slot.owner ? `${slot.owner.slice(0, 8)}…` : 'unclaimed';
    console.log(
      `  ${slot.key.padEnd(26)} ${owner.padEnd(12)} floor ${formatEther(slot.floor).padStart(8)}  ` +
        `next ${formatEther(slot.charged).padStart(10)}  takes ${slot.takes}`,
    );
  }
}

console.log(`
  spent ${formatEther(spent)} ETH on claims and takes
  deployer now ${await balanceOf(deployer().address)} ETH
  taker    now ${await balanceOf(taker().address)} ETH

  addresses written to ${path.relative(process.cwd(), LEDGER)}
  explorer ${ROBINHOOD_TESTNET.explorer}

  Copy them into src/addresses.ts as EXAMPLE_SITES, then run seed-example-extras.ts
  and seed-example-content.ts.
`);
