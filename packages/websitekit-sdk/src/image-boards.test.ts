import { readFileSync } from 'node:fs';

import { decodeFunctionData, encodeFunctionData, keccak256, toHex, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  IMAGE_BOARD_ABI,
  BOARD_DOMAIN_NAME,
  IMAGE_BOARD_COLLECTION_ABI,
  blockEditorGrantTypedData,
  buildBuyBlocks,
  buildBuyBlocksWithPermit,
  buildCreateImageBoard,
  buildLowerPrices,
  buildEditBlock,
  buildImageBoardWithdrawFor,
  buildSetBlockEditor,
  buildSetBlockEditorWithSig,
  buildTransferBlock,
  IMAGE_BLOCK_RESALE_ROYALTY_BPS,
  IMAGE_BOARD_PROTOCOL_BPS,
  IMAGE_BOARD_ROYALTY_BPS,
  imageBoardDeploymentFor,
  resaleSplit,
  permitTypedData,
  splitSignature,
  type CreateImageBoardOptions,
} from './image-boards';

const BOARD = '0x00000000000000000000000000000000000b0a2d' as Address;
const COLLECTION = '0x0000000000000000000000000000000000c011ec' as Address;
const SELLER = '0x0000000000000000000000000000000000005e11' as Address;
const BUYER = '0x000000000000000000000000000000000000b0b0' as Address;
const TOKEN = '0x00000000000000000000000000000000000070c0' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;

/** Encodes and decodes against the ABI, so a builder whose args do not fit the function fails here
 *  rather than as a revert on chain. */
function roundTrip(request: { abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) {
  const data = encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args } as never);
  return decodeFunctionData({ abi: request.abi, data } as never);
}

function createOptions(overrides: Partial<CreateImageBoardOptions> = {}): CreateImageBoardOptions {
  return {
    collection: COLLECTION,
    seller: SELLER,
    settlementToken: TOKEN,
    width: 300,
    height: 671,
    cellSize: 10,
    cellPrice: 10_003n,
    imageHash: keccak256(toHex('img')),
    zones: [],
    kept: [],
    ...overrides,
  };
}

describe('buildCreateImageBoard', () => {
  it('encodes createBoardFor with the seller named and the config intact', () => {
    const request = buildCreateImageBoard(createOptions());
    expect(request.address).toBe(COLLECTION);
    expect(request.abi).toBe(IMAGE_BOARD_COLLECTION_ABI);
    const decoded = roundTrip(request);
    expect(decoded.functionName).toBe('createBoardFor');
    expect(decoded.args?.[0]).toBe(SELLER);
    expect(decoded.args?.[1]).toMatchObject({ width: 300, height: 671, cellSize: 10, cellPrice: 10_003n, settlementToken: TOKEN });
  });

  it('refuses before sending what the contract would refuse', () => {
    expect(() => buildCreateImageBoard(createOptions({ seller: ZERO }))).toThrow(/seller/);
    expect(() => buildCreateImageBoard(createOptions({ settlementToken: ZERO }))).toThrow(/ERC-20/);
    expect(() => buildCreateImageBoard(createOptions({ cellSize: 12 }))).toThrow(/grid/);
    expect(() => buildCreateImageBoard(createOptions({ height: 10_010 }))).toThrow(/grid/);
    expect(() => buildCreateImageBoard(createOptions({ cellPrice: 0n }))).toThrow(/price/);
    expect(() => buildCreateImageBoard(createOptions({ imageHash: `0x${'0'.repeat(64)}` as Hex }))).toThrow(/hash/);
  });

  it('carries the zones and kept blocks through the ABI', () => {
    const zones = [{ col: 0, row: 0, cols: 4, rows: 3, cellPrice: 30_011n }];
    const kept = [{ col: 10, row: 10, cols: 2, rows: 2 }];
    const decoded = roundTrip(buildCreateImageBoard(createOptions({ zones, kept })));
    expect(decoded.args?.[1]).toMatchObject({ zones, kept });
  });

  it('refuses a layout the contract would refuse, and a zone price that would not encode', () => {
    const zone = { col: 0, row: 0, cols: 3, rows: 3, cellPrice: 1n };
    expect(() => buildCreateImageBoard(createOptions({ zones: [zone, { ...zone, col: 2 }] }))).toThrow(/zones-overlap at 1/);
    expect(() => buildCreateImageBoard(createOptions({ kept: [{ col: 29, row: 0, cols: 2, rows: 1 }] }))).toThrow(/kept-outside at 0/);
    expect(() => buildCreateImageBoard(createOptions({ zones: [{ ...zone, cellPrice: 1n << 192n }] }))).toThrow(/out of range/);
    expect(() => buildCreateImageBoard(createOptions({ zones: [{ ...zone, cellPrice: (1n << 192n) - 1n }] }))).not.toThrow();
  });

  it('accepts the largest grid', () => {
    expect(() => buildCreateImageBoard(createOptions({ width: 2569, height: 10_009 }))).not.toThrow();
  });
});

describe('buying', () => {
  const rect = { col: 4, row: 5, cols: 3, rows: 2 };
  const other = { col: 0, row: 0, cols: 1, rows: 1 };

  it('buyBlocks names the recipient and every rectangle, in order', () => {
    const decoded = roundTrip(buildBuyBlocks({ board: BOARD, recipient: BUYER, rects: [rect, other] }));
    expect(decoded.functionName).toBe('buyBlocks');
    expect(decoded.args).toEqual([BUYER, [rect, other]]);
  });

  it('buyBlocksWithPermit carries the signed value and the permit after the rectangles', () => {
    const permit = { deadline: 1_900_000_000n, v: 27, r: `0x${'aa'.repeat(32)}` as Hex, s: `0x${'bb'.repeat(32)}` as Hex };
    const decoded = roundTrip(buildBuyBlocksWithPermit({ board: BOARD, recipient: BUYER, rects: [rect], permitValue: 600_000n, permit }));
    expect(decoded.functionName).toBe('buyBlocksWithPermit');
    expect(decoded.args).toEqual([BUYER, [rect], 600_000n, 1_900_000_000n, 27, permit.r, permit.s]);
  });

  it('refuses an unnamed recipient — never the sender by default', () => {
    expect(() => buildBuyBlocks({ board: BOARD, recipient: ZERO, rects: [rect] })).toThrow(/recipient/);
  });

  it('refuses an empty buy, as the contract would', () => {
    expect(() => buildBuyBlocks({ board: BOARD, recipient: BUYER, rects: [] })).toThrow(/at least one/);
  });

  it('refuses coordinates a uint16 cannot carry, in any rectangle', () => {
    expect(() => buildBuyBlocks({ board: BOARD, recipient: BUYER, rects: [{ ...rect, col: 65_536 }] })).toThrow(/col/);
    expect(() => buildBuyBlocks({ board: BOARD, recipient: BUYER, rects: [rect, { ...rect, rows: -1 }] })).toThrow(/rows/);
    expect(() => buildBuyBlocks({ board: BOARD, recipient: BUYER, rects: [{ ...rect, cols: 1.5 }] })).toThrow(/cols/);
  });
});

describe('lowering prices', () => {
  it('encodes lowerPrices with the share', () => {
    const decoded = roundTrip(buildLowerPrices({ board: BOARD, priceBps: 7_500 }));
    expect(decoded.functionName).toBe('lowerPrices');
    expect(decoded.args).toEqual([7_500n]);
  });

  it('refuses what is not a cut: zero, full price, more, or a fraction', () => {
    for (const priceBps of [0, 10_000, 12_000, 50.5, -1]) {
      expect(() => buildLowerPrices({ board: BOARD, priceBps }), String(priceBps)).toThrow(/not a cut/);
    }
    expect(roundTrip(buildLowerPrices({ board: BOARD, priceBps: 1 })).args).toEqual([1n]);
    expect(roundTrip(buildLowerPrices({ board: BOARD, priceBps: 9_999 })).args).toEqual([9_999n]);
  });
});

describe('permits and signatures', () => {
  it('signs over the token’s own domain with the board as spender', () => {
    const typed = permitTypedData({
      token: TOKEN,
      tokenName: 'Global Dollar',
      chainId: 4663,
      owner: BUYER,
      spender: BOARD,
      value: 60_018n,
      nonce: 3n,
      deadline: 99n,
    });
    expect(typed.domain).toEqual({ name: 'Global Dollar', version: '1', chainId: 4663, verifyingContract: TOKEN });
    expect(typed.message).toEqual({ owner: BUYER, spender: BOARD, value: 60_018n, nonce: 3n, deadline: 99n });
  });

  it('splits a 65-byte signature into r, s, v', () => {
    const sig = `0x${'11'.repeat(32)}${'22'.repeat(32)}1c` as Hex;
    expect(splitSignature(sig, 5n)).toEqual({ deadline: 5n, r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}`, v: 28 });
    expect(() => splitSignature('0x1234', 5n)).toThrow(/65 bytes/);
  });

  it('the editor grant is typed exactly as the contract hashes it', () => {
    const typed = blockEditorGrantTypedData({
      board: BOARD,
      chainId: 46630,
      tokenId: 2n,
      editor: SELLER,
      nonce: 0n,
      deadline: 9n,
    });
    // ImageBoard.sol: EditorGrant(uint256 blockId,address editor,uint256 nonce,uint256 deadline)
    expect(typed.types.EditorGrant.map((f) => `${f.type} ${f.name}`).join(',')).toBe(
      'uint256 blockId,address editor,uint256 nonce,uint256 deadline',
    );
    // ImageBoard.sol: DOMAIN_NAME_HASH = keccak256("Image Board"), one name for every board, naming no product.
    expect(typed.domain).toEqual({ name: BOARD_DOMAIN_NAME, version: '1', chainId: 46630, verifyingContract: BOARD });
    expect(BOARD_DOMAIN_NAME).toBe('Image Board');
    expect(typed.message).toEqual({ blockId: 2n, editor: SELLER, nonce: 0n, deadline: 9n });
  });
});

describe('holder calls', () => {
  it('encode against the board ABI', () => {
    const hash = keccak256(toHex('picture'));
    expect(roundTrip(buildEditBlock({ board: BOARD, tokenId: 2n, contentHash: hash })).args).toEqual([2n, hash]);
    expect(roundTrip(buildSetBlockEditor({ board: BOARD, tokenId: 2n, editor: SELLER })).args).toEqual([2n, SELLER]);
    const sig = `0x${'ab'.repeat(65)}` as Hex;
    expect(
      roundTrip(buildSetBlockEditorWithSig({ board: BOARD, tokenId: 2n, editor: SELLER, deadline: 7n, signature: sig })).args,
    ).toEqual([2n, SELLER, 7n, sig]);
    // A block moves by `transferBlock(blockId, to)`, its owner's own call — it is not a token.
    const give = buildTransferBlock({ board: BOARD, tokenId: 2n, to: BUYER });
    expect(give.functionName).toBe('transferBlock');
    expect(roundTrip(give).args).toEqual([2n, BUYER]);
    expect(() => buildTransferBlock({ board: BOARD, tokenId: 2n, to: ZERO })).toThrow(/given to someone/);
    const withdraw = buildImageBoardWithdrawFor({ board: BOARD, account: SELLER });
    expect(withdraw.abi).toBe(IMAGE_BOARD_ABI);
    expect(roundTrip(withdraw).args).toEqual([SELLER]);
  });
});

/** Testnet only until mainnet is deployed (2026-10-12): mainnet is refused, never answered with testnet's addresses. */
describe('imageBoardDeploymentFor', () => {
  it('names the testnet deployment, and refuses mainnet and any other chain by name', () => {
    expect(imageBoardDeploymentFor(46630)).toMatchObject({ chainId: 46630, decimals: 6, mintable: true });
    expect(imageBoardDeploymentFor(46630).collection).toMatch(/^0x[0-9a-f]{40}$/);
    expect(() => imageBoardDeploymentFor(4663)).toThrow('websitekit: image boards are not deployed on chain 4663. Deployed chains: 46630.');
    expect(() => imageBoardDeploymentFor(1)).toThrow(/not deployed on chain 1\./);
  });
});

describe('the cut and the royalties the contracts carry', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
  it('are the constants in the Solidity, and the protocol cut the deploy script insists on', () => {
    const collection = read('../../websitekit-contracts/src/ImageBoardCollection.sol');
    const board = read('../../websitekit-contracts/src/ImageBoard.sol');
    const deploy = read('../scripts/deploy-image-boards.ts');
    expect(collection.match(/ROYALTY_BPS = (\d+);/)?.[1]).toBe(String(IMAGE_BOARD_ROYALTY_BPS));
    expect(board.match(/RESALE_ROYALTY_BPS = (\d+);/)?.[1]).toBe(String(IMAGE_BLOCK_RESALE_ROYALTY_BPS));
    expect(deploy.match(/protocolBps !== (\d+)n\)/)?.[1]).toBe(String(IMAGE_BOARD_PROTOCOL_BPS));
  });
});

/** The contract's own boundaries (`ImageBoardResale.t.sol`), where its `resaleSplit` is tested. */
describe('resaleSplit', () => {
  it('rounds both shares down and gives the owner the rest', () => {
    expect(resaleSplit(1_000_003n)).toEqual({ protocolCut: 50_000n, royalty: 50_000n, toOwner: 900_003n });
    expect(resaleSplit(19n)).toEqual({ protocolCut: 0n, royalty: 0n, toOwner: 19n });
    expect(resaleSplit(20n)).toEqual({ protocolCut: 1n, royalty: 1n, toOwner: 18n });
  });

  it('takes the protocol cut at its own rate, not the royalty’s', () => {
    expect(resaleSplit(1_000_003n, 300n)).toEqual({ protocolCut: 30_000n, royalty: 50_000n, toOwner: 920_003n });
  });
});
