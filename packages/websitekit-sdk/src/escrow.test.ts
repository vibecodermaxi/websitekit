import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';

import {
  buildApproveVault,
  buildClaim,
  buildCreateEscrowedSite,
  buildFundReserve,
  buildMarkDark,
  buildRelease,
  buildVaultWithdrawFor,
  ESCROW_FACTORY_ABI,
  ESCROW_VAULT_ABI,
} from './escrow';
import { slotKey } from './keys';
import { SLOT_SITE_ABI } from './reads';

const ESCROW_FACTORY = '0x2222222222222222222222222222222222222222' as Address;
const SITE = '0x1111111111111111111111111111111111111111' as Address;
const VAULT = '0x6666666666666666666666666666666666666666' as Address;
const PUBLISHER = '0x3333333333333333333333333333333333333333' as Address;
const TOKEN = '0x5555555555555555555555555555555555555555' as Address;
const NATIVE = '0x0000000000000000000000000000000000000000' as Address;

const ECONOMICS = { takeBps: 14_000n, payoutBps: 11_500n, reversionBps: 9_700n, maxReversionWeeks: 52n, cooldownSecs: 900n };
const RENTALS = { siteRentBps: 2_500n, maxRentalTerm: 2_592_000n, minRentBps: 25n };
const FLOOR_POLICY = { floorDeltaBps: 2_000n, floorChangeCooldown: 86_400n, maxAskBps: 40_000n };

describe('buildCreateEscrowedSite', () => {
  const request = buildCreateEscrowedSite({
    escrowFactory: ESCROW_FACTORY,
    owner: PUBLISHER,
    name: 'S',
    symbol: 'S',
    baseTokenURI: '',
    settlementToken: TOKEN,
    economics: ECONOMICS,
    rentals: RENTALS,
    floorPolicy: FLOOR_POLICY,
    slots: { 'hero.headline': 25_000_000n },
  });

  /**
   * The owner is the FIRST argument and is required — the escrow factory always names the owner,
   * and a builder that let it default to the payer would be the shape of mistake this repo's
   * standing check exists to catch.
   */
  it('targets the escrow factory and puts the owner first', () => {
    expect(request.address).toBe(ESCROW_FACTORY);
    expect(request.abi).toBe(ESCROW_FACTORY_ABI);
    expect(request.functionName).toBe('createEscrowedSite');
    expect(request.args[0]).toBe(PUBLISHER);
    expect(request.args[2]).toEqual([slotKey('hero.headline')]);
    expect(request.args[3]).toEqual([25_000_000n]);
  });

  /**
   * Whatever the config says about the pipe, the factory overwrites it with the vault. The builder
   * sends the pinned shape so a simulation against the factory reads the way the chain will act.
   */
  it('sends the config pinned, with the treasury a placeholder the factory replaces', () => {
    const config = request.args[1] as { treasury: Address; pinTreasury: boolean; settlementToken: Address };
    expect(config.pinTreasury).toBe(true);
    expect(config.treasury).toBe(PUBLISHER);
    expect(config.settlementToken).toBe(TOKEN);
  });
});

describe('the vault builders', () => {
  it('hashes the key for claim and carries the floor through', () => {
    const request = buildClaim(VAULT, 'hero.headline', 250_000n);
    expect(request.abi).toBe(ESCROW_VAULT_ABI);
    expect(request.args).toEqual([slotKey('hero.headline'), 250_000n]);
  });

  /**
   * **Zero means no floor and must reach the call as zero**, not be dropped as falsy. It is what
   * every caller meant before the parameter existed, and a builder that omitted it would produce
   * the arity the contract no longer has.
   */
  it('sends a zero floor rather than dropping it', () => {
    expect(buildClaim(VAULT, 'hero.headline', 0n).args).toEqual([slotKey('hero.headline'), 0n]);
  });

  /** The surrender's consent lives on the SITE, not the vault: it is an ERC-721 approval. */
  it('approves the vault on the site', () => {
    const request = buildApproveVault(SITE, VAULT);
    expect(request.address).toBe(SITE);
    expect(request.abi).toBe(SLOT_SITE_ABI);
    expect(request.args).toEqual([VAULT, true]);
  });

  it('names the payee on withdrawFor and the id on release', () => {
    expect(buildVaultWithdrawFor(VAULT, PUBLISHER).args).toEqual([PUBLISHER]);
    expect(buildRelease(VAULT, 7n).args).toEqual([7n]);
    expect(buildMarkDark(VAULT)).toMatchObject({ address: VAULT, functionName: 'markDark', args: [] });
  });

  /**
   * The one money builder. Native sends the amount as value and zero as the argument; a token
   * board sends zero value and the amount as the argument, and the vault pulls it.
   */
  it('funds the reserve as value on a native board and as an argument on a token board', () => {
    expect(buildFundReserve(VAULT, 5n, NATIVE)).toMatchObject({ args: [0n], value: 5n });
    expect(buildFundReserve(VAULT, 5n, TOKEN)).toMatchObject({ args: [5n], value: 0n });
  });
});
