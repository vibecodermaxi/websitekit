/**
 * Render escrow — the vault that holds a board's publisher revenue for a window and hands it to the
 * board's slot holders if the page goes dark inside it.
 *
 * `docs/escrow_contract.md` is the design; this is its client. Three contracts, none of them
 * `SlotSite`: **`EscrowVault`** is one EIP-1167 clone per board and holds the money, the clock and
 * the ledger; **`EscrowFactory`** creates a board and its vault in one transaction with the board's
 * `treasury` pinned to the vault before anyone can touch it; **`Attestor`** is the one-slot registry
 * the privileged key is read from, so the key can rotate without a new vault implementation.
 *
 * **What `SlotSite` needs from any of this is `pinTreasury` and nothing else.** Every figure the
 * vault decides on — the cap, who claims, who is paid — is read off the site's public accessors.
 *
 * Builders here follow `writes.ts`: request objects for viem, never a wallet of our own. The one
 * builder that moves money is `buildFundReserve`, and it takes `settlementToken` for the reason
 * every money builder in this package does — there is no default, because a default is silently
 * right for one kind of site and wrong for the other.
 */
import type { Abi, Address, Hex, PublicClient } from 'viem';

import attestorAbiJson from './abi/Attestor.json';
import escrowFactoryAbiJson from './abi/EscrowFactory.json';
import escrowVaultAbiJson from './abi/EscrowVault.json';
import { slotKey } from './keys';
import { SLOT_SITE_ABI } from './reads';
import { buildCreateSite, isNativeSettlement, type BuildCreateSiteOptions, type CallRequest } from './writes';

export const ESCROW_VAULT_ABI = escrowVaultAbiJson as Abi;
export const ESCROW_FACTORY_ABI = escrowFactoryAbiJson as Abi;
export const ATTESTOR_ABI = attestorAbiJson as Abi;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

/** The factory's policy, copied onto each vault at bind and immutable for that board thereafter. */
export interface EscrowParams {
  /** Seconds a deposit must be served in the light before it is the publisher's. */
  windowSecs: bigint;
  /** Seconds after `markDark` before any holder may claim — the window in which `clearDark`
   *  corrects a mistake before money moves on it. */
  claimDelaySecs: bigint;
  /** Minimum spacing between `markDark`/`clearDark`. */
  minTransitionSecs: bigint;
  /** Below this, inbound accumulates unbooked rather than becoming a deposit. */
  minBooking: bigint;
}

// ---------------------------------------------------------------------------
// Creating an escrowed board
// ---------------------------------------------------------------------------

export interface BuildCreateEscrowedSiteOptions extends Omit<BuildCreateSiteOptions, 'factory' | 'owner' | 'treasury' | 'pinTreasury'> {
  /** The `EscrowFactory`, not the `SlotFactory`. */
  escrowFactory: Address;
  /**
   * Who owns the board. **Required**, where `buildCreateSite` lets it default to the sender: the
   * escrow factory always names the owner, and a builder that filled it in with the payer would
   * be the mistake this repo's standing check exists to catch.
   */
  owner: Address;
}

/**
 * Builds `EscrowFactory.createEscrowedSite`.
 *
 * `treasury` and `pinTreasury` are not options: the factory overwrites both with the vault it
 * deploys, whatever a caller passes, so a caller cannot create an escrowed board whose money goes
 * anywhere but its own vault. The config is otherwise exactly `buildCreateSite`'s, clamps included.
 */
export function buildCreateEscrowedSite(
  options: BuildCreateEscrowedSiteOptions,
): CallRequest<'createEscrowedSite', [Address, unknown, Hex[], bigint[]]> {
  const { escrowFactory, owner, ...rest } = options;
  const inner = buildCreateSite({ ...rest, factory: escrowFactory, owner, treasury: owner, pinTreasury: true });
  if (inner.functionName !== 'createSiteFor') {
    throw new Error('websitekit/escrow: the owner must be named');
  }
  const [, config, keys, floors] = inner.args;
  return {
    address: escrowFactory,
    abi: ESCROW_FACTORY_ABI,
    functionName: 'createEscrowedSite',
    args: [owner, config, keys, floors],
  };
}

// ---------------------------------------------------------------------------
// The vault's entry points
// ---------------------------------------------------------------------------

/** Sweeps the site and books the unbooked inbound. Permissionless — always to the board's owner. */
export function buildBook(vault: Address): CallRequest<'book', []> {
  return { address: vault, abi: ESCROW_VAULT_ABI, functionName: 'book', args: [] };
}

/** Credits a mature deposit to whoever owned the board when it was booked. Permissionless. */
export function buildRelease(vault: Address, id: bigint): CallRequest<'release', [bigint]> {
  return { address: vault, abi: ESCROW_VAULT_ABI, functionName: 'release', args: [id] };
}

/**
 * The holder surrenders `key` for up to what they paid. **The holder's call**, or an operator
 * they approved — and the vault itself must be approved to move the token first, which is
 * `buildApproveVault`. A claim without that approval fails at the surrender and credits nothing.
 *
 * **`minPaid` has NO DEFAULT, and that is the point of it.** A surrender cannot be undone and the
 * pool is first-come-first-served, so a caller who omitted a floor would silently get the old
 * behaviour: the slot handed in for whatever the block happens to hold. Driven on chain
 * (`escrow_mainnet.md` E-4), a second claimant was credited $0.589474 against the $1.30 the vault
 * had quoted a block earlier. Pass `0n` to mean no floor, deliberately and in writing.
 *
 * It is a floor on what the CALLER is credited, not on what the vault holds — the contract applies
 * it after capping at the slot's own `lastPrice`, so a holder is never refused by money they could
 * not have reached.
 */
export function buildClaim(vault: Address, key: string, minPaid: bigint): CallRequest<'claim', [Hex, bigint]> {
  return { address: vault, abi: ESCROW_VAULT_ABI, functionName: 'claim', args: [slotKey(key), minPaid] };
}

/**
 * The surrender's consent: `setApprovalForAll(vault, true)` on the SITE, so `claim` can move the
 * holder's token into the vault. Sent by the holder, on the site, before `buildClaim`.
 */
export function buildApproveVault(site: Address, vault: Address): CallRequest<'setApprovalForAll', [Address, boolean]> {
  return { address: site, abi: SLOT_SITE_ABI, functionName: 'setApprovalForAll', args: [vault, true] };
}

/** Pays `account` what the vault has credited it. Permissionless; only `account` is paid. */
export function buildVaultWithdrawFor(vault: Address, account: Address): CallRequest<'withdrawFor', [Address]> {
  return { address: vault, abi: ESCROW_VAULT_ABI, functionName: 'withdrawFor', args: [account] };
}

/** The attestor's. Stops every immature deposit's clock. */
export function buildMarkDark(vault: Address): CallRequest<'markDark', []> {
  return { address: vault, abi: ESCROW_VAULT_ABI, functionName: 'markDark', args: [] };
}

/** The attestor's. Closes the episode and adds it to `darkAccrued`. */
export function buildClearDark(vault: Address): CallRequest<'clearDark', []> {
  return { address: vault, abi: ESCROW_VAULT_ABI, functionName: 'clearDark', args: [] };
}

/**
 * Pays the board's owner any balance that is not the settlement token. `0x0` is native — on a
 * token board that is the common royalty case, not the residue.
 */
export function buildSweepForeign(vault: Address, token: Address): CallRequest<'sweepForeign', [Address]> {
  return { address: vault, abi: ESCROW_VAULT_ABI, functionName: 'sweepForeign', args: [token] };
}

/**
 * Adds reserve only a claim may spend — what lets a claim pay `lastPrice` in full rather than the
 * publisher's 95% of it. Native sends `value`; a token board pulls `amount` and needs an allowance
 * on the VAULT (`buildApproveSettlement` with the vault as spender).
 */
export function buildFundReserve(
  vault: Address,
  amount: bigint,
  settlementToken: Address,
): CallRequest<'fundReserve', [bigint]> {
  const native = isNativeSettlement(settlementToken);
  return {
    address: vault,
    abi: ESCROW_VAULT_ABI,
    functionName: 'fundReserve',
    args: [native ? 0n : amount],
    value: native ? amount : 0n,
  };
}

/** The factory owner's. Refused while the board is dark. */
export function buildWithdrawReserve(
  vault: Address,
  amount: bigint,
  to: Address,
): CallRequest<'withdrawReserve', [bigint, Address]> {
  return { address: vault, abi: ESCROW_VAULT_ABI, functionName: 'withdrawReserve', args: [amount, to] };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface VaultState {
  site: Address;
  settlementToken: Address;
  windowSecs: bigint;
  claimDelaySecs: bigint;
  minTransitionSecs: bigint;
  minBooking: bigint;
  /** `0n` when live. While non-zero, maturity is evaluated as of this moment. */
  darkSince: bigint;
  darkAccrued: bigint;
  lastTransitionAt: bigint;
  bookedTotal: bigint;
  pendingTotal: bigint;
  reserve: bigint;
  depositCount: bigint;
  /** Inbound the vault holds that is neither booked, credited nor reserve. */
  unbooked: bigint;
  /** The sum of deposits the publisher has NOT yet earned — what a claim may drain. */
  immaturePool: bigint;
  isDark: boolean;
}

export async function readVault(client: PublicClient, vault: Address): Promise<VaultState> {
  const read = <T>(functionName: string) =>
    client.readContract({ address: vault, abi: ESCROW_VAULT_ABI, functionName, args: [] }) as Promise<T>;

  const [
    site,
    settlementToken,
    windowSecs,
    claimDelaySecs,
    minTransitionSecs,
    minBooking,
    darkSince,
    darkAccrued,
    lastTransitionAt,
    bookedTotal,
    pendingTotal,
    reserve,
    depositCount,
    unbooked,
    immaturePool,
  ] = await Promise.all([
    read<Address>('site'),
    read<Address>('settlementToken'),
    read<bigint>('windowSecs'),
    read<bigint>('claimDelaySecs'),
    read<bigint>('minTransitionSecs'),
    read<bigint>('minBooking'),
    read<bigint>('darkSince'),
    read<bigint>('darkAccrued'),
    read<bigint>('lastTransitionAt'),
    read<bigint>('bookedTotal'),
    read<bigint>('pendingTotal'),
    read<bigint>('reserve'),
    read<bigint>('depositCount'),
    read<bigint>('unbooked'),
    read<bigint>('immaturePool'),
  ]);

  return {
    site,
    settlementToken,
    windowSecs,
    claimDelaySecs,
    minTransitionSecs,
    minBooking,
    darkSince,
    darkAccrued,
    lastTransitionAt,
    bookedTotal,
    pendingTotal,
    reserve,
    depositCount,
    unbooked,
    immaturePool,
    isDark: darkSince !== 0n,
  };
}

export interface VaultDeposit {
  id: bigint;
  /** Remaining, undrained. Zero once released or fully claimed. */
  amount: bigint;
  bookedAt: bigint;
  darkAtBooking: bigint;
  /** Who owned the board when this was booked, and who `release` pays. */
  beneficiary: Address;
  /** The vault's own verdict — releasable and never claimable. */
  mature: boolean;
}

/**
 * Every deposit on a vault, with the vault's own maturity verdict beside each.
 *
 * Read from the contract rather than recomputed here: the predicate decides both sides of every
 * dispute, and a TypeScript twin of it would be a second implementation with no shared vector.
 */
export async function readDeposits(client: PublicClient, vault: Address): Promise<VaultDeposit[]> {
  const count = (await client.readContract({
    address: vault,
    abi: ESCROW_VAULT_ABI,
    functionName: 'depositCount',
    args: [],
  })) as bigint;

  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i));
  return Promise.all(
    ids.map(async (id) => {
      const [raw, mature] = await Promise.all([
        client.readContract({ address: vault, abi: ESCROW_VAULT_ABI, functionName: 'depositAt', args: [id] }) as Promise<{
          amount: bigint;
          bookedAt: bigint;
          darkAtBooking: bigint;
          beneficiary: Address;
        }>,
        client.readContract({ address: vault, abi: ESCROW_VAULT_ABI, functionName: 'mature', args: [id] }) as Promise<boolean>,
      ]);
      return { id, amount: raw.amount, bookedAt: raw.bookedAt, darkAtBooking: raw.darkAtBooking, beneficiary: raw.beneficiary, mature };
    }),
  );
}

/** What `claim(key)` would credit right now, or `0n` when it would revert for any reason. */
export async function readClaimable(client: PublicClient, vault: Address, key: string): Promise<bigint> {
  return (await client.readContract({
    address: vault,
    abi: ESCROW_VAULT_ABI,
    functionName: 'claimable',
    args: [slotKey(key)],
  })) as bigint;
}

/** What `account` may withdraw from the vault's pull ledger. */
export async function readVaultPending(client: PublicClient, vault: Address, account: Address): Promise<bigint> {
  return (await client.readContract({
    address: vault,
    abi: ESCROW_VAULT_ABI,
    functionName: 'pending',
    args: [account],
  })) as bigint;
}

/** The vault the escrow factory bound to `site`, or `null` if it created none. */
export async function readVaultOf(client: PublicClient, escrowFactory: Address, site: Address): Promise<Address | null> {
  const vault = (await client.readContract({
    address: escrowFactory,
    abi: ESCROW_FACTORY_ABI,
    functionName: 'vaultOf',
    args: [site],
  })) as Address;
  return vault.toLowerCase() === ZERO_ADDRESS ? null : vault;
}

export interface EscrowBind {
  /** `site.treasury() == vault` — the publisher's cut has nowhere else to go. */
  routesHere: boolean;
  /** `site.treasuryPinned()` — and nobody can repoint it. */
  pinned: boolean;
  /** `vault.site() == site` — and the vault agrees. */
  bound: boolean;
  /** All three. The only sentence a badge is allowed to say. */
  escrowed: boolean;
}

/**
 * The guarantee, checked in BOTH directions.
 *
 * `createSite` is public, so anyone can create a second real board whose `treasury` is an existing
 * vault. Its money would be a donation to the vault's own board; its buyers would see a pinned
 * treasury pointing at a vault that owes them nothing. `bound` is what tells the two apart, and a
 * badge that read only the site's side would be asserting something the vault never agreed to.
 */
export async function readEscrowBind(client: PublicClient, site: Address, vault: Address): Promise<EscrowBind> {
  const [treasury, pinned, vaultSite] = await Promise.all([
    client.readContract({ address: site, abi: SLOT_SITE_ABI, functionName: 'treasury', args: [] }) as Promise<Address>,
    client.readContract({ address: site, abi: SLOT_SITE_ABI, functionName: 'treasuryPinned', args: [] }) as Promise<boolean>,
    client.readContract({ address: vault, abi: ESCROW_VAULT_ABI, functionName: 'site', args: [] }) as Promise<Address>,
  ]);
  const routesHere = treasury.toLowerCase() === vault.toLowerCase();
  const bound = vaultSite.toLowerCase() === site.toLowerCase();
  return { routesHere, pinned, bound, escrowed: routesHere && pinned && bound };
}

/**
 * The factory's current policy — what the NEXT board will be bound with. A vault already bound
 * carries its own copy (`readVault`), and the two can honestly differ.
 */
export async function readEscrowPolicy(client: PublicClient, escrowFactory: Address): Promise<EscrowParams> {
  const [windowSecs, claimDelaySecs, minTransitionSecs, minBooking] = (await client.readContract({
    address: escrowFactory,
    abi: ESCROW_FACTORY_ABI,
    functionName: 'params',
    args: [],
  })) as readonly [bigint, bigint, bigint, bigint];
  return { windowSecs, claimDelaySecs, minTransitionSecs, minBooking };
}

/** The key the registry currently names, or `null` when it names nobody (fail-open). */
export async function readAttestor(client: PublicClient, registry: Address): Promise<Address | null> {
  const key = (await client.readContract({ address: registry, abi: ATTESTOR_ABI, functionName: 'attestor', args: [] })) as Address;
  return key.toLowerCase() === ZERO_ADDRESS ? null : key;
}
