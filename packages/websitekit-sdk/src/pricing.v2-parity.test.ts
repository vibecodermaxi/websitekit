/**
 * The v2 half of the cross-language parity harness — spec §7, test layer 1.
 *
 * Spawns `forge script script/GenV2Vectors.s.sol` in `packages/websitekit-contracts`, which imports
 * the exact `Pricing.sol` and `RentalsLib.sol` a deployed site is built from, and asserts the
 * TypeScript twins reproduce every row byte-identically.
 *
 * **Why this is a separate file and a separate grid from `pricing.solidity-parity.test.ts`.**
 * `docs/STATE.md` records that v2 leaves the existing take-price vectors unaffected *by
 * construction* — the ask enters as the reversion base rather than as a multiplier (§3.1). Keeping
 * `out/price-vectors.jsonl` literally untouched is what makes that claim checkable rather than
 * merely asserted: if that grid ever changes, something about v1 pricing moved and the claim was
 * wrong. The two families also share no input dimensions, so one row schema would be mostly nulls.
 *
 * Three families, and the reason each is here rather than covered by a unit test:
 *
 *   - **ask** — the reversion base, the ceiling, and *the quote that composes them*. §3.1's claim is
 *     about the composition, so a twin that resolved the base correctly and then applied it in the
 *     wrong position would pass a piecewise comparison on every row.
 *   - **rent** — linear accrual and the unaccrued remainder a buyer inherits (§2.4.2). The client
 *     side of this is what decides whether an encumbered position reads as buyable at all.
 *   - **fee** — the gross cost of a term and the protocol/site/escrow split (§2.5).
 *
 * Overflow rows are asserted, not skipped. `BigInt` is arbitrary-precision and `uint256` is not, so
 * that boundary is the one place the two languages genuinely differ — and it is exactly where a UI
 * would otherwise quote a number no transaction could ever pay.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  computeTakePrice,
  resolveReversionBase,
  askCeiling,
  PricingOverflowError,
} from './pricing';
import { accrual, rentCost, rentSplit } from './rentals';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractsDir = path.resolve(__dirname, '../../websitekit-contracts');
const outFile = path.join(contractsDir, 'out', 'v2-vectors.jsonl');

// Delete any stale output BEFORE spawning. Without this a file left from a prior successful run
// masks a currently-broken generator as a vacuous pass: a compile error or an early revert never
// reaches the generator's own `vm.writeFile(OUT_PATH, "")`, so yesterday's grid survives untouched
// and every assertion below passes against it.
fs.rmSync(outFile, { force: true });

const result = spawnSync('forge', ['script', 'script/GenV2Vectors.s.sol'], {
  cwd: contractsDir,
  encoding: 'utf-8',
  maxBuffer: 64 * 1024 * 1024,
});

interface AskRow {
  kind: 'ask';
  ask_floor: string;
  last_price: string;
  base_price: string;
  max_ask_bps: number;
  overflow: boolean;
  reversion_base?: string;
  ask_ceiling?: string;
  price?: string;
  effective_floor?: string;
}

interface RentRow {
  kind: 'rent';
  prepaid: string;
  // `uint64`-typed, so strings: `JSON.parse` float-rounds a bare number past 2^53, and these run to
  // 1.8e19. That is not a hypothetical — it is how the first run of this file "found" a divergence
  // that was really the harness feeding the twin a rounded input.
  start: string;
  expiry: string;
  now_ts: string;
  overflow: boolean;
  accrued?: string;
  unaccrued?: string;
}

interface FeeRow {
  kind: 'fee';
  rate_per_day: string;
  duration_secs: string;
  protocol_rent_bps: number;
  fee_bps: number;
  overflow: boolean;
  cost?: string;
  protocol_cut?: string;
  site_cut?: string;
  net?: string;
}

type Row = AskRow | RentRow | FeeRow;

const rows: Row[] =
  result.status === 0 && fs.existsSync(outFile)
    ? fs
        .readFileSync(outFile, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Row)
    : [];

/** Every numeric field parses through `BigInt`, never the float-coercing `Number`. */
const big = (v: string): bigint => BigInt(v);

const asks = rows.filter((r): r is AskRow => r.kind === 'ask');
const rents = rows.filter((r): r is RentRow => r.kind === 'rent');
const fees = rows.filter((r): r is FeeRow => r.kind === 'fee');

/**
 * The pricing config the ask grid holds fixed — the Standard profile, matching
 * `_emitAskRow`. The config dimension is swept exhaustively by the v1 grid; sweeping it again here
 * would multiply the row count to restate a result that grid already owns.
 */
const ASK_GRID_ELAPSED_WEEKS = 3n;
const ASK_GRID_DECAY_BPS = 9_700n;
const ASK_GRID_TAKE_BPS = 14_000n;
const ASK_GRID_MAX_DECAY_WEEKS = 52n;

function describeAsk(r: AskRow): string {
  return `ask=${r.ask_floor} last=${r.last_price} base=${r.base_price} maxAskBps=${r.max_ask_bps}`;
}
function describeRent(r: RentRow): string {
  return `prepaid=${r.prepaid} start=${r.start} expiry=${r.expiry} now=${r.now_ts}`;
}
function describeFee(r: FeeRow): string {
  return `rate=${r.rate_per_day} duration=${r.duration_secs} protocol=${r.protocol_rent_bps} fee=${r.fee_bps}`;
}

describe('the v2 generator ran and produced a grid worth trusting', () => {
  it('exits clean and writes a non-empty file', () => {
    expect(result.stderr ?? '').not.toMatch(/Compiler run failed/);
    expect(result.status).toBe(0);
    expect(fs.existsSync(outFile)).toBe(true);
  });

  it('emits all three families, none of them token-sized (fail closed)', () => {
    expect(asks.length).toBeGreaterThan(100);
    expect(rents.length).toBeGreaterThan(100);
    expect(fees.length).toBeGreaterThan(50);
  });

  // Each of these is a boundary the corresponding guard exists for. If a grid stopped reaching one,
  // the assertion that depends on it would go quietly vacuous rather than fail.
  it('reaches the boundaries the guards are written for', () => {
    // The `askFloor == 0` fall-through, and the down-only `maxAskBps` clamp.
    expect(asks.some((r) => r.ask_floor === '0')).toBe(true);
    expect(asks.some((r) => r.max_ask_bps === 10_000)).toBe(true);
    // `expiry == 0` is "no tenancy", not a term that ended at the epoch.
    expect(rents.some((r) => r.expiry === '0')).toBe(true);
    // Both sides of the expiry clamp, which is what makes a lapsed term earn exactly `prepaid`.
    expect(rents.some((r) => r.expiry !== '0' && big(r.now_ts) < big(r.expiry))).toBe(true);
    expect(rents.some((r) => r.expiry !== '0' && big(r.now_ts) > big(r.expiry))).toBe(true);
    // Both ends of the `[1_000, 4_000]` band on the total rent fee, and both degenerate splits.
    expect(fees.some((r) => r.protocol_rent_bps + r.fee_bps === 1_000)).toBe(true);
    expect(fees.some((r) => r.protocol_rent_bps + r.fee_bps === 4_000)).toBe(true);
    expect(fees.some((r) => r.fee_bps === 0)).toBe(true);
    expect(fees.some((r) => r.protocol_rent_bps === 0)).toBe(true);
    // A term whose gross cost truncates to zero — admissible, and the dust corner depends on it.
    expect(fees.some((r) => r.cost === '0')).toBe(true);
  });

  // Both classes have to be present in every family, or one comparison path is silently vacuous.
  it('contains both computable and overflowing rows in each family', () => {
    for (const [name, family] of [
      ['ask', asks],
      ['rent', rents],
      ['fee', fees],
    ] as const) {
      expect(family.some((r) => r.overflow), `${name} has no overflow rows`).toBe(true);
      expect(family.some((r) => !r.overflow), `${name} has no computable rows`).toBe(true);
    }
  });
});

describe('the ask twin matches Solidity byte-for-byte', () => {
  it('agrees on the reversion base and the ceiling for every computable row', () => {
    const computable = asks.filter((r) => !r.overflow);
    expect(computable.length).toBeGreaterThan(0);

    for (const row of computable) {
      const base = resolveReversionBase(big(row.ask_floor), big(row.last_price));
      const ceiling = askCeiling(big(row.last_price), big(row.base_price), BigInt(row.max_ask_bps));
      if (base.toString() !== row.reversion_base || ceiling.toString() !== row.ask_ceiling) {
        throw new Error(
          `ask divergence — ${describeAsk(row)}\n` +
            `  solidity: base=${row.reversion_base} ceiling=${row.ask_ceiling}\n` +
            `  typescript: base=${base} ceiling=${ceiling}`,
        );
      }
    }
  });

  /**
   * The composition, which is the claim §3.1 actually makes. Resolving the base correctly and then
   * feeding it to the wrong parameter of `computeTakePrice` reproduces every value checked above.
   */
  it('agrees on the quote priced from the resolved base', () => {
    for (const row of asks.filter((r) => !r.overflow)) {
      const { price, effectiveFloor } = computeTakePrice(
        resolveReversionBase(big(row.ask_floor), big(row.last_price)),
        big(row.base_price),
        ASK_GRID_ELAPSED_WEEKS,
        ASK_GRID_DECAY_BPS,
        ASK_GRID_TAKE_BPS,
        ASK_GRID_MAX_DECAY_WEEKS,
      );
      if (price.toString() !== row.price || effectiveFloor.toString() !== row.effective_floor) {
        throw new Error(
          `ask-quote divergence — ${describeAsk(row)}\n` +
            `  solidity: price=${row.price} floor=${row.effective_floor}\n` +
            `  typescript: price=${price} floor=${effectiveFloor}`,
        );
      }
    }
  });

  /**
   * §3.1 restated directly against the grid rather than against the twin's own source. Every row
   * with no ask posted must price identically to the same row with the ask dimension removed
   * entirely — that equality is what keeps the whole pre-v2 vector grid valid evidence.
   */
  it('leaves pricing untouched when no ask is posted', () => {
    const unset = asks.filter((r) => !r.overflow && r.ask_floor === '0');
    expect(unset.length).toBeGreaterThan(0);

    for (const row of unset) {
      const withoutAsk = computeTakePrice(
        big(row.last_price),
        big(row.base_price),
        ASK_GRID_ELAPSED_WEEKS,
        ASK_GRID_DECAY_BPS,
        ASK_GRID_TAKE_BPS,
        ASK_GRID_MAX_DECAY_WEEKS,
      );
      expect(withoutAsk.price.toString(), describeAsk(row)).toBe(row.price);
      expect(withoutAsk.effectiveFloor.toString(), describeAsk(row)).toBe(row.effective_floor);
    }
  });

  it('throws exactly where Solidity reverts', () => {
    const overflowing = asks.filter((r) => r.overflow);
    expect(overflowing.length).toBeGreaterThan(0);

    for (const row of overflowing) {
      let threw = false;
      try {
        askCeiling(big(row.last_price), big(row.base_price), BigInt(row.max_ask_bps));
        computeTakePrice(
          resolveReversionBase(big(row.ask_floor), big(row.last_price)),
          big(row.base_price),
          ASK_GRID_ELAPSED_WEEKS,
          ASK_GRID_DECAY_BPS,
          ASK_GRID_TAKE_BPS,
          ASK_GRID_MAX_DECAY_WEEKS,
        );
      } catch (error) {
        expect(error, describeAsk(row)).toBeInstanceOf(PricingOverflowError);
        threw = true;
      }
      if (!threw) throw new Error(`twin returned a value where Solidity reverted — ${describeAsk(row)}`);
    }
  });
});

describe('the rent twin matches Solidity byte-for-byte', () => {
  it('agrees on accrued and unaccrued for every computable row', () => {
    const computable = rents.filter((r) => !r.overflow);
    expect(computable.length).toBeGreaterThan(0);

    for (const row of computable) {
      const got = accrual(big(row.prepaid), big(row.start), big(row.expiry), big(row.now_ts));
      if (got.accrued.toString() !== row.accrued || got.unaccrued.toString() !== row.unaccrued) {
        throw new Error(
          `accrual divergence — ${describeRent(row)}\n` +
            `  solidity: accrued=${row.accrued} unaccrued=${row.unaccrued}\n` +
            `  typescript: accrued=${got.accrued} unaccrued=${got.unaccrued}`,
        );
      }
    }
  });

  /**
   * The property `endRental` depends on: a lapsed term has earned exactly its escrow, so `finish`
   * drains it to zero and leaves nothing stranded behind the fields it deletes. Asserted against
   * Solidity's own output, so it is a statement about the chain rather than about the twin.
   */
  it('has a lapsed term earning exactly its escrow, in both languages', () => {
    const lapsed = rents.filter((r) => !r.overflow && r.expiry !== '0' && big(r.now_ts) >= big(r.expiry));
    expect(lapsed.length).toBeGreaterThan(0);

    for (const row of lapsed) {
      expect(row.accrued, describeRent(row)).toBe(row.prepaid);
      expect(row.unaccrued, describeRent(row)).toBe('0');
      const got = accrual(big(row.prepaid), big(row.start), big(row.expiry), big(row.now_ts));
      expect(got.accrued, describeRent(row)).toBe(big(row.prepaid));
    }
  });

  it('throws exactly where Solidity reverts', () => {
    const overflowing = rents.filter((r) => r.overflow);
    expect(overflowing.length).toBeGreaterThan(0);

    for (const row of overflowing) {
      let threw = false;
      try {
        accrual(big(row.prepaid), big(row.start), big(row.expiry), big(row.now_ts));
      } catch (error) {
        expect(error, describeRent(row)).toBeInstanceOf(PricingOverflowError);
        threw = true;
      }
      if (!threw) throw new Error(`twin returned a value where Solidity reverted — ${describeRent(row)}`);
    }
  });
});

describe('the rent fee twin matches Solidity byte-for-byte', () => {
  it('agrees on cost and the three-way split for every computable row', () => {
    const computable = fees.filter((r) => !r.overflow);
    expect(computable.length).toBeGreaterThan(0);

    for (const row of computable) {
      const cost = rentCost(big(row.rate_per_day), big(row.duration_secs));
      const split = rentSplit(cost, BigInt(row.protocol_rent_bps), BigInt(row.fee_bps));
      const actual = {
        cost: cost.toString(),
        protocol_cut: split.protocolCut.toString(),
        site_cut: split.siteCut.toString(),
        net: split.net.toString(),
      };
      const expected = {
        cost: row.cost,
        protocol_cut: row.protocol_cut,
        site_cut: row.site_cut,
        net: row.net,
      };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          `rent split divergence — ${describeFee(row)}\n` +
            `  solidity: ${JSON.stringify(expected)}\n` +
            `  typescript: ${JSON.stringify(actual)}`,
        );
      }
    }
  });

  /**
   * The three legs sum to the gross cost exactly, in Solidity's own numbers. This is what lets the
   * contract's `totalEscrowedRent` reconcile against the sum of its live tenancies — the invariant
   * suite's `_checkEscrowMatchesTenancies` is the same claim one level up, and it would be
   * unprovable if `net` were its own bps multiply rather than a subtraction.
   */
  it('splits the gross cost with nothing left over', () => {
    for (const row of fees.filter((r) => !r.overflow)) {
      const sum = big(row.protocol_cut!) + big(row.site_cut!) + big(row.net!);
      expect(sum.toString(), describeFee(row)).toBe(row.cost);
    }
  });

  it('throws exactly where Solidity reverts', () => {
    const overflowing = fees.filter((r) => r.overflow);
    expect(overflowing.length).toBeGreaterThan(0);

    for (const row of overflowing) {
      let threw = false;
      try {
        const cost = rentCost(big(row.rate_per_day), big(row.duration_secs));
        rentSplit(cost, BigInt(row.protocol_rent_bps), BigInt(row.fee_bps));
      } catch (error) {
        expect(error, describeFee(row)).toBeInstanceOf(PricingOverflowError);
        threw = true;
      }
      if (!threw) throw new Error(`twin returned a value where Solidity reverted — ${describeFee(row)}`);
    }
  });
});

describe('standing source guards', () => {
  const rentalsSol = fs.readFileSync(path.join(contractsDir, 'src', 'RentalsLib.sol'), 'utf-8');
  const siteSol = fs.readFileSync(path.join(contractsDir, 'src', 'SlotSite.sol'), 'utf-8');

  it('RentalsLib.sol has no unchecked block', () => {
    // Match the block-opening token, not the bare word — a comment mentioning `unchecked` must not
    // trip this.
    expect(rentalsSol).not.toMatch(/unchecked\s*\{/);
  });

  /**
   * `net` is a subtraction, never its own bps multiply. A third percentage would not sum back to
   * `cost`, and the escrow ledger would stop reconciling — silently, and only for costs whose two
   * cuts happen to truncate.
   */
  it('rentSplit still derives net by subtraction', () => {
    expect(rentalsSol).toMatch(/net = cost - protocolCut - siteCut;/);
  });

  /**
   * The two families of bps arithmetic that touch money live in `Pricing` and `RentalsLib` and
   * nowhere else. A reintroduced inline `* bps / BPS_DENOMINATOR` in the site would be a second
   * implementation of the same truncation, outside everything this harness sweeps — which is exactly
   * how `_bookRentPayment` looked before the split was extracted.
   */
  it('SlotSite.sol does not reimplement the rent split', () => {
    const body = siteSol.replace(/\/\/\/.*$/gm, '').replace(/\/\/.*$/gm, '');
    expect(body).toMatch(/RentalsLib\.rentSplit\(/);
    expect(body).not.toMatch(/cost \* protocolRentBps/);
    expect(body).not.toMatch(/cost \* feeBps/);
  });

  /**
   * The ask is a BASE, not a multiplier (§3.1). If this ever becomes `askFloor * something`, every
   * pre-v2 take-price vector stops being evidence about this code and the other grid has to be
   * regenerated from scratch.
   */
  it('the reversion base is still a selection, not a multiplier', () => {
    const pricingSol = fs.readFileSync(path.join(contractsDir, 'src', 'Pricing.sol'), 'utf-8');
    expect(pricingSol).toMatch(/return askFloor != 0 \? askFloor : lastPrice;/);
  });
});
