import { defineConfig } from 'tsup';

/**
 * Ships a BUILD rather than TypeScript source.
 *
 * Source-only publishing worked while both consumers were Next apps with `transpilePackages`, and
 * failed for everyone else: Vite, Remix, plain `tsc` and Node all hit a syntax error inside
 * `node_modules`, which the scaffold's own config called "an unhelpful place to meet your first
 * websitekit problem". `package.json#publishConfig` swaps the entry points to `dist/` at publish
 * time, so the workspace keeps importing `src/` and the dev loop is unchanged.
 *
 * ESM only. viem is ESM-first and every target that matters resolves it, so a dual CJS build would
 * be real complexity — `require`/`import` interop, two type trees — for a consumer who does not
 * exist yet. Revisit when one asks.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  // Never inline the peer. Two copies of viem means two sets of nominal types, so a consumer's
  // `PublicClient` stops being assignable to ours — the exact failure this package spent a release
  // shipping as a hard dependency.
  external: ['viem'],
});
