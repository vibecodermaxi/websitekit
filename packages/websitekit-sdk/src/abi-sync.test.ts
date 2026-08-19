/**
 * Fails when a committed `src/abi/*.json` no longer matches what `forge build` produces.
 *
 * The failure this exists to catch is silent and expensive: change a signature in Solidity, forget
 * to re-export, and every builder in `writes.ts` keeps compiling and keeps encoding calldata
 * against the OLD selector. Nothing type-checks wrong. The call just reverts on chain — or worse,
 * hits a different function that happens to share a selector. TypeScript cannot see this; only a
 * byte comparison against the artifact can.
 *
 * Skips (rather than fails) when `packages/websitekit-contracts/out` is absent, because it is
 * gitignored: a fresh clone that has not run `forge build` has nothing to compare against, and a
 * hard failure there would just teach people to ignore the suite.
 */
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractsOut = path.resolve(__dirname, '../../websitekit-contracts/out');

const TARGETS: Array<[solFile: string, contractName: string, committed: string]> = [
  ['SlotSite.sol', 'SlotSite', 'SlotSite.json'],
  ['SlotFactory.sol', 'SlotFactory', 'SlotFactory.json'],
  ['SlotReader.sol', 'SlotReader', 'SlotReader.json'],
  ['RentalsLib.sol', 'RentalsLib', 'RentalsLib.json'],
];

describe('committed ABIs match the forge artifacts', () => {
  for (const [solFile, contractName, committed] of TARGETS) {
    const artifactPath = path.join(contractsOut, solFile, `${contractName}.json`);
    const hasArtifact = fs.existsSync(artifactPath);

    it.skipIf(!hasArtifact)(`${contractName} is in sync (run \`pnpm sync:abi\` if not)`, () => {
      const artifactAbi = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')).abi;
      const committedAbi = JSON.parse(fs.readFileSync(path.join(__dirname, 'abi', committed), 'utf-8'));
      expect(committedAbi).toEqual(artifactAbi);
    });
  }
});

/**
 * The rental events are declared in `RentalsLib`, not in the site — the library is delegatecalled,
 * so they are emitted at the SITE's address while the site's own ABI cannot decode them. An indexer
 * therefore needs both, which is what `SITE_EVENTS_ABI` merges.
 *
 * This pins the fact rather than the workaround. If a future refactor moved these declarations into
 * the site, the merge would start double-counting and nothing else would notice.
 */
describe('the rental events live in the library, not the site', () => {
  const eventNames = (file: string): string[] =>
    (JSON.parse(fs.readFileSync(path.join(__dirname, 'abi', file), 'utf-8')) as Array<{ type: string; name?: string }>)
      .filter((entry) => entry.type === 'event')
      .map((entry) => entry.name!);

  const RENTAL_EVENTS = ['RentalListed', 'SlotRented', 'RentalExtended', 'RentalEnded', 'UpdateUser'];

  it('declares every rental event in RentalsLib', () => {
    expect(eventNames('RentalsLib.json')).toEqual(expect.arrayContaining(RENTAL_EVENTS));
  });

  it('declares none of them in the site, so the merge cannot double-count', () => {
    const site = eventNames('SlotSite.json');
    for (const name of RENTAL_EVENTS) {
      expect(site, `${name} is now declared in both ABIs`).not.toContain(name);
    }
  });
});
