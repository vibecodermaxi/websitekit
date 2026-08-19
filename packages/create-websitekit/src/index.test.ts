/**
 * The scaffold's job is to produce a directory that works. These tests run the real CLI against a
 * real temp directory and check the things that are silently wrong otherwise — a `.gitignore` that
 * never got renamed, a package name left as the template's, a slot key in the config that the SDK
 * would reject at import time.
 *
 * Not tested here: `pnpm install && pnpm dev` in the generated project. That needs `@websitekit/*`
 * published to a registry, which they are not yet.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(__dirname, 'index.ts');

let workDir: string;
let projectDir: string;

function run(args: string[], cwd: string) {
  return spawnSync('npx', ['tsx', cli, ...args], { cwd, encoding: 'utf-8' });
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-websitekit-'));
  projectDir = path.join(workDir, 'my-site');
  const result = run(['my-site'], workDir);
  expect(result.status, result.stderr).toBe(0);
}, 60_000);

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('the generated project', () => {
  it('has everything needed to run', () => {
    for (const file of [
      'package.json',
      'tsconfig.json',
      'next.config.mjs',
      'websitekit.config.ts',
      'app/layout.tsx',
      'app/page.tsx',
      'app/board.tsx',
      'app/globals.css',
      'lib/chain.ts',
      'scripts/deploy.ts',
      'README.md',
      '.env.example',
    ]) {
      expect(fs.existsSync(path.join(projectDir, file)), file).toBe(true);
    }
  });

  it('takes its name from the directory', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('my-site');
  });

  /**
   * npm refuses to publish a `.gitignore`, so the template carries it under another name. Forgetting
   * the rename means the generated project's first commit contains `node_modules` and `.env` — a
   * leaked key, in the worst case.
   */
  it('has a real .gitignore covering .env and node_modules', () => {
    const ignore = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf-8');
    expect(ignore).toContain('.env');
    expect(ignore).toContain('node_modules');
    expect(fs.existsSync(path.join(projectDir, 'gitignore'))).toBe(false);
  });

  /** The example must never carry a real key, and the deploy script must never work without one. */
  it('ships an empty .env.example and no .env', () => {
    const example = fs.readFileSync(path.join(projectDir, '.env.example'), 'utf-8');
    expect(example).toMatch(/DEPLOYER_PRIVATE_KEY=\s*$/m);
    expect(fs.existsSync(path.join(projectDir, '.env'))).toBe(false);
  });

  /**
   * Every key in the scaffold config is a permanent on-chain identity the moment someone deploys.
   * A key that `assertValidSlotKey` would reject turns `pnpm dev` into an import-time crash on the
   * very first run, which is the worst possible first impression.
   */
  it('uses slot keys the SDK accepts', async () => {
    const { assertValidSlotKey } = await import('@websitekit/sdk');
    const source = fs.readFileSync(path.join(projectDir, 'websitekit.config.ts'), 'utf-8');
    const keys = [...source.matchAll(/^\s+'([a-z0-9._-]+)': \{ kind:/gm)].map((match) => match[1]!);

    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) expect(() => assertValidSlotKey(key)).not.toThrow();
  });

  /** Every slot referenced by the page must exist in the config, or `<Slot>` throws at render. */
  it('only renders slots that are in the config', () => {
    const config = fs.readFileSync(path.join(projectDir, 'websitekit.config.ts'), 'utf-8');
    const page = fs.readFileSync(path.join(projectDir, 'app/page.tsx'), 'utf-8');
    const used = [...page.matchAll(/<Slot\s+id="([a-z0-9._-]+)"/g)].map((match) => match[1]!);

    expect(used.length).toBeGreaterThan(5);
    for (const key of used) expect(config, key).toContain(`'${key}'`);
  });

  /**
   * §0: `fallback` is what makes the page look finished on day one. A `<Slot>` without one renders
   * nothing when unclaimed, which on a fresh site is every slot.
   */
  it('gives every rendered slot a fallback', () => {
    const page = fs.readFileSync(path.join(projectDir, 'app/page.tsx'), 'utf-8');
    for (const tag of page.match(/<Slot\b[^>]*\/>/gs) ?? []) {
      expect(tag, tag).toContain('fallback=');
    }
  });
});

describe('the CLI refuses to do damage', () => {
  it('will not scaffold into a non-empty directory', () => {
    const occupied = path.join(workDir, 'occupied');
    fs.mkdirSync(occupied);
    fs.writeFileSync(path.join(occupied, 'important.txt'), 'do not clobber me');

    const result = run(['occupied'], workDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not empty');
    expect(fs.readFileSync(path.join(occupied, 'important.txt'), 'utf-8')).toBe('do not clobber me');
  }, 30_000);

  it('rejects a name npm could not publish', () => {
    const result = run(['My Site'], workDir);
    expect(result.status).toBe(1);
  }, 30_000);

  it('asks for a directory when given none', () => {
    const result = run([], workDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('usage');
  }, 30_000);
});
