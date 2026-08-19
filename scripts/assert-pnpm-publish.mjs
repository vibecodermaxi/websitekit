#!/usr/bin/env node
/**
 * `prepublishOnly` guard: refuses a publish that is not being driven by pnpm.
 *
 * **The entry points of `@websitekit/sdk` and `@websitekit/react` live on `publishConfig`** so the
 * workspace can import `src/` with no build step while the registry gets `dist/`. That swap is a
 * **pnpm** feature. `npm publish` honours only `registry`, `access` and `tag` on `publishConfig`,
 * so it uploads the development manifest verbatim — `main` pointing at `./src/index.ts`, a path
 * `files` deliberately excludes. npm does not validate that `main` exists. The result installs
 * cleanly and throws `Module not found` on first import, on a version number that can never be
 * reused. That is exactly how 0.1.0 of both packages was burned.
 *
 * A packed-tarball check cannot catch this: `pnpm pack` applies the swap, so it always looks right.
 * The only observable difference at publish time is who is driving, and `npm_config_user_agent`
 * carries that — `pnpm/9.15.0 …` against `npm/10.9.2 …`.
 */
const agent = process.env.npm_config_user_agent ?? '';

if (!/^pnpm\//.test(agent)) {
  console.error(`
  Refusing to publish: this is being run by \`${agent.split(' ')[0] || 'an unknown client'}\`, not pnpm.

  These packages declare their published entry points on \`publishConfig\`, and only pnpm applies
  that swap. Publishing with npm uploads \`main: "./src/index.ts"\` — a file that is not in the
  tarball — and npm will accept it without complaint.

  Use:  pnpm release        (verifies the packed tarballs, then publishes)
`);
  process.exit(1);
}
