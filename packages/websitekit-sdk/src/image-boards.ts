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
 * vectors generated from it. The buy gate is the CONTRACT's `blockError`, read fresh by
 * `readBlockError`; the twin is what a screen previews.
 */
import { toFunctionSelector, type Abi, type Address, type Hex, type PublicClient } from 'viem';

import imageBoardAbiJson from './abi/ImageBoard.json';
import imageBoardCollectionAbiJson from './abi/ImageBoardCollection.json';
import { gridOf, layoutProblem, type BlockErrorName, type Rect, type Zone } from './image-grid';
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
 * Robinhood Chain Testnet, deployed 2026-10-12 by `scripts/deploy-image-boards.ts`: the first
 * generation whose collection takes its name and symbol from its deployer (read them with `name()`
 * and `symbol()`). Its token is a `TestUSD` with EIP-2612 `permit` — not
 * `ROBINHOOD_TESTNET_TUSD`, which page boards settle in and which has none. Verified on Blockscout.
 */
export const ROBINHOOD_TESTNET_IMAGE_BOARDS: ImageBoardDeployment = {
  chainId: 46630,
  implementation: '0x0a6630ba362e103fc258112b94e58834e5fa9f16',
  collection: '0x891132c16bd2bff50c839ff2d679fe3dd6d908c6',
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
}

export interface BlockState extends Rect {
  tokenId: bigint;
  owner: Address;
  /** Zero until the first write. */
  contentHash: Hex;
  version: number;
  /** `0x0…0` when nobody is granted; a grant dies on transfer, on chain. */
  editor: Address;
  /** What its owner listed it for; zero when it is not for sale. Ends on any change of owner. */
  listPrice: bigint;
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
  const [collection, boardToken, seller, settlementToken, width, height, cellSize, gridCols, gridRows, cellPrice, zones, imageHash, blockCount, priceBps] =
    await Promise.all([
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
  };
}

/** One block, its holder and its content. Its shape is all zero, and its owner zero, for a number
 *  never sold. */
export async function readBlock(client: PublicClient, board: Address, tokenId: bigint, opts: ReadAt = {}): Promise<BlockState> {
  const read = reader(client, board, opts);
  const [shape, owner, editor, listPrice] = await Promise.all([
    read<{ col: number; row: number; cols: number; rows: number; version: number; contentHash: Hex }>('blockOf', [tokenId]),
    read<Address>('ownerOf', [tokenId]),
    read<Address>('editorOf', [tokenId]),
    read<bigint>('listPrice', [tokenId]),
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
 * an unknown answer. `blockError` returns `bytes4(0)` for a block that can be bought.
 */
const BLOCK_ERRORS: ReadonlyMap<string, BlockErrorName> = new Map([
  ['0x00000000', 'none'],
  ...(['EmptyBlock', 'OutsideGrid', 'CellsTaken'] as const).map((name): [string, BlockErrorName] => {
    if (!IMAGE_BOARD_ABI.some((item) => item.type === 'error' && item.name === name)) {
      throw new Error(`ImageBoard ABI has no error ${name}`);
    }
    return [toFunctionSelector(`${name}()`), name];
  }),
]);

/**
 * The BUY GATE: the contract's own answer for this block, now. A buy action asks this immediately
 * before it builds the call, so a screen's preview from `image-grid.ts` is never what decides.
 */
export async function readBlockError(client: PublicClient, board: Address, rect: Rect): Promise<BlockErrorName> {
  const selector = await reader(client, board)<Hex>('blockError', [rect.col, rect.row, rect.cols, rect.rows]);
  const name = BLOCK_ERRORS.get(selector.toLowerCase());
  if (!name) throw new Error(`blockError answered ${selector}, which is no error this client knows`);
  return name;
}

/**
 * The BUY GATE for several rectangles bought together: what `buyBlocks` would revert with, now. Each
 * rectangle in order asks the contract's `blockError`, and one that shares a cell with an earlier
 * rectangle of the same list is `CellsTaken` — which the contract finds the same way, taking each in
 * turn. The screen's preview is `buyError` in `image-grid.ts`.
 */
export async function readBuyError(client: PublicClient, board: Address, rects: readonly Rect[]): Promise<BlockErrorName> {
  if (rects.length === 0) return 'EmptyBlock';
  const answers = await Promise.all(rects.map((rect) => readBlockError(client, board, rect)));
  for (const [i, rect] of rects.entries()) {
    if (answers[i] !== 'none') return answers[i]!;
    if (rects.slice(0, i).some((earlier) => rectsShareACell(earlier, rect))) return 'CellsTaken';
  }
  return 'none';
}

function rectsShareACell(a: Rect, b: Rect): boolean {
  return a.col < b.col + b.cols && b.col < a.col + a.cols && a.row < b.row + b.rows && b.row < a.row + a.rows;
}

/**
 * What the contract charges for this block, now — the figure a buyer's permit is signed for.
 * `image-grid.ts`'s `quote` is the screen's preview of it; this is what a buy is prepared with.
 */
export function readQuote(client: PublicClient, board: Address, rect: Rect): Promise<bigint> {
  return reader(client, board)<bigint>('quote', [rect.col, rect.row, rect.cols, rect.rows]);
}

/**
 * What the contract charges for these rectangles bought together, now: the sum of each one's own
 * `quote`, which is exactly what `buyBlocks` pulls.
 */
export async function readBuyQuote(client: PublicClient, board: Address, rects: readonly Rect[]): Promise<bigint> {
  const quotes = await Promise.all(rects.map((rect) => readQuote(client, board, rect)));
  return quotes.reduce((sum, q) => sum + q, 0n);
}

/** What share of the creation prices a square costs now. The one board read that changes by an act of its holder. */
export async function readPriceBps(client: PublicClient, board: Address, opts: ReadAt = {}): Promise<number> {
  return Number(await reader(client, board, opts)<bigint>('priceBps'));
}

/** The taken-cells word for each of these rows, in one batch — what the gas estimate needs. */
export async function readRowBits(client: PublicClient, board: Address, rows: readonly number[], opts: ReadAt = {}): Promise<Map<number, bigint>> {
  const read = reader(client, board, opts);
  const words = await Promise.all(rows.map((r) => read<bigint>('rowBits', [BigInt(r)])));
  return new Map(rows.map((r, i) => [r, words[i]!]));
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
}

/**
 * `ImageBoardCollection.createBoardFor`. Refuses here what the contract would refuse, so a bad
 * config fails before anyone spends gas on a revert that names nothing.
 */
export function buildCreateImageBoard(o: CreateImageBoardOptions): CallRequest<'createBoardFor', [Address, unknown]> {
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
  return {
    address: o.collection,
    abi: IMAGE_BOARD_COLLECTION_ABI,
    functionName: 'createBoardFor',
    args: [
      o.seller,
      {
        settlementToken: o.settlementToken,
        width: o.width,
        height: o.height,
        cellSize: o.cellSize,
        cellPrice: o.cellPrice,
        imageHash: o.imageHash,
        zones: o.zones.map((z) => ({ col: z.col, row: z.row, cols: z.cols, rows: z.rows, cellPrice: z.cellPrice })),
        kept: o.kept.map((k) => ({ col: k.col, row: k.row, cols: k.cols, rows: k.rows })),
      },
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
  return rects.map((rect) => {
    const [col, row, cols, rows] = rectArgs(rect);
    return { col, row, cols, rows };
  });
}

/** `buyBlocks`, for a payer that has already approved the board: every rectangle its own block, all or nothing. */
export function buildBuyBlocks(o: {
  board: Address;
  recipient: Address;
  rects: readonly Rect[];
}): CallRequest<'buyBlocks', [Address, unknown]> {
  return {
    address: o.board,
    abi: IMAGE_BOARD_ABI,
    functionName: 'buyBlocks',
    args: [namedRecipient(o.recipient), rectsArg(o.rects)],
  };
}

export interface PermitSignature {
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

/**
 * `buyBlocksWithPermit`: one signature (`permitTypedData`) plus one transaction. `permitValue` is the
 * amount the permit was SIGNED for — the total the buyer was shown. The board pulls the total at the
 * moment of the buy, which a price cut can only have lowered.
 */
export function buildBuyBlocksWithPermit(o: {
  board: Address;
  recipient: Address;
  rects: readonly Rect[];
  permitValue: bigint;
  permit: PermitSignature;
}): CallRequest<'buyBlocksWithPermit', [Address, unknown, bigint, bigint, number, Hex, Hex]> {
  return {
    address: o.board,
    abi: IMAGE_BOARD_ABI,
    functionName: 'buyBlocksWithPermit',
    args: [namedRecipient(o.recipient), rectsArg(o.rects), o.permitValue, o.permit.deadline, o.permit.v, o.permit.r, o.permit.s],
  };
}

/**
 * `lowerPrices`: every unsold square to `priceBps` of the price set at creation. The board's holder
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
