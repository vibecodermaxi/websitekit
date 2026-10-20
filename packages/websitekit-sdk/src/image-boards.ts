/**
 * Image boards: reads and call builders for `ImageBoard` and `ImageBoardCollection`
 * (`docs/IMAGE-BOARD-SPEC.md`). Import from `@websitekit/sdk/image-boards`.
 *
 * A seller uploads a picture; buyers buy rectangular blocks of its squares and put their own
 * pictures in them. **The board is the NFT, a block is not**: each board is one token in a
 * collection, minted to its seller when it is created, and a block is a record on its board,
 * numbered from 1, moved only by its owner. Blocks are called `tokenId` in this API — they were
 * tokens once — and a board's own token is `boardToken`, so the two never share a name.
 *
 * **Testnet only for now.** `IMAGE_BOARD_DEPLOYMENTS` names Robinhood Chain Testnet (46630) alone, and
 * `imageBoardDeploymentFor` throws for any other chain, mainnet included, rather than answering
 * with another chain's addresses. Mainnet arrives as an entry here and a release, nothing else.
 *
 * Builders return a `CallRequest` and never send; nothing here holds a wallet. Reads take the
 * client as an argument and are plain `readContract` calls, so a client with `batch.multicall`
 * batches them by itself.
 *
 * Geometry and prices are in `./image-grid` (re-exported here), a twin of the contract pinned by
 * vectors generated from it. The buy gate is the CONTRACT's `buyError`, read fresh by
 * `readBuyError`, and a buy is priced by its `quoteBlocks` (`readQuoteBlocks`); the twin is what a
 * screen previews.
 *
 * **Any cell can be bought** (2026-10-14): a buy over sold cells takes them, paying their owners.
 * The twin needs the board's cell map (`readCellMap`) and its blocks to price that; `gridStateOf`
 * puts them together.
 */
import { encodeAbiParameters, toFunctionSelector, type Abi, type Address, type Hex, type PublicClient } from 'viem';

import imageBoardAbiJson from './abi/ImageBoard.json';
import imageBoardCollectionAbiJson from './abi/ImageBoardCollection.json';
import { cellMapFromBlocks, cellMapOf, gridOf, layoutProblem, termsError, type BlockErrorName, type CellMap, type GridState, type Rect, type TakeTerms, type Zone } from './image-grid';
import { accruedOf, rentCost, rentSplit } from './rentals';
import type { CallRequest } from './writes';

export * from './image-grid';

export const IMAGE_BOARD_ABI = imageBoardAbiJson as Abi;
export const IMAGE_BOARD_COLLECTION_ABI = imageBoardCollectionAbiJson as Abi;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = `0x${'0'.repeat(64)}`;

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------

export interface ImageBoardDeployment {
  chainId: number;
  /** Every board is an EIP-1167 clone of this. */
  implementation: Address;
  /**
   * `ImageBoardCollection`: `createBoardFor`, and the ERC-721 in which every board is one token. Its
   * owner can only change which tokens NEW boards may use and where token metadata is fetched from.
   */
  collection: Address;
  /** The one settlement token the collection allows. Identity is the address, never the symbol. */
  token: Address;
  /** The token's decimals, read and asserted by the deploy script. */
  decimals: number;
  /** True only for a testnet stand-in anyone may mint. Never true where the money is real. */
  mintable: boolean;
  explorer: string;
}

/**
 * Robinhood Chain Testnet, deployed 2026-10-14 by `scripts/deploy-image-boards.ts`: the takeovers
 * generation — any sold square can be bought from its owner, on terms each board's creator chose.
 * Its collection takes its name and symbol from its deployer (read them with `name()` and
 * `symbol()`). Its token is a `TestUSD` with EIP-2612 `permit` — not `ROBINHOOD_TESTNET_TUSD`,
 * which page boards settle in and which has none. Verified on Blockscout.
 */
export const ROBINHOOD_TESTNET_IMAGE_BOARDS: ImageBoardDeployment = {
  chainId: 46630,
  implementation: '0xa6cfa3e406ff0d2e97fc6026ebc35a9c3e1d63f0',
  collection: '0x2032e20f12d4c9e086ba497ad01da80d9e2f8f41',
  token: '0x20f5aa5b5a49571925ede3fc206347963ddba783',
  decimals: 6,
  mintable: true,
  explorer: 'https://explorer.testnet.chain.robinhood.com',
};

/** Image boards, by chain. Testnet only until mainnet is deployed. */
export const IMAGE_BOARD_DEPLOYMENTS: Readonly<Record<number, ImageBoardDeployment>> = {
  [ROBINHOOD_TESTNET_IMAGE_BOARDS.chainId]: ROBINHOOD_TESTNET_IMAGE_BOARDS,
};

/**
 * The deployment on this chain. **Throws** rather than answering undefined, naming the chains that
 * have one: no deployment, no boards — and never another chain's addresses.
 */
export function imageBoardDeploymentFor(chainId: number): ImageBoardDeployment {
  const deployment = IMAGE_BOARD_DEPLOYMENTS[chainId];
  if (!deployment) {
    throw new Error(
      `websitekit: image boards are not deployed on chain ${chainId}. Deployed chains: ${Object.keys(IMAGE_BOARD_DEPLOYMENTS).join(', ')}.`,
    );
  }
  return deployment;
}

// ---------------------------------------------------------------------------
// The protocol's terms, as the contracts carry them
// ---------------------------------------------------------------------------

/** The protocol's cut of every square sold and every block resold. The deploy script refuses any other. */
export const IMAGE_BOARD_PROTOCOL_BPS = 500n;
/** ERC-2981, paid to a board's creator when the board's NFT is resold: `ImageBoardCollection.ROYALTY_BPS`. */
export const IMAGE_BOARD_ROYALTY_BPS = 500n;
/** What whoever holds the board is credited per square sold, in bps of its price. */
export const IMAGE_BOARD_SELLER_BPS = 10_000n - IMAGE_BOARD_PROTOCOL_BPS;
/** What a block's resale pays whoever holds the board's NFT then: `ImageBoard.RESALE_ROYALTY_BPS`. */
export const IMAGE_BLOCK_RESALE_ROYALTY_BPS = 500n;

/** What a rental pays whoever holds the board's NFT then, beside the protocol's cut: `ImageBoard.RENT_ROYALTY_BPS`. */
export const IMAGE_BLOCK_RENT_ROYALTY_BPS = 500n;
/** The shortest and longest term a block can be rented for: `MIN_RENTAL_DURATION`, `MAX_RENTAL_TERM`. */
export const IMAGE_BLOCK_MIN_RENTAL_SECS = 3_600n;
export const IMAGE_BLOCK_MAX_RENTAL_SECS = 31_536_000n;

/**
 * How a resale at `price` is credited — **a twin of the contract's `resaleSplit`**, for showing an
 * owner what they receive. Both shares round down and the owner gets the remainder, so the three sum
 * to the price. The sale itself never reads this.
 */
export function resaleSplit(price: bigint, protocolBps: bigint = IMAGE_BOARD_PROTOCOL_BPS): { protocolCut: bigint; royalty: bigint; toOwner: bigint } {
  const protocolCut = (price * protocolBps) / 10_000n;
  const royalty = (price * IMAGE_BLOCK_RESALE_ROYALTY_BPS) / 10_000n;
  return { protocolCut, royalty, toOwner: price - protocolCut - royalty };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ImageBoardState {
  address: Address;
  /** The board's NFT: `collection`'s token `boardToken`. */
  collection: Address;
  boardToken: bigint;
  /** Whoever holds the board's NFT now — who the next square sold pays. Not frozen. */
  seller: Address;
  settlementToken: Address;
  /** The image's own pixels. */
  width: number;
  height: number;
  cellSize: number;
  gridCols: number;
  gridRows: number;
  /** The price set at creation; what a square costs now is this at `priceBps` (`squarePrice`). */
  cellPrice: bigint;
  /** Cells priced differently from `cellPrice`, frozen at creation; empty on most boards. */
  zones: Zone[];
  /** What share of the creation prices an unsold square costs now: 10,000 until the board's holder
   *  lowers it, and it only ever falls. Not frozen. */
  priceBps: number;
  imageHash: Hex;
  /** Block numbers run 1..blockCount. Kept blocks, the creator's, are the first ones. */
  blockCount: number;
  /** Who the board was created for, and owns its kept blocks. Never moves; the board's NFT does. */
  creator: Address;
  /** Kept blocks are 1..keptCount. They cannot be taken while `creator` owns them. */
  keptCount: number;
  /** How a sold cell is taken, chosen by the creator. Frozen. */
  terms: TakeTerms;
  /** Cells no block holds. */
  freeCells: number;
}

export interface BlockState extends Rect {
  tokenId: bigint;
  owner: Address;
  /** Zero until the first write. */
  contentHash: Hex;
  version: number;
  /** `0x0…0` when nobody is granted; a grant dies on transfer, on chain. */
  editor: Address;
  /** What its owner listed it for; zero when it is not for sale. Ends on any change of owner, and on a take. */
  listPrice: bigint;
  /** What it cost over the creation price of its cells, in bps, rounded up: what a take of it is priced from. */
  level: bigint;
  /** When it was bought (or kept), in seconds. A resale or a gift does not move it. */
  boughtAt: bigint;
  /** How many of its cells no later block has taken. Its rectangle never changes; this does. */
  cellsLeft: number;
  /**
   * The picture the board shows for it now (2026-10-20): the tenant's during a live term once they
   * have chosen one, the owner's `contentHash` otherwise. Everything that draws or serves a block
   * reads THIS, never `contentHash`.
   */
  shownHash: Hex;
  /** Its tenancy; `expiry` zero for none. A lapsed term stays here until the next one replaces it. */
  rental: BlockRental;
  /** Its rent offer; a `ratePerDay` of zero is none. */
  rentListing: BlockRentListing;
}

/** A block's tenancy (`IMAGE-BOARD-SPEC.md` §12). `prepaid` is net of both cuts and streams to the owner. */
export interface BlockRental {
  tenant: Address;
  start: bigint;
  expiry: bigint;
  prepaid: bigint;
  claimed: bigint;
  tenantHash: Hex;
}

export interface BlockRentListing {
  ratePerDay: bigint;
  maxDurationSecs: bigint;
}

/**
 * `at` pins every read to one block. Without it each read answers at whatever block the RPC is on,
 * and a batching client splits a large batch across several `eth_call`s, so one board's blocks could be
 * read either side of a buy. viem batches calls that share a block number together, so pinning
 * costs no extra round trips.
 */
export interface ReadAt {
  at?: bigint;
}

function reader(client: PublicClient, address: Address, { at }: ReadAt = {}) {
  return <T>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address, abi: IMAGE_BOARD_ABI, functionName, args, blockNumber: at } as never) as Promise<T>;
}

/** Everything about a board that is not a block, in one batch. All of it is frozen at creation
 *  except `blockCount`, `seller`, which follows the board's NFT, and `priceBps`, which falls. */
export async function readImageBoard(client: PublicClient, board: Address, opts: ReadAt = {}): Promise<ImageBoardState> {
  const read = reader(client, board, opts);
  const [
    collection,
    boardToken,
    seller,
    settlementToken,
    width,
    height,
    cellSize,
    gridCols,
    gridRows,
    cellPrice,
    zones,
    imageHash,
    blockCount,
    priceBps,
    creator,
    keptCount,
    takeBps,
    payoutBps,
    reversionBps,
    maxReversionWeeks,
    cooldownSecs,
    freeCells,
  ] = await Promise.all([
      read<Address>('collection'),
      read<bigint>('boardTokenId'),
      read<Address>('seller'),
      read<Address>('settlementToken'),
      read<number>('width'),
      read<number>('height'),
      read<number>('cellSize'),
      read<number>('gridCols'),
      read<number>('gridRows'),
      read<bigint>('cellPrice'),
      read<readonly { col: number; row: number; cols: number; rows: number; cellPrice: bigint }[]>('zones'),
      read<Hex>('imageHash'),
      read<bigint>('blockCount'),
      read<bigint>('priceBps'),
      read<Address>('creator'),
      read<number>('keptCount'),
      read<number>('takeBps'),
      read<number>('payoutBps'),
      read<number>('reversionBps'),
      read<number>('maxReversionWeeks'),
      read<number>('cooldownSecs'),
      read<bigint>('freeCells'),
    ]);
  return {
    address: board,
    collection,
    boardToken,
    seller,
    settlementToken,
    width,
    height,
    cellSize,
    gridCols,
    gridRows,
    cellPrice,
    zones: zones.map((z) => ({ col: z.col, row: z.row, cols: z.cols, rows: z.rows, cellPrice: z.cellPrice })),
    imageHash,
    blockCount: Number(blockCount),
    priceBps: Number(priceBps),
    creator,
    keptCount: Number(keptCount),
    terms: {
      takeBps: Number(takeBps),
      payoutBps: Number(payoutBps),
      reversionBps: Number(reversionBps),
      maxReversionWeeks: Number(maxReversionWeeks),
      cooldownSecs: Number(cooldownSecs),
    },
    freeCells: Number(freeCells),
  };
}

/** One block, its holder and its content. Its shape is all zero, and its owner zero, for a number
 *  never sold. */
export async function readBlock(client: PublicClient, board: Address, tokenId: bigint, opts: ReadAt = {}): Promise<BlockState> {
  const read = reader(client, board, opts);
  const [shape, owner, editor, listPrice, shownHash, rental, offer] = await Promise.all([
    read<{ col: number; row: number; cols: number; rows: number; version: number; level: bigint; boughtAt: number; cellsLeft: number; contentHash: Hex }>(
      'blockOf',
      [tokenId],
    ),
    read<Address>('ownerOf', [tokenId]),
    read<Address>('editorOf', [tokenId]),
    read<bigint>('listPrice', [tokenId]),
    read<Hex>('shownHash', [tokenId]),
    read<{ tenant: Address; start: number; expiry: number; prepaid: bigint; claimed: bigint; tenantHash: Hex }>('rentalOf', [tokenId]),
    read<readonly [bigint, bigint]>('rentListing', [tokenId]),
  ]);
  return {
    tokenId,
    col: shape.col,
    row: shape.row,
    cols: shape.cols,
    rows: shape.rows,
    owner,
    contentHash: shape.contentHash,
    version: shape.version,
    editor,
    listPrice,
    level: shape.level,
    boughtAt: BigInt(shape.boughtAt),
    cellsLeft: shape.cellsLeft,
    shownHash,
    rental: {
      tenant: rental.tenant,
      start: BigInt(rental.start),
      expiry: BigInt(rental.expiry),
      prepaid: rental.prepaid,
      claimed: rental.claimed,
      tenantHash: rental.tenantHash,
    },
    rentListing: { ratePerDay: offer[0], maxDurationSecs: BigInt(offer[1]) },
  };
}

/** Where a block is, alone: one read, for a caller that needs nothing else about it. A block never moves. */
export async function readBlockRect(client: PublicClient, board: Address, tokenId: bigint): Promise<Rect> {
  const shape = await reader(client, board)<{ col: number; row: number; cols: number; rows: number }>('blockOf', [tokenId]);
  return { col: shape.col, row: shape.row, cols: shape.cols, rows: shape.rows };
}

/** Every block, its holder and its content, in one batch — `blockCount` from `readImageBoard`. */
export function readBlocks(client: PublicClient, board: Address, blockCount: number, opts: ReadAt = {}): Promise<BlockState[]> {
  return Promise.all(Array.from({ length: blockCount }, (_, i) => readBlock(client, board, BigInt(i + 1), opts)));
}

/**
 * Selector → name, built from the ABI so a renamed error fails loudly here instead of reading as
 * an unknown answer. `buyError` returns `bytes4(0)` for a buy that can go through.
 */
const BLOCK_ERRORS: ReadonlyMap<string, BlockErrorName> = new Map([
  ['0x00000000', 'none'],
  ...(['EmptyBlock', 'OutsideGrid', 'CellsTaken', 'CellsKept', 'CoolingDown', 'TooLarge', 'TooManyBlocks'] as const).map(
    (name): [string, BlockErrorName] => {
      if (!IMAGE_BOARD_ABI.some((item) => item.type === 'error' && item.name === name)) {
        throw new Error(`ImageBoard ABI has no error ${name}`);
      }
      return [toFunctionSelector(`${name}()`), name];
    },
  ),
]);

function rectsArgs(rects: readonly Rect[]) {
  return rects.map((rect) => {
    const [col, row, cols, rows] = rectArgs(rect);
    return { col, row, cols, rows };
  });
}

/**
 * The BUY GATE: what `buyBlocks` would revert with for these rectangles, now — the contract's own
 * `buyError`, in its order. A buy action asks this immediately before anyone signs, so the screen's
 * preview (`buyError` in `image-grid.ts`) is never what decides.
 */
export async function readBuyError(client: PublicClient, board: Address, rects: readonly Rect[]): Promise<BlockErrorName> {
  if (rects.length === 0) return 'EmptyBlock';
  const selector = await reader(client, board)<Hex>('buyError', [rectsArgs(rects)]);
  const name = BLOCK_ERRORS.get(selector.toLowerCase());
  if (!name) throw new Error(`buyError answered ${selector}, which is no error this client knows`);
  return name;
}

/**
 * What the contract charges for these rectangles bought together, now: exactly what `buyBlocks`
 * pulls, and what a buy names as its most (`maxTotal`). Reverts when `readBuyError` is not `none`,
 * so ask that first. `quoteBlocks` in `image-grid.ts` is the screen's preview of it.
 */
export function readQuoteBlocks(client: PublicClient, board: Address, rects: readonly Rect[]): Promise<bigint> {
  return reader(client, board)<bigint>('quoteBlocks', [rectsArgs(rects)]);
}

/**
 * Which block holds every cell, in one batch of `cellRow` reads, a row each. `grid` is the board's
 * (`readImageBoard`); it never changes.
 */
export async function readCellMap(client: PublicClient, board: Address, grid: { cols: number; rows: number }, opts: ReadAt = {}): Promise<CellMap> {
  const read = reader(client, board, opts);
  const rows = await Promise.all(Array.from({ length: grid.rows }, (_, r) => read<readonly bigint[]>('cellRow', [BigInt(r)])));
  return cellMapOf(grid, rows);
}

/**
 * The twin's view of a board, from the reads a screen already makes, pinned to one block. `blocks`
 * is every block (`readBlocks`); the cell map is painted from them (`cellMapFromBlocks`) unless
 * given — `readCellMap` reads it instead.
 */
export function gridStateOf(board: ImageBoardState, blocks: readonly BlockState[], cells?: CellMap): GridState {
  const grid = { cols: board.gridCols, rows: board.gridRows };
  return {
    grid,
    cellPrice: board.cellPrice,
    zones: board.zones,
    priceBps: board.priceBps,
    terms: board.terms,
    creator: board.creator,
    keptCount: board.keptCount,
    cells: cells ?? cellMapFromBlocks(grid, blocks),
    blocks: new Map(blocks.map((b) => [Number(b.tokenId), { owner: b.owner, level: b.level, boughtAt: b.boughtAt }])),
  };
}

/** What share of the creation prices a square costs now. The one board read that changes by an act of its holder. */
export async function readPriceBps(client: PublicClient, board: Address, opts: ReadAt = {}): Promise<number> {
  return Number(await reader(client, board, opts)<bigint>('priceBps'));
}

/** Cells no block holds: zero once every square has had a first sale. They can still be taken. */
export async function readFreeCells(client: PublicClient, board: Address, opts: ReadAt = {}): Promise<number> {
  return Number(await reader(client, board, opts)<bigint>('freeCells'));
}

/** The board's zones, frozen at creation: what a listing needs to say "from" rather than "per square". */
export async function readZones(client: PublicClient, board: Address, opts: ReadAt = {}): Promise<Zone[]> {
  const zones = await reader(client, board, opts)<readonly Zone[]>('zones');
  return zones.map((z) => ({ col: z.col, row: z.row, cols: z.cols, rows: z.rows, cellPrice: z.cellPrice }));
}

/** How many blocks have been sold — block numbers run 1..this. The one read a listing makes per board. */
export async function readBlockCount(client: PublicClient, board: Address, opts: ReadAt = {}): Promise<number> {
  return Number(await reader(client, board, opts)<bigint>('blockCount'));
}

export function readOwnerOf(client: PublicClient, board: Address, tokenId: bigint): Promise<Address> {
  return reader(client, board)<Address>('ownerOf', [tokenId]);
}

export function readCanEdit(client: PublicClient, board: Address, tokenId: bigint, account: Address): Promise<boolean> {
  return reader(client, board)<boolean>('canEdit', [tokenId, account]);
}

/** What the board owes `account` (whoever held the board at a sale, or the protocol) on its pull ledger. */
export function readImageBoardPending(client: PublicClient, board: Address, account: Address): Promise<bigint> {
  return reader(client, board)<bigint>('pendingWithdrawals', [account]);
}

/** Who the protocol's cut is credited to: an immutable of the implementation every board shares. */
export function readProtocolTreasury(client: PublicClient, board: Address): Promise<Address> {
  return reader(client, board)<Address>('protocolTreasury');
}

/** The board implementation's protocol cut, which a resale takes at (`resaleSplit`). */
export async function readProtocolBps(client: PublicClient, board: Address): Promise<bigint> {
  return reader(client, board)<bigint>('protocolBps');
}

export function readEditorNonce(client: PublicClient, board: Address, owner: Address): Promise<bigint> {
  return reader(client, board)<bigint>('editorNonces', [owner]);
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export interface CreateImageBoardOptions {
  collection: Address;
  /** Who receives the board's NFT, is paid for its squares and gets its royalty. Required: whoever
   *  sends the creation (a relayer, say) must never be it by default. */
  seller: Address;
  /** Required on every money builder: a default is right for one chain and wrong for the other. */
  settlementToken: Address;
  width: number;
  height: number;
  cellSize: number;
  cellPrice: bigint;
  /** Hash of the original image bytes. */
  imageHash: Hex;
  /** Required, `[]` for one price everywhere: a default is how a caller forgets the seller's zones. */
  zones: readonly Zone[];
  /** Required, `[]` for none: blocks the seller keeps, made with the board as theirs. */
  kept: readonly Rect[];
  /** How a sold cell is taken. Required, with no default: the creator chooses, as a page board's publisher does. */
  terms: TakeTerms;
}

/**
 * `ImageBoard.Config`, as `initialize` decodes it. Since 2026-10-20 the collection passes a board's
 * set-up through as bytes it never reads — so a later implementation may take another shape — and
 * the struct is no longer in any ABI. Written out here, and pinned by creating boards with zones,
 * kept blocks and terms on real bytecode (the platform's anvil suite and the deploy's smoke).
 */
export const IMAGE_BOARD_CONFIG_PARAMS = [
  {
    type: 'tuple',
    components: [
      { name: 'settlementToken', type: 'address' },
      { name: 'width', type: 'uint32' },
      { name: 'height', type: 'uint32' },
      { name: 'cellSize', type: 'uint8' },
      { name: 'cellPrice', type: 'uint256' },
      { name: 'imageHash', type: 'bytes32' },
      {
        name: 'zones',
        type: 'tuple[]',
        components: [
          { name: 'col', type: 'uint16' },
          { name: 'row', type: 'uint16' },
          { name: 'cols', type: 'uint16' },
          { name: 'rows', type: 'uint16' },
          { name: 'cellPrice', type: 'uint192' },
        ],
      },
      {
        name: 'kept',
        type: 'tuple[]',
        components: [
          { name: 'col', type: 'uint16' },
          { name: 'row', type: 'uint16' },
          { name: 'cols', type: 'uint16' },
          { name: 'rows', type: 'uint16' },
        ],
      },
      {
        name: 'terms',
        type: 'tuple',
        components: [
          { name: 'takeBps', type: 'uint256' },
          { name: 'payoutBps', type: 'uint256' },
          { name: 'reversionBps', type: 'uint256' },
          { name: 'maxReversionWeeks', type: 'uint256' },
          { name: 'cooldownSecs', type: 'uint256' },
        ],
      },
    ],
  },
] as const;

/**
 * `ImageBoardCollection.createBoardFor`. Refuses here what the contract would refuse, so a bad
 * config fails before anyone spends gas on a revert that names nothing.
 */
export function buildCreateImageBoard(o: CreateImageBoardOptions): CallRequest<'createBoardFor', [Address, Hex]> {
  if (o.seller === ZERO_ADDRESS) throw new Error('image board: the seller must be named');
  if (o.settlementToken === ZERO_ADDRESS) throw new Error('image board: settles in an ERC-20 only');
  if ('error' in gridOf(o.width, o.height, o.cellSize)) {
    throw new Error(`image board: ${o.width}×${o.height} at ${o.cellSize} px is not a grid the contract accepts`);
  }
  if (o.cellPrice <= 0n) throw new Error('image board: the cell price must be above zero');
  if (o.imageHash.toLowerCase() === ZERO_HASH) throw new Error('image board: the image hash is required');
  const grid = gridOf(o.width, o.height, o.cellSize) as { cols: number; rows: number };
  const layout = layoutProblem(grid, o.zones, o.kept);
  if (layout) throw new Error(`image board: ${layout.problem} at ${layout.index}`);
  // The contract stores a zone's price in 192 bits; a larger one would not encode.
  if (o.zones.some((z) => z.cellPrice >= 1n << 192n)) throw new Error('image board: a zone price is out of range');
  for (const [field, value] of Object.entries(o.terms)) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`image board: ${field} ${value} is not a whole number`);
  }
  // Checked against the cut every deployment carries; the deploy script refuses any other.
  const terms = termsError(o.terms, Number(IMAGE_BOARD_PROTOCOL_BPS));
  if (terms) throw new Error(`image board: the terms are refused (${terms})`);
  return {
    address: o.collection,
    abi: IMAGE_BOARD_COLLECTION_ABI,
    functionName: 'createBoardFor',
    args: [
      o.seller,
      encodeAbiParameters(IMAGE_BOARD_CONFIG_PARAMS, [
        {
          settlementToken: o.settlementToken,
          width: o.width,
          height: o.height,
          cellSize: o.cellSize,
          cellPrice: o.cellPrice,
          imageHash: o.imageHash,
          zones: o.zones.map((z) => ({ col: z.col, row: z.row, cols: z.cols, rows: z.rows, cellPrice: z.cellPrice })),
          kept: o.kept.map((k) => ({ col: k.col, row: k.row, cols: k.cols, rows: k.rows })),
          terms: {
            takeBps: BigInt(o.terms.takeBps),
            payoutBps: BigInt(o.terms.payoutBps),
            reversionBps: BigInt(o.terms.reversionBps),
            maxReversionWeeks: BigInt(o.terms.maxReversionWeeks),
            cooldownSecs: BigInt(o.terms.cooldownSecs),
          },
        },
      ]),
    ],
  };
}

const UINT16_MAX = 0xffff;
function rectArgs(rect: Rect): [number, number, number, number] {
  for (const [field, value] of Object.entries(rect)) {
    if (!Number.isInteger(value) || value < 0 || value > UINT16_MAX) {
      throw new Error(`image board: ${field} ${value} is not a cell coordinate`);
    }
  }
  return [rect.col, rect.row, rect.cols, rect.rows];
}

function namedRecipient(recipient: Address): Address {
  // The standing check: the block goes to whoever is NAMED, never the sender by default.
  if (recipient === ZERO_ADDRESS) throw new Error('image board: the recipient must be named');
  return recipient;
}

/** The `Rect[]` `buyBlocks` takes. An empty list is refused here, as the contract would. */
function rectsArg(rects: readonly Rect[]): { col: number; row: number; cols: number; rows: number }[] {
  if (rects.length === 0) throw new Error('image board: a buy needs at least one rectangle');
  return rectsArgs(rects);
}

function namedMax(maxTotal: bigint): bigint {
  // A buy with no bound pays whatever the cells cost when it lands, which a take can raise.
  if (maxTotal <= 0n) throw new Error('image board: a buy must name the most it will pay');
  return maxTotal;
}

/**
 * `buyBlocks`, for a payer that has already approved the board: every rectangle its own block, all
 * or nothing. `maxTotal` is the total the buyer was shown (`readQuoteBlocks`); the contract refuses
 * the buy (`PriceTooHigh`) if the cells cost more when it lands, and after `deadline` (seconds).
 */
export function buildBuyBlocks(o: {
  board: Address;
  recipient: Address;
  rects: readonly Rect[];
  maxTotal: bigint;
  deadline: bigint;
}): CallRequest<'buyBlocks', [Address, unknown, bigint, bigint]> {
  return {
    address: o.board,
    abi: IMAGE_BOARD_ABI,
    functionName: 'buyBlocks',
    args: [namedRecipient(o.recipient), rectsArg(o.rects), namedMax(o.maxTotal), o.deadline],
  };
}

export interface PermitSignature {
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

/**
 * `buyBlocksWithPermit`: one signature (`permitTypedData`) plus one transaction. `maxTotal` is the
 * total the buyer was shown, and the permit is signed for exactly it; its deadline is the buy's.
 * The board pulls what the cells cost when the buy lands and refuses it (`PriceTooHigh`) above
 * `maxTotal` — a take, a later buy or a week's reversion can move it either way.
 */
export function buildBuyBlocksWithPermit(o: {
  board: Address;
  recipient: Address;
  rects: readonly Rect[];
  maxTotal: bigint;
  permit: PermitSignature;
}): CallRequest<'buyBlocksWithPermit', [Address, unknown, bigint, bigint, number, Hex, Hex]> {
  return {
    address: o.board,
    abi: IMAGE_BOARD_ABI,
    functionName: 'buyBlocksWithPermit',
    args: [namedRecipient(o.recipient), rectsArg(o.rects), namedMax(o.maxTotal), o.permit.deadline, o.permit.v, o.permit.r, o.permit.s],
  };
}

/**
 * `lowerPrices`: every free square to `priceBps` of the price set at creation; sold cells never see it. The board's holder
 * sends it; the contract refuses anyone else, and anything not below the current share.
 */
export function buildLowerPrices(o: { board: Address; priceBps: number }): CallRequest<'lowerPrices', [bigint]> {
  if (!Number.isInteger(o.priceBps) || o.priceBps <= 0 || o.priceBps >= 10_000) {
    throw new Error(`image board: ${o.priceBps} bps is not a cut`);
  }
  return { address: o.board, abi: IMAGE_BOARD_ABI, functionName: 'lowerPrices', args: [BigInt(o.priceBps)] };
}

/**
 * The EIP-2612 permit a buyer signs for the total they were shown, with the board as spender.
 *
 * `version` is "1" for both tokens the collections allow — mainnet USDG ("Global Dollar") and the
 * testnet image-board `TestUSD` — proved on chain by `deploy-image-boards.ts`, which simulates a
 * permit signed this way. `tokenName` is the token's `name()`, read, never assumed.
 */
export function permitTypedData(o: {
  token: Address;
  tokenName: string;
  chainId: number;
  owner: Address;
  spender: Address;
  value: bigint;
  /** The owner's current `nonces(owner)` on the token. */
  nonce: bigint;
  deadline: bigint;
}) {
  return {
    domain: { name: o.tokenName, version: '1', chainId: o.chainId, verifyingContract: o.token },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit' as const,
    message: { owner: o.owner, spender: o.spender, value: o.value, nonce: o.nonce, deadline: o.deadline },
  };
}

/** Splits a 65-byte signature into the `v, r, s` a permit buy takes. */
export function splitSignature(signature: Hex, deadline: bigint): PermitSignature {
  if (signature.length !== 132) throw new Error('image board: a permit signature is 65 bytes');
  return {
    deadline,
    r: signature.slice(0, 66) as Hex,
    s: `0x${signature.slice(66, 130)}` as Hex,
    v: parseInt(signature.slice(130, 132), 16),
  };
}

/** `edit`: the owner or the current editor writes the block's content hash. */
export function buildEditBlock(o: { board: Address; tokenId: bigint; contentHash: Hex }): CallRequest<'edit', [bigint, Hex]> {
  return { address: o.board, abi: IMAGE_BOARD_ABI, functionName: 'edit', args: [o.tokenId, o.contentHash] };
}

/** `setEditor`, sent by the owner. Zero clears the grant. */
export function buildSetBlockEditor(o: { board: Address; tokenId: bigint; editor: Address }): CallRequest<'setEditor', [bigint, Address]> {
  return { address: o.board, abi: IMAGE_BOARD_ABI, functionName: 'setEditor', args: [o.tokenId, o.editor] };
}

/**
 * The grant an owner signs so someone else can relay it. Every board's domain has the same name,
 * which names no product; `verifyingContract` is what tells one board's grants from another's.
 */
export const BOARD_DOMAIN_NAME = 'Image Board';

export function blockEditorGrantTypedData(o: {
  board: Address;
  chainId: number;
  tokenId: bigint;
  editor: Address;
  /** The owner's current `editorNonces(owner)` on the board. Read it; do not assume zero. */
  nonce: bigint;
  deadline: bigint;
}) {
  return {
    domain: { name: BOARD_DOMAIN_NAME, version: '1', chainId: o.chainId, verifyingContract: o.board },
    types: {
      EditorGrant: [
        { name: 'blockId', type: 'uint256' },
        { name: 'editor', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'EditorGrant' as const,
    message: { blockId: o.tokenId, editor: o.editor, nonce: o.nonce, deadline: o.deadline },
  };
}

/** Relays a signed grant. The grant records the OWNER as grantor, so relaying confers nothing. */
export function buildSetBlockEditorWithSig(o: {
  board: Address;
  tokenId: bigint;
  editor: Address;
  deadline: bigint;
  signature: Hex;
}): CallRequest<'setEditorWithSig', [bigint, Address, bigint, Hex]> {
  return {
    address: o.board,
    abi: IMAGE_BOARD_ABI,
    functionName: 'setEditorWithSig',
    args: [o.tokenId, o.editor, o.deadline, o.signature],
  };
}

/**
 * Gives a block to `to` — the holder's own transaction, and the only way a block moves.
 * A block is not a token, so there is no receiver check: an address that cannot use it still holds
 * it, as one that never signs in does.
 */
export function buildTransferBlock(o: { board: Address; to: Address; tokenId: bigint }): CallRequest<'transferBlock', [bigint, Address]> {
  if (o.to === ZERO_ADDRESS) throw new Error('image board: a block must be given to someone');
  return { address: o.board, abi: IMAGE_BOARD_ABI, functionName: 'transferBlock', args: [o.tokenId, o.to] };
}

/** Pays `account` what the board owes it. Permissionless, and pays only `account`, so anyone may send it. */
export function buildImageBoardWithdrawFor(o: { board: Address; account: Address }): CallRequest<'withdrawFor', [Address]> {
  return { address: o.board, abi: IMAGE_BOARD_ABI, functionName: 'withdrawFor', args: [o.account] };
}

// ---------------------------------------------------------------------------
// Resale (`IMAGE-BOARD-SPEC.md` §7a): the whole block, at its owner's price
// ---------------------------------------------------------------------------

/** `listBlock`: put the block up for sale at `price`, or change the price. The owner alone. */
export function buildListBlock(o: { board: Address; tokenId: bigint; price: bigint }): CallRequest<'listBlock', [bigint, bigint]> {
  if (o.price <= 0n) throw new Error('image board: a listing needs a price above zero');
  return { address: o.board, abi: IMAGE_BOARD_ABI, functionName: 'listBlock', args: [o.tokenId, o.price] };
}

export function buildDelistBlock(o: { board: Address; tokenId: bigint }): CallRequest<'delistBlock', [bigint]> {
  return { address: o.board, abi: IMAGE_BOARD_ABI, functionName: 'delistBlock', args: [o.tokenId] };
}

// ---------------------------------------------------------------------------
// Renting (`IMAGE-BOARD-SPEC.md` §12, 2026-10-20): a term of a block, prepaid, streamed to its owner
// ---------------------------------------------------------------------------

/** Whether a tenancy is live at `now` (the chain's time, never the machine's): it ends AT `expiry`. */
export function rentalLive(rental: Pick<BlockRental, 'expiry'>, now: bigint): boolean {
  return now < rental.expiry;
}

/** Rent streamed to the owner and not yet credited: what `claimRent` would credit at `now`. */
export function rentUnclaimed(rental: BlockRental, now: bigint): bigint {
  return accruedOf(rental.prepaid, rental.start, rental.expiry, now) - rental.claimed;
}

/**
 * What a term of `durationSecs` at `ratePerDay` costs and where it goes, composed as `rent` composes
 * it: the page boards' `rentCost` and `rentSplit` with the protocol's 5% and the board holder's 5%.
 */
export function blockRentQuote(ratePerDay: bigint, durationSecs: bigint): { cost: bigint; protocolCut: bigint; royalty: bigint; net: bigint } {
  const cost = rentCost(ratePerDay, durationSecs);
  const { protocolCut, siteCut, net } = rentSplit(cost, IMAGE_BOARD_PROTOCOL_BPS, IMAGE_BLOCK_RENT_ROYALTY_BPS);
  return { cost, protocolCut, royalty: siteCut, net };
}

function rentalTerm(durationSecs: bigint, longest: bigint = IMAGE_BLOCK_MAX_RENTAL_SECS): bigint {
  if (durationSecs < IMAGE_BLOCK_MIN_RENTAL_SECS || durationSecs > longest) {
    throw new Error(`image board: a term of ${durationSecs} s is outside an hour to ${longest} s`);
  }
  return durationSecs;
}

/** `listForRent`: offer the block at `ratePerDay` for terms up to `maxDurationSecs`; a rate of zero ends the offer. */
export function buildListForRent(o: {
  board: Address;
  tokenId: bigint;
  ratePerDay: bigint;
  maxDurationSecs: bigint;
}): CallRequest<'listForRent', [bigint, bigint, bigint]> {
  if (o.ratePerDay < 0n) throw new Error('image board: a rate cannot be negative');
  const longest = o.ratePerDay === 0n ? 0n : rentalTerm(o.maxDurationSecs);
  return { address: o.board, abi: IMAGE_BOARD_ABI, functionName: 'listForRent', args: [o.tokenId, o.ratePerDay, longest] };
}

/**
 * `rentWithPermit`: one signature (`permitTypedData` for exactly `blockRentQuote(rate, term).cost`)
 * plus one transaction. `tenant` is named — whoever pays need not be them. `expectedRatePerDay` is
 * the rate the payer was SHOWN; the contract refuses any other.
 */
export function buildRentBlockWithPermit(o: {
  board: Address;
  tokenId: bigint;
  tenant: Address;
  durationSecs: bigint;
  expectedRatePerDay: bigint;
  permit: PermitSignature;
}): CallRequest<'rentWithPermit', [bigint, Address, bigint, bigint, bigint, number, Hex, Hex]> {
  return {
    address: o.board,
    abi: IMAGE_BOARD_ABI,
    functionName: 'rentWithPermit',
    args: [o.tokenId, namedRecipient(o.tenant), rentalTerm(o.durationSecs), o.expectedRatePerDay, o.permit.deadline, o.permit.v, o.permit.r, o.permit.s],
  };
}

/** `extendRentalWithPermit`: the tenant's term becomes `durationSecs` from now, at the current rate. */
export function buildExtendRentalWithPermit(o: {
  board: Address;
  tokenId: bigint;
  durationSecs: bigint;
  expectedRatePerDay: bigint;
  permit: PermitSignature;
}): CallRequest<'extendRentalWithPermit', [bigint, bigint, bigint, bigint, number, Hex, Hex]> {
  return {
    address: o.board,
    abi: IMAGE_BOARD_ABI,
    functionName: 'extendRentalWithPermit',
    args: [o.tokenId, rentalTerm(o.durationSecs), o.expectedRatePerDay, o.permit.deadline, o.permit.v, o.permit.r, o.permit.s],
  };
}

/** `claimRent`: credits each block's owner what has streamed to them. Permissionless; pays only owners. */
export function buildClaimRent(o: { board: Address; tokenIds: readonly bigint[] }): CallRequest<'claimRent', [readonly bigint[]]> {
  if (o.tokenIds.length === 0) throw new Error('image board: name at least one block to claim rent for');
  return { address: o.board, abi: IMAGE_BOARD_ABI, functionName: 'claimRent', args: [o.tokenIds] };
}

/** `editRented`: the tenant's picture for their term. The owner's picture is untouched. */
export function buildEditRented(o: { board: Address; tokenId: bigint; contentHash: Hex }): CallRequest<'editRented', [bigint, Hex]> {
  return { address: o.board, abi: IMAGE_BOARD_ABI, functionName: 'editRented', args: [o.tokenId, o.contentHash] };
}

/**
 * `buyListedBlockWithPermit`: one signature (`permitTypedData` for exactly `expectedPrice`) plus one
 * transaction. `expectedPrice` is the price the buyer was SHOWN; the contract refuses any other.
 */
export function buildBuyListedBlockWithPermit(o: {
  board: Address;
  tokenId: bigint;
  recipient: Address;
  expectedPrice: bigint;
  permit: PermitSignature;
}): CallRequest<'buyListedBlockWithPermit', [bigint, Address, bigint, bigint, number, Hex, Hex]> {
  return {
    address: o.board,
    abi: IMAGE_BOARD_ABI,
    functionName: 'buyListedBlockWithPermit',
    args: [o.tokenId, namedRecipient(o.recipient), o.expectedPrice, o.permit.deadline, o.permit.v, o.permit.r, o.permit.s],
  };
}
