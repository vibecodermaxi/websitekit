// Copies the ABI out of forge's build artifact into the committed `src/abi/*.json` the SDK imports.
// Run after any contract change: `pnpm --filter @websitekit/sdk sync:abi`.
//
// The SDK cannot import `packages/websitekit-contracts/out/**` directly — that directory is
// gitignored, so a fresh clone (and every CI job and every published build) would have no ABI at
// all. The artifact is therefore the SOURCE and the committed JSON is the ARTEFACT, and
// `abi-sync.test.ts` fails if the two drift apart. That test is the actual guard; this script is
// just the fix for it.
//
// Only the `abi` key is copied. Forge's artifact also carries bytecode, the full solc metadata blob
// and source ids — none of which the SDK uses, all of which churn on every recompile and would turn
// a no-op rebuild into a diff.
//
// **RentalsLib is here because the rental EVENTS are declared in it, not in the site.** The library
// is delegatecalled, so those events are emitted at the SITE's address and an indexer watching a
// site sees them — but the site's own ABI cannot decode them, because the site never declares them.
// Verified against the artifacts: `SlotSite`'s ABI has 24 events and not one of `RentalListed`,
// `SlotRented`, `RentalExtended`, `RentalEnded` or `UpdateUser` is among them. An indexer needs both
// ABIs merged, which is what `SITE_EVENTS_ABI` in `reads.ts` is.
//
// The mapping below is the single place a contract rename has to touch: the committed filenames are
// the SDK's public surface and stay put, whatever the Solidity files are called. That decoupling is
// what made dropping the `V2` suffix a one-line change here rather than an edit to every import.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractsOut = path.resolve(__dirname, '../../websitekit-contracts/out');
const abiDir = path.resolve(__dirname, '../src/abi');

/** [solidity file, contract name, committed filename] */
export const TARGETS = [
  ['SlotSite.sol', 'SlotSite', 'SlotSite.json'],
  ['SlotFactory.sol', 'SlotFactory', 'SlotFactory.json'],
  ['SlotReader.sol', 'SlotReader', 'SlotReader.json'],
  ['RentalsLib.sol', 'RentalsLib', 'RentalsLib.json'],
];

let wrote = 0;
for (const [solFile, contractName, outName] of TARGETS) {
  const artifactPath = path.join(contractsOut, solFile, `${contractName}.json`);
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));
  } catch {
    console.error(`sync-abi: no artifact at ${artifactPath} — run \`forge build\` first`);
    process.exitCode = 1;
    continue;
  }
  const target = path.join(abiDir, outName);
  // Trailing newline so the file is POSIX-clean and diffs stay one-line-per-change.
  writeFileSync(target, `${JSON.stringify(artifact.abi, null, 2)}\n`);
  console.log(`sync-abi: ${contractName} -> src/abi/${outName} (${artifact.abi.length} entries)`);
  wrote += 1;
}

if (wrote === 0) process.exitCode = 1;
