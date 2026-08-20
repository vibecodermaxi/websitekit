import { type ApiSymbol, groupOf, readSdkSurface } from './api-reference';
import snapshot from './v1-sdk-surface.json';

/**
 * What changed in `@websitekit/sdk` between v1 and v2, computed rather than remembered.
 *
 * **The v1 sources are deleted.** They were the regression net until v2's invariant suite replaced
 * them, and they went with the v1 contracts. So the left-hand side of this diff is a FROZEN
 * SNAPSHOT of v1's public surface — `v1-sdk-surface.json`, generated once from git history at
 * `84c88d3^` and never hand-edited, in the same spirit as the vendored `PricingFrozen.sol` the
 * parity harness compares against. Vendoring is the point: a reference you can edit is not a
 * reference.
 *
 * The right-hand side is read live from the SDK's own types. That asymmetry is deliberate — v1 can
 * never change again, and v2 changes constantly, so anything this page says about v2 has to come
 * from the compiler. A migration page that describes a signature the SDK no longer has is the exact
 * failure that killed `docs/sdk.md`.
 */

interface SnapshotSymbol {
  kind: string;
  signature: string;
}

const V1: Map<string, SnapshotSymbol> = new Map(
  Object.entries((snapshot as { symbols: Record<string, SnapshotSymbol> }).symbols),
);

export interface Change {
  name: string;
  kind: string;
  group: string;
  /** Absent for an addition. */
  before?: string;
  /** Absent for a removal. */
  after?: string;
  /** Why it changed. Hand-written, and checked against the computed diff below. */
  note?: string;
}

/**
 * The reasons, which the compiler cannot supply.
 *
 * Every key here is asserted to still be a real difference — see `assertNotesAreLive`. That is what
 * stops this from becoming the thing it documents: if v2 moves and a note stops applying, the build
 * fails rather than the page quietly lying.
 */
const NOTES: Record<string, string> = {
  readSlots:
    'Reads take a `SiteRef` — `{ site, reader }` — instead of a bare site address. v1 read the board out of the site contract itself; v2 routes every read through `SlotReader`, a separate and deliberately REPLACEABLE deployment, because view logic is where a frozen contract otherwise strands you. Also gained an optional `blockNumber` for pinned reads.',
  readSlot: 'Same `SiteRef` change as `readSlots`.',
  readSiteTerms: 'Same `SiteRef` change, and the terms it returns now carry rent economics and the availability flag.',
  readBuyContext: 'Same `SiteRef` change.',
  SiteEconomics:
    '`decayBps` and `maxDecayWeeks` are now `reversionBps` and `maxReversionWeeks`. Not cosmetic: the price is bounded below by the publisher\'s floor, so it is mean reversion of the takeover price, not loss of value, and "decay" told holders the wrong story about what they own.',
  SiteTerms: 'The same rename, plus rent terms, the settlement token, and per-slot availability.',
  buildBuyFrom:
    '`settlementToken` is now a REQUIRED argument. There is no default on purpose: a native-shaped call against a token-settled site reverts `NativeNotAccepted`, and the identical call is correct on a native site — so a default would be silently right half the time and would fail first on a real stablecoin deployment.',
  BuildCreateSiteOptions:
    'Site creation now takes the settlement token, the rental terms and the floor policy. All frozen or ratcheted at issue.',
  DefineSiteInput:
    '`reader` is required. It is not resolved from the chain id, because the reader is meant to be replaceable and a config that silently picks one for you is a config that breaks when it is replaced.',
  SiteConfig: 'Carries `reader`, a ready-made `ref`, and the settlement decimals the floors were parsed against.',
  SlotDefinitionInput:
    'A floor is a decimal string in the SITE\'S SETTLEMENT CURRENCY, not in ether. `minFloor` derives from the token\'s decimals — 1e14 native, 100 units on a 6-decimal stablecoin — so `parseEther` on a floor is wrong by 1e12 against USDG and silently correct on a native site. Use `parseFloor`.',
  SlotState: 'Gained the rental state, the availability flag, and the net cost of an encumbered position.',
  Deployment: 'Carries `version: 1 | 2`, so an address ledger can no longer be read as the wrong generation.',
  BuildBuyOptions: '`charged` is the quoted price, explicitly NOT `netCost` — netting the inherited rent stream would underpay the call and revert.',
  EXAMPLE_SITES: 'The four reference boards were redeployed as v2 clones. The v1 addresses survive as `EXAMPLE_SITES_V1`, unreadable by this SDK.',
  SiteEconomicsConfig: 'Same reversion rename as `SiteEconomics`, on the input side.',
};

function toChange(name: string, before?: SnapshotSymbol, after?: ApiSymbol): Change {
  return {
    name,
    kind: after?.kind ?? before?.kind ?? 'const',
    group: after ? groupOf(name) : 'Removed',
    before: before?.signature,
    after: after?.signatureFull,
    note: NOTES[name],
  };
}

export interface Migration {
  /** Exports v2 added. */
  added: Change[];
  /** Exports that survived but whose type changed — the ones that break a v1 call site. */
  changed: Change[];
  /** Exports v2 dropped. */
  removed: Change[];
  /** Survived unchanged. */
  unchangedCount: number;
  v1Count: number;
  v2Count: number;
}

let cached: Migration | null = null;

export function readMigration(): Migration {
  if (cached) return cached;

  const v2 = readSdkSurface();
  const added: Change[] = [];
  const changed: Change[] = [];
  const removed: Change[] = [];
  let unchangedCount = 0;

  for (const [name, before] of V1) {
    const after = v2.get(name);
    if (!after) {
      removed.push(toChange(name, before, undefined));
    } else if (after.signatureFull !== before.signature) {
      changed.push(toChange(name, before, after));
    } else {
      unchangedCount += 1;
    }
  }
  for (const [name, after] of v2) {
    if (!V1.has(name)) added.push(toChange(name, undefined, after));
  }

  const byName = (a: Change, b: Change) => a.name.localeCompare(b.name);
  cached = {
    added: added.sort(byName),
    changed: changed.sort(byName),
    removed: removed.sort(byName),
    unchangedCount,
    v1Count: V1.size,
    v2Count: v2.size,
  };

  assertNotesAreLive(cached);
  return cached;
}

/**
 * Fails the build if a hand-written note no longer describes a real difference.
 *
 * Every sentence in `NOTES` is a claim about a diff the compiler computed. If v2 changes such that
 * a noted symbol is no longer added, changed or removed, the note has become fiction — and the
 * whole reason this page is generated is that hand-maintained API prose rots silently.
 */
function assertNotesAreLive(migration: Migration): void {
  const live = new Set(
    [...migration.added, ...migration.changed, ...migration.removed].map((change) => change.name),
  );
  const stale = Object.keys(NOTES).filter((name) => !live.has(name));
  if (stale.length) {
    throw new Error(
      `migration: ${stale.length} note(s) no longer describe a v1→v2 difference: ${stale.join(', ')}. ` +
        `The SDK changed underneath them — update or delete the note in lib/migration.ts.`,
    );
  }
}

/** Additions grouped by the SDK's own section headings, which is how a reader looks for them. */
export function addedByGroup(migration: Migration): { title: string; changes: Change[] }[] {
  const groups = new Map<string, Change[]>();
  for (const change of migration.added) {
    const list = groups.get(change.group) ?? [];
    list.push(change);
    groups.set(change.group, list);
  }
  return [...groups.entries()].map(([title, changes]) => ({ title, changes }));
}
