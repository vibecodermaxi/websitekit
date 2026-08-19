/**
 * Slot identity — spec §2, and the one decision everything else falls out of.
 *
 *     tokenId = uint256(keccak256(bytes("hero.headline")))
 *
 * The hashing happens HERE, client-side. The contract only ever sees a `bytes32`, so it never
 * learns the string and therefore never learns the shape of anyone's page — which is what lets one
 * audited implementation serve every site. v1 could not do this: it uses `uint32` ordinals 0–164
 * against a genesis manifest with `GENESIS_SLOT_COUNT = 165` as a bounding constant that freezes
 * the page's structure forever.
 *
 * Two consequences of keys over ordinals, both real:
 *
 *   - **Migration becomes tractable.** A v2 site is a fresh clone where the same string keys are
 *     re-registered and the client flips one address. Ordinals made that impossible.
 *   - **Enumeration is lost.** A mapping keyed by hash has no range, which is why `SlotSite`
 *     carries a `registeredSlots` array. A client does not need it — a site knows its own keys from
 *     config — but indexers and marketplaces do.
 *
 * There is no reverse function and there cannot be one. A site that wants to display its keys reads
 * them from its own config, not from the chain.
 */
import { keccak256, toBytes } from 'viem';
import type { Hex } from 'viem';

/**
 * Slot keys are namespaced dotted paths: `hero.headline`, `nav.link.1`, `footer.cta`.
 *
 * The restriction is deliberately not enforced by the contract, which takes any `bytes32` — it is
 * enforced here so that two developers describing the same region of a page arrive at the same
 * string, and so a key never carries whitespace or casing differences that hash to a different slot
 * while looking identical in a config file. `Hero.Headline` and `hero.headline ` are different
 * slots on-chain and indistinguishable in a screenshot.
 */
const KEY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** Long enough for any real path, short enough that a key is never a payload. */
export const MAX_KEY_LENGTH = 128;

export class InvalidSlotKeyError extends Error {
  constructor(key: string, reason: string) {
    super(`websitekit/keys: "${key}" is not a valid slot key — ${reason}`);
    this.name = 'InvalidSlotKeyError';
  }
}

/**
 * Validates a slot key without hashing it. Exposed because a config loader wants to report every
 * bad key at once rather than throwing on the first.
 */
export function assertValidSlotKey(key: string): void {
  if (key.length === 0) throw new InvalidSlotKeyError(key, 'it is empty');
  if (key.length > MAX_KEY_LENGTH) {
    throw new InvalidSlotKeyError(key, `it is ${key.length} characters, over the ${MAX_KEY_LENGTH} limit`);
  }
  if (!KEY_PATTERN.test(key)) {
    throw new InvalidSlotKeyError(
      key,
      'keys are lowercase alphanumeric segments joined by . _ or - (e.g. "hero.headline", "nav.link.1")',
    );
  }
}

/**
 * `keccak256(utf8(key))` — the `bytes32` the contract stores, and `uint256(…)` of it is the
 * ERC-721 token id.
 */
export function slotKey(key: string): Hex {
  assertValidSlotKey(key);
  return keccak256(toBytes(key));
}

/** The ERC-721 token id for a slot, for wallet and marketplace links. */
export function slotTokenId(key: string): bigint {
  return BigInt(slotKey(key));
}

/**
 * Hashes many keys and reports ALL failures together.
 *
 * A site registers its slots in one transaction, so a config with three bad keys should produce one
 * error listing three, not three rounds of fix-and-retry against a chain.
 */
export function slotKeys(keys: readonly string[]): Hex[] {
  const problems: string[] = [];
  for (const key of keys) {
    try {
      assertValidSlotKey(key);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  if (problems.length > 0) {
    throw new InvalidSlotKeyError(`${problems.length} keys`, `\n  ${problems.join('\n  ')}`);
  }

  // A duplicate key is a duplicate SLOT, and `registerSlots` reverts `SlotAlreadyRegistered` on the
  // second one — after the first has already been written. Catching it here turns a half-applied
  // transaction into a config error.
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) throw new InvalidSlotKeyError(key, 'it appears more than once');
    seen.add(key);
  }

  return keys.map((key) => slotKey(key));
}
