import { defineConfig } from 'tsup';

/** See `@websitekit/sdk`'s config for why this ships a build and why it is ESM-only. */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  external: ['viem', 'react', 'react-dom', '@websitekit/sdk'],
  // Every component and hook here is a client boundary — five of the seven source files already
  // carry the directive individually. Bundling merges them into one module, so the directive has to
  // be reasserted at the top of the output or React Server Components sees a server module and
  // rejects the hooks inside it. A server component importing this is still the supported pattern:
  // that is what a client boundary IS.
  banner: { js: "'use client';" },
});
