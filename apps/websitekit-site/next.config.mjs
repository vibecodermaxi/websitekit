import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {import('next').NextConfig} */
export default {
  // Without this Next walks up past the repo looking for a lockfile and picks ~/pnpm-lock.yaml,
  // which puts the tracing root outside the workspace — the deployed bundle then misses
  // `content/` and the workspace-linked @websitekit/* sources.
  outputFileTracingRoot: repoRoot,
  // @websitekit/* publish TypeScript source rather than a build artefact, so Next compiles them like
  // first-party code. Same reason the scaffold template does it — and a live reminder that "ship
  // source or ship a build" is still an open public-API decision before the first npm publish.
  transpilePackages: ['@websitekit/sdk', '@websitekit/react'],
};
