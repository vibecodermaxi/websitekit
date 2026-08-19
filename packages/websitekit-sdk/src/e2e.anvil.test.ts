/**
 * End-to-end proof that the SDK and the v2 contracts agree, run against a real EVM.
 *
 * **Why this exists when the unit tests are green.** Everything else in this package tests the SDK
 * against its own assumptions. The failure this catches is the one that survives all of it: an
 * argument tuple in the wrong order, a struct field decoded into the wrong property, a stale
 * committed ABI encoding calldata against a selector that no longer exists. None of those are type
 * errors, none fail a unit test, and all of them produce a transaction that reverts — or worse,
 * one that succeeds against a different function.
 *
 * v2 adds a fourth: **a mislinked library.** `RentalsLib` is delegatecalled from an address baked
 * into the implementation's bytecode, so linking it wrong is not a revert — it is arbitrary
 * behaviour at an address that may hold no code at all (§11.4). The deploy below does the link the
 * way a real deploy script must, and every rental scenario afterwards is what proves the link is
 * live rather than merely plausible.
 *
 * Skips (rather than fails) when anvil or the forge artifacts are missing — a fresh clone that has
 * not run `forge build` has nothing to deploy, and a hard failure there just teaches people to
 * ignore the suite.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

import { encodeText, readContent, contentHashToCid } from './content';
import { slotKey } from './keys';
import { computeBuyBreakdown, askCeiling } from './pricing';
import { quoteRent } from './rentals';
import {
  SLOT_SITE_ABI,
  SITE_EVENTS_ABI,
  readSlots,
  readSlot,
  readSlotsMulti,
  readSiteTerms,
  economicsFromTerms,
  isTokenSettled,
  readBuyContext,
  readRental,
  readListing,
  readAccruedRent,
  readCanEdit,
  readPendingWithdrawal,
  type SiteRef,
} from './reads';
import {
  buildBuyFrom,
  buildEdit,
  buildSetEditor,
  buildSetEditorWithSig,
  editorGrantTypedData,
  buildCreateSite,
  buildRegisterSlots,
  buildSetAvailability,
  buildWithdrawFor,
  buildSetAsk,
  buildListForRent,
  buildRent,
  buildClaimRent,
  buildEndRental,
  buildSweepTreasury,
  buildApproveSettlement,
  isNativeSettlement,
} from './writes';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractsOut = path.resolve(__dirname, '../../websitekit-contracts/out');
const PORT = 8899;
const RPC = `http://127.0.0.1:${PORT}`;

const hasAnvil = spawnSync('anvil', ['--version'], { encoding: 'utf-8' }).status === 0;
const hasArtifacts = fs.existsSync(path.join(contractsOut, 'SlotSite.sol', 'SlotSite.json'));
const runnable = hasAnvil && hasArtifacts;

// **Say why, loudly.** These are the only tests that run real bytecode, and on a fresh clone
// `out/` does not exist until `forge build` has run — so without this the suite reports a
// confident green having silently skipped 32 tests, which is the worst of both outcomes. A
// contributor who sees the count drop has no way to know that is expected.
if (!runnable) {
  const reason = !hasAnvil
    ? 'anvil is not on PATH — install Foundry: https://getfoundry.sh'
    : 'no contract artifacts — run `pnpm build:contracts` (or `forge build`) first';
  console.warn(`\n  SKIPPING the anvil end-to-end suite: ${reason}\n`);
}

interface Artifact {
  abi: Abi;
  bytecode: Hex;
  /** solc's placeholder map: which library goes where in the bytecode. */
  linkReferences: Record<string, Record<string, Array<{ start: number; length: number }>>>;
}

function artifact(solFile: string, name: string): Artifact {
  const json = JSON.parse(fs.readFileSync(path.join(contractsOut, solFile, `${name}.json`), 'utf-8'));
  return {
    abi: json.abi as Abi,
    bytecode: json.bytecode.object as Hex,
    linkReferences: json.bytecode.linkReferences ?? {},
  };
}

/**
 * Substitutes a deployed library address into an unlinked artifact.
 *
 * solc leaves a `__$<34 hex>$__` placeholder at every call site and records the byte offsets in
 * `linkReferences`. viem has no linker, so a deploy script has to do this itself — and §11.4 flags
 * exactly this as v2's new deploy-time failure mode: get it wrong and the implementation
 * delegatecalls into whatever is at the wrong address, with no revert to tell you.
 *
 * Offsets are in BYTES over the bytecode; the hex string is two characters per byte, and the leading
 * `0x` shifts everything by one byte's worth of prefix. Both conversions below are where an
 * off-by-one silently produces a contract that deploys fine and misbehaves later.
 */
function link(bytecode: Hex, references: Artifact['linkReferences'], libraries: Record<string, Address>): Hex {
  let out = bytecode.slice(2); // drop 0x; offsets are relative to the bytecode itself
  let substitutions = 0;

  for (const perFile of Object.values(references)) {
    for (const [libName, spots] of Object.entries(perFile)) {
      const address = libraries[libName];
      if (!address) throw new Error(`e2e: no address supplied for library ${libName}`);
      const bare = address.slice(2).toLowerCase();
      for (const { start, length } of spots) {
        if (length !== 20) throw new Error(`e2e: unexpected link length ${length} for ${libName}`);
        out = out.slice(0, start * 2) + bare + out.slice((start + length) * 2);
        substitutions += 1;
      }
    }
  }

  if (substitutions === 0) throw new Error('e2e: nothing was linked — the artifact has no link references');
  if (/__\$[0-9a-f]{34}\$__/.test(out)) {
    throw new Error('e2e: a library placeholder survived linking — the offsets are wrong');
  }
  return `0x${out}` as Hex;
}

// Anvil's deterministic accounts 0..3.
const OWNER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const ALICE = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const BOB = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const AGENCY = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');

const KEYS = { 'hero.headline': parseEther('0.01'), 'hero.image': parseEther('0.05') };

const ECONOMICS = {
  takeBps: 14_000n,
  payoutBps: 11_500n,
  reversionBps: 9_000n,
  maxReversionWeeks: 12n,
  cooldownSecs: 900n,
};
const RENTALS = { siteRentBps: 2_500n, maxRentalTerm: 2_592_000n /* 30d */, minRentBps: 25n };
const FLOOR_POLICY = { floorDeltaBps: 2_000n, floorChangeCooldown: 86_400n, maxAskBps: 40_000n };

const NATIVE = '0x0000000000000000000000000000000000000000' as Address;

let anvil: ChildProcess;
let publicClient: PublicClient;
let wallet: WalletClient;
let factory: Address;
let reader: Address;
let rentalsLib: Address;
let site: Address;
let ref: SiteRef;

async function send(
  account: typeof OWNER,
  request: { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; value?: bigint },
) {
  const hash = await wallet.writeContract({ ...request, account, chain: foundry } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  // `waitForTransactionReceipt` resolves for a REVERTED transaction too — it returns a receipt with
  // `status: 'reverted'` rather than throwing. Without this check a failed write is indistinguishable
  // from a successful one until some later assertion fails for a reason that makes no sense.
  if (receipt.status !== 'success') {
    throw new Error(`e2e: ${request.functionName} reverted (tx ${hash})`);
  }
  return receipt;
}

async function warp(seconds: number) {
  await publicClient.request({ method: 'evm_increaseTime' as never, params: [seconds] as never });
  await publicClient.request({ method: 'evm_mine' as never, params: [] as never });
}

async function deploy(art: { abi: Abi; bytecode: Hex }, args: readonly unknown[]): Promise<Address> {
  const hash = await wallet.deployContract({ ...art, account: OWNER, chain: foundry, args } as never);
  return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
}

/**
 * One chain and one set of deployments for the whole file.
 *
 * Both suites below share them deliberately: the second exists to contrast a token-settled site
 * against the native one, and `readSlotsMulti` reads both in a single call, which is only a
 * meaningful test if they coexist. Hoisted to file scope rather than living in the first suite's
 * `beforeAll`, because a per-suite `afterAll` there killed anvil before the second suite started —
 * which surfaces as `ECONNREFUSED` from a deploy and reads like a broken RPC rather than a teardown
 * ordering mistake.
 */
beforeAll(async () => {
  if (!runnable) return;
  anvil = spawn('anvil', ['--port', String(PORT), '--silent'], { stdio: 'ignore' });

  publicClient = createPublicClient({ chain: foundry, transport: http(RPC) });
  wallet = createWalletClient({ chain: foundry, transport: http(RPC) });

  // Poll rather than sleep — anvil's startup time is not a constant worth guessing at.
  for (let i = 0; i < 100; i++) {
    try {
      await publicClient.getBlockNumber();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // The library first — its address has to exist before the implementation can be linked to it.
  rentalsLib = await deploy(artifact('RentalsLib.sol', 'RentalsLib'), []);

  const siteArtifact = artifact('SlotSite.sol', 'SlotSite');
  const implementation = await deploy(
    { abi: siteArtifact.abi, bytecode: link(siteArtifact.bytecode, siteArtifact.linkReferences, { RentalsLib: rentalsLib }) },
    [500n, 500n, OWNER.address], // protocolBps, protocolRentBps, protocolTreasury
  );

  factory = await deploy(artifact('SlotFactory.sol', 'SlotFactory'), [implementation, rentalsLib]);
  reader = await deploy(artifact('SlotReader.sol', 'SlotReader'), []);
}, 60_000);

afterAll(() => {
  anvil?.kill();
});

describe.skipIf(!runnable)('a whole v2 site, driven through the SDK against a real EVM', () => {
  it('creates a site with its board registered in one transaction', async () => {
    const request = buildCreateSite({
      factory,
      name: 'Example Site',
      symbol: 'EXMPL',
      baseTokenURI: 'https://example.com/slot/',
      treasury: OWNER.address,
      settlementToken: NATIVE,
      economics: ECONOMICS,
      rentals: RENTALS,
      floorPolicy: FLOOR_POLICY,
      slots: KEYS,
    });

    // `simulateContract` gives us the return value; the write then lands the same call.
    const { result } = await publicClient.simulateContract({ ...request, account: OWNER } as never);
    site = result as Address;
    ref = { site, reader };
    await send(OWNER, request);

    expect(site).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  /**
   * The terms, read back through the reader. A field decoded into the wrong property here would
   * silently mis-price every quote the client ever renders — and v2's struct is twenty-two fields
   * rather than v1's twelve, so there is a great deal more room for one to land in the wrong slot.
   */
  it('reads back the terms it was deployed with', async () => {
    const terms = await readSiteTerms(publicClient, ref);
    expect(terms).toMatchObject({
      implementationVersion: 2n,
      takeBps: 14_000n,
      payoutBps: 11_500n,
      reversionBps: 9_000n,
      maxReversionWeeks: 12n,
      cooldownSecs: 900n,
      protocolBps: 500n,
      protocolRentBps: 500n,
      siteRentBps: 2_500n,
      minRentBps: 25n,
      maxAskBps: 40_000n,
      maxRentalTerm: 2_592_000n,
      settlementToken: NATIVE,
      paused: false,
      openRegistration: false,
      termsLocked: false,
    });
    // Native settlement derives an 18-decimal dust floor (§11.2).
    expect(terms.minFloor).toBe(10n ** 14n);
    expect(isTokenSettled(terms)).toBe(false);
  });

  it('reads the whole board in one call, keyed by the strings it was asked about', async () => {
    const slots = await readSlots(publicClient, ref, Object.keys(KEYS));

    expect(slots.map((s) => s.key)).toEqual(['hero.headline', 'hero.image']);
    expect(slots[0]!.keyHash).toBe(slotKey('hero.headline'));
    expect(slots[0]!.floor).toBe(parseEther('0.01'));
    expect(slots[1]!.floor).toBe(parseEther('0.05'));

    // Unclaimed slots come back as null rather than the zero address, and charge the FLOOR.
    for (const slot of slots) {
      expect(slot.owner).toBeNull();
      expect(slot.contentHash).toBeNull();
      expect(slot.registered).toBe(true);
      expect(slot.isUnclaimed).toBe(true);
      expect(slot.charged).toBe(slot.effectiveFloor);
      // No tenancy, so nothing is inherited and net cost is the whole price.
      expect(slot.isRented).toBe(false);
      expect(slot.unaccruedRent).toBe(0n);
      expect(slot.netCost).toBe(slot.charged);
    }
  });

  it('refuses an unregistered key, so nobody squats the site before launch', async () => {
    const [ghost] = await readSlots(publicClient, ref, ['footer.cta']);
    expect(ghost!.registered).toBe(false);
    expect(ghost!.effectiveFloor).toBe(0n);
  });

  /**
   * The publisher's listing toggle, end to end: off through the SDK builder, visible through the
   * reader, enforced by the claim path, and reversible. Runs while `hero.image` is still unclaimed
   * — the flag only gates claims — and puts the flag back so the rest of the sequence is
   * undisturbed.
   */
  it('takes a slot off the market and puts it back, without touching anything owned', async () => {
    await send(OWNER, buildSetAvailability(site, ['hero.image'], false));
    const [off] = await readSlots(publicClient, ref, ['hero.image']);
    expect(off!.isAvailable).toBe(false);
    expect(off!.isUnclaimed).toBe(true);

    // The claim must revert `SlotUnavailable`. `send` checks receipt status, but this never gets
    // that far — the node rejects it at gas estimation, which is what a real client sees too.
    const context = await readBuyContext(publicClient, ref, 'hero.image');
    await expect(send(ALICE, buildBuyFrom(site, context, NATIVE))).rejects.toThrow();

    await send(OWNER, buildSetAvailability(site, ['hero.image'], true));
    const [on] = await readSlots(publicClient, ref, ['hero.image']);
    expect(on!.isAvailable).toBe(true);
  });

  /**
   * The claim path end to end: quote through the SDK, read the encumbrance at the same block, build,
   * send. Also the check that the TypeScript price twin agrees with what the chain actually charges —
   * the parity harness proves the math, this proves the plumbing carrying it.
   */
  it('claims a slot at the price the TypeScript twin predicted', async () => {
    const before = await readSlot(publicClient, ref, 'hero.headline');
    const terms = await readSiteTerms(publicClient, ref);

    const predicted = computeBuyBreakdown(
      before.lastPrice,
      before.floor,
      0n,
      economicsFromTerms(terms),
      before.isUnclaimed,
    );
    expect(predicted.charged).toBe(before.charged);

    const context = await readBuyContext(publicClient, ref, 'hero.headline');
    await send(ALICE, buildBuyFrom(site, context, terms.settlementToken));

    const after = await readSlot(publicClient, ref, 'hero.headline');
    expect(after.owner?.toLowerCase()).toBe(ALICE.address.toLowerCase());
    expect(after.lastPrice).toBe(before.charged);
    expect(after.takes).toBe(1);
    expect(after.isUnclaimed).toBe(false);
  });

  /** §6.1: the first claim in a site's life closes the free-edit window, permanently. */
  it('locks the terms on the first claim', async () => {
    const terms = await readSiteTerms(publicClient, ref);
    expect(terms.termsLocked).toBe(true);
  });

  /**
   * The slippage headroom the builder adds is sent as `msg.value`, and the excess lands in the
   * payer's pull ledger rather than being lost. Asserting it here is what makes the default safe to
   * leave on.
   */
  it('credits the slippage headroom back to the payer', async () => {
    const pending = await readPendingWithdrawal(publicClient, site, ALICE.address);
    expect(pending).toBeGreaterThan(0n);

    await send(ALICE, buildWithdrawFor(site, ALICE.address));
    expect(await readPendingWithdrawal(publicClient, site, ALICE.address)).toBe(0n);
  });

  /**
   * The full content round trip: encode, hash, write the hash on-chain, read it back, and verify
   * the bytes against it exactly as a renderer would.
   */
  it('writes content and verifies it back through the hash gate', async () => {
    const content = encodeText('Ship faster.');
    await send(ALICE, buildEdit(site, 'hero.headline', content.hash));

    const slot = await readSlot(publicClient, ref, 'hero.headline');
    expect(slot.contentHash).toBe(content.hash);
    expect(slot.version).toBe(1);

    // What `<Slot>` does: fetch by hash, verify, then render.
    const result = readContent(content.bytes, slot.contentHash!);
    expect(result.ok).toBe(true);
    if (result.ok) expect(new TextDecoder().decode(result.payload)).toBe('Ship faster.');

    // And the on-chain hash alone is enough to build the storage address.
    expect(contentHashToCid(slot.contentHash!)).toBe(content.cid);
  });

  it('rejects substituted bytes that do not match the on-chain hash', async () => {
    const slot = await readSlot(publicClient, ref, 'hero.headline');
    const substituted = encodeText('Buy my coin.').bytes;
    expect(readContent(substituted, slot.contentHash!)).toEqual({ ok: false, reason: 'hash-mismatch' });
  });

  it('grants delegated editing, and the delegate can write', async () => {
    expect(await readCanEdit(publicClient, site, 'hero.headline', AGENCY.address)).toBe(false);

    await send(ALICE, buildSetEditor(site, 'hero.headline', AGENCY.address));
    expect(await readCanEdit(publicClient, site, 'hero.headline', AGENCY.address)).toBe(true);

    const content = encodeText('Written by the agency.');
    await send(AGENCY, buildEdit(site, 'hero.headline', content.hash));

    const slot = await readSlot(publicClient, ref, 'hero.headline');
    expect(slot.contentHash).toBe(content.hash);
    expect(slot.version).toBe(2);
  });

  // -----------------------------------------------------------------
  // The ask — §3
  // -----------------------------------------------------------------

  /**
   * The ask is the **reversion base**, not a list price. Posting one does not put the slot up for
   * sale and does not change what a buyer pays today; it changes the price the slot reverts *from*,
   * which is how a present owner opts out of being treated as abandoned.
   *
   * The ceiling is computed client-side with the same function the chain uses, so a UI can disable
   * the control rather than let the transaction revert `AskAboveCap`.
   */
  it('posts an ask within the cap, and refuses one above it', async () => {
    const before = await readSlot(publicClient, ref, 'hero.headline');
    const terms = await readSiteTerms(publicClient, ref);

    const ceiling = askCeiling(before.lastPrice, before.floor, terms.maxAskBps);
    expect(ceiling).toBeGreaterThan(before.lastPrice);

    await send(ALICE, buildSetAsk(site, 'hero.headline', ceiling));
    const after = await readSlot(publicClient, ref, 'hero.headline');
    expect(after.askFloor).toBe(ceiling);

    // One wei above what the twin computed is one wei above what the chain will accept.
    await expect(send(ALICE, buildSetAsk(site, 'hero.headline', ceiling + 1n))).rejects.toThrow();
  });

  it('clears the ask with a zero, falling back to what was paid', async () => {
    await send(ALICE, buildSetAsk(site, 'hero.headline', 0n));
    expect((await readSlot(publicClient, ref, 'hero.headline')).askFloor).toBe(0n);
  });

  // -----------------------------------------------------------------
  // Rentals — §2. Every scenario below also proves the library link is live.
  // -----------------------------------------------------------------

  /**
   * The listing path. Rate is per DAY and duration is in SECONDS, and getting that asymmetry wrong
   * is off by 86,400x in a direction nothing else catches.
   */
  it('lists a position for rent at a rate above the anti-poisoning floor', async () => {
    const slot = await readSlot(publicClient, ref, 'hero.headline');
    const terms = await readSiteTerms(publicClient, ref);

    // Comfortably above `minRentBps` of the effective floor, which is what `listForRent` enforces.
    const ratePerDay = (slot.effectiveFloor * 164n) / 10_000n;
    expect(ratePerDay).toBeGreaterThan((slot.effectiveFloor * terms.minRentBps) / 10_000n);

    await send(ALICE, buildListForRent(site, 'hero.headline', ratePerDay, 604_800n));

    const listing = await readListing(publicClient, site, 'hero.headline');
    expect(listing.isListed).toBe(true);
    expect(listing.ratePerDay).toBe(ratePerDay);
    expect(listing.maxDurationSecs).toBe(604_800n);
    // The site's cut is SNAPSHOTTED at list time, which is what lets `siteRentBps` stay mutable.
    expect(listing.feeBps).toBe(terms.siteRentBps);
  });

  /**
   * Opening a tenancy, with the cost computed by the TypeScript twin and charged by the chain. A
   * mismatch here is the rental path's version of a mis-quoted buy: the transaction reverts, or
   * lands having moved a different amount than the UI promised.
   */
  it('rents the position at the cost the twin predicted', async () => {
    const listing = await readListing(publicClient, site, 'hero.headline');
    const terms = await readSiteTerms(publicClient, ref);
    const durationSecs = 172_800n; // two days

    const quote = quoteRent(listing.ratePerDay, durationSecs, terms.protocolRentBps, listing.feeBps);
    expect(quote.cost).toBeGreaterThan(0n);
    expect(quote.protocolCut + quote.siteCut + quote.net).toBe(quote.cost);

    await send(
      BOB,
      buildRent({
        site,
        key: 'hero.headline',
        durationSecs,
        expectedRatePerDay: listing.ratePerDay,
        settlementToken: terms.settlementToken,
        cost: quote.cost,
      }),
    );

    const rental = await readRental(publicClient, site, 'hero.headline');
    expect(rental.tenant?.toLowerCase()).toBe(BOB.address.toLowerCase());
    expect(rental.isActive).toBe(true);
    // `prepaid` is NET of the fee split — what actually streams to the owner.
    expect(rental.prepaid).toBe(quote.net);
    expect(rental.expiry - rental.start).toBe(durationSecs);
  });

  /**
   * §2.3, and the reason `readCanEdit` is a chain read rather than an inference from ownership:
   * during a live term the tenant holds the content gate and the OWNER is locked out. Reconstructing
   * "can edit" from `owner === account` would offer Alice an edit button that reverts.
   */
  it('hands the content gate to the tenant and locks the owner out', async () => {
    expect(await readCanEdit(publicClient, site, 'hero.headline', BOB.address)).toBe(true);
    expect(await readCanEdit(publicClient, site, 'hero.headline', ALICE.address)).toBe(false);

    const content = encodeText('Rented by the advertiser.');
    await send(BOB, buildEdit(site, 'hero.headline', content.hash));
    expect((await readSlot(publicClient, ref, 'hero.headline')).contentHash).toBe(content.hash);
  });

  /**
   * **The field that makes an encumbered position legible** (§2.4.2). Without it a rented slot reads
   * as "buy something you cannot use"; with it, a buyer sees they pay `charged` and inherit
   * `unaccruedRent` back over the remaining term.
   */
  it('surfaces the unaccrued rent a buyer would inherit, and the net cost', async () => {
    await warp(86_400); // one day into a two-day term

    const slot = await readSlot(publicClient, ref, 'hero.headline');
    expect(slot.isRented).toBe(true);
    expect(slot.tenant?.toLowerCase()).toBe(BOB.address.toLowerCase());
    expect(slot.unaccruedRent).toBeGreaterThan(0n);
    expect(slot.netCost).toBe(slot.charged - slot.unaccruedRent);
    expect(slot.netCost).toBeLessThan(slot.charged);

    // And the buy context carries the same numbers, pinned to one block.
    const context = await readBuyContext(publicClient, ref, 'hero.headline');
    expect(context.slot.unaccruedRent).toBeGreaterThan(0n);
    expect(context.slot.netCost).toBe(context.slot.charged - context.slot.unaccruedRent);
  });

  it('accrues rent to the owner, claimable through the pull ledger', async () => {
    const accrued = await readAccruedRent(publicClient, site, 'hero.headline');
    expect(accrued).toBeGreaterThan(0n);

    const before = await readPendingWithdrawal(publicClient, site, ALICE.address);
    // Permissionless: the AGENCY calls it and Alice is credited, not the caller.
    await send(AGENCY, buildClaimRent(site, 'hero.headline'));

    const after = await readPendingWithdrawal(publicClient, site, ALICE.address);
    expect(after - before).toBeGreaterThan(0n);
    expect(await readPendingWithdrawal(publicClient, site, AGENCY.address)).toBe(0n);
  });

  /**
   * `endRental` is load-bearing for the mechanism, not housekeeping: `rent` refuses to open against
   * a lapsed-but-uncleared term, so until this runs the position has left the rental market for
   * everyone. It also restores the owner's content hash, so the expired tenant's copy stops
   * rendering.
   */
  it('clears a lapsed tenancy and restores the owner content', async () => {
    const during = await readSlot(publicClient, ref, 'hero.headline');
    await warp(172_800); // past the two-day expiry

    const lapsed = await readRental(publicClient, site, 'hero.headline');
    expect(lapsed.isActive).toBe(false);
    expect(lapsed.isLapsed).toBe(true);
    // Already cleared from the reader's point of view, because `userOf` respects expiry.
    expect((await readSlot(publicClient, ref, 'hero.headline')).isRented).toBe(false);

    await send(AGENCY, buildEndRental(site, 'hero.headline'));

    const cleared = await readRental(publicClient, site, 'hero.headline');
    expect(cleared.tenant).toBeNull();
    expect(cleared.expiry).toBe(0n);
    expect(cleared.prepaid).toBe(0n);

    // The tenant's content is gone and the owner's is back.
    const after = await readSlot(publicClient, ref, 'hero.headline');
    expect(after.contentHash).not.toBe(during.contentHash);
    expect(await readCanEdit(publicClient, site, 'hero.headline', ALICE.address)).toBe(true);
  });

  /**
   * The rental events are declared in `RentalsLib` and emitted through a delegatecall, so they carry
   * the SITE's address while the site's own ABI cannot decode them. An indexer using
   * `SLOT_SITE_ABI` alone silently sees nothing here — which is the whole reason `SITE_EVENTS_ABI`
   * exists and why `sync:abi` emits both.
   */
  it('emits rental logs at the site address, decodable only with the merged ABI', async () => {
    const withMerged = await publicClient.getContractEvents({
      address: site,
      abi: SITE_EVENTS_ABI,
      eventName: 'SlotRented',
      fromBlock: 0n,
    });
    expect(withMerged.length).toBeGreaterThan(0);

    const siteOnly = SLOT_SITE_ABI.filter((e) => e.type === 'event' && e.name === 'SlotRented');
    expect(siteOnly).toHaveLength(0);
  });

  // -----------------------------------------------------------------
  // The mechanic, and the recipient trap
  // -----------------------------------------------------------------

  /**
   * Bob displaces Alice, Alice is paid at least the floor, and the delegation Alice granted dies
   * with the take.
   */
  it('takes the slot, pays the displaced owner, and kills the delegation', async () => {
    await send(ALICE, buildSetEditor(site, 'hero.headline', AGENCY.address));
    expect(await readCanEdit(publicClient, site, 'hero.headline', AGENCY.address)).toBe(true);
    await warp(901);

    const terms = await readSiteTerms(publicClient, ref);
    const context = await readBuyContext(publicClient, ref, 'hero.headline');
    const before = context.slot;
    const owedBefore = await readPendingWithdrawal(publicClient, site, ALICE.address);

    await send(BOB, buildBuyFrom(site, context, terms.settlementToken));

    const after = await readSlot(publicClient, ref, 'hero.headline');
    expect(after.owner?.toLowerCase()).toBe(BOB.address.toLowerCase());
    expect(after.takes).toBe(2);

    // The guarantee that survives every input is the FLOOR, not a profit: a displaced owner is
    // credited `payoutBps` of the current effective floor, which is at least the floor itself.
    const credited = (await readPendingWithdrawal(publicClient, site, ALICE.address)) - owedBefore;
    expect(credited).toBe((before.effectiveFloor * terms.payoutBps) / 10_000n);
    expect(credited).toBeGreaterThanOrEqual(before.floor);

    // The grant was stamped at one take and the slot is now at two.
    expect(await readCanEdit(publicClient, site, 'hero.headline', AGENCY.address)).toBe(false);
  });

  /**
   * `buyFor` over the wire — the trap that killed one implementation in the sibling repo. The
   * relayer pays and owns nothing.
   */
  it('buys on behalf of someone else without the relayer ending up owning the slot', async () => {
    const terms = await readSiteTerms(publicClient, ref);
    const context = await readBuyContext(publicClient, ref, 'hero.image');

    await send(OWNER, buildBuyFrom(site, context, terms.settlementToken, { recipient: ALICE.address }));

    const after = await readSlot(publicClient, ref, 'hero.image');
    expect(after.owner?.toLowerCase()).toBe(ALICE.address.toLowerCase());
  });

  /**
   * The signed-grant path, end to end. The SDK builds the EIP-712 payload from one set of
   * assumptions and the contract recomputes the digest from another; a typehash string that differs
   * by a space, or a field in the wrong order, produces a signature that verifies against nothing.
   * Neither side can catch that alone.
   */
  it('accepts a grant the owner signed and a stranger relayed', async () => {
    const siteName = (await publicClient.readContract({
      address: site, abi: SLOT_SITE_ABI, functionName: 'name',
    })) as string;
    const nonce = (await publicClient.readContract({
      address: site, abi: SLOT_SITE_ABI, functionName: 'editorNonces', args: [ALICE.address],
    })) as bigint;
    const deadline = BigInt((await publicClient.getBlock()).timestamp) + 3600n;

    const typedData = editorGrantTypedData({
      site, chainId: foundry.id, siteName, key: 'hero.image',
      editor: AGENCY.address, nonce, deadline,
    });
    const signature = await wallet.signTypedData({ ...typedData, account: ALICE });

    expect(await readCanEdit(publicClient, site, 'hero.image', AGENCY.address)).toBe(false);

    // BOB relays it — he pays the gas and gains nothing.
    await send(BOB, buildSetEditorWithSig(site, 'hero.image', AGENCY.address, deadline, signature));

    expect(await readCanEdit(publicClient, site, 'hero.image', AGENCY.address)).toBe(true);
    expect(await readCanEdit(publicClient, site, 'hero.image', BOB.address)).toBe(false);
  });

  it('registers a new slot after launch', async () => {
    await send(OWNER, buildRegisterSlots(site, { 'footer.cta': parseEther('0.02') }));

    const slot = await readSlot(publicClient, ref, 'footer.cta');
    expect(slot.registered).toBe(true);
    expect(slot.floor).toBe(parseEther('0.02'));
  });

  /** §10.4. Permissionless, and pays the site's `treasury` rather than whoever called it. */
  it('sweeps the treasury to the site, not to the caller', async () => {
    const treasuryBefore = await publicClient.getBalance({ address: OWNER.address });
    await send(AGENCY, buildSweepTreasury(site));
    expect(await publicClient.getBalance({ address: OWNER.address })).toBeGreaterThan(treasuryBefore);
  });
});

/**
 * A second site settling in a 6-decimal ERC-20 — the branch that rewrites collection and payout on
 * the function with the most test weight behind it (§8).
 *
 * Two things only this reaches. `msg.value` must be exactly zero or the site reverts
 * `NativeNotAccepted`, so a builder that sent the price as value would fail every purchase here
 * while being correct on the native site above. And `minFloor` is derived from the token's decimals
 * (§11.2), so a floor parsed with `parseEther` is wrong by 1e12 — the config bug this release fixed.
 */
describe.skipIf(!runnable)('a token-settled site', () => {
  let tokenSite: Address;
  let tokenRef: SiteRef;
  let token: Address;

  const unit = (amount: string) => parseUnits(amount, 6);

  beforeAll(async () => {
    token = await deploy(artifact('SlotSiteBase.t.sol', 'MockToken'), []);

    for (const account of [ALICE, BOB]) {
      await send(account, {
        address: token,
        abi: artifact('SlotSiteBase.t.sol', 'MockToken').abi,
        functionName: 'mint',
        args: [account.address, unit('1000000')],
      });
    }

    const request = buildCreateSite({
      factory,
      name: 'Token Site',
      symbol: 'TKN',
      baseTokenURI: '',
      treasury: OWNER.address,
      settlementToken: token,
      economics: ECONOMICS,
      rentals: RENTALS,
      floorPolicy: FLOOR_POLICY,
      slots: { 'hero.headline': unit('0.01') },
    });
    const { result } = await publicClient.simulateContract({ ...request, account: OWNER } as never);
    tokenSite = result as Address;
    tokenRef = { site: tokenSite, reader };
    await send(OWNER, request);
  }, 60_000);

  /**
   * §11.2. `minFloor` is 1e-4 of a unit against the token's OWN decimals — 100 units here, against
   * 1e14 on the native site. A constant tuned for one is wrong by twelve orders of magnitude for the
   * other, which is exactly why `parseFloor` takes decimals and `parseEther` is banned for floors.
   */
  it('derives minFloor from the token decimals, not from 18', async () => {
    const terms = await readSiteTerms(publicClient, tokenRef);
    expect(isTokenSettled(terms)).toBe(true);
    expect(terms.settlementToken.toLowerCase()).toBe(token.toLowerCase());
    expect(terms.minFloor).toBe(100n);
    expect(terms.minFloor).not.toBe(10n ** 14n);
  });

  /**
   * The buy path with zero `msg.value` and a real allowance. The builder decides this from the
   * settlement token alone, which is why it is a required argument rather than an optional one.
   */
  it('claims with an allowance and no native value at all', async () => {
    const terms = await readSiteTerms(publicClient, tokenRef);
    expect(isNativeSettlement(terms.settlementToken)).toBe(false);

    const context = await readBuyContext(publicClient, tokenRef, 'hero.headline');
    const request = buildBuyFrom(tokenSite, context, terms.settlementToken);
    expect(request.value).toBe(0n);

    // The allowance has to cover `maxPrice`, for the same reason the native path sends it as value.
    await send(ALICE, buildApproveSettlement(terms.settlementToken, tokenSite, request.args[1] as bigint));
    await send(ALICE, request);

    const after = await readSlot(publicClient, tokenRef, 'hero.headline');
    expect(after.owner?.toLowerCase()).toBe(ALICE.address.toLowerCase());
    expect(after.charged).toBeGreaterThan(0n);
  });

  /**
   * The directory read: two sites, one round trip. A view living inside a site cannot do this at
   * all, which is as much the reader's reason to exist as the enriched fields are.
   */
  it('reads both sites in a single call', async () => {
    const boards = await readSlotsMulti(publicClient, reader, [
      { site, keys: ['hero.headline', 'hero.image'] },
      { site: tokenSite, keys: ['hero.headline'] },
    ]);

    expect(boards).toHaveLength(2);
    expect(boards[0]).toHaveLength(2);
    expect(boards[1]).toHaveLength(1);
    expect(boards[0]![0]!.key).toBe('hero.headline');
    expect(boards[1]![0]!.owner?.toLowerCase()).toBe(ALICE.address.toLowerCase());
  });
});
