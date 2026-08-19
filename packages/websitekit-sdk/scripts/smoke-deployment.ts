/**
 * Proves a fresh protocol deployment actually works, by driving one real site through it.
 *
 *   set -a && . .env && set +a
 *   pnpm --filter @websitekit/sdk exec tsx scripts/smoke-deployment.ts
 *
 * **Why this is not redundant with the codehash check in `deploy-protocol.ts`.** That check proves
 * the factory RECORDS the right library address. It does not prove the implementation's own bytecode
 * was linked to it — those are two different things, written at two different moments, and only one
 * of them is what a `delegatecall` actually follows. Spec §11.4 is explicit that the test suite has
 * to exercise a rental through a clone, because that is the only path that touches the linked
 * address at all: a wrong link is not a revert, it is a call into whatever happens to live there.
 *
 * So the sequence below is chosen for coverage rather than realism. `createSite` exercises the
 * clone path; `buy` exercises the money spine and the reader; `listForRent` and `rent` are the two
 * calls that go THROUGH the library, and `readSlots` afterwards proves the tenancy state the library
 * wrote is readable back through the site's own storage.
 *
 * Driven entirely through `@websitekit/sdk`, per the house rule: a real chain with real gas and real
 * block times is the only place a wrong deadline, a torn read or a bad ABI encoding shows up as what
 * it actually is.
 *
 * It leaves a real site on chain. That is deliberate — it is evidence, and on testnet it costs
 * nothing to keep.
 */
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  buildBuyFrom,
  buildCreateSite,
  buildListForRent,
  buildRent,
  readBuyContext,
  readListing,
  readRental,
  readSiteTerms,
  readSlots,
  quoteRent,
  type SiteRef,
} from '../src/index';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — run \`set -a && . .env && set +a\` first`);
  return value;
}

const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [required('TESTNET_RPC_URL')] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://explorer.testnet.chain.robinhood.com' } },
  testnet: true,
});

const FACTORY = required('WEBSITEKIT_FACTORY') as `0x${string}`;
const READER = required('WEBSITEKIT_READER') as `0x${string}`;

const owner = privateKeyToAccount(required('TESTNET_DEPLOYER_KEY') as `0x${string}`);
const tenant = privateKeyToAccount(required('TESTNET_TAKER_KEY') as `0x${string}`);

const publicClient = createPublicClient({ chain: robinhoodTestnet, transport: http() });
const ownerWallet = createWalletClient({ account: owner, chain: robinhoodTestnet, transport: http() });
const tenantWallet = createWalletClient({ account: tenant, chain: robinhoodTestnet, transport: http() });

async function send(wallet: typeof ownerWallet, label: string, request: Record<string, unknown>) {
  const hash = await wallet.writeContract(request as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  // A reverted transaction still resolves here — only `status` tells them apart.
  if (receipt.status !== 'success') throw new Error(`${label} reverted (tx ${hash})`);
  console.log(`  ${label.padEnd(14)} ok  (gas ${receipt.gasUsed})`);
  return receipt;
}

// Floors sit just above `minFloor` (1e14 on an 18-decimal native chain) so the whole run costs
// faucet dust rather than testnet ETH somebody has to top up.
const FLOOR = parseEther('0.0002');
const KEYS = { 'hero.headline': FLOOR, 'hero.image': FLOOR };

console.log(`\nsmoke test against factory ${FACTORY}`);
console.log(`owner  ${owner.address} — ${formatEther(await publicClient.getBalance({ address: owner.address }))} ETH`);
console.log(`tenant ${tenant.address} — ${formatEther(await publicClient.getBalance({ address: tenant.address }))} ETH\n`);

// --- 1. the clone path -------------------------------------------------------

const createRequest = buildCreateSite({
  factory: FACTORY,
  name: 'Deployment Smoke Test',
  symbol: 'SMOKE',
  baseTokenURI: 'https://websitekit.org/slot/',
  treasury: owner.address,
  settlementToken: '0x0000000000000000000000000000000000000000',
  economics: {
    takeBps: 14_000n,
    payoutBps: 11_500n,
    reversionBps: 9_700n,
    maxReversionWeeks: 52n,
    cooldownSecs: 900n,
  },
  rentals: { siteRentBps: 2_500n, maxRentalTerm: 2_592_000n, minRentBps: 25n },
  floorPolicy: { floorDeltaBps: 2_000n, floorChangeCooldown: 86_400n, maxAskBps: 40_000n },
  slots: KEYS,
});

const { result } = await publicClient.simulateContract({ ...createRequest, account: owner } as never);
const site = result as `0x${string}`;
await send(ownerWallet, 'createSite', { ...createRequest, account: owner });
console.log(`  site           ${site}\n`);

const ref: SiteRef = { site, reader: READER };

// --- 2. the reader -----------------------------------------------------------

const terms = await readSiteTerms(publicClient, ref);
console.log('  terms read through SlotReader:');
console.log(`    version ${terms.implementationVersion}  take ${terms.takeBps}  payout ${terms.payoutBps}`);
console.log(`    minFloor ${terms.minFloor}  maxRentalTerm ${terms.maxRentalTerm}  locked ${terms.termsLocked}`);

const before = await readSlots(publicClient, ref, Object.keys(KEYS));
console.log(`    ${before.length} slots, both unclaimed: ${before.every((s) => s.isUnclaimed)}\n`);

// --- 3. the money spine ------------------------------------------------------

const context = await readBuyContext(publicClient, ref, 'hero.headline');
await send(ownerWallet, 'buy', {
  ...buildBuyFrom(site, context, terms.settlementToken),
  account: owner,
});

// --- 4. THE LIBRARY LINK — the only calls that delegatecall into RentalsLib ---

const [claimed] = await readSlots(publicClient, ref, ['hero.headline']);
const ratePerDay = (claimed!.effectiveFloor * 164n) / 10_000n;
await send(ownerWallet, 'listForRent', {
  ...buildListForRent(site, 'hero.headline', ratePerDay, 604_800n),
  account: owner,
});

const listing = await readListing(publicClient, site, 'hero.headline');
const durationSecs = 86_400n;
const quote = quoteRent(listing.ratePerDay, durationSecs, terms.protocolRentBps, listing.feeBps);
await send(tenantWallet, 'rent', {
  ...buildRent({
    site,
    key: 'hero.headline',
    durationSecs,
    expectedRatePerDay: listing.ratePerDay,
    settlementToken: terms.settlementToken,
    cost: quote.cost,
  }),
  account: tenant,
});

// --- 5. read the library's own state back ------------------------------------

const rental = await readRental(publicClient, site, 'hero.headline');
const after = await readSlots(publicClient, ref, ['hero.headline']);

console.log('\n  tenancy written by the delegatecalled library:');
console.log(`    tenant     ${rental.tenant}`);
console.log(`    active     ${rental.isActive}`);
console.log(`    term       ${rental.expiry - rental.start}s`);
console.log(`    prepaid    ${rental.prepaid} (net of ${quote.protocolCut + quote.siteCut} in fees)`);
console.log(`    unaccrued  ${after[0]!.unaccruedRent}  net cost to a buyer ${after[0]!.netCost}`);

if (rental.tenant?.toLowerCase() !== tenant.address.toLowerCase()) throw new Error('tenant mismatch');
if (!rental.isActive) throw new Error('tenancy did not open');
if (rental.prepaid !== quote.net) throw new Error(`prepaid ${rental.prepaid} != predicted net ${quote.net}`);
if (!after[0]!.isRented) throw new Error('reader does not see the tenancy');

console.log(`
  LIBRARY LINK LIVE. A tenancy opened, was booked at the amount the TypeScript twin
  predicted, and reads back through both the site and the reader.

  site ${site}
  ${robinhoodTestnet.blockExplorers.default.url}/address/${site}
`);
