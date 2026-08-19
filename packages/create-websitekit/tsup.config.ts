import { defineConfig } from 'tsup';

/**
 * The scaffolder ships as a built bin. `bin` pointed at `./src/index.ts`, which plain `node` cannot
 * execute — so `npx create-websitekit`, the documented way a developer starts, could never have
 * worked from a published tarball.
 *
 * No `dts`: this is an executable, not a library. Nothing imports it. `template/` is copied by the
 * bin at runtime from `../template`, which resolves correctly from `dist/index.js`.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  sourcemap: true,
  clean: true,
  target: 'node18',
});
