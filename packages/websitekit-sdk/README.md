# `@websitekit/sdk`

Reads, writes and pricing for **websitekit** — an issuance and settlement layer for tokenized page
inventory. A publisher marks regions of their page as slots; anyone buys one and becomes its
effective owner, able to write its content, trade it as an ERC-721, or rent it to an advertiser.

```bash
npm install @websitekit/sdk viem
```

`viem` is a peer dependency: this package takes *your* client, so there is one copy of viem and one
set of types.

## Reading a board

Every read goes through `SlotReader`, a deliberately replaceable deployment — so reads take a
`SiteRef` (`{ site, reader }`) rather than a bare address.

```ts
import { createPublicClient, http } from 'viem';
import { readSlots, readSiteTerms, deploymentFor } from '@websitekit/sdk';

const client = createPublicClient({ chain, transport: http() });
// 4663 is Robinhood Chain mainnet; 46630 is its testnet. `deploymentFor` throws for any other id.
const ref = { site: '0xYourBoard', reader: deploymentFor(4663).reader! };

const terms = await readSiteTerms(client, ref);
const slots = await readSlots(client, ref, ['hero.headline', 'hero.image']);
```

Each slot carries what a page needs to render *and* what a buyer needs to decide: `charged` (what
this buyer pays — the floor on a claim, the take price on a take), `unaccruedRent` and `netCost` for
an encumbered position, and `isAvailable` for the publisher's listing toggle.

## Buying

Never assemble a `buy` by hand. `readBuyContext` pins the quote, the encumbrance hash and the
**chain's** clock to one block, and `buildBuyFrom` builds from exactly that:

```ts
import { readBuyContext, buildBuyFrom } from '@websitekit/sdk';

const context = await readBuyContext(client, ref, 'hero.headline');
const request = buildBuyFrom(ref.site, context, terms.settlementToken);
await walletClient.writeContract(request);
```

This SDK never holds a key. Every `build*` returns a request object your wallet layer sends.

## Escrow

Optional, and deployed on mainnet and testnet (`escrowDeploymentFor`). A site created through `EscrowFactory` has its `treasury`
pinned to an `EscrowVault`; the publisher's cut waits a window there, and a slot holder on a page
that goes dark can hand the slot back for what they paid.

```ts
import {
  buildCreateEscrowedSite, // the factory names the OWNER; treasury and pinTreasury are not options
  buildBook, buildRelease, buildVaultWithdrawFor, // permissionless — each pays a recorded party
  buildApproveVault, buildClaim,                  // the holder's: approve the vault, then surrender
  readVault, readDeposits, readClaimable, readEscrowBind,
} from '@websitekit/sdk';

const bind = await readEscrowBind(client, site, vault);
bind.escrowed; // treasury == vault AND pinned AND vault.site() == site — check BOTH directions
```

`buildClaim` moves the holder's token into the vault before a unit is credited, so `buildApproveVault`
has to land first, on the site. `readClaimable` is the vault's own verdict and folds every refusal
into a zero; `readVault` carries the clock and the ledger. `buildMarkDark`/`buildClearDark` are the
attestor's and accepted from nobody else.

## Image boards

The second kind of board: one uploaded picture, sold as rectangular blocks of square cells. **A
board is an NFT and a collection**: its own token sits in a shared Boards collection, and the board
itself is an ERC-721 whose tokens are its blocks — minted at the buy, approvable, tradable anywhere,
with metadata built on chain (`readBlockTokenURI`) and pictures addressed by their hash on IPFS
(`contentHashToCid`). Any cell can be bought, sold or not: a buy over another block's cells takes
them at that block's price times the board's take multiple, and credits its owner — as a page slot
is taken — except one bought in the last cooldown. The covered block keeps its token and the cells
it has left. Spec: [`docs/IMAGE-BOARD-SPEC.md`](../../docs/IMAGE-BOARD-SPEC.md) §13.

**This generation is on Robinhood Chain mainnet (4663), settling in USDG, and on its testnet
(46630).** `imageBoardDeploymentFor` throws for any other chain; the earlier generation answers a
different ABI and is not listed.
Everything lives under its own entry point, because its names (`quote`, `readBlock`, `Rect`) are
generic:

```ts
import {
  imageBoardDeploymentFor, readImageBoard, readBlocks, readCellMap, gridStateOf, readBuyError,
  readQuoteBlocks, permitTypedData, splitSignature, buildBuyBlocksWithPermit, quoteBlocks, buyError,
} from '@websitekit/sdk/image-boards';

const { token } = imageBoardDeploymentFor(46630);
const board = await readImageBoard(client, '0xBoard');
const rects = [{ col: 4, row: 2, cols: 10, rows: 8 }]; // each rectangle becomes its own block

// A preview, as the pointer moves: the twin, against the board's cells and blocks.
const blocks = await readBlocks(client, board.address, board.blockCount);
const cells = await readCellMap(client, board.address, { cols: board.gridCols, rows: board.gridRows });
const state = gridStateOf(board, blocks, cells);
const shown = buyError(state, rects, now) === 'none' ? quoteBlocks(state, rects, now) : null;

// The chain is the gate: ask it, fresh, right before building the buy.
if ((await readBuyError(client, board.address, rects)) !== 'none') throw new Error('refused');
const total = await readQuoteBlocks(client, board.address, rects);
// …sign `permitTypedData({ token, spender: board.address, value: total, … })`, then:
const request = buildBuyBlocksWithPermit({
  board: board.address, recipient: buyer, rects, maxTotal: total, permit: splitSignature(sig, deadline),
});
```

`quoteBlocks` and `buyError` are a TypeScript twin of the contract, pinned to it by vectors the
contract generates — use them to preview a selection as the pointer moves, never to decide a buy.
A take's price moves with time, so they take `now` (seconds, the chain's clock), and the buy names
the most it will pay (`maxTotal`): the contract refuses it if the cells cost more when it lands. Builders
cover the rest: creating a board (`buildCreateImageBoard`, permissionless; the seller is named and
signs nothing), writing a block's picture hash (`buildEditBlock`), editors, moving a block
(`buildTransferBlock`, `buildApproveBlock`, `buildSetBlockOperator` — an approval moves a block and
nothing else), resale inside the board (`buildListBlock`, `buildBuyListedBlockWithPermit`), lowering
prices (`buildLowerPrices`) and announcing a lapsed tenant picture (`buildPokeBlock`). A sale on a
marketplace does not move a block's take price: its metadata states it (`readTakePrice`).
`composeBoard` draws the board from its source, its cell map and each block's decoded picture, as
every renderer must (spec §13.9).

**Renting a block.** An owner offers a block at a daily rate, up to a longest term
(`buildListForRent`; a rate of zero ends the offer). Anyone can rent it for a NAMED tenant — the
payer need not be them — for a term from an hour to 365 days, prepaid by permit for exactly
`blockRentQuote(rate, secs).cost` and at the rate they were shown (`buildRentBlockWithPermit`
refuses another). 5% goes to the protocol and 5% to whoever holds the board then; the rest streams
by the second to whoever owns the block. The tenant's picture is held apart from the owner's
(`buildEditRented`) and shows until the term ends, by itself, with no transaction: anything that
draws a block reads `readBlock(...).shownHash`, never `contentHash`. `buildExtendRentalWithPermit`
restarts the term from now. Streamed rent is credited by `buildClaimRent(ids)`, which anyone may
send and which pays only each block's owner; then it is withdrawn as any other credit.
`rentalLive` and `rentUnclaimed` read a term at the chain's time. A take refunds the tenant for the
squares taken and the term goes on over the rest; a take ends the rent offer; a rental starting ends
a resale listing; a change of owner credits the old owner what streamed, and the term carries on.

**A board keeps the rules it was created with.** The collection's owner can point NEW boards at a
later implementation; an existing board never moves (`implementationOf`). `buildCreateImageBoard`
encodes the set-up as bytes the collection does not read (`IMAGE_BOARD_CONFIG_PARAMS`), so a later
implementation may take a different one. A square is any whole size from `MIN_CELL_SIZE` (10 px) to
`MAX_CELL_SIZE` (200 px). One buy may take cells from at most `MAX_BLOCKS_TAKEN_PER_BUY` (88) blocks.

**What the chain does not do:** draw the picture. A block stores a content hash; composing the
board's picture from its blocks, and serving the collection's token metadata, is the job of whoever
hosts the board. A board created straight through the collection gets its NFT, but its metadata is
only as good as that host's support for it.

## Three rules worth knowing up front

- **`settlementToken` is required on every builder that moves money.** There is no default: a
  native-shaped call against a token site reverts, and the same call is correct on a native site —
  so a default is silently right half the time.
- **Never `parseEther` a floor.** `minFloor` derives from the settlement token's decimals, so 18 is
  wrong by 1e12 against 6-decimal USDG. Use `parseFloor(amount, decimals)`.
- **Deadlines and liveness use `block.timestamp`, not `Date.now()`.** The helpers here read the
  chain's clock for you; wall-clock answers are confidently wrong on a lagging L2.

## Status

Live on Robinhood Chain mainnet, where boards settle in USDG and the money is real, and on its
testnet; image boards are on both. Unaudited, and the contracts are **not
upgradeable** — a site is a clone frozen to the implementation it was created from. Experimental
software.

MIT © websitekit
