#!/usr/bin/env node
/**
 * Packs every publishable workspace package and asserts that each entry point it declares —
 * `main`, `types`, `bin`, and every condition of `exports` — resolves to a file that is actually
 * INSIDE the resulting tarball.
 *
 * **Why this exists.** `@websitekit/sdk@0.1.0` and `@websitekit/react@0.1.0` shipped to npm with
 * `main` pointing at `./src/index.ts`, which `files` excludes. Both were installable and neither
 * could be imported. The cause: the entry points live on `publishConfig` so the workspace can keep
 * importing `src/` while the registry gets `dist/` — and **that swap is a pnpm feature.** `npm
 * publish` honours only `registry`, `access` and `tag` there, so it uploaded the dev manifest
 * verbatim. npm does not validate that `main` exists; it published a broken package on a version
 * number that can never be reused.
 *
 * The lesson is not "remember to type pnpm". It is that the packed tarball is the only artifact
 * worth checking, because it is the only one a consumer sees. This checks that artifact, so it
 * catches the npm-vs-pnpm slip, a `files` list that forgets `dist`, and a missing build alike.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['packages/websitekit-sdk', 'packages/websitekit-react', 'packages/create-websitekit'];

/** Every path an installed consumer can be sent to, flattened out of the manifest. */
function entryPoints(manifest) {
  const out = [];
  for (const key of ['main', 'types', 'module']) {
    if (manifest[key]) out.push([key, manifest[key]]);
  }
  for (const [name, target] of Object.entries(manifest.bin ?? {})) out.push([`bin:${name}`, target]);
  const walk = (node, label) => {
    if (typeof node === 'string') return out.push([label, node]);
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, `${label}[${key}]`);
    }
  };
  if (manifest.exports !== undefined) walk(manifest.exports, 'exports');
  return out;
}

const staging = mkdtempSync(path.join(tmpdir(), 'websitekit-verify-'));
let failures = 0;

try {
  for (const pkg of PACKAGES) {
    const dir = path.join(root, pkg);
    // `pnpm pack` runs prepack, so this also proves the build is wired up.
    const stdout = execFileSync('pnpm', ['pack', '--pack-destination', staging], { cwd: dir, encoding: 'utf-8' });
    const tarball = stdout.trim().split('\n').filter((line) => line.endsWith('.tgz')).pop();
    if (!tarball) throw new Error(`${pkg}: pnpm pack printed no tarball path`);

    const listing = execFileSync('tar', ['tzf', tarball], { encoding: 'utf-8' });
    const files = new Set(
      listing.split('\n').filter(Boolean).map((name) => path.posix.normalize(name.replace(/^package\//, ''))),
    );
    const manifest = JSON.parse(
      execFileSync('tar', ['xzfO', tarball, 'package/package.json'], { encoding: 'utf-8' }),
    );

    const missing = entryPoints(manifest).filter(
      ([, target]) => !files.has(path.posix.normalize(target.replace(/^\.\//, ''))),
    );
    if (missing.length) {
      failures += 1;
      console.error(`  BROKEN  ${manifest.name}@${manifest.version}`);
      for (const [label, target] of missing) console.error(`            ${label} -> ${target} is not in the tarball`);
    } else {
      console.log(`  ok      ${manifest.name}@${manifest.version} — ${entryPoints(manifest).length} entry point(s) resolve`);
    }
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n  ${failures} package(s) would publish broken. Publish with \`pnpm publish\`, not \`npm publish\`.`);
  process.exit(1);
}
console.log('\n  every declared entry point exists inside its tarball');
