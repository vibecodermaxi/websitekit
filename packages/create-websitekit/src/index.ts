#!/usr/bin/env node
/**
 * `pnpm create websitekit my-site` — spec §6.
 *
 * Copies `template/` into a new directory and rewrites the handful of places the project name
 * appears. That is the whole job. It deliberately does not prompt, does not ask for credentials,
 * and does not touch the network: §6's target is `cd my-site && pnpm dev` working immediately, and
 * every question asked before that is a question that can be answered wrong.
 *
 * **The template is real, editable source, not an inert blob.** In particular `scripts/deploy.ts`
 * ships inside the generated project rather than behind a `websitekit deploy` binary. §6 writes it as
 * `pnpm websitekit deploy`; shipping it as a readable script in the repo the builder just created is
 * better for the same money — deploying a site is one `createSite` call, and a builder who can read
 * the thirty lines that do it understands what they now own. A hidden binary would make the one
 * transaction that matters the one thing they cannot inspect.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templateDir = path.resolve(__dirname, '../template');

function fail(message: string): never {
  console.error(`create-websitekit: ${message}`);
  process.exit(1);
}

const target = process.argv[2];
if (!target) fail('usage: pnpm create websitekit <directory>');

const projectDir = path.resolve(process.cwd(), target);
const projectName = path.basename(projectDir);

if (!/^[a-z0-9][a-z0-9._-]*$/.test(projectName)) {
  fail(`"${projectName}" is not a usable npm package name — lowercase, starting alphanumeric`);
}
// Refuse rather than merge. A half-overwritten project is worse than no project, and the failure
// shows up later as a build error nobody connects to this command.
if (existsSync(projectDir) && readdirSync(projectDir).length > 0) {
  fail(`${projectDir} already exists and is not empty`);
}

mkdirSync(projectDir, { recursive: true });
cpSync(templateDir, projectDir, { recursive: true });

// npm refuses to publish a `.gitignore`, so templates ship it under another name and rename on the
// way out. Without this the generated project commits node_modules and .env on its first commit.
const gitignore = path.join(projectDir, 'gitignore');
if (existsSync(gitignore)) renameSync(gitignore, path.join(projectDir, '.gitignore'));

const packageJsonPath = path.join(projectDir, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
packageJson.name = projectName;
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

console.log(`
  Created ${projectName}.

    cd ${target}
    pnpm install
    pnpm dev

  The page renders straight away, with no credentials, against a shared demo board
  on testnet: already claimed across two owners, two slots left open, one taken
  twice, one under a live tenancy, and one withdrawn from sale. Unowned slots show
  your \`fallback\` copy. Alt-click any slot to see what it costs.

  When you want your own site:

    cp .env.example .env      # add a funded testnet key
    pnpm deploy:site          # one transaction, prints the address into your config
`);
