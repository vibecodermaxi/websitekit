/**
 * The read path — spec §5, rebuilt on `SlotReader` for v2.
 *
 * **A page with twelve slots is still one RPC call.** What changed is which contract answers it.
 * v1 carried a `getSlots` view inside the site itself; v2 removed it and composes the same view in
 * `SlotReader`, a separate, deliberately NON-frozen deployment (§11.4). Two things fall out of that
 * and both matter to callers:
 *
 *   1. **Reads take a reader address as well as a site address.** Hence `SiteRef`. It is a nuisance
 *      exactly once, at wiring time, and it is what makes the net-cost presentation §2.4.2 requires
 *      a redeployable UI concern rather than a permanent one in frozen bytecode.
 *   2. **One call can span many SITES.** A view living inside a site can only ever read that site;
 *      `readSlotsMulti` reads a whole directory in one round trip.
 *
 * Still deliberately NOT Multicall3: it is not deployed at its canonical address on every chain, so
 * depending on it would import a per-chain deployment check into the critical read path for no gain.
 *
 * SSR: call `readSlots` server-side with the site's own RPC key, then hydrate. A few seconds of
 * `revalidate` is the right default — a slot changing hands is not a sub-second concern at this
 * scale.
 */
import type { Abi, Address, Hex, PublicClient } from 'viem';

import slotSiteAbiJson from './abi/SlotSite.json';
import slotReaderAbiJson from './abi/SlotReader.json';
import rentalsLibAbiJson from './abi/RentalsLib.json';
import { slotKey } from './keys';
import type { SiteEconomics } from './pricing';

/** The committed `SlotSite` ABI, typed for viem. Kept in sync by `pnpm sync:abi`. */
export const SLOT_SITE_ABI = slotSiteAbiJson as Abi;

/** The convenience-view periphery. Redeployable — see the module note. */
export const SLOT_READER_ABI = slotReaderAbiJson as Abi;

/**
 * `RentalsLib`'s ABI. Needed on its own only rarely; what most callers want is `SITE_EVENTS_ABI`.
 */
export const RENTALS_LIB_ABI = rentalsLibAbiJson as Abi;

/**
 * **The ABI to watch a site's logs with.**
 *
 * `RentalsLib` is delegatecalled, so every rental event it emits is attributed to the SITE's
 * address — but the site never declares those events, so the site's own ABI cannot decode them. An
 * indexer using `SLOT_SITE_ABI` alone silently drops `RentalListed`, `SlotRented`, `RentalExtended`,
 * `RentalEnded` and `UpdateUser`: five events, no error, just an empty result where a tenancy should
 * be. `abi-sync.test.ts` pins that the two ABIs declare disjoint event sets, so this merge cannot
 * start double-counting if a future refactor moves a declaration.
 */
export const SITE_EVENTS_ABI = [...SLOT_SITE_ABI, ...RENTALS_LIB_ABI] as Abi;

/**
 * Where to read a site from.
 *
 * The reader is a separate deployment and a *replaceable* one, so it is passed rather than baked
 * into the SDK: pinning a reader address in this package would mean a version bump to adopt a new
 * view. `deploymentFor(chainId).reader` is the usual source.
 */
export interface SiteRef {
  site: Address;
  reader: Address;
}

/** One row of the reader's `readSlots`, with the string key the caller asked about carried back. */
export interface SlotState {
  /** The dotted key from the site's config, e.g. `hero.headline`. */
  key: string;
  /** `keccak256(utf8(key))` — what the contract stores. */
  keyHash: Hex;
  /** `null` when unclaimed, rather than the zero address. */
  owner: Address | null;
  /**
   * `null` when the slot has never been edited. The zero hash is the contract's "unset" value and
   * would otherwise be handed to a fetcher that would 404 on it.
   */
  contentHash: Hex | null;
  /** The site owner's configured floor. */
  floor: bigint;
  /** What a first claim costs right now — `max(reverted, floor)`. */
  effectiveFloor: bigint;
  /** What the current owner actually paid. */
  lastPrice: bigint;
  /**
   * The owner's posted ask, or `0n`. §3: this is the **reversion base** — the price the slot
   * reverts *from* — not a list price and not what a buyer pays. Cleared on every sale.
   */
  askFloor: bigint;
  lastPurchaseTs: bigint;
  /** Bumped on every edit; what a client caches content against. */
  version: number;
  takes: number;
  /** False for a key the site owner has not registered. Such a slot cannot be bought (§7.5). */
  registered: boolean;
  /**
   * The publisher's listing toggle (§10.4). Only meaningful while unclaimed: `false` means the
   * claim path reverts `SlotUnavailable`, so a board should render the slot as "not currently
   * offered" rather than claimable. Takes and rentals on an OWNED position ignore it — the flag is
   * not a lever over positions people already paid for.
   */
  isAvailable: boolean;
  /** Convenience for the overwhelmingly common branch. */
  isUnclaimed: boolean;
  /** What THIS buyer would be charged — `effectiveFloor` on a claim, the take price on a take. */
  charged: bigint;

  // --- tenancy (§2) ---

  /** The LIVE tenant, or `null`. An expired-but-uncleared term reads as `null`, not as a tenancy. */
  tenant: Address | null;
  /** Raw expiry. Non-zero on a lapsed-but-uncleared term, so it is not a liveness signal — use
   *  `tenant` or `isRented` for that. */
  rentalExpiry: bigint;
  /**
   * Escrowed rent not yet earned — **what a buyer inherits** (§2.4.2).
   *
   * This is the number that makes an encumbered position legible. Without it a rented slot reads as
   * "buy something you cannot use"; with it, the buyer sees they are paying `charged` for an asset
   * that hands them `unaccruedRent` back over the remaining term.
   */
  unaccruedRent: bigint;
  /**
   * `charged - unaccruedRent`. The number a confirm dialog should lead with, and the reason §2.4.2
   * calls surfacing it the highest-value client change in the release.
   *
   * Clamped at zero: a position can carry more unaccrued rent than it costs to take, and a negative
   * "cost" is a presentation problem rather than a refund. `isFreeCarry` flags that case rather than
   * hiding it.
   */
  netCost: bigint;
  /** True when the inherited rent stream exceeds the purchase price outright. */
  isFreeCarry: boolean;
  /** Whether a live tenancy is in force right now. */
  isRented: boolean;
  /** Listed rent, per DAY, or `0n` when not listed. Durations elsewhere are in SECONDS (§2.5.3). */
  ratePerDay: bigint;
  /** The longest term the owner will accept, in seconds. `0n` when not listed. */
  maxDurationSecs: bigint;
  /** Whether the position can be rented right now. */
  isListed: boolean;
}

/** The reader's `SlotView` struct, as viem decodes it. */
interface RawSlotView {
  key: Hex;
  owner: Address;
  contentHash: Hex;
  floor: bigint;
  effectiveFloor: bigint;
  charged: bigint;
  lastPrice: bigint;
  askFloor: bigint;
  lastPurchaseTs: bigint;
  version: number;
  takes: number;
  registered: boolean;
  available: boolean;
  tenant: Address;
  rentalExpiry: bigint;
  unaccruedRent: bigint;
  ratePerDay: bigint;
  maxDurationSecs: bigint;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Reads every slot on a page in one call.
 *
 * Takes STRING keys and returns them on each row, because the alternative — hand back rows keyed by
 * hash and make the caller re-derive the mapping — is how a render loop ends up hashing the same
 * twelve strings on every frame.
 */
export async function readSlots(
  client: PublicClient,
  ref: SiteRef,
  keys: readonly string[],
  blockNumber?: bigint,
): Promise<SlotState[]> {
  if (keys.length === 0) return [];
  const hashes = keys.map((key) => slotKey(key));

  const views = (await client.readContract({
    address: ref.reader,
    abi: SLOT_READER_ABI,
    functionName: 'readSlots',
    args: [ref.site, hashes],
    blockNumber,
  })) as readonly RawSlotView[];

  // Defensive: a length mismatch means the ABI and the deployed reader have diverged, and zipping
  // regardless would silently attribute one slot's state to another key.
  if (views.length !== keys.length) {
    throw new Error(
      `websitekit/reads: readSlots returned ${views.length} rows for ${keys.length} keys — ` +
        'the committed ABI and the deployed reader have diverged (run `pnpm sync:abi`)',
    );
  }

  return views.map((view, index) => toSlotState(keys[index]!, hashes[index]!, view));
}

/** Single-slot convenience. Prefer `readSlots` for anything rendering more than one. */
export async function readSlot(client: PublicClient, ref: SiteRef, key: string): Promise<SlotState> {
  const [state] = await readSlots(client, ref, [key]);
  return state!;
}

/**
 * The directory read: many sites, one round trip.
 *
 * A view living inside a site can only ever read that site, which is why v1 had no equivalent and
 * why this is the reader's reason to exist as much as the enriched fields are. Results come back in
 * the order the sites were given, each already zipped against its own key list.
 */
export async function readSlotsMulti(
  client: PublicClient,
  reader: Address,
  boards: ReadonlyArray<{ site: Address; keys: readonly string[] }>,
  blockNumber?: bigint,
): Promise<SlotState[][]> {
  if (boards.length === 0) return [];
  const hashLists = boards.map((board) => board.keys.map((key) => slotKey(key)));

  const out = (await client.readContract({
    address: reader,
    abi: SLOT_READER_ABI,
    functionName: 'readSlotsMulti',
    args: [boards.map((board) => board.site), hashLists],
    blockNumber,
  })) as readonly (readonly RawSlotView[])[];

  if (out.length !== boards.length) {
    throw new Error(
      `websitekit/reads: readSlotsMulti returned ${out.length} boards for ${boards.length} sites — ` +
        'the committed ABI and the deployed reader have diverged (run `pnpm sync:abi`)',
    );
  }

  return out.map((views, i) =>
    views.map((view, j) => toSlotState(boards[i]!.keys[j]!, hashLists[i]![j]!, view)),
  );
}

function toSlotState(key: string, keyHash: Hex, view: RawSlotView): SlotState {
  const isUnclaimed = view.owner.toLowerCase() === ZERO_ADDRESS;
  const tenant = view.tenant.toLowerCase() === ZERO_ADDRESS ? null : view.tenant;
  const isFreeCarry = view.unaccruedRent > view.charged;
  return {
    key,
    keyHash,
    owner: isUnclaimed ? null : view.owner,
    contentHash: view.contentHash === ZERO_HASH ? null : view.contentHash,
    floor: view.floor,
    effectiveFloor: view.effectiveFloor,
    lastPrice: view.lastPrice,
    askFloor: view.askFloor,
    lastPurchaseTs: view.lastPurchaseTs,
    version: view.version,
    takes: view.takes,
    registered: view.registered,
    isAvailable: view.available,
    isUnclaimed,
    // The reader already picked the right branch; recomputing it here would be a second definition
    // of "what this buyer pays" that could drift from the one the chain will charge.
    charged: view.charged,
    tenant,
    rentalExpiry: view.rentalExpiry,
    unaccruedRent: view.unaccruedRent,
    netCost: isFreeCarry ? 0n : view.charged - view.unaccruedRent,
    isFreeCarry,
    isRented: tenant !== null,
    ratePerDay: view.ratePerDay,
    maxDurationSecs: view.maxDurationSecs,
    isListed: view.ratePerDay > 0n,
  };
}

/**
 * A site's terms: the protocol constants it was cloned under, the economics, and the rental and
 * floor policy.
 *
 * **Cacheable, but no longer immutable.** In v1 every field here was frozen at `initialize()` and
 * the advice was to read once and cache forever. v2 is tiered (§6.1): before the first claim a
 * publisher may change anything; after it, take economics may only ratchet in the holder-safe
 * direction, and the rental terms stay freely mutable in both directions (§2.5.1). `termsLocked`
 * tells you which regime a site is in. Cache for the lifetime of a page, not of a session.
 */
export interface SiteTerms {
  implementationVersion: bigint;
  takeBps: bigint;
  payoutBps: bigint;
  /** Per-week reversion. `10_000` is none at all. v1 called this `decayBps`. */
  reversionBps: bigint;
  maxReversionWeeks: bigint;
  cooldownSecs: bigint;
  protocolBps: bigint;
  protocolRentBps: bigint;
  /** The site's rent cut. Freely mutable — but a listing SNAPSHOTS it, so never price an existing
   *  listing against this (§2.5.1). */
  siteRentBps: bigint;
  minRentBps: bigint;
  maxAskBps: bigint;
  floorDeltaBps: bigint;
  floorChangeCooldown: bigint;
  /** The smallest legal floor, derived from the settlement token's decimals (§11.2). */
  minFloor: bigint;
  maxRentalTerm: bigint;
  /** `0x0` means native settlement. Frozen — there is no setter, ever. */
  settlementToken: Address;
  paused: boolean;
  openRegistration: boolean;
  /** Set by the first claim in a site's life, and never unset. Gates the ratchet rules. */
  termsLocked: boolean;
  defaultFloor: bigint;
  treasury: Address;
  royaltyBps: bigint;
}

/**
 * @param blockNumber Pin the read to one block. Matters when the terms are read alongside a quote
 * that is itself pinned — mixing a quote from block N with terms from N+1 is the same torn read
 * `readBuyContext` exists to avoid, one level up.
 *
 * One call, not one per field. Reading these individually is twenty-two RPC round trips.
 */
export async function readSiteTerms(
  client: PublicClient,
  ref: SiteRef,
  blockNumber?: bigint,
): Promise<SiteTerms> {
  return (await client.readContract({
    address: ref.reader,
    abi: SLOT_READER_ABI,
    functionName: 'readTerms',
    args: [ref.site],
    blockNumber,
  })) as SiteTerms;
}

/**
 * The subset of a site's terms the pricing twin needs, mapped without hand-copying five bps fields.
 *
 * Worth a helper rather than a spread: the fields are all `bigint`s with similar names, so
 * transposing two of them type-checks, runs, and produces a quote that is merely *wrong* — which is
 * the failure mode the whole parity layer exists to prevent one level down.
 */
export function economicsFromTerms(terms: SiteTerms): SiteEconomics {
  return {
    takeBps: terms.takeBps,
    payoutBps: terms.payoutBps,
    reversionBps: terms.reversionBps,
    maxReversionWeeks: terms.maxReversionWeeks,
    protocolBps: terms.protocolBps,
  };
}

/** Whether a site settles in an ERC-20 rather than the chain's native currency. */
export function isTokenSettled(terms: Pick<SiteTerms, 'settlementToken'>): boolean {
  return terms.settlementToken.toLowerCase() !== ZERO_ADDRESS;
}

/**
 * The `expectedTerms` argument every buy needs (§4).
 *
 * **Always read this in its own step and pass it in.** Never compute it inline in an argument list:
 * it has to reflect the state the buyer was actually shown, and a fresh read taken at submit time
 * would defeat the guard it exists to be by picking up the very change it should be rejecting.
 *
 * v2 widened what it covers. It now commits to the TENANCY as well as the floor and registration —
 * the rental tuple is what a buyer inherits, so a term opened between quote and submit invalidates
 * the deal they were shown. Note it deliberately excludes `askFloor`: an ask moves price, and
 * `maxPrice` already guards price.
 */
export async function readEncumbrance(client: PublicClient, site: Address, key: string): Promise<Hex> {
  return (await client.readContract({
    address: site,
    abi: SLOT_SITE_ABI,
    functionName: 'encumbranceHash',
    args: [slotKey(key)],
  })) as Hex;
}

/**
 * Everything a buy needs, read at one pinned block.
 *
 * **Three bugs this exists to prevent, all of which look like the chain misbehaving.**
 *
 * 1. **A torn read.** Reading the quote at block N and `encumbranceHash` at block N+1 means the
 *    buyer signs terms that never coexisted. Pinning both to one block number is the only way the
 *    `expectedTerms` guard actually guards the thing that was quoted.
 * 2. **Wall-clock deadlines.** `buy`'s deadline is compared against `block.timestamp`, not against
 *    the client's clock. Those are close on most chains and are NOT the same number — a user whose
 *    system clock is ten minutes slow, or an L2 whose timestamps lag, gets `DeadlineExpired` on
 *    every purchase with nothing in the UI able to explain why. `now` here is the chain's own clock,
 *    and `buildBuyFrom` uses it.
 * 3. **An encumbered position reading as unbuyable.** `slot.unaccruedRent` and `slot.netCost` come
 *    back on the same pinned read, so the confirm dialog can say "you pay X, you inherit Y, net Z"
 *    from numbers that all describe one block (§2.4.2).
 */
export interface BuyContext {
  slot: SlotState;
  expectedTerms: Hex;
  /** The chain's clock at `blockNumber` — NOT `Date.now()`. */
  now: bigint;
  blockNumber: bigint;
}

export async function readBuyContext(
  client: PublicClient,
  ref: SiteRef,
  key: string,
): Promise<BuyContext> {
  const block = await client.getBlock();
  const keyHash = slotKey(key);

  const [slots, expectedTerms] = await Promise.all([
    readSlots(client, ref, [key], block.number),
    client.readContract({
      address: ref.site,
      abi: SLOT_SITE_ABI,
      functionName: 'encumbranceHash',
      args: [keyHash],
      blockNumber: block.number,
    }) as Promise<Hex>,
  ]);

  return {
    slot: slots[0]!,
    expectedTerms,
    now: block.timestamp,
    blockNumber: block.number,
  };
}

/**
 * A tenancy, straight from the site. `readSlots` already carries the fields a page needs; this is
 * for a rental panel that has to show the whole term.
 */
export interface Rental {
  tenant: Address | null;
  start: bigint;
  expiry: bigint;
  /** Net of the fee split — what actually streams to the owner over the term. */
  prepaid: bigint;
  /** How much of `prepaid` has already been swept into the pull ledger. */
  claimed: bigint;
  /** The owner's content hash, restored by `endRental` when the term lapses. */
  ownerHashSnapshot: Hex;
  /** Whether the term is live right now. */
  isActive: boolean;
  /** Whether the term has lapsed but not yet been cleared — see `buildEndRental`. */
  isLapsed: boolean;
}

/**
 * @param nowSecs The chain time to judge liveness against. Omit and it is READ FROM THE CHAIN, at
 * the cost of one extra round trip.
 *
 * **It is deliberately not `Date.now()`.** Liveness here is decided by `block.timestamp`, and the
 * two clocks are close on most chains and are never the same number — an L2 whose timestamps lag,
 * or a test chain that has been warped forward, makes a wall-clock answer confidently wrong. This
 * SDK has been bitten by exactly that once already, in `buy`'s deadline; the first run of the v2
 * end-to-end suite caught it here as well, reporting a term that had expired three days earlier as
 * still live. Pass `nowSecs` from a pinned block when several reads must describe one instant.
 */
export async function readRental(
  client: PublicClient,
  site: Address,
  key: string,
  nowSecs?: bigint,
): Promise<Rental> {
  const [raw, now] = await Promise.all([
    client.readContract({
      address: site,
      abi: SLOT_SITE_ABI,
      functionName: 'rentals',
      args: [slotKey(key)],
    }) as Promise<readonly [Address, bigint, bigint, bigint, bigint, Hex]>,
    nowSecs !== undefined ? Promise.resolve(nowSecs) : client.getBlock().then((block) => block.timestamp),
  ]);

  const [tenant, start, expiry, prepaid, claimed, ownerHashSnapshot] = raw;
  const isActive = expiry !== 0n && now < expiry;

  return {
    tenant: tenant.toLowerCase() === ZERO_ADDRESS ? null : tenant,
    start,
    expiry,
    prepaid,
    claimed,
    ownerHashSnapshot,
    isActive,
    isLapsed: expiry !== 0n && !isActive,
  };
}

/** A position's rental listing. `ratePerDay === 0n` means not listed. */
export interface Listing {
  ratePerDay: bigint;
  maxDurationSecs: bigint;
  /**
   * The site's cut, SNAPSHOTTED when the listing was written. **Price an existing listing against
   * this, never against the site's current `siteRentBps`** — the snapshot is what lets that
   * parameter be freely mutable without letting a publisher advertise 0% and raise it before anyone
   * rents (§2.5.1).
   */
  feeBps: bigint;
  isListed: boolean;
}

export async function readListing(client: PublicClient, site: Address, key: string): Promise<Listing> {
  const [ratePerDay, maxDurationSecs, feeBps] = (await client.readContract({
    address: site,
    abi: SLOT_SITE_ABI,
    functionName: 'listings',
    args: [slotKey(key)],
  })) as readonly [bigint, bigint, number];

  return {
    ratePerDay,
    maxDurationSecs,
    feeBps: BigInt(feeBps),
    isListed: ratePerDay > 0n,
  };
}

/**
 * Rent the owner has earned so far, gross of what has already been claimed.
 *
 * The claimable amount is this minus `readRental().claimed` — the contract exposes the gross figure
 * because that is what the accrual formula produces, and subtracting in the wrong direction is how a
 * UI ends up offering a claim that reverts `NothingToWithdraw`.
 */
export async function readAccruedRent(client: PublicClient, site: Address, key: string): Promise<bigint> {
  return (await client.readContract({
    address: site,
    abi: SLOT_SITE_ABI,
    functionName: 'accruedRent',
    args: [slotKey(key)],
  })) as bigint;
}

/** Escrowed rent not yet earned — what a buyer of this position would inherit (§2.4.2). */
export async function readUnaccruedRent(client: PublicClient, site: Address, key: string): Promise<bigint> {
  return (await client.readContract({
    address: site,
    abi: SLOT_SITE_ABI,
    functionName: 'unaccruedRent',
    args: [slotKey(key)],
  })) as bigint;
}

/**
 * Whether an address may write this slot's content.
 *
 * Read rather than reconstructed from `owner`, so the client cannot offer an edit button for a
 * transaction that will revert — and in v2 that reconstruction would be wrong more often than it
 * was in v1: during a live tenancy the TENANT holds the content gate and the owner is locked out
 * entirely (§2.3). There is one definition of who may write, and it is in the contract.
 */
export async function readCanEdit(
  client: PublicClient,
  site: Address,
  key: string,
  account: Address,
): Promise<boolean> {
  return (await client.readContract({
    address: site,
    abi: SLOT_SITE_ABI,
    functionName: 'canEdit',
    args: [slotKey(key), account],
  })) as boolean;
}

/** What a caller can withdraw from this site's pull ledger. */
export async function readPendingWithdrawal(
  client: PublicClient,
  site: Address,
  account: Address,
): Promise<bigint> {
  return (await client.readContract({
    address: site,
    abi: SLOT_SITE_ABI,
    functionName: 'pendingWithdrawals',
    args: [account],
  })) as bigint;
}
