# Image boards — contract spec

`ImageBoardCollection.sol` and `ImageBoard.sol`. The second kind of board: one uploaded image, sold
as rectangles of square cells. **Each board is one ERC-721 token; a block is not a token** (decided
2026-10-09). `PROTOCOL-SPEC.md` describes the first kind (`SlotSite`, regions of a publisher's own
page); nothing here changes it, and the two share no code or storage.

**Status: unaudited**, like the rest of the protocol. Outside the frozen core, like the escrow
contracts. Changes to this document need a recorded reason, as `PROTOCOL-SPEC.md`'s do.

**Why the board and not the block.** A token per block made one board hundreds of marketplace
listings of unrelated pictures. One token per board is one listing whose picture is the whole board,
every block's picture in it.

## 1. Shape

- **`ImageBoardCollection`** is an ERC-721 (Solady) whose name and symbol are constructor arguments,
  fixed at deployment and chosen by whoever deploys it (changed 2026-10-12: the protocol's source
  names no product, as `SlotSite`'s name and symbol are `createSite` arguments; both must be
  non-empty, `EmptyName`). Its
  `createBoardFor(seller, config)` clones one `ImageBoard` implementation (EIP-1167), initializes it,
  and mints the board's token to `seller`, in one transaction — so no uninitialized clone exists for
  anyone else to claim. Tokens run from 1.
- **`ImageBoard`** holds one board: the grid, the blocks, the money. It knows its `collection` and
  its `boardTokenId`. Verifying the implementation once verifies every board.
- **The implementation's constructor takes `protocolBps` and `protocolTreasury`** as immutables, so a
  clone cannot strip them. The deploy script reads both from the live `SlotSite` implementation and
  refuses anything but 500 bps.

## 2. Powers

- **Nobody has power over a board, except to make its free squares cheaper.** Once created, the
  grid, the zones' shapes and the take terms are frozen; nothing pauses, nothing upgrades. A block
  changes owner only by its owner's act — `transferBlock`, or a sale of the listing they put up
  (§7a) — and loses cells only to a buy that pays its owner for them (§11). Whoever holds the
  board's token may lower every free square's price and never raise it (§2a).
- **The collection's owner has exactly two powers**: `allowToken` (which settlement tokens NEW boards
  may use) and `setBaseURI` (where token metadata is fetched from, so its host can move domains;
  it emits ERC-4906 `BatchMetadataUpdate(1, max)`). It has no reach into a board, its blocks or its
  money.
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
| `cellSize` | 10, 15 or 20 |
| `cellPrice` | Non-zero, in the token's units. What a square costs now is this at `priceBps` (§2a) |
| `imageHash` | Non-zero. Hash of the source image, recorded so the board names what it sells |
| `zones` | Optional, may be empty. §4a |
| `kept` | Optional, may be empty. §4a |
| `terms` | `takeBps`, `payoutBps`, `reversionBps`, `maxReversionWeeks`, `cooldownSecs`: how a sold cell is taken (§11), under `TermsLib.checkEconomicsAbsolute`'s clamps, which revert with its own errors |

Anything else reverts `InvalidConfig` or `ZeroAddress`. `initialize` records `msg.sender` as the
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

## 11. Takeovers — added 2026-10-14, deployed on testnet

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
  - **`MAX_BLOCKS_TAKEN_PER_BUY` = 128**, counted once per rectangle: each costs a credit, a count,
    perhaps a delisting, and an event.
  - Measured under `MAX_ZONES` (512, unchanged): a fresh 256 × 16 buy 18.7M; a fresh 8 × 512 buy,
    every row its own zone, 19.3M; the worst take — 512 words, 128 blocks each with an owner never
    credited before, each listed and a year old — 23.5M.
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
