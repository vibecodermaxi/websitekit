/**
 * A site's configuration — the file a builder actually edits (§0).
 *
 * ```ts
 * // websitekit.config.ts
 * export default defineSite({
 *   address: '0x…',          // the clone returned by createSite(), one tx
 *   chain: base,
 *   slots: {
 *     'hero.headline': { kind: 'text',  floor: '0.002' },
 *     'hero.image':    { kind: 'image', floor: '0.01'  },
 *     'nav.link.1':    { kind: 'link',  floor: '0.005' },
 *   },
 * })
 * ```
 *
 * **`address`, not `siteId`.** §0 calls this field `siteId`, which is vestigial: §2 retires the
 * concept outright — "No `siteId` term: with clones locked, each site is its own contract and its
 * own token namespace." There is no id, only a contract address, and calling it an id invites
 * exactly the shared-registry mental model the clone decision exists to kill.
 *
 * This module is deliberately in the framework-agnostic SDK rather than in `@websitekit/react`. The
 * config is what the CLI reads to deploy, what an indexer reads to enumerate, and what the React
 * provider reads to render; only one of those is a React concern.
 */
import { parseUnits } from 'viem';
import type { Address, Chain } from 'viem';

import { assertValidSlotKey } from './keys';
import { ContentKind } from './content';
import type { SiteRef } from './reads';

/**
 * Decimals a floor string is parsed against when the config does not say otherwise.
 *
 * 18 is the native default and NOT a safe universal one. §11.2: a site settling in 6-decimal USDG
 * parses `'0.01'` as `10_000_000_000_000_000` rather than `10_000` — **wrong by a factor of 1e12**,
 * which is not a rounding error but a floor twelve orders of magnitude above anything anyone will
 * pay, on a contract whose floors then move at most ±20% per day. Set `decimals` on any site that
 * does not settle natively.
 */
export const DEFAULT_SETTLEMENT_DECIMALS = 18;

/**
 * Parses a human decimal amount against a settlement token's decimals.
 *
 * **Never use `parseEther` for a floor.** It hardcodes 18 and is silently correct on a native site,
 * which is exactly what makes it dangerous: the bug does not appear until the first token-settled
 * site, and by then it is baked into a config file nobody re-reads.
 */
export function parseFloor(amount: string, decimals: number = DEFAULT_SETTLEMENT_DECIMALS): bigint {
  return parseUnits(amount, decimals);
}

/**
 * How `@websitekit/react` should render a slot. Purely a CLIENT-side convention — the chain stores an
 * opaque hash and knows nothing about kinds, and a site rendering its own payload structure through
 * `useSlot()` can ignore this entirely.
 */
export type SlotKindName = 'text' | 'link' | 'image' | 'video';

export const CONTENT_KIND_BY_NAME: Record<SlotKindName, number> = {
  text: ContentKind.Text,
  link: ContentKind.Link,
  image: ContentKind.Image,
  video: ContentKind.Video,
};

export interface SlotDefinitionInput {
  kind: SlotKindName;
  /**
   * A decimal string in the site's SETTLEMENT currency — `'0.002'`, not `2000000000000000n`.
   *
   * A string because this is the one number a builder types by hand, and `0.002` in a config file
   * read as a JS float is exactly the class of money bug the rest of this codebase refuses to have.
   * It is converted once, here, against the site's `decimals`.
   */
  floor: string;
}

export interface SlotDefinition {
  key: string;
  kind: SlotKindName;
  contentKind: number;
  floor: bigint;
}

export interface DefineSiteInput {
  /** The clone's address, returned by `createSite()`. */
  address: Address;
  /**
   * The `SlotReader` every read goes through (§11.4).
   *
   * Required rather than resolved from a chain table, because the reader is deliberately
   * REPLACEABLE — pinning one in this package would mean a version bump to adopt a new view, and
   * there is no v2 deployment to resolve one from yet in any case.
   */
  reader: Address;
  chain: Chain;
  slots: Record<string, SlotDefinitionInput>;
  /**
   * Decimals of the site's settlement token, from `readSiteTerms().settlementToken`.
   *
   * **Required for any site that does not settle natively.** Defaults to 18, which is right for
   * native and wrong by 1e12 for 6-decimal USDG — see `DEFAULT_SETTLEMENT_DECIMALS`.
   */
  decimals?: number;
  /**
   * Where verified content bytes are fetched from, given a CID.
   *
   * Defaults to a public IPFS gateway, which is fine for text and is the scaffold's zero-credential
   * default. A site with its own storage passes its own resolver — see §3's three tiers. Whatever
   * this returns, the bytes are hash-checked before they render, so a hostile gateway can cause a
   * blank slot but never a substituted one.
   */
  contentUrl?: (cid: string) => string;
}

export interface SiteConfig {
  address: Address;
  reader: Address;
  /** `{ site, reader }`, ready to hand to any read. */
  ref: SiteRef;
  chain: Chain;
  /** What the floors above were parsed against. Carried so a consumer can format them back. */
  decimals: number;
  /** Insertion-ordered, matching the config file, so a board reads in the order it was written. */
  slots: SlotDefinition[];
  slotsByKey: Record<string, SlotDefinition>;
  keys: string[];
  contentUrl: (cid: string) => string;
}

export const DEFAULT_CONTENT_GATEWAY = (cid: string): string => `https://${cid}.ipfs.w3s.link/`;

export class InvalidSiteConfigError extends Error {
  constructor(message: string) {
    super(`websitekit/config: ${message}`);
    this.name = 'InvalidSiteConfigError';
  }
}

/**
 * Validates a site config and normalizes it into the shape every consumer wants.
 *
 * Everything here fails at import time rather than at render time. A typo'd key or a malformed
 * floor should stop a build, not produce a slot that quietly never resolves on a page nobody
 * checked.
 */
export function defineSite(input: DefineSiteInput): SiteConfig {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.address)) {
    throw new InvalidSiteConfigError(`address "${input.address}" is not a 20-byte hex address`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.reader ?? '')) {
    throw new InvalidSiteConfigError(
      `reader "${input.reader}" is not a 20-byte hex address — every v2 read goes through SlotReader`,
    );
  }
  if (!input.chain?.id) throw new InvalidSiteConfigError('chain is required — import one from viem/chains');

  const keys = Object.keys(input.slots);
  if (keys.length === 0) throw new InvalidSiteConfigError('a site with no slots has nothing to own');

  const decimals = input.decimals ?? DEFAULT_SETTLEMENT_DECIMALS;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new InvalidSiteConfigError(`decimals must be an integer in 0..36, got ${decimals}`);
  }

  const slots = keys.map((key) => {
    assertValidSlotKey(key);
    const definition = input.slots[key]!;

    const contentKind = CONTENT_KIND_BY_NAME[definition.kind];
    if (contentKind === undefined) {
      throw new InvalidSiteConfigError(
        `"${key}" has kind "${definition.kind}" — expected one of ${Object.keys(CONTENT_KIND_BY_NAME).join(', ')}`,
      );
    }

    let floor: bigint;
    try {
      floor = parseFloor(definition.floor, decimals);
    } catch {
      throw new InvalidSiteConfigError(`"${key}" has floor "${definition.floor}", which is not a decimal amount`);
    }
    if (floor <= 0n) {
      throw new InvalidSiteConfigError(`"${key}" has floor "${definition.floor}" — a zero floor is free to claim`);
    }

    return { key, kind: definition.kind, contentKind, floor };
  });

  return {
    address: input.address,
    reader: input.reader,
    ref: { site: input.address, reader: input.reader },
    chain: input.chain,
    decimals,
    slots,
    slotsByKey: Object.fromEntries(slots.map((slot) => [slot.key, slot])),
    keys,
    contentUrl: input.contentUrl ?? DEFAULT_CONTENT_GATEWAY,
  };
}

/** The `{ key: floor }` map `buildCreateSite`/`buildRegisterSlots` take. */
export function slotFloors(config: SiteConfig): Record<string, bigint> {
  return Object.fromEntries(config.slots.map((slot) => [slot.key, slot.floor]));
}
