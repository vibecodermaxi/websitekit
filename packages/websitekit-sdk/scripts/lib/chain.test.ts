import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ROBINHOOD_MAINNET_CHAIN, ROBINHOOD_TESTNET_CHAIN } from '../../src/index';

import { requireScopedEnv, resolveScriptChain, scopedEnv } from './chain';

describe('resolveScriptChain', () => {
  it('is the testnet when nothing is declared', () => {
    expect(resolveScriptChain(undefined)).toBe(ROBINHOOD_TESTNET_CHAIN);
    expect(resolveScriptChain('')).toBe(ROBINHOOD_TESTNET_CHAIN);
  });

  it('is the chain that was declared', () => {
    expect(resolveScriptChain('46630')).toBe(ROBINHOOD_TESTNET_CHAIN);
    expect(resolveScriptChain('4663')).toBe(ROBINHOOD_MAINNET_CHAIN);
  });

  /**
   * These scripts deploy contracts and spend real balances. The only fallback available is the
   * testnet, so a typo meaning mainnet would run a deploy somewhere nobody chose — and a deploy is
   * the one action in this directory with no undo.
   */
  it('refuses a value it cannot resolve rather than falling back', () => {
    expect(() => resolveScriptChain('mainnet')).toThrow(/not a chain id/);
    expect(() => resolveScriptChain('4663.5')).toThrow(/not a chain id/);
    expect(() => resolveScriptChain('1')).toThrow(/chain 1 is unknown/);
  });
});

describe('scopedEnv — a TESTNET_ name may only be read on a testnet', () => {
  const legacyOnly = {
    TESTNET_DEPLOYER_KEY: '0xtestnetkey',
    TESTNET_RPC_URL: 'https://keyed.testnet.example',
  };

  /**
   * **The rule this file exists for.** Both cases use the SAME environment, because that is the
   * input on which a scoped and an unscoped read are able to disagree — an assertion that two
   * things agree has to be able to see them disagree.
   */
  it('answers with the legacy name on a testnet and is blind to it on mainnet', () => {
    expect(scopedEnv(ROBINHOOD_TESTNET_CHAIN, 'DEPLOYER_KEY', 'TESTNET_DEPLOYER_KEY', legacyOnly)).toBe(
      '0xtestnetkey',
    );
    expect(scopedEnv(ROBINHOOD_MAINNET_CHAIN, 'DEPLOYER_KEY', 'TESTNET_DEPLOYER_KEY', legacyOnly)).toBeUndefined();
  });

  it('prefers the neutral name on either chain', () => {
    const both = { ...legacyOnly, DEPLOYER_KEY: '0xneutral' };
    expect(scopedEnv(ROBINHOOD_TESTNET_CHAIN, 'DEPLOYER_KEY', 'TESTNET_DEPLOYER_KEY', both)).toBe('0xneutral');
    expect(scopedEnv(ROBINHOOD_MAINNET_CHAIN, 'DEPLOYER_KEY', 'TESTNET_DEPLOYER_KEY', both)).toBe('0xneutral');
  });

  it('is undefined when neither is set', () => {
    expect(scopedEnv(ROBINHOOD_TESTNET_CHAIN, 'DEPLOYER_KEY', 'TESTNET_DEPLOYER_KEY', {})).toBeUndefined();
  });

  /**
   * A mainnet deploy that silently picked up a testnet key would fail its GAS ESTIMATE, which viem
   * reports as `execution reverted` with no revert data — the error shape this repo has already
   * lost a session to. The refusal has to name what it wanted instead.
   */
  it('refuses by name, and names the legacy variable only where it would have been read', () => {
    expect(() => requireScopedEnv(ROBINHOOD_MAINNET_CHAIN, 'DEPLOYER_KEY', 'TESTNET_DEPLOYER_KEY', legacyOnly))
      .toThrow(/DEPLOYER_KEY is not set for Robinhood Chain/);
    expect(() => requireScopedEnv(ROBINHOOD_MAINNET_CHAIN, 'DEPLOYER_KEY', 'TESTNET_DEPLOYER_KEY', legacyOnly))
      .not.toThrow(/TESTNET_DEPLOYER_KEY/);
    expect(() => requireScopedEnv(ROBINHOOD_TESTNET_CHAIN, 'DEPLOYER_KEY', 'TESTNET_DEPLOYER_KEY', {}))
      .toThrow(/or TESTNET_DEPLOYER_KEY/);
  });
});

describe('the mintable stand-in is refused off a testnet', () => {
  /**
   * **Read as SOURCE rather than executed, deliberately.** Importing `deploy-test-usd.ts` runs it,
   * and a suite that would deploy a contract if a guard were ever mutated away is a worse hazard
   * than the one it is checking for. `slot-offer.source.test.ts`'s move, for a sharper reason.
   *
   * What it pins is that the guard reads the CHAIN and throws — `TestUSD.mint` is permissionless,
   * which is what `SettlementToken.mintable` gates checkout's faucet on, so one on a chain where
   * the money is real is a token anybody can print sitting beside a token nobody can.
   */
  it('has a guard on the chain rather than a comment about it', () => {
    const source = readFileSync(new URL('../deploy-test-usd.ts', import.meta.url), 'utf-8');
    expect(source).toMatch(/if \(!activeChain\.testnet\)/);
    expect(source).toMatch(/throw new Error\(/);
    // And no override, because there is no argument for one.
    expect(source).not.toMatch(/FORCE|ALLOW_MAINNET|--force/);
  });
});
