/**
 * Sweeps every seeded board's treasury and pull ledger back to the accounts that own them.
 *
 * **Why a seeding run needs this at all.** The deployer is the `treasury` on all five reference
 * boards, so ~95% of everything either account spends claiming a slot lands in the site's own
 * `treasuryBalance` and stays there — the money is not gone, it is parked in a contract. A displaced
 * owner's payout likewise sits in `pendingWithdrawals` until somebody pulls it. Seeding five boards
 * therefore drains two testnet wallets into five contracts while barely burning anything, and the
 * next script in the sequence fails for lack of gas money that is sitting a call away.
 *
 *   set -a && . ./.env && set +a
 *   pnpm --filter @websitekit/sdk exec tsx scripts/reclaim-testnet.ts
 *
 * Both calls used here are PERMISSIONLESS and pay the party that is owed rather than the caller —
 * `sweepTreasury` pays the site's `treasury` and `withdrawFor` pays the named account (§10.4). That
 * is why one key can settle both accounts' balances, and it is worth noticing that the design makes
 * this script safe rather than the script being careful.
 */
import { formatEther } from 'viem';

import { buildSweepTreasury, buildWithdrawFor, readPendingWithdrawal, readSiteTerms } from '../src/index';
import {
  balanceOf,
  demoSite,
  deployer,
  deployerWallet,
  exampleSites,
  publicClient,
  refFor,
  send,
  taker,
} from './lib/chain';

const SITES = { demo: demoSite(), ...exampleSites() };

console.log(`deployer ${deployer().address}  ${await balanceOf(deployer().address)} ETH`);
console.log(`taker    ${taker().address}  ${await balanceOf(taker().address)} ETH`);

let swept = 0n;
let pulled = 0n;

for (const [slug, site] of Object.entries(SITES)) {
  const terms = await readSiteTerms(publicClient, refFor(site));
  const treasury = await publicClient.readContract({
    address: site,
    abi: [{ type: 'function', name: 'treasuryBalance', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
    functionName: 'treasuryBalance',
  }) as bigint;

  console.log(`\n${slug}  ${site}`);

  if (treasury > 0n) {
    await send(deployerWallet(), `sweepTreasury ${slug}`, {
      ...buildSweepTreasury(site),
      account: deployer(),
    });
    swept += treasury;
    console.log(`  swept   ${formatEther(treasury).padStart(12)} ETH to ${terms.treasury}`);
  } else {
    console.log('  treasury empty');
  }

  for (const [label, account] of [['deployer', deployer().address], ['taker', taker().address]] as const) {
    const owed = await readPendingWithdrawal(publicClient, site, account);
    if (owed === 0n) continue;
    await send(deployerWallet(), `withdrawFor ${slug}/${label}`, {
      ...buildWithdrawFor(site, account),
      account: deployer(),
    });
    pulled += owed;
    console.log(`  pulled  ${formatEther(owed).padStart(12)} ETH for the ${label}`);
  }
}

console.log(`
  swept ${formatEther(swept)} ETH of site treasury, pulled ${formatEther(pulled)} ETH of payouts
  deployer now ${await balanceOf(deployer().address)} ETH
  taker    now ${await balanceOf(taker().address)} ETH
`);
