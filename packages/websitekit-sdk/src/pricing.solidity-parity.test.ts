/**
 * The cross-language parity harness — spec §7.8, and the stage the build order puts second for a
 * reason: everything after it assumes the client and the chain agree on a number.
 *
 * Spawns `forge script script/GenPriceVectors.s.sol` in `packages/websitekit-contracts`, which imports
 * the exact `Pricing.sol` library `SlotSite` is built from, and asserts the TypeScript twin
 * reproduces every row byte-identically.
 *
 * **What this harness does that v1's did not, and why.** v1 sweeps one hardcoded config
 * because it is one site. §7.8's named failure mode for the framework is that the existing
 * fixed-config vectors keep passing while the config space goes unswept, so the config is a swept
 * dimension here. Two further extensions fall out of that:
 *
 *   - **The split is compared, not just the price.** The payout/protocol/site split is the part
 *     keyed to `effectiveFloor`, and a twin that got the claim-vs-take branch backwards would still
 *     pass a price-only comparison on every row.
 *   - **Overflow rows are asserted, not skipped.** v1 skips rows where checked arithmetic
 *     reverts. That leaves the one place the two languages genuinely differ — `BigInt` is
 *     arbitrary-precision, `uint256` is not — completely untested. Here the generator records those
 *     rows and the twin must throw at the same point.
 *
 * File-based handoff, not stdout: forge script's stdout mixes compiler status, a traces section and
 * gas lines around any `console2.log` output, and is not reliably line-parseable.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { computeTakePrice, computeSplit, PricingOverflowError } from './pricing';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractsDir = path.resolve(__dirname, '../../websitekit-contracts');
const outFile = path.join(contractsDir, 'out', 'price-vectors.jsonl');

// Delete any stale output BEFORE spawning. Without this a file left from a prior successful run
// masks a currently-broken generator as a vacuous pass: a compile error or an early revert never
// reaches the generator's own `vm.writeFile(OUT_PATH, "")`, so yesterday's valid-looking grid
// survives untouched and every assertion below passes against it.
fs.rmSync(outFile, { force: true });

const result = spawnSync('forge', ['script', 'script/GenPriceVectors.s.sol'], {
  cwd: contractsDir,
  encoding: 'utf-8',
  maxBuffer: 64 * 1024 * 1024,
});

interface Leg {
  charged: string;
  payout: string;
  protocol: string;
  site: string;
}

interface Row {
  take_bps: number;
  payout_bps: number;
  decay_bps: number;
  max_decay_weeks: number;
  protocol_bps: number;
  base_price: string;
  last_price: string;
  elapsed_weeks: number;
  overflow: boolean;
  price?: string;
  effective_floor?: string;
  claim?: Leg;
  take?: Leg;
}

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

function tsQuote(row: Row) {
  return computeTakePrice(
    big(row.last_price),
    big(row.base_price),
    BigInt(row.elapsed_weeks),
    BigInt(row.decay_bps),
    BigInt(row.take_bps),
    BigInt(row.max_decay_weeks),
  );
}

function describeRow(row: Row): string {
  return `take=${row.take_bps} payout=${row.payout_bps} decay=${row.decay_bps} weeks<=${row.max_decay_weeks} protocol=${row.protocol_bps} base=${row.base_price} last=${row.last_price} elapsed=${row.elapsed_weeks}`;
}

describe('the generator ran and produced a grid worth trusting', () => {
  it('exits clean and writes a non-empty file', () => {
    expect(result.stderr ?? '').not.toMatch(/Compiler run failed/);
    expect(result.status).toBe(0);
    expect(fs.existsSync(outFile)).toBe(true);
  });

  it('emits a wide grid rather than a token one (fail closed)', () => {
    expect(rows.length).toBeGreaterThan(2000);
  });

  // A grid that swept one config would still satisfy every assertion below while proving nothing
  // about the other 19,999 admissible `takeBps` values — which is §7.8's whole warning.
  it('actually sweeps the config dimension', () => {
    const configs = new Set(
      rows.map((r) => `${r.take_bps}/${r.payout_bps}/${r.decay_bps}/${r.max_decay_weeks}/${r.protocol_bps}`),
    );
    expect(configs.size).toBeGreaterThanOrEqual(12);

    // Both ends of each clamp must appear, or the boundaries are untested.
    expect(rows.some((r) => r.take_bps === 30_000)).toBe(true);
    expect(rows.some((r) => r.payout_bps === 10_000)).toBe(true);
    expect(rows.some((r) => r.decay_bps === 10_000)).toBe(true);
    expect(rows.some((r) => r.decay_bps === 1)).toBe(true);
    expect(rows.some((r) => r.max_decay_weeks === 0)).toBe(true);
    expect(rows.some((r) => r.max_decay_weeks === 52)).toBe(true);
    expect(rows.some((r) => r.protocol_bps === 0)).toBe(true);
  });

  // Both classes have to be present, or one of the two comparison paths below is silently vacuous.
  it('contains both computable and overflowing rows', () => {
    const overflow = rows.filter((r) => r.overflow).length;
    expect(overflow).toBeGreaterThan(0);
    expect(rows.length - overflow).toBeGreaterThan(1000);
  });
});

describe('the TypeScript twin matches Solidity byte-for-byte', () => {
  it('agrees on take price and effective floor for every computable row', () => {
    const computable = rows.filter((r) => !r.overflow);
    expect(computable.length).toBeGreaterThan(0);

    for (const row of computable) {
      const { price, effectiveFloor } = tsQuote(row);
      if (price.toString() !== row.price || effectiveFloor.toString() !== row.effective_floor) {
        throw new Error(
          `price/floor divergence — ${describeRow(row)}\n` +
            `  solidity: price=${row.price} floor=${row.effective_floor}\n` +
            `  typescript: price=${price} floor=${effectiveFloor}`,
        );
      }
    }
  });

  it('agrees on the claim and take splits for every computable row', () => {
    const computable = rows.filter((r) => !r.overflow);

    for (const row of computable) {
      const { price, effectiveFloor } = tsQuote(row);
      for (const [branch, expected] of [
        ['claim', row.claim!],
        ['take', row.take!],
      ] as const) {
        const split = computeSplit(
          effectiveFloor,
          price,
          branch === 'claim',
          BigInt(row.payout_bps),
          BigInt(row.protocol_bps),
        );
        const actual = {
          charged: split.charged.toString(),
          payout: split.payout.toString(),
          protocol: split.protocolCut.toString(),
          site: split.siteCut.toString(),
        };
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(
            `${branch} split divergence — ${describeRow(row)}\n` +
              `  solidity: ${JSON.stringify(expected)}\n` +
              `  typescript: ${JSON.stringify(actual)}`,
          );
        }
      }
    }
  });

  /**
   * The rows v1's harness throws away. `BigInt` has no word size, so without the explicit
   * guards in `pricing.ts` the twin would return a perfectly reasonable-looking number for inputs
   * the chain reverts on — and a UI would quote a price no transaction could ever pay.
   */
  it('throws exactly where Solidity reverts', () => {
    const overflowing = rows.filter((r) => r.overflow);
    expect(overflowing.length).toBeGreaterThan(0);

    for (const row of overflowing) {
      let threw = false;
      try {
        const { price, effectiveFloor } = tsQuote(row);
        // The price may compute while a split overflows; the generator marks both the same way.
        computeSplit(effectiveFloor, price, true, BigInt(row.payout_bps), BigInt(row.protocol_bps));
        computeSplit(effectiveFloor, price, false, BigInt(row.payout_bps), BigInt(row.protocol_bps));
      } catch (error) {
        expect(error, describeRow(row)).toBeInstanceOf(PricingOverflowError);
        threw = true;
      }
      if (!threw) {
        throw new Error(`twin returned a value where Solidity reverted — ${describeRow(row)}`);
      }
    }
  });
});

describe('standing source guards', () => {
  const pricingSol = fs.readFileSync(path.join(contractsDir, 'src', 'Pricing.sol'), 'utf-8');

  it('Pricing.sol has no unchecked block', () => {
    // Match the block-opening token, not the bare word — a comment mentioning `unchecked` must not
    // trip this.
    expect(pricingSol).not.toMatch(/unchecked\s*\{/);
  });

  /**
   * The decay loop is the single most tempting thing in this codebase to "simplify", and doing so
   * breaks parity silently: truncating division once per iteration means the closed form is a
   * different number, and nothing fails loudly at the call site.
   */
  it('Pricing.sol still decays iteratively', () => {
    expect(pricingSol).toMatch(/for \(uint256 i = 0; i < clampedWeeks; i\+\+\)/);
    expect(pricingSol).toMatch(/decayed = \(decayed \* decayBps\) \/ BPS_DENOMINATOR;/);
  });

  /**
   * `Pricing` is the only place bps arithmetic that touches money is allowed to live. A reintroduced
   * `_bpsOf` in `SlotSite` would be a second implementation of the same truncation, outside
   * everything this harness sweeps.
   */
  it('SlotSite.sol does not reimplement bps arithmetic', () => {
    const slotSite = fs.readFileSync(path.join(contractsDir, 'src', 'SlotSite.sol'), 'utf-8');
    const body = slotSite.replace(/\/\/\/.*$/gm, '').replace(/\/\/.*$/gm, '');
    expect(body).not.toMatch(/function _bpsOf/);
  });
});
