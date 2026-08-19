import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {import('next').NextConfig} */
export default {
  // Without this Next walks up past the repo looking for a lockfile and picks ~/pnpm-lock.yaml,
  // which puts the tracing root outside the workspace — the deployed bundle then misses
  // `content/` and the workspace-linked @websitekit/* sources.
  outputFileTracingRoot: repoRoot,
  // The workspace copies of @websitekit/* keep their entry points on `src/` so the dev loop needs no
  // build step — `publishConfig` swaps them to `dist/` at publish time. This app consumes the
  // workspace copies, so Next still has to compile them like first-party code. The published
  // packages ship a real build and a consumer needs none of this.
  transpilePackages: ['@websitekit/sdk', '@websitekit/react'],

  /**
   * `/docs/sdk` was a real page for the whole pre-v2 life of this site, and it is indexed and
   * linked from outside. Deleting the document turned it into a 404 for anyone arriving on an old
   * link — which is worse than the stale page only in that it loses the reader entirely. A
   * permanent redirect sends them to the document that replaced it.
   */
  async redirects() {
    return [{ source: '/docs/sdk', destination: '/docs/guide', permanent: true }];
  },
};
