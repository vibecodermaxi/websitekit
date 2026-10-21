# Image boards — contract spec

`ImageBoardCollection.sol` and `ImageBoard.sol`, with `ImageBoardExtension.sol`,
`ImageBoardRenderer.sol` and `ImageBoardStorage.sol` (§13.1). The second kind of board: one uploaded
image, sold as rectangles of square cells. **Each board is one ERC-721 token in the Boards
collection, and each board is itself an ERC-721 whose tokens are its blocks** (§13, decided
2026-10-21). `PROTOCOL-SPEC.md` describes the first kind (`SlotSite`, regions of a publisher's own
page); nothing here changes it, and the two share no code or storage.

**Status: unaudited**, like the rest of the protocol. Outside the frozen core, like the escrow
contracts. **The §13 generation is deployed on Robinhood Chain mainnet (4663) on 2026-10-22, and on
its testnet (46630) on 2026-10-21**; the addresses are `imageBoardDeploymentFor` in
`@websitekit/sdk/image-boards`. Changes to this document need a recorded reason, as
`PROTOCOL-SPEC.md`'s do.

**How to read it.** §1–§12 were written for the earlier generation, in which a block was a record
and not a token; §13 amends them and wins wherever they differ. The earlier generation was deployed
on both chains, holds no boards, and is retired: the SDK does not list it, and its mainnet collection
allows no token.

**Why the board, then the block** (history). The earlier generation made the board its only token
because a token per block, in one shared collection, made one board hundreds of marketplace listings
of unrelated pictures. §13 gives each board a collection of its own, so a board's blocks are listed
together and apart from every other board's.

## 1. Shape

- **`ImageBoardCollection`** is an ERC-721 (Solady) whose name and symbol are constructor arguments,
  fixed at deployment and chosen by whoever deploys it (changed 2026-10-12: the protocol's source
  names no product, as `SlotSite`'s name and symbol are `createSite` arguments; both must be
  non-empty, `EmptyName`). Its
  `createBoardFor(seller, config)` clones the current `implementation` (EIP-1167), initializes it,
  and mints the board's token to `seller`, in one transaction — so no uninitialized clone exists for
  anyone else to claim. Tokens run from 1. `implementationOf(token)` records which implementation
  each board was cloned from.
- **`config` is bytes the collection never reads** (changed 2026-10-20): the ABI-encoded set-up of
  the current implementation (§4), passed to `initialize(boardTokenId, creator, config)`. After it
  returns, the collection asks the board's `settlementToken()` and refuses a token not on its
  allowlist (`TokenNotAllowed`). That is all it asks of an implementation, so a later one may take
  a set-up of another shape.
- **`ImageBoard`** holds one board: the grid, the blocks, the money. It knows its `collection` and
  its `boardTokenId`. Verifying an implementation once verifies every board cloned from it.
- **The implementation's constructor takes `protocolBps` and `protocolTreasury`** as immutables, so a
  clone cannot strip them. The deploy script reads both from the live `SlotSite` implementation and
  refuses anything but 500 bps.

## 2. Powers

- **Nobody has power over a board, except to make its free squares cheaper.** Once created, the
  grid, the zones' shapes and the take terms are frozen; nothing pauses, nothing upgrades. A block
  changes owner only by its owner's act — `transferBlock`, or a sale of the listing they put up
  (§7a) — and loses cells only to a buy that pays its owner for them (§11). Whoever holds the
  board's token may lower every free square's price and never raise it (§2a).
- **The collection's owner has exactly three powers**: `allowToken` (which settlement tokens NEW
  boards may use), `setImplementation` (which implementation NEW boards are cloned from; refuses an
  address with no code, `NotAContract`; emits `ImplementationSet`), and `setBaseURI` (where token
  metadata is fetched from, so its host can move domains; it emits ERC-4906
  `BatchMetadataUpdate(1, max)`). It has no reach into an existing board, its blocks or its money: a
  board runs the implementation it was cloned from, for good.
- **Recorded reason for `setImplementation`** (2026-10-20): a board's code is fixed when it is
  cloned, so a feature added later can only reach boards created after it. Without this power such
  a feature would need a second collection, splitting boards between two NFT collections. A buyer
  reads a board's rules from `implementationOf`, never from the collection's current one.
- **`createBoardFor` is permissionless** and the seller signs nothing. That grants nothing to the
  caller: `seller` is explicit and receives the token.

## 2a. Lowering prices (added 2026-10-11)

**Recorded reason**: a board priced too high had no way to find its price — the seller had no
powers at all, so a slow board stayed slow. A cut only ever goes down, so it never raises what a buy
pays (since §11 a buy names the most it will pay anyway: a take can raise a sold square's price).
Raising prices, per-zone cuts and a price that falls on a schedule were considered and not chosen.

- **`priceBps`** is what share of the prices set at creation a FREE square costs now: 10,000 at
  creation. **`lowerPrices(newPriceBps)`**: whoever holds the board's token at that moment
  (`seller()`), else `NotBoardHolder`; `newPriceBps` above zero and below `priceBps`, else
  `InvalidPrice`. It only ever falls. `PricesLowered(holder, priceBps)` announces it.
- **One share for the whole board**: the board's own `cellPrice` and every zone's are scaled alike.
  `cellPrice` and `zones()` keep reading the prices set at creation.
- **The free part of a rectangle is scaled as a whole** — the sum of its free cells' creation
  prices — by `priceBps` and **rounds up**, so no cut makes a square free: one free cell costs at
  least one unit. Scaling the part rather than each cell means splitting a buy can cost at most one
  unit more per block, never less.
- A cut touches nothing already sold: blocks, their owners, the prices they list them at (§7a), and
  what taking their cells costs (§11.3 — a take is priced from the creation price, not the cut one).

## 3. The board's token

- **Whoever holds a board's token is paid for every square sold while they hold it.** `seller()` on
  the board is `collection.ownerOf(boardTokenId)`, read at each sale. Money already credited stays
  with whoever it was credited to; handing the token on moves only future sales.
- **ERC-2981**: `royaltyInfo` pays 5% (`ROYALTY_BPS`, a constant) to the board's creator — the
  `seller` it was created for — whoever holds it later.
- **ERC-4906**: a board calls `collection.boardChanged()` on every buy and every edit, and the
  collection emits `MetadataUpdate(tokenId)` for that board's token. Only a board the collection
  created can: `tokenOfBoard[msg.sender]` must be set, else `NotABoard`.
- `tokenURI(id)` is `baseURI ++ id`, and reverts for a token never minted.

## 4. Configuration (frozen at `initialize`)

| Field | Rule |
|---|---|
| `settlementToken` | Non-zero, on the collection's allowlist. ERC-20 only: there is no native path |
| `width`, `height` | The image's own pixels |
| `cellSize` | Any whole number from `MIN_CELL_SIZE` (10) to `MAX_CELL_SIZE` (200) (changed 2026-10-20 from exactly 10, 15 or 20, so larger squares for a large picture need no new contract) |
| `cellPrice` | Non-zero, in the token's units. What a square costs now is this at `priceBps` (§2a) |
| `imageHash` | Non-zero. Hash of the source image, recorded so the board names what it sells |
| `zones` | Optional, may be empty. §4a |
| `kept` | Optional, may be empty. §4a |
| `terms` | `takeBps`, `payoutBps`, `reversionBps`, `maxReversionWeeks`, `cooldownSecs`: how a sold cell is taken (§11), under `TermsLib.checkEconomicsAbsolute`'s clamps, which revert with its own errors |

The collection carries this as `abi.encode(Config)` (§1). Anything else reverts `InvalidConfig` or `ZeroAddress`. `initialize` records `msg.sender` as the
board's `collection`; a clone initialized by anyone else is not the collection's and cannot signal it.

## 4a. Zones and kept blocks (added 2026-10-11)

**Recorded reason**: a seller could set one price for every square, and could put their own logo on
the board only by buying it from themselves and paying the protocol's cut. Both are fixed at
creation, so neither weakens a buyer's promise that a first buy's price never rises (§2a).

- **A zone** is `(col, row, cols, rows, cellPrice)`: those cells cost `cellPrice` (a `uint192`)
  instead of the board's. Dearer or cheaper; never zero, never empty, inside the grid, and **zones
  never overlap**, so a cell has exactly one price. At most `MAX_ZONES` (512) — the chain's ceiling,
  not a product limit: each zone costs ~31k gas to create and ~3.5k on every buy, and at 512 both
  creating the largest board and the dearest buy the caps allow (§11.4) fit 4663's 32M cap with 1.2×
  headroom.
  Anything else reverts `InvalidConfig`. `zones()` reads them back in the order given; `ZoneSet`
  announces each.
- **A cell's creation price** is its zone's, or `cellPrice`. A free cell costs it at `priceBps`
  (§2a); a sold one is taken from it (§11.3). `quote(col, row, cols, rows)` prices a rectangle as
  `quoteBlocks` does (§6).
- **A kept block** is a rectangle recorded at `initialize` as an ordinary block owned by the board's
  creator — the `seller` `createBoardFor` names, never the caller — with ids from 1 in the order
  given. No money moves and the protocol takes nothing. It goes through the buy's own gate, so kept
  blocks that overlap revert `CellsTaken`, and one outside the grid `OutsideGrid`, empty
  `EmptyBlock`. `BlockKept(blockId, owner, col, row, cols, rows)` announces each. It is recorded at
  level 10,000 and **cannot be taken while the creator owns it** (`CellsKept`, §11.5); otherwise it
  is a block like any other (§7, §7a): a picture, an editor, a gift, a resale. It belongs to the
  creator, not the board's NFT: selling the board does not hand it over.
- A zone may lie over kept cells. Kept cells are never sold first-hand, so the zone's price applies
  to them only when they are taken after the creator lets the block go.

## 5. The grid

- `gridCols = width / cellSize`, `gridRows = height / cellSize`, counted from the top-left. The strip
  a whole cell does not fit is not for sale.
- **At most 256 columns** (a block id per cell, eight to a storage word, 32 words a row — §11.2)
  and **at most 1,000 rows**. One buy is bounded by words written and blocks taken (§11.4), not by
  the grid: the whole of a large grid is several buys.
- **A block is any rectangle of cells**, free or held (§11), up to the caps.
- **`buyError(rects)` is the one gate** (`blockError(col, row, cols, rows)` for one rectangle). It
  returns the selector the buy would revert with, in the buy's order (§11.4) — `EmptyBlock`,
  `OutsideGrid`, `CellsTaken` (two rectangles of one buy share a cell), `TooLarge`, `TooManyBlocks`,
  `CellsKept`, `CoolingDown` — or zero. Off-chain previews are a twin pinned by vectors the
  contract generates (`GenImageGridVectors.s.sol`).

## 6. Buying

**Changed 2026-10-11 — recorded reason**: a buyer who wanted an L-shape, or two separate spots, had
to buy each in its own transaction, each with its own signature and fee, and could end up with one
and not the other. A buy is now a list of rectangles, all or nothing. Each rectangle is its own
block, so a block stays a rectangle with one picture, and nothing about blocks (§7, §7a) changes.
One block made of several rectangles was considered and not chosen: drawing, cropping and resale
would all have to learn a new shape.

- **`buyBlocks(recipient, rects, maxTotal, deadline)`**, and **`buyBlocksWithPermit(recipient,
  rects, maxTotal, deadline, v, r, s)`**, which first tries an EIP-2612 `permit` for `maxTotal` — the
  total the buyer was shown and signed — with the buy's own deadline. A failed permit is ignored, so
  replaying it first cannot make the buy revert. Whatever the buy does not pull stays the payer's
  allowance, spendable only by their own buys. Returns the first block's id.
- **All or nothing.** The rectangles are taken in the order given, each through the gate (§5)
  against the board AND the rectangles before it in the list. The first that fails names the error.
  An empty list reverts `EmptyBlock`.
- **`recipient` is explicit**; zero reverts. **A price bound and a deadline** (since §11): a take
  can raise what a sold square costs while the buy is on its way, so the buy reverts `PriceTooHigh`
  above `maxTotal` and `DeadlineExpired` after `deadline`. `quoteBlocks(rects)` is exactly what it
  pulls, and reverts with the gate's error rather than price a refusal.
- **Each block is priced and cut as if bought alone** (§11.3): its free part and every block it
  takes from, its own protocol cut rounded down. Splitting a buy never changes what any one block
  credits.
- Effects: for each rectangle in order, credit and shrink every block it takes from (§11.4), mark
  the cells, record the block (owner `recipient`, version 0, its level and time) and emit its
  `BlockBought`; then credit the holder and the protocol once, pull the total from `msg.sender`
  once, and signal the collection once. Re-entrancy is guarded.
- Block ids run from 1 per board, consecutive within a buy. `blockCount` is the last one.
- One buy writes at most `MAX_WORDS_PER_BUY` cell words and takes from at most
  `MAX_BLOCKS_TAKEN_PER_BUY` blocks (§11.4).

## 7. Blocks

- **A block is a record, not a token**: `ownerOf(blockId)` (zero for an id never sold), its
  rectangle, `contentHash` and `version`, and since §11 its `level`, `boughtAt` and `cellsLeft` —
  what a take of it is priced from, and how many cells of its rectangle are still its own. Its
  rectangle never changes; a take only lowers `cellsLeft`.
- **`transferBlock(blockId, to)`**: the owner alone, to anyone but zero. There are no approvals — a
  block is given, not traded — and the board's holder has no power over it.
- **Content**: `edit(blockId, contentHash)` by the owner or the one editor they name (`setEditor`, or
  `setEditorWithSig` with an EIP-712 `EditorGrant(blockId, editor, nonce, deadline)` signed by the
  owner; domain name `Image Board`, version 1, the board as `verifyingContract` — a name with no
  product in it, since 2026-10-12). ERC-1271
  owners are accepted. **A grant dies on transfer**, including A→B→A.

## 7a. Resale (added 2026-10-11)

A block is resold **whole**, inside the board. There is no partial sale and no token, so no
marketplace lists a block.

- **`listBlock(blockId, price)`**: the owner alone; `price` non-zero (`InvalidPrice`) — zero means
  not for sale. Calling it again changes the price. `delistBlock(blockId)`: the owner alone, and
  `NotListed` when there is nothing to take down. `listPrice(blockId)` reads it.
- **`buyListedBlock(blockId, recipient, expectedPrice)`**, and `buyListedBlockWithPermit(…)`, which
  first tries a permit for exactly `expectedPrice` (a failed permit is ignored, as on a first buy).
  `recipient` explicit, zero reverts. `NotListed` when it is not for sale; **`PriceChanged` when
  the listed price is not `expectedPrice`** — unlike a first sale's, a listing's price can move
  while the buy is on its way, so the buyer names the price they agreed to.
- **The split**, `resaleSplit(price)`: the protocol's cut at `protocolBps`, a royalty of
  `RESALE_ROYALTY_BPS` (500, a constant) to **whoever holds the board's NFT at that moment**, and
  the rest to the block's owner. Both shares round down; the owner's remainder makes the three sum
  to the price exactly. The implementation's constructor refuses a `protocolBps` that leaves no
  room for the royalty (`protocolBps + 500 > 10,000`).
- **Every change of a block's owner** — a gift or a resale — ends its editor grant and its listing,
  and so does **a take of any of its cells** (§11), which emits `BlockDelisted`. A listing therefore
  only ever names the price its current owner set for what the block is now; handing a block back
  (A→B→A) does not revive one. A block with no cells left cannot be listed (`NothingLeft`).
- A resale changes who owns the block and nothing else: cells, shape, `contentHash`, `version`,
  `level` and `boughtAt` stay. It does not signal the collection — the board's picture has not
  changed.

## 8. Money

- **Pull ledger.** A buy credits every displaced owner their payout (§11.3), the protocol its cut,
  and the board's holder at that moment the rest — `total − cut − payouts`, block by block (§6). A
  resale credits as §7a.
- `withdrawFor(account)` is permissionless and always pays `account`; it is the only function that
  sends value.
- A sale of the BOARD's token on a marketplace is the marketplace's: one that honours ERC-2981 pays
  the creator 5%. A block's resale is §7a and never leaves the board.

## 9. Events

Collection: `BoardCreated(seller, board, tokenId, creator)`, `TokenAllowed`, `BaseURISet`,
`MetadataUpdate`, `BatchMetadataUpdate`, and ERC-721's `Transfer`/`Approval`. Board:
`BoardInitialized(collection, boardTokenId, settlementToken, gridCols, gridRows, cellPrice)`;
`ZoneSet(index, col, row, cols, rows, cellPrice)` and `BlockKept(blockId, owner, col, row, cols, rows)`
at creation; `CellsLost(fromBlockId, toBlockId, owner, cells, payout)` once per covered block per
rectangle, before the new block's `BlockBought(blockId, payer, recipient, col, row, cols, rows, total,
protocolCut, seller)` — `seller` is who was credited the rest, one per block of a buy, each with its
own `total` and `protocolCut`;
`PricesLowered(holder, priceBps)`; `BlockTransferred(blockId, from, to)` on EVERY change of owner, gift or
resale; `BlockListed(blockId, owner, price)`; `BlockDelisted(blockId, owner)`;
`BlockResold(blockId, payer, recipient, blockSeller, price, protocolCut, royalty, boardHolder)`, after
the `BlockTransferred` it caused; `BlockEdited`; `EditorSet`; `Withdrawn`.

## 10. Tests

`test/ImageBoard.t.sol`, `test/ImageBoardResale.t.sol`, `test/ImageBoardZones.t.sol`,
`test/ImageBoardMultiBuy.t.sol`, `test/ImageBoardPriceCut.t.sol` and `test/ImageBoardTakeovers.t.sol`
(unit, every rule at its boundary; §11.8) and
`test/ImageBoard.invariant.t.sol`,
with `test/ImageBoardBase.t.sol` shared. The invariants: no cell is in two blocks; money in equals the
holders' credits plus the protocol cut; every sale credits whoever held the board then; the owner is
`recipient`; nobody but a block's owner moves it — not the board's holder, not its editor; a
listing is only ever its current owner's and ends when the block changes hands; a resale goes through
only at the price the buyer named and credits owner, board holder and protocol exactly that price.
Since §4a the invariant board has three zones (one over a kept block) and a kept block, and the model
prices each buy cell by cell from its own map while the contract sums overlaps per zone. Since §2a
and the list buy (2026-10-11): buys of two rectangles, a third of them overlapping each other on
purpose, are decided by the model as a whole; the holder (and, to be refused, anyone else) lowers
prices; the model scales each block by its own share, rounding up by a different formula, and the
board's `priceBps` must equal it after every call.

## 11. Takeovers — added 2026-10-14

**Recorded reason**: a board had nothing left to sell once its squares were gone, so it stopped
earning, and the contest that page slots and bots have — anyone may take what someone else holds,
at a price that pays them — was missing. Decided with the operator: **every board has takeovers,
as every page slot does**; **kept squares cannot be taken**; **a take on a listed block ends the
listing**; **the cap on a buy's size is set from gas measurements**. This reverses §2's *a block
moves only by its owner's act* and the 2026-10-07 decision *no takeovers*; §§2–10 are written to
agree with it.

### 11.1 What a take is

- **Any cell may be bought**, free or sold, except a kept one and one still in its cooldown. A buy
  is still a list of rectangles, each its own block (§6), and a rectangle may now cover free cells,
  sold cells, or both.
- **A take is a new block on top.** The cells it covers become the new block's; every block it
  covered keeps its record, its picture and its owner, and loses those cells. A block's visible
  part is the cells still marked with its id. Drawing oldest first and newest last gives the
  picture; nothing needs to know a block's shape but its own rectangle.
- A block that loses every cell still exists, owns nothing on the picture, and can be neither
  listed nor resold (`NothingLeft`).
- **The board's holder has no new power.** Nobody chooses who may take, and nothing pauses it.

### 11.2 State

- **Who holds each cell**: a block id per cell, `uint32`, eight cells to a storage word (column `c`
  in word `c / 8`, lane `c % 8`), so a row of 256 cells is 32 words. Zero is a free cell. This
  replaces the row bitmap; `cellRow(row)` reads a row's words, `rowBits(row)` is now a view computed
  from them (a bit per held cell), and `freeCells` counts the cells no block holds. Ids stop at
  2^32 − 1 (`InvalidConfig` past it).
- **A block's level and time**, packed into the existing `Block` word with its rectangle and
  version: `level` (`uint96`, in bps of its cells' creation prices), `boughtAt` (`uint40`), and
  `cellsLeft` (`uint24`).
- **The board's terms**, chosen by the creator and frozen at `initialize`, under the same clamps
  as `SlotSite` (`TermsLib.checkEconomicsAbsolute`): `takeBps`, `payoutBps`, `reversionBps`,
  `maxReversionWeeks`, `cooldownSecs`. Decided 2026-10-14: the creator picks, as a page board's
  publisher does; the platform offers the page slots' profiles and asks, with no default.
- **`creator`**, the `seller` `createBoardFor` named (§11.5).

### 11.3 Price

**A cell's creation price** is its zone's `cellPrice`, or the board's (§4a). The sum of a set of
cells' creation prices is their **base**.

**A block's level** is what it cost divided by its base, in bps, rounded UP: a first buy at full
price is 10,000, a first buy after a cut is `priceBps`, and a take records whatever it paid. Every
cell of a block is worth its own creation price times its block's level — so zones keep pricing
position after a take, and a level averages only within one block.

For the cells of one rectangle that block `b` holds now, with base `B`:

- `floorLevel` is the second result of `Pricing.computeTakePrice(level_b, 10_000,
  weeksSince(boughtAt_b), reversionBps, takeBps, maxReversionWeeks)` — the page slots' own
  function. The level reverts weekly toward 10,000 and never below it.
- **Charged** `B × floorLevel × takeBps / 10⁸`, from the floor directly and not from a rounded take
  level, so that charged ≥ payout + protocol holds for every part. **Displaced owner** credited
  `B × floorLevel × payoutBps / 10⁸`. **Protocol** `B × floorLevel × protocolBps / 10⁸`. **The board's holder at that moment**
  the rest. `payoutBps ≥ 10,000` (the clamp), so a displaced owner always receives at least the
  floor of what they lose.
- **The floor is the creation price, never the cut one.** `priceBps` (§2a) applies to free cells
  only — *a cut touches nothing already sold* stays true. A buyer who bought after a cut is still
  paid against the full creation price when taken.

Free cells in the same rectangle cost what they do today: their base at `priceBps`, split as a
first sale (§8). A rectangle's price is the sum over its free part and each block it covers; its
new block's level is that price over the rectangle's whole base.

**Pricing reads the cell map.** A rectangle's cells get their creation prices once — each zone
painted over its overlap, so the cost is cells plus zones, never cells times zones — and are walked
row-major in runs of one block id; each covered block is tallied once per rectangle however many
runs it appears in. The SDK's twin reads the same map through `cellRow`.

### 11.4 Buying

- **`buyBlocks(recipient, rects, maxTotal, deadline)`** and the permit variant. Prices can now RISE
  between quoting and mining — someone takes the same cells first — so the buy names the most it
  will pay (`PriceTooHigh`) and a deadline (`DeadlineExpired`), as `SlotSite.buy` does. §6's *no
  price bound and no deadline* is withdrawn.
- **The gate is `buyError(rects)`**, and the buy reverts with exactly its answer, checked in the
  same order: an empty list `EmptyBlock`; then rectangle by rectangle, its shape (`EmptyBlock`,
  `OutsideGrid`), `CellsTaken` if it shares a cell with an EARLIER rectangle of the same buy (sold
  cells are no longer an error), `TooLarge` past the word cap, then in the order its cells are met,
  `CellsKept` (§11.5), `CoolingDown` (a covered block bought less than `cooldownSecs` ago) and
  `TooManyBlocks` past the block cap. `quoteBlocks(rects)` is what the buy pulls, and reverts with
  the gate's answer rather than price a refusal. `blockError` and `quote` are both for one
  rectangle.
- **The caps, set from cold gas measured in `ImageBoardTakeovers.t.sol`** (2026-10-14), each under
  4663's 32M per transaction with 1.2× headroom (26.7M):
  - **`MAX_WORDS_PER_BUY` = 512 cell words**, across the buy's rectangles: each row of a rectangle
    counts the words its columns span. Words, not cells, because the word is what a buy pays for —
    measured with no zones, a 1 × 1,000 column (1,000 words) cost 25.6M and a 256 × 16 strip (512
    words, 4,096 cells) 15.6M. A cell cap that held for every shape would have stopped near 700
    cells; 512 words allow a 64 × 64 square or a 256 × 16 strip, and a column only 512 tall. The
    whole-grid buy of §5 ends here.
  - **`MAX_BLOCKS_TAKEN_PER_BUY` = 88** (128 until rentals, §12), counted once per rectangle: each
    costs a credit, a count, perhaps a delisting, an event — and, if rented, settling and refunding
    its tenancy.
  - Measured under `MAX_ZONES` (512, unchanged): a fresh 256 × 16 buy 18.7M; a fresh 8 × 512 buy,
    every row its own zone, 19.3M; the worst take — 512 words, 88 blocks each a year old, each with
    an owner never credited before, each rented to its own tenant and offered for rent and for
    resale — 26.0M, under the 26.67M bound (32M with 20% headroom). At 92 it was 26.4M; at 96, 26.7M.
- Effects per rectangle: price each part, credit each displaced owner, decrement each covered
  block's `cellsLeft`, end each covered block's listing, write the cells, record the new block with
  its level and `boughtAt`, emit. Then one pull, one `boardChanged`.

### 11.5 Kept squares

**Never taken while the creator owns them.** A kept block's ids are `1..keptCount`, so a cell
whose id is at most `keptCount` and whose block the creator still owns refuses the buy with
`CellsKept`. Decided 2026-10-14: the protection ends when the creator gives or resells the block
(it is then an ordinary block: a kept block's level is 10,000 and its `boughtAt` the board's
creation, and neither a gift nor a resale changes either, for any block), and comes
back if it returns to them — the reason for kept squares is the creator's own logo, and squares
protected forever would become a thing to sell.

### 11.6 Events

`BlockBought` as today, its `total` the whole rectangle's. New: **`CellsLost(fromBlockId,
toBlockId, owner, cells, payout)`** once per covered block per rectangle, before the new block's
`BlockBought` — the watcher tells the displaced owner from it. A listing ended by a take emits
`BlockDelisted`.

### 11.7 Decided with it (2026-10-14)

1. **Terms are the creator's**, from the page slots' profiles (§11.2).
2. **Kept squares are protected only while the creator owns them** (§11.5).
3. **No ask, no renting** on image boards: page slots' `setAsk` and rentals are not carried over.
   Resale (§7a) stays as the way to sell below the take price.

### 11.8 Tests

`test/ImageBoardTakeovers.t.sol`: every rule at its boundary — one take to the unit, reversion at
the week's edge, the floor at the creation price, a take across two blocks and free cells, a block
met twice in one rectangle, the cooldown's last second, kept squares while given away and back, a
take ending a listing, nothing left to list, a cut touching nothing sold, `maxTotal` and the
deadline exact, both caps at their edge, the id guard, the terms' clamps — and the gas the caps are
set from. The invariant suite's model keeps its own cell map, levels, times and clock; it prices
each covered block cell by cell with its own reversion loop and measures every party's credit
across every buy. 30 contract mutations, each caught by the unit tests; three of them (a payout one
unit high, kept squares protected forever, no reversion) also caught by the invariant suite alone.
The SDK's twin (`buyError`, `quoteBlocks`) is pinned by `GenImageGridVectors.s.sol`, which builds a
board by real buys and takes at real times and buys every list case for real on a snapshot.

## 12. Renting a block — added 2026-10-20

**Recorded reason**: a block earned its owner nothing while held — only a take or a resale paid. A
term lets an owner earn from a block while keeping it, and gives an advertiser a placement without
buying. Page boards' rentals (`PROTOCOL-SPEC.md` §2) are the model, changed where a block differs
from a page slot.

### 12.1 What is kept from page rentals

- An owner offers a block at a daily rate for terms up to a longest one (`listForRent`, owner only,
  while the block holds a cell; a rate of zero ends the offer). Terms run from `MIN_RENTAL_DURATION`
  (1 hour) to `MAX_RENTAL_TERM` (365 days), in seconds; the rate is per day.
- A term is paid up front by whoever calls `rent(blockId, tenant, durationSecs, expectedRatePerDay)`
  — the tenant is NAMED — at exactly the rate the payer agreed to (`RateChanged` otherwise). The rest
  after both cuts is held by the board and **streams to whoever owns the block** linearly from the
  term's start to its end. `claimRent(ids)`, permissionless, credits each owner what has streamed.
- `extendRental`, the tenant only, during a live term: the term becomes `durationSecs` from now at
  the CURRENT rate; what was paid and has not streamed rolls into it (settle, then restart).
- Any change of owner (`transferBlock`, a resale) first credits the old owner what streamed, and
  ends the rent offer; the tenancy survives. `owner == tenant` is legal. Cooldowns do not apply.

### 12.2 What differs, and why

- **Fixed split**: 5% to the protocol (`protocolBps`), 5% to whoever holds the board's NFT at that
  moment (`RENT_ROYALTY_BPS`), the rest escrowed — as a resale's. There is no publisher's dial.
- **The tenant's picture is held apart** (`Rental.tenantHash`, set by `editRented`). `shownHash`
  is the tenant's while the term is live and they have chosen one, the owner's `contentHash`
  otherwise — so a term ends by itself, at `expiry`, with no transaction: no `endRental`, no keeper,
  and no lockout of the owner, who may change their own picture during a term. A new term may start
  the moment one lapses; it starts with no tenant picture.
- **A take does not end a tenancy; it shrinks it.** A take of `lost` of a rented block's `before`
  cells credits the owner what has streamed, refunds the tenant `unstreamed × lost / before`
  (rounded down), and streams the rest from now to the same end over the cells left. A take ends the
  block's rent offer, rented or not — as it ends a resale listing.
- **No rate floor.** On a page board a self-rented slot could not be edited by whoever took it, so
  `PROTOCOL-SPEC.md` §2.1 needs a floor. Here a take makes a new block its taker edits freely; a
  tenancy never stands in a taker's way.
- **A rental ends any resale listing**, so a buyer's `expectedPrice` never buys a block whose term
  they were not shown.

### 12.3 State and events

```solidity
struct RentListing { uint192 ratePerDay; uint64 maxDurationSecs; }
struct Rental { address tenant; uint40 start; uint40 expiry; uint128 prepaid; uint128 claimed; bytes32 tenantHash; }
mapping(uint256 => RentListing) public rentListing;   // rentalOf(id) reads the Rental
```

`RentListed(blockId, owner, ratePerDay, maxDurationSecs)` (zero rate: ended), `BlockRented(blockId,
tenant, payer, expiry, cost)`, `RentalExtended(blockId, tenant, expiry, cost)`, `RentClaimed(blockId,
owner, amount)`, `RentRefunded(blockId, tenant, cells, amount)`. A tenant's picture emits
`BlockEdited` with the tenant as editor. Errors: `NotForRent`, `RateChanged`, `TermTooLong`,
`RentalActive`, `RentalExpired`, `NotTenant`.

### 12.4 Tests

`test/ImageBoardRentals.t.sol`: every rule at its boundary, money measured across each call; 23
mutations of the rules, all caught (two after tests were strengthened, one of them finding that a
take left an unrented block's offer standing). The invariant suite models every tenancy, offer and
shown picture, and measures every party's credit across rentals, extensions, claims, takes, gifts
and resales; the board holds what it owes plus what is still streaming.

## 13. The token generation — decided 2026-10-21, deployed on both chains

**Recorded reason**: in §1–§12 a block is a record no wallet or marketplace can see, its picture is
drawn and served by whoever runs the board's metadata host, and the token's metadata is
`baseURI ++ id` on that host. Trading was already open to anyone who calls the contract, but holding,
showing and trading a block depended on one operator. This generation makes every block a token
anyone can see and trade, computes metadata on chain, and addresses every picture by its hash on
IPFS, so a board and its blocks work with no particular operator.

This reverses §1's *a block is not a token* (decided 2026-10-09) and §7's *there are no approvals*.
The reason for the first was that a token per block in ONE shared collection put hundreds of
unrelated pictures into one marketplace listing; here each board is its own collection, so a board's
blocks are listed together and nothing else is.

### 13.1 Shape

- **The Boards collection** (a new `ImageBoardCollection`): one ERC-721 with a token per board,
  minted to `seller` at `createBoardFor` as in §1. Name and symbol are constructor arguments, as
  today. It records each token's board (`boardOf(token)`), and its `tokenURI(token)` returns that
  board's `boardURI()` (reverting for a token never minted). Its own collection metadata,
  `contractURI()`, is a constructor argument, fixed at deployment.
- **A board is a collection**: `ImageBoard` is an ERC-721 whose tokens are its blocks, token id =
  block id (from 1). It exists from `createBoardFor` but holds no token until its first sale.
- **The extension** (`ImageBoardExtension`): rentals (§12's entry points) and creation
  (`initialize`, zones) run as code the board DELEGATECALLs, because the board with this section's
  surface does not fit EIP-170 alone (measured 2026-10-21: 27,812 B; 20,893 B with these moved).
  Its address is an immutable of the implementation. Both contracts inherit ONE storage base
  (`ImageBoardStorage`), so their layouts cannot drift. The board keeps one explicit forwarding
  function per moved function, so its own ABI is complete. The extension holds no funds of its own:
  run by delegatecall it pulls rent and credits ledgers in the board's storage. Called directly it
  touches only its own storage, which holds nothing.
- **The renderer** (`ImageBoardRenderer`): a view-only contract that builds every metadata string
  (§13.8). Its address is an immutable of the implementation, so nobody can change how an existing
  board's metadata reads. Its deploy arguments are `thumbnailBase` and `rendererPage` (§13.8).

### 13.2 Powers

- **Nobody has power over an existing board, its blocks, its money or its metadata.** §2's first
  point stands, with "by its owner's act" now including an approval its owner gave (§13.4).
- **The Boards collection's owner has two powers**, both over boards not yet created:
  `setImplementation` and `allowToken`, as in §2. **`setBaseURI` is gone**: metadata is computed on
  chain. The protocol fee and treasury are implementation immutables, as today.
- **Ownership moves only by the two-step handover** (`requestOwnershipHandover` by the new owner,
  then `completeOwnershipHandover` by the current one within 48 hours). The one-step
  `transferOwnership` and `renounceOwnership` revert, so ownership can be neither sent to a mistyped
  address nor thrown away.

### 13.3 Configuration

As §4, except:

| Field | Rule |
|---|---|
| `name` | 1 to 100 bytes. Shown as is, escaped for JSON by the renderer; not checked for UTF-8 |
| `description` | 0 to 1,000 bytes; optional |
| `sourceCid` | The source image's IPFS address as binary CID bytes: 1 to 64 bytes, a CIDv1 (first byte `0x01`). The protocol cannot check that it addresses the image; renderers check what they fetch against `imageHash` (§13.7) |
| `imageHash` | `sha256` of the source image's bytes (§13.7) |
| `kept` | **Removed**, with kept blocks (§4a), `BlockKept`, `keptCount` and `CellsKept` (§11.5). A creator who wants their own spot buys it after creation, like anyone else, and it can be taken like any other block |

Anything else reverts `InvalidConfig`, as today.

### 13.4 Blocks are tokens

- **ERC-721** in full: `balanceOf`, `ownerOf` (reverts `NoSuchBlock` for an id never sold, as the standard requires;
  §7's zero-for-unsold reading moves to `blockOf`), `approve`, `getApproved`, `setApprovalForAll`,
  `isApprovedForAll`, `transferFrom`, both `safeTransferFrom`s, and ERC-721 metadata (`name`,
  `symbol`, `tokenURI`).
- **A buy mints** each new block to `recipient` (§6), without the receiver callback, so a buy to a
  contract can be neither refused nor re-entered by it. The `Transfer` from zero is emitted where
  `BlockBought` is.
- **Every change of owner goes through one path** (a transfer, a gift, a resale through §7a): it
  credits the old owner the rent streamed so far (§12.1), ends the rent offer, the resale listing
  and the editor grant, clears the token's approval, moves the balance, and emits `Transfer`. The
  tenancy survives (§12.1). A transfer to oneself is allowed by the standard and does the same.
- **Who may transfer**: the owner, the token's approved address, or an operator the owner approved
  for all; anyone else reverts `NotAuthorized`. `to` of zero reverts `ZeroAddress`; a `from` that is
  not the owner reverts `NotBlockOwner`. Transfers are guarded against re-entrancy, and
  `safeTransferFrom` calls `onERC721Received` after the state has moved (`UnsafeRecipient` on a
  wrong answer).
- **An approval moves a block and nothing else.** Editing (`canEdit`), naming an editor, listing,
  offering for rent and lowering prices are unchanged: an approved address can do none of them.
- **`transferBlock` and `BlockTransferred` are gone**: `transferFrom` and `Transfer` replace them.
- **A block with no cells left is still a token** (decided 2026-10-21): it can be held and moved,
  shows nothing on the board, and still cannot be listed (`NothingLeft`).
- **`name()`** is the board's name. **`symbol()`** is the Boards collection's `symbol()` followed by
  `-` and the board's token id (e.g. `XYZ-12`), read from the collection, so no brand is a literal
  in this contract.
- **`owner()`** (ERC-173) is `seller()`: whoever holds the board's token manages the collection's
  page where a marketplace offers that. It grants no power in this contract.

### 13.5 Standards

- **ERC-2981**: a block's `royaltyInfo` pays `RESALE_ROYALTY_BPS` (500) to `seller()` at the moment
  of the query. A marketplace may ignore it; a resale through §7a always pays it. The board's token
  keeps §3's royalty to its creator.
- **ERC-4907, read side**: `userOf(id)` is the tenant while a term is live (zero otherwise),
  `userExpires(id)` the term's end (zero for none). `UpdateUser` is emitted when a term starts and
  when it is extended. `setUser` reverts (`NotAuthorized`): a user is made only by a paid term
  (§12). **Unlike ERC-4907's reference, the user survives a transfer**, because the tenancy does
  (§12.1).
- **ERC-4906**: `MetadataUpdate(blockId)` whenever what a block's metadata says changes: an edit or
  a tenant's edit, a term starting or extended, each block a take shrinks, and `poke` (§13.6). A
  mint or a transfer emits `Transfer`, which marketplaces read. The board's own token gets
  `MetadataUpdate` from the collection through `boardChanged()` whenever `changes` moves (§13.6).
- **ERC-5646**: `getStateFingerprint(id)` is `keccak256(abi.encode(cellsLeft, contentHash,
  shownHash, tenant, expiry, listPrice, ratePerDay, maxDurationSecs))`. An order that names it
  cannot be filled after a take, a new picture, a term or a change of listing. It does not cover the
  take price, which changes weekly by the clock (§11.3) with no transaction.
- **ERC-7572**: `contractURI()` is the board's collection metadata (§13.8).
- **ERC-165** for ERC-721, its metadata extension, ERC-2981, ERC-4907, ERC-4906 and ERC-5646. Not
  ERC-173: `owner()` is its read, but there is no `transferOwnership` — the owner moves only with
  the board's NFT.

### 13.6 The change counter and `poke`

- **`changes`** counts the changes that alter the drawn board: once per buy (however many
  rectangles), once per edit or tenant edit, once per `poke`. Each also calls `boardChanged()`.
- **A term that lapses changes the drawn board with no transaction** (§12.2). `poke(blockId)`, by
  anyone, once per term, after the term has ended and only if a tenant's picture was showing: it
  bumps `changes`, calls `boardChanged()` and emits `MetadataUpdate(blockId)`. Otherwise it reverts
  `NotLapsed`. The once-per-term mark is cleared when a new term starts.

### 13.7 Pictures: hashes and addresses

- **`contentHash` and `tenantHash` are `sha256` of the picture's own bytes** (WebP, PNG or JPEG),
  with no envelope, so each IS an IPFS address: the CIDv1 of a raw block with a sha2-256 multihash,
  the 36 bytes `0x01 0x55 0x12 0x20 ‖ hash`, written `b` followed by their RFC 4648 base32,
  lowercase, without padding (`bafkrei…`). A picture is ONE raw block, so at most 1 MiB; a bigger one
  has no address its hash names. The contract never hashes, as before; this is how every reader
  turns a hash into an address.
- **The source image is too large to be one block**, so its address is `sourceCid` (§13.3) and its
  hash `imageHash`. A renderer that fetches the source checks `sha256` of the bytes against
  `imageHash`, and of a block's picture against its hash, and draws nothing it cannot match.
- **Pinning is not the protocol's**: a picture shows wherever someone keeps it available on IPFS. A
  hash on chain whose bytes nobody serves draws nothing.

### 13.8 Metadata

Built by the renderer as `data:application/json;base64,…`, every string escaped for JSON.
`tokenURI` reverts for an id never sold.

| | `name` | `image` | `animation_url` | attributes |
|---|---|---|---|---|
| The board's token (Boards collection) | the board's name | `thumbnailBase ‖ boardTokenId ‖ "?v=" ‖ changes`: the composite drawn by whoever serves `thumbnailBase`, at a new address after every change | `rendererPage ‖ "?chain=" ‖ chainid ‖ "&board=" ‖ address` | width, height, cell size, squares, squares free, blocks, settlement token, creator |
| The board's collection (`contractURI`) | the board's name | `ipfs://` + `sourceCid` | — | `description` when set |
| A block | the board's name, ` #`, the block id | `ipfs://` + the CID of `shownHash` (the tenant's picture during a term, else the owner's); omitted while there is none | the same page with `&block=` and the id: that block's squares still showing | column, row, columns, rows, squares, squares left, take price now (smallest units of the settlement token, the cost of taking every square it still holds), cooldown end (date), rented until (date, during a term), board |

- `thumbnailBase` and `rendererPage` (an `ipfs://` address of the reference renderer, §13.9) are
  the renderer's deploy arguments, fixed for every board of that implementation.
- **The take price is a reading, not a promise**: it falls weekly by reversion (§11.3) with no event,
  so a marketplace's cached copy goes stale. It never rises without a transaction.
- **The board's `image` depends on `thumbnailBase` being served**; its `animation_url`, the block
  `image`s and the collection's `image` depend only on the chain and IPFS.

### 13.9 The drawn board

What every renderer draws, and the reference renderer at `rendererPage` implements:

1. Read the board at one chain block: the grid, every block's rectangle and shown hash, and the
   cell map (`cellRow` for every row).
2. Start from the source image, all of it, the strip no whole cell fits included.
3. For every block in id order, for every cell the cell map gives to that block, lay the block's
   shown picture over that cell's pixels, source-over with straight (unpremultiplied) alpha. The
   picture covers the block's whole rectangle: at exactly the rectangle's size in pixels, or at half
   of each side rounded to the nearest pixel (at least 1), scaled up to it. **The scaling filter is
   the renderer's**, so two renderers may differ slightly on a half-size picture.
4. A block with no picture, a picture not available, or one whose bytes do not match its hash is
   not drawn: the source shows there.

The reference renderer's source is `packages/websitekit-sdk/renderer/` (`pnpm build:renderer`
writes the one file that is pinned).

This defines what is drawn, not a byte-identical file: decoders and encoders differ, and no render
hash is recorded on chain. A renderer may draw less than this (a front end applying its own policy);
it may not draw a block on cells the cell map does not give it.

### 13.10 Events

As §9, except: ERC-721's `Transfer`, `Approval` and `ApprovalForAll` on the board; `Transfer` replaces
`BlockTransferred` and comes before the `BlockResold` it caused; `BlockKept` is gone; ERC-4906
`MetadataUpdate` and ERC-4907 `UpdateUser` on the board (§13.5); `BaseURISet` and `BatchMetadataUpdate`
are gone from the collection. **ERC-721 and ERC-20 `Transfer` share their first topic**: a reader
tells them apart by the emitting address, never by the topic.

### 13.11 Tests

Everything in §10–§12.4 carried over, plus: an ERC-721 conformance suite; every transfer path at its
boundary (owner, approved, operator, stranger, to zero, to self, to a contract that refuses);
invariants that balances sum to the blocks each address owns, that an approval dies with every
change of owner, that a transfer by an operator settles rent exactly as a gift does (money measured
across the call), and that no approved address can edit, list or offer a block; the CID encoding as
a fixture shared with the SDK; `poke` once per term at the second it lapses; the metadata strings
parsed as JSON for names with quotes, backslashes and control characters; the extension's storage
layout checked against the board's; and gas for the worst buy and the worst take measured cold
again under §11.4's bound.
