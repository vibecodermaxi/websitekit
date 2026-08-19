/**
 * The two things spec §11 leaves open, both of which are measurements rather than decisions.
 *
 * 1. **Is EIP-7702 actually live on RH Chain?** §10.5 concludes it is, from a version number:
 *    ArbOS 40 shipped it and this chain reports ArbOS 61. That is an inference, and the spec says
 *    so — "confirm decisively with one type-4 transaction on testnet 46630". §10.7's fallback
 *    reasoning depends on it: with a 7702-delegated EOA, `wallet_sendCalls` batches atomically with
 *    `msg.sender` still being the user, so no contract support is needed for batching.
 *
 *    Note that block-header fork sniffing does NOT work here — Arbitrum blocks carry no
 *    `withdrawalsRoot`, `requestsHash` or beacon-root fields regardless of fork level. Sending the
 *    transaction is the only way to know.
 *
 * 2. **Is anything happening on this chain?** §7.7 — "the mechanic dies quietly at small scale" —
 *    is the framework's main product risk, and launch-chain activity feeds straight into it. The
 *    spec's own attempt found zero transactions in a 40-block sample and was then rate-limited
 *    (403) trying to widen it. Forty blocks is seconds of wall time on a fast chain and proves
 *    nothing either way; this measures properly against the funded RPC.
 *
 *   set -a && . .env && set +a
 *   pnpm --filter @websitekit/sdk exec tsx scripts/chain-checks.ts
 */
import { createPublicClient, createWalletClient, defineChain, http, type Chain } from 'viem';

import { ROBINHOOD_TESTNET } from '../src/index';
import { publicClient as testnetClient, required, robinhoodTestnet as testnet, taker } from './lib/chain';

const mainnet = defineChain({
  id: 4663,
  name: 'RH Mainnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [required('MAINNET_RPC_URL')] } },
});

// ---------------------------------------------------------------------------
// 1. EIP-7702, observed rather than inferred
// ---------------------------------------------------------------------------

async function checkEip7702() {
  console.log('=== EIP-7702 (type-4 SetCode) on testnet 46630 ===\n');

  const account = taker();
  const publicClient = testnetClient;
  const wallet = createWalletClient({ account, chain: testnet, transport: http() });

  const before = await publicClient.getCode({ address: account.address });
  console.log(`  EOA ${account.address}`);
  console.log(`  code before: ${before ?? '(none)'}`);

  // Delegate to the deployed SlotFactory. The target only has to be a contract; nothing is called
  // through it, and the delegation is revoked below. Taken from the SDK's address table rather than
  // written out, because the literal that used to sit here was the v1 factory and outlived it.
  const target = ROBINHOOD_TESTNET.factory;

  try {
    const authorization = await wallet.signAuthorization({ account, contractAddress: target, executor: 'self' });
    // Explicit gas. viem's estimator round-trips `eth_estimateGas`, which on this RPC returns a
    // figure that does not account for the authorization list's PER_EMPTY_ACCOUNT_COST — the
    // transaction then fails with "gas too low", which reads exactly like the chain rejecting
    // type-4 outright. It is not; it is an estimation gap, and mistaking one for the other would
    // have retired §10.7's batching path for the wrong reason.
    const hash = await wallet.sendTransaction({
      authorizationList: [authorization],
      to: account.address,
      data: '0x',
      gas: 200_000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    // `status: reverted` here is EXPECTED and is not the thing being measured. The transaction
    // calls the EOA, which now delegates to `SlotFactory`, which has no fallback — so the call
    // reverts. EIP-7702 applies the authorization list in the pre-execution phase, so the
    // delegation lands anyway. The code check below is the actual result; the receipt status is
    // noise from the no-op call used to carry the authorization.
    console.log(`  type-4 tx:   ${hash}  (call status ${receipt.status} — expected, see note)`);

    const after = await publicClient.getCode({ address: account.address });
    console.log(`  code after:  ${after ?? '(none)'}`);

    const expected = `0xef0100${target.slice(2).toLowerCase()}`;
    const delegated = after?.toLowerCase() === expected;
    console.log(`  expected:    ${expected}`);
    console.log(`\n  RESULT: EIP-7702 is ${delegated ? 'LIVE' : 'NOT working as expected'} on 46630`);

    if (delegated) {
      // Revoke, or the EOA keeps delegated code and every later transaction from it runs the
      // factory's fallback. Leaving a test delegation on a funded key is a live footgun.
      const revoke = await wallet.signAuthorization({
        account,
        contractAddress: '0x0000000000000000000000000000000000000000',
        executor: 'self',
      });
      const revokeHash = await wallet.sendTransaction({
        authorizationList: [revoke],
        to: account.address,
        data: '0x',
        gas: 200_000n,
      });
      await publicClient.waitForTransactionReceipt({ hash: revokeHash });
      const final = await publicClient.getCode({ address: account.address });
      console.log(`  revoked:     ${revokeHash}  code now ${final ?? '(none)'}`);
    }
  } catch (error) {
    console.log(`\n  RESULT: type-4 REJECTED — ${(error as Error).message.split('\n')[0]}`);
    console.log('  §10.7 must not rely on wallet-side batching on this chain.');
    console.log('  (If this says "gas too low", it is an estimation gap, not a rejection — raise the');
    console.log('   explicit gas above and re-run before concluding anything.)');
  }
}

// ---------------------------------------------------------------------------
// 2. Chain liveness — the input to §7.7
// ---------------------------------------------------------------------------

async function measureLiveness(chain: Chain, sampleSize: number) {
  const client = createPublicClient({ chain, transport: http() });
  const head = await client.getBlockNumber();

  const numbers: bigint[] = [];
  for (let i = 0; i < sampleSize; i++) numbers.push(head - BigInt(i));

  // Batched in chunks so a wide sample does not open a thousand sockets at once.
  const blocks: { number: bigint; timestamp: bigint; txCount: number }[] = [];
  for (let i = 0; i < numbers.length; i += 50) {
    const chunk = await Promise.all(
      numbers.slice(i, i + 50).map(async (blockNumber) => {
        const block = await client.getBlock({ blockNumber, includeTransactions: false });
        return { number: block.number!, timestamp: block.timestamp, txCount: block.transactions.length };
      }),
    );
    blocks.push(...chunk);
  }

  blocks.sort((a, b) => Number(a.number - b.number));
  const totalTx = blocks.reduce((sum, b) => sum + b.txCount, 0);
  const nonEmpty = blocks.filter((b) => b.txCount > 0).length;
  const span = blocks[blocks.length - 1]!.timestamp - blocks[0]!.timestamp;
  const blockTime = Number(span) / (blocks.length - 1);

  console.log(`\n=== ${chain.name} (${chain.id}) liveness ===\n`);
  console.log(`  head block          ${head}`);
  console.log(`  sampled             ${blocks.length} blocks`);
  console.log(`  wall time covered   ${(Number(span) / 60).toFixed(1)} minutes`);
  console.log(`  mean block time     ${blockTime.toFixed(2)}s`);
  console.log(`  blocks with any tx  ${nonEmpty} / ${blocks.length}  (${((nonEmpty / blocks.length) * 100).toFixed(1)}%)`);
  console.log(`  total transactions  ${totalTx}`);
  console.log(`  tx per minute       ${(totalTx / (Number(span) / 60)).toFixed(2)}`);

  return { totalTx, nonEmpty, blocks: blocks.length, blockTime, spanSecs: Number(span) };
}

await checkEip7702();

const mainnetStats = await measureLiveness(mainnet, 2000);
const testnetStats = await measureLiveness(testnet, 500);

console.log(`
=== What this means for §7.7 ===

  §7.7 is the framework's main product risk: take/decay needs contested attention, and a market
  with no takes reads as broken rather than as calm. The launch chain's own activity is the
  ceiling on how much attention any site on it can contest for.

  RH mainnet: ${mainnetStats.totalTx} transactions across ${mainnetStats.blocks} blocks
              (${(mainnetStats.spanSecs / 60).toFixed(0)} minutes of wall time)
  RH testnet: ${testnetStats.totalTx} transactions across ${testnetStats.blocks} blocks
              (${(testnetStats.spanSecs / 60).toFixed(0)} minutes of wall time)
`);
