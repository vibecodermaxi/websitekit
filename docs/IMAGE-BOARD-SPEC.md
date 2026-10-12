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

- **Nobody has power over a board, except to make its unsold squares cheaper.** Once created, the
  grid and the zones' shapes are frozen; nothing pauses, nothing upgrades; a block moves only by its
  owner's act — `transferBlock`, or a sale of the listing they put up (§7a). Whoever holds the
  board's token may lower every unsold square's price and never raise it (§2a).
- **The collection's owner has exactly two powers**: `allowToken` (which settlement tokens NEW boards
  may use) and `setBaseURI` (where token metadata is fetched from, so its host can move domains;
  it emits ERC-4906 `BatchMetadataUpdate(1, max)`). It has no reach into a board, its blocks or its
  money.
- **`createBoardFor` is permissionless** and the seller signs nothing. That grants nothing to the
  caller: `seller` is explicit and receives the token.

## 2a. Lowering prices (added 2026-10-11)

**Recorded reason**: a board priced too high had no way to find its price — the seller had no
powers at all, so a slow board stayed slow. A cut that only ever goes down keeps the promise a first
buy rests on: the price a buyer is shown is the most they will pay, so a buy still needs no price
bound and no deadline. Raising prices, per-zone cuts and a price that falls on a schedule were
considered and not chosen.

- **`priceBps`** is what share of the prices set at creation an unsold square costs now: 10,000 at
  creation. **`lowerPrices(newPriceBps)`**: whoever holds the board's token at that moment
  (`seller()`), else `NotBoardHolder`; `newPriceBps` above zero and below `priceBps`, else
  `InvalidPrice`. It only ever falls. `PricesLowered(holder, priceBps)` announces it.
- **One share for the whole board**: the board's own `cellPrice` and every zone's are scaled alike.
  `cellPrice` and `zones()` keep reading the prices set at creation.
- **`quote` scales the whole block's price** — the sum of its cells' creation prices — by
  `priceBps` and **rounds up**, so no cut makes a block free: a block of one cell costs at least one
  unit. Scaling the block rather than each cell means splitting a buy can cost at most one unit more
  per block, never less.
- A cut touches nothing already sold: blocks, their owners, and the prices they list them at (§7a).

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

Anything else reverts `InvalidConfig` or `ZeroAddress`. `initialize` records `msg.sender` as the
board's `collection`; a clone initialized by anyone else is not the collection's and cannot signal it.

## 4a. Zones and kept blocks (added 2026-10-11)

**Recorded reason**: a seller could set one price for every square, and could put their own logo on
the board only by buying it from themselves and paying the protocol's cut. Both are fixed at
creation, so neither weakens a buyer's promise that a first buy's price never rises (§2a).

- **A zone** is `(col, row, cols, rows, cellPrice)`: those cells cost `cellPrice` (a `uint192`)
  instead of the board's. Dearer or cheaper; never zero, never empty, inside the grid, and **zones
  never overlap**, so a cell has exactly one price. At most `MAX_ZONES` (512) — the chain's ceiling,
  not a product limit: each zone costs ~31k gas to create and ~3–4k on every buy, and at 512 both
  creating the largest board and buying its whole grid fit 4663's 32M cap with 1.2× headroom.
  Anything else reverts `InvalidConfig`. `zones()` reads them back in the order given; `ZoneSet`
  announces each.
- **`quote(col, row, cols, rows)`** is the sum of each cell's price — position now matters — at
  `priceBps` (§2a). It says nothing about whether the cells are free (`blockError` does).
- **A kept block** is a rectangle recorded at `initialize` as an ordinary block owned by the board's
  creator — the `seller` `createBoardFor` names, never the caller — with ids from 1 in the order
  given. No money moves and the protocol takes nothing. It goes through the buy's own gate, so kept
  blocks that overlap revert `CellsTaken`, and one outside the grid `OutsideGrid`, empty
  `EmptyBlock`. `BlockKept(blockId, owner, col, row, cols, rows)` announces each. From then on it is a
  block like any other (§7, §7a): a picture, an editor, a gift, a resale. It belongs to the creator,
  not the board's NFT: selling the board does not hand it over.
- A zone may lie over kept cells. They are never sold first-hand, so its price never applies to them.

## 5. The grid

- `gridCols = width / cellSize`, `gridRows = height / cellSize`, counted from the top-left. The strip
  a whole cell does not fit is not for sale.
- **At most 256 columns** (a bitmap, one storage word per row) and **at most 1,000 rows**, so the
  whole grid is always one transaction: a buy costs about 22,631 gas per fresh row, and the largest
  grid measured 22.83M against chain 4663's 32M per-transaction cap.
- **A block is any rectangle of free cells**, from 1×1 to the whole grid.
- **`blockError(col, row, cols, rows)` is the one gate.** It returns the selector the buy would revert
  with — `EmptyBlock`, `OutsideGrid`, `CellsTaken` — or zero. Off-chain previews are a twin pinned by
  vectors the contract generates (`GenImageGridVectors.s.sol`).

## 6. Buying

**Changed 2026-10-11 — recorded reason**: a buyer who wanted an L-shape, or two separate spots, had
to buy each in its own transaction, each with its own signature and fee, and could end up with one
and not the other. A buy is now a list of rectangles, all or nothing. Each rectangle is its own
block, so a block stays a rectangle with one picture, and nothing about blocks (§7, §7a) changes.
One block made of several rectangles was considered and not chosen: drawing, cropping and resale
would all have to learn a new shape.

- **`buyBlocks(recipient, rects)`**, and **`buyBlocksWithPermit(recipient, rects, permitValue,
  deadline, v, r, s)`**, which first tries an EIP-2612 `permit` for `permitValue` — the total the
  buyer was shown and signed. A failed permit is ignored, so replaying it first cannot make the buy
  revert. A cut landing between signing and sending (§2a) only lowers what is pulled; the rest of
  the allowance stays the payer's, spendable only by their own buys. Returns the first block's id.
- **All or nothing.** The rectangles are taken in the order given, each through `blockError` against
  the cells sold AND the rectangles before it in the list, so two that share a cell revert
  `CellsTaken`. The first that fails names the error. An empty list reverts `EmptyBlock`.
- **`recipient` is explicit**; zero reverts. **No price bound and no deadline**: each block's price
  is `quote` of its rectangle (§4a, §2a), which can only have fallen since the buyer saw it; the
  only other thing that can change is whether the cells are free, and the buy refuses that.
- **Each block is priced and cut as if bought alone**: its own `quote`, its own protocol cut
  rounded down. Splitting a buy never changes what any one block credits.
- Effects: for each rectangle in order, mark the cells, record the block (owner `recipient`, version
  0) and emit its `BlockBought`; then credit the ledger once, pull the total from `msg.sender` once,
  and signal the collection once. Re-entrancy is guarded.
- Block ids run from 1 per board, consecutive within a buy. `blockCount` is the last one.
- There is no limit on how many rectangles one buy takes but the chain's gas.

## 7. Blocks

- **A block is a record, not a token**: `ownerOf(blockId)` (zero for an id never sold), its shape,
  `contentHash` and `version`.
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
- **Every change of a block's owner** — a gift or a resale — ends its editor grant and its listing.
  A listing therefore only ever names the price its current owner set; handing a block back
  (A→B→A) does not revive one.
- A resale changes who owns the block and nothing else: cells, shape, `contentHash` and `version`
  stay. It does not signal the collection — the board's picture has not changed.

## 8. Money

- **Pull ledger.** A sale credits each block's `total − cut` to the board's holder at that moment
  and its `cut = total × protocolBps / 10,000` to the protocol, block by block (§6). A resale
  credits as §7a.
- `withdrawFor(account)` is permissionless and always pays `account`; it is the only function that
  sends value.
- A sale of the BOARD's token on a marketplace is the marketplace's: one that honours ERC-2981 pays
  the creator 5%. A block's resale is §7a and never leaves the board.

## 9. Events

Collection: `BoardCreated(seller, board, tokenId, creator)`, `TokenAllowed`, `BaseURISet`,
`MetadataUpdate`, `BatchMetadataUpdate`, and ERC-721's `Transfer`/`Approval`. Board:
`BoardInitialized(collection, boardTokenId, settlementToken, gridCols, gridRows, cellPrice)`;
`ZoneSet(index, col, row, cols, rows, cellPrice)` and `BlockKept(blockId, owner, col, row, cols, rows)`
at creation; `BlockBought(blockId, payer, recipient, col, row, cols, rows, total, protocolCut, seller)` — `seller`
is who was credited, one per block of a buy, each with its own `total` and `protocolCut`;
`PricesLowered(holder, priceBps)`; `BlockTransferred(blockId, from, to)` on EVERY change of owner, gift or
resale; `BlockListed(blockId, owner, price)`; `BlockDelisted(blockId, owner)`;
`BlockResold(blockId, payer, recipient, blockSeller, price, protocolCut, royalty, boardHolder)`, after
the `BlockTransferred` it caused; `BlockEdited`; `EditorSet`; `Withdrawn`.

## 10. Tests

`test/ImageBoard.t.sol`, `test/ImageBoardResale.t.sol`, `test/ImageBoardZones.t.sol`,
`test/ImageBoardMultiBuy.t.sol` and `test/ImageBoardPriceCut.t.sol` (unit, every rule at its boundary) and
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
