/**
 * Verifies a deployment on a Blockscout explorer, and reports what actually stuck.
 *
 *   set -a && . .env && set +a
 *   pnpm --filter @websitekit/sdk exec tsx scripts/verify-deployment.ts
 *
 * **This exists because the obvious invocation is wrong in two different ways**, both of which cost
 * real time on the first deployment and neither of which announces itself. The prose is in
 * `docs/STATE.md`; this is the executable version, so the next chain is one command rather than six
 * attempts.
 *
 * ---
 *
 * **Trap 1 — `forge verify-contract --libraries` can only ever produce a PARTIAL match.**
 *
 * That flag puts the library address into the standard-json `settings.libraries`. Blockscout then
 * recompiles with libraries as a compiler SETTING — and compiler settings are part of the metadata
 * JSON, so the metadata hash changes and the bytecode can never fully match what was deployed.
 * Measured: the same sources end in metadata hash `ce016bf1…` compiled with the library as a
 * setting, and `9ec5b95e…` compiled with the placeholder — and `9ec5b95e…` is what is on chain,
 * because `deploy-protocol.ts` links post-compile from solc's byte offsets.
 *
 * The fix is to make Blockscout compile the way the deployed bytecode was compiled: submit
 * standard-json with `settings.libraries = {}` and pass the library through the v1 API's
 * `libraryname1` / `libraryaddress1` fields, which are a POST-COMPILE link rather than a setting.
 * `forge` has no flag for this, hence the hand-rolled request below.
 *
 * Known trade: verified this way, Blockscout's `external_libraries` comes back empty, so the
 * explorer stops *displaying* the link. The authoritative record is on-chain anyway — the factory
 * stores `rentalsLib` and `rentalsLibCodehash` — and a full metadata match is the stronger claim.
 *
 * **Trap 2 — `forge` will tell you the factory is already verified. It is not.**
 *
 * Blockscout's proxy heuristic sees `SlotFactory` holding the implementation's address in an
 * immutable, classifies it `proxy_type: basic_implementation`, and serves SlotSite's source at the
 * factory's address. `getsourcecode` therefore returns a verified contract, `forge` believes it and
 * skips, and the explorer shows 169 ABI entries for a contract that has 11. `--skip-is-verified-check`
 * forces it through.
 *
 * The general lesson, and the reason the final report below reads `/api/v2/addresses/<addr>` rather
 * than `getsourcecode`: that endpoint reports the address's OWN state, while `getsourcecode` follows
 * proxy resolution. A false PASS is quieter than a false fail and survives much longer.
 *
 * ---
 *
 * Cloudflare rejects a bare API POST with `error code: 1010`, so the request carries a browser
 * `User-Agent`. Nothing else about it is unusual.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, parseAbiParameters } from 'viem';

import { deploymentFor } from '../src/index';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractsDir = path.resolve(__dirname, '../../websitekit-contracts');

const CHAIN_ID = 46630;
const COMPILER = '0.8.30+commit.73712a01';
const OPTIMIZER_RUNS = '200';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const deployment = deploymentFor(CHAIN_ID);
if (deployment.version !== 2 || !deployment.reader || !deployment.rentalsLib) {
  throw new Error(`chain ${CHAIN_ID} has no complete v2 deployment recorded in addresses.ts`);
}
const EXPLORER = deployment.explorer;
const API = `${EXPLORER}/api`;

const PROTOCOL_TREASURY = (process.env.PROTOCOL_TREASURY ?? '') as `0x${string}`;
if (!/^0x[0-9a-fA-F]{40}$/.test(PROTOCOL_TREASURY)) {
  throw new Error('PROTOCOL_TREASURY is not set — it is part of the implementation constructor args');
}

/** Everything the implementation's constructor was given, in order. */
const siteArgs = encodeAbiParameters(parseAbiParameters('uint256, uint256, address'), [
  500n,
  500n,
  PROTOCOL_TREASURY,
]);
const factoryArgs = encodeAbiParameters(parseAbiParameters('address, address'), [
  deployment.implementation,
  deployment.rentalsLib,
]);

/** The ordinary path: no libraries, so `forge` gets a full match on its own. */
function verifyWithForge(address: string, target: string, constructorArgs?: `0x${string}`) {
  const args = [
    'verify-contract',
    '--chain-id', String(CHAIN_ID),
    '--verifier', 'blockscout',
    '--verifier-url', API,
    '--compiler-version', COMPILER,
    '--num-of-optimizations', OPTIMIZER_RUNS,
    // Always on: Blockscout's proxy heuristic makes the "already verified" check unreliable for any
    // contract that stores an address in an immutable. See Trap 2.
    '--skip-is-verified-check',
    '--watch',
    ...(constructorArgs ? ['--constructor-args', constructorArgs] : []),
    address,
    target,
  ];
  const out = spawnSync('forge', args, { cwd: contractsDir, encoding: 'utf-8' });
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  console.log(`  ${/successfully verified|Pass - Verified/.test(text) ? 'verified' : 'SEE OUTPUT'}`);
  if (!/successfully verified|Pass - Verified/.test(text)) console.log(text.split('\n').slice(-6).join('\n'));
}

/** The library-linked path: settings.libraries must be EMPTY, link supplied separately. See Trap 1. */
async function verifyLibraryLinked(address: string, target: string, constructorArgs: `0x${string}`) {
  const sj = spawnSync('forge', ['verify-contract', '--show-standard-json-input', address, target], {
    cwd: contractsDir,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  }).stdout;

  const parsed = JSON.parse(sj);
  if (Object.keys(parsed.settings?.libraries ?? {}).length > 0) {
    throw new Error('standard-json carries settings.libraries — that guarantees a partial match');
  }

  const body = new URLSearchParams({
    module: 'contract',
    action: 'verifysourcecode',
    codeformat: 'solidity-standard-json-input',
    contractaddress: address,
    contractname: target,
    compilerversion: `v${COMPILER}`,
    sourceCode: sj,
    constructorArguements: constructorArgs.slice(2),
    libraryname1: 'RentalsLib',
    libraryaddress1: deployment.rentalsLib!,
  });

  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': BROWSER_UA },
    body,
  });
  const json = (await res.json()) as { result?: string; status?: string };
  const guid = json.result;
  if (json.status !== '1' || !guid) throw new Error(`submission rejected: ${JSON.stringify(json)}`);

  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 8_000));
    const check = await fetch(`${API}?module=contract&action=checkverifystatus&guid=${guid}`, {
      headers: { 'User-Agent': BROWSER_UA },
    });
    const status = (await check.json()) as { result?: string };
    if (status.result && !/pending/i.test(status.result)) {
      console.log(`  ${status.result}`);
      return;
    }
  }
  console.log('  still pending after 96s — check the explorer');
}

/** Reads the address's OWN verification state, not whatever a proxy resolves to. See Trap 2. */
async function report(label: string, address: string) {
  const res = await fetch(`${EXPLORER}/api/v2/smart-contracts/${address}`, {
    headers: { 'User-Agent': BROWSER_UA },
  });
  let full: unknown = null;
  let abi = 0;
  try {
    const d = (await res.json()) as { is_fully_verified?: boolean; abi?: unknown[] };
    full = d.is_fully_verified ?? null;
    abi = d.abi?.length ?? 0;
  } catch {
    /* unverified addresses return no contract record */
  }
  console.log(`  ${label.padEnd(12)} fully_verified=${String(full).padEnd(5)} abi=${abi}`);
}

console.log(`\nverifying against ${EXPLORER}\n`);

console.log('RentalsLib');
verifyWithForge(deployment.rentalsLib!, 'src/RentalsLib.sol:RentalsLib');

console.log('SlotSite (library-linked — hand-rolled, see Trap 1)');
await verifyLibraryLinked(deployment.implementation, 'src/SlotSite.sol:SlotSite', siteArgs);

console.log('SlotFactory');
verifyWithForge(deployment.factory, 'src/SlotFactory.sol:SlotFactory', factoryArgs);

console.log('SlotReader');
verifyWithForge(deployment.reader!, 'src/SlotReader.sol:SlotReader');

console.log('\nfinal state (read from /api/v2, which does not follow proxy resolution):');
await report('RentalsLib', deployment.rentalsLib!);
await report('SlotSite', deployment.implementation);
await report('SlotFactory', deployment.factory);
await report('SlotReader', deployment.reader!);

console.log(`
All four should read fully_verified=true. A clone of the implementation then resolves
automatically — it reports proxy_type: eip1167 with the implementation as its target, and
its own \`abi\` is 0, which is how Blockscout models a proxy rather than a failure.
`);
