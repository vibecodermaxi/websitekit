import { readFileSync } from 'node:fs';

import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, keccak256, toHex, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  IMAGE_BOARD_ABI,
  BOARD_DOMAIN_NAME,
  IMAGE_BOARD_COLLECTION_ABI,
  IMAGE_BOARD_CONFIG_PARAMS,
  blockEditorGrantTypedData,
  buildBuyBlocks,
  buildBuyBlocksWithPermit,
  buildCreateImageBoard,
  imageBoardTextProblem,
  ROBINHOOD_MAINNET_IMAGE_BOARDS,
  ROBINHOOD_TESTNET_IMAGE_BOARDS,
  blockRentQuote,
  buildClaimRent,
  buildEditRented,
  buildExtendRentalWithPermit,
  buildListForRent,
  buildRentBlockWithPermit,
  rentalLive,
  rentUnclaimed,
  buildLowerPrices,
  buildEditBlock,
  buildImageBoardWithdrawFor,
  buildSetBlockEditor,
  buildSetBlockEditorWithSig,
  buildTransferBlock,
  buildApproveBlock,
  buildSetBlockOperator,
  buildPokeBlock,
  pokeDue,
  IMAGE_BOARD_DEPLOYMENTS,
  IMAGE_BLOCK_RESALE_ROYALTY_BPS,
  IMAGE_BOARD_PROTOCOL_BPS,
  IMAGE_BOARD_ROYALTY_BPS,
  imageBoardDeploymentFor,
  resaleSplit,
  permitTypedData,
  splitSignature,
  type CreateImageBoardOptions,
} from './image-boards';
import { ROBINHOOD_MAINNET_USDG } from './settlement';

const BOARD = '0x00000000000000000000000000000000000b0a2d' as Address;
const COLLECTION = '0x0000000000000000000000000000000000c011ec' as Address;
const SELLER = '0x0000000000000000000000000000000000005e11' as Address;
const BUYER = '0x000000000000000000000000000000000000b0b0' as Address;
const TOKEN = '0x00000000000000000000000000000000000070c0' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
/** The page boards' Standard profile. */
const STANDARD = { takeBps: 14_000, payoutBps: 11_500, reversionBps: 9_700, maxReversionWeeks: 52, cooldownSecs: 3_600 };

/** Encodes and decodes against the ABI, so a builder whose args do not fit the function fails here
 *  rather than as a revert on chain. */
function roundTrip(request: { abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) {
  const data = encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args } as never);
  return decodeFunctionData({ abi: request.abi, data } as never);
}

/** The board's set-up, which `createBoardFor` carries as bytes the collection never reads. */
function configOf(decoded: { args?: readonly unknown[] }) {
  return decodeAbiParameters(IMAGE_BOARD_CONFIG_PARAMS, decoded.args?.[1] as Hex)[0];
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
    sourceCid: '0x01551220ab',
    name: 'A board',
    description: '',
    zones: [],
    terms: STANDARD,
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
    expect(configOf(decoded)).toMatchObject({ width: 300, height: 671, cellSize: 10, cellPrice: 10_003n, settlementToken: TOKEN });
  });

  it('refuses before sending what the contract would refuse', () => {
    expect(() => buildCreateImageBoard(createOptions({ seller: ZERO }))).toThrow(/seller/);
    expect(() => buildCreateImageBoard(createOptions({ settlementToken: ZERO }))).toThrow(/ERC-20/);
    expect(() => buildCreateImageBoard(createOptions({ cellSize: 9 }))).toThrow(/grid/);
    expect(() => buildCreateImageBoard(createOptions({ cellSize: 201 }))).toThrow(/grid/);
    // Any whole size in the range, not only the three a set-up screen offers (2026-10-20).
    expect(configOf(roundTrip(buildCreateImageBoard(createOptions({ cellSize: 12 }))))).toMatchObject({ cellSize: 12 });
    expect(() => buildCreateImageBoard(createOptions({ height: 10_010 }))).toThrow(/grid/);
    // Priced zero with no priced zone keeps every square: nothing for sale (2026-10-24).
    expect(() => buildCreateImageBoard(createOptions({ cellPrice: 0n }))).toThrow(/nothing-for-sale/);
    expect(() => buildCreateImageBoard(createOptions({ imageHash: `0x${'0'.repeat(64)}` as Hex }))).toThrow(/hash/);
  });

  it('carries a board priced zero that sells only its zones, and a kept zone', () => {
    const zones = [
      { col: 0, row: 0, cols: 4, rows: 3, cellPrice: 30_011n },
      { col: 4, row: 0, cols: 2, rows: 2, cellPrice: 0n },
    ];
    expect(configOf(roundTrip(buildCreateImageBoard(createOptions({ cellPrice: 0n, zones }))))).toMatchObject({ cellPrice: 0n, zones });
  });

  it('carries the zones, the name, the description and the source CID through the ABI', () => {
    const zones = [{ col: 0, row: 0, cols: 4, rows: 3, cellPrice: 30_011n }];
    const decoded = roundTrip(buildCreateImageBoard(createOptions({ zones, name: 'Ünïcode "quoted"', description: 'About it.', sourceCid: '0x0170122001' })));
    expect(configOf(decoded)).toMatchObject({ zones, name: 'Ünïcode "quoted"', description: 'About it.', sourceCid: '0x0170122001' });
  });

  /** The contract counts BYTES: a name of 50 two-byte letters is 100 bytes, and one more is refused. */
  it('refuses a name, description or source CID the contract would refuse', () => {
    expect(() => buildCreateImageBoard(createOptions({ name: '' }))).toThrow(/name/);
    expect(() => buildCreateImageBoard(createOptions({ name: 'é'.repeat(50) }))).not.toThrow();
    expect(() => buildCreateImageBoard(createOptions({ name: 'é'.repeat(50) + 'a' }))).toThrow(/name/);
    expect(() => buildCreateImageBoard(createOptions({ description: 'a'.repeat(1_000) }))).not.toThrow();
    expect(() => buildCreateImageBoard(createOptions({ description: 'a'.repeat(1_001) }))).toThrow(/description/);
    expect(() => buildCreateImageBoard(createOptions({ sourceCid: '0x' }))).toThrow(/CID/);
    expect(() => buildCreateImageBoard(createOptions({ sourceCid: '0x0055' }))).toThrow(/CID/);
    expect(() => buildCreateImageBoard(createOptions({ sourceCid: `0x01${'00'.repeat(64)}` as Hex }))).toThrow(/CID/);
    expect(() => buildCreateImageBoard(createOptions({ sourceCid: `0x01${'00'.repeat(63)}` as Hex }))).not.toThrow();
  });

  it('refuses a layout the contract would refuse, and a zone price that would not encode', () => {
    const zone = { col: 0, row: 0, cols: 3, rows: 3, cellPrice: 1n };
    expect(() => buildCreateImageBoard(createOptions({ zones: [zone, { ...zone, col: 2 }] }))).toThrow(/zones-overlap at 1/);
    expect(() => buildCreateImageBoard(createOptions({ zones: [{ ...zone, cellPrice: 1n << 192n }] }))).toThrow(/out of range/);
    expect(() => buildCreateImageBoard(createOptions({ zones: [{ ...zone, cellPrice: (1n << 192n) - 1n }] }))).not.toThrow();
  });

  it('carries the terms through the ABI', () => {
    const decoded = roundTrip(buildCreateImageBoard(createOptions()));
    expect(configOf(decoded)).toMatchObject({
      terms: { takeBps: 14_000n, payoutBps: 11_500n, reversionBps: 9_700n, maxReversionWeeks: 52n, cooldownSecs: 3_600n },
    });
  });

  it('refuses terms the contract would refuse, at each clamp', () => {
    const terms = (t: Partial<typeof STANDARD>) => createOptions({ terms: { ...STANDARD, ...t } });
    // The take must clear the payout plus the protocol's 500.
    expect(() => buildCreateImageBoard(terms({ takeBps: 12_000 }))).toThrow(/TakeBelowPayout/);
    expect(() => buildCreateImageBoard(terms({ takeBps: 12_001 }))).not.toThrow();
    expect(() => buildCreateImageBoard(terms({ payoutBps: 9_999 }))).toThrow(/PayoutBelowPrincipal/);
    expect(() => buildCreateImageBoard(terms({ takeBps: 30_001 }))).toThrow(/TakeTooHigh/);
    expect(() => buildCreateImageBoard(terms({ reversionBps: 0 }))).toThrow(/InvalidReversion/);
    expect(() => buildCreateImageBoard(terms({ maxReversionWeeks: 53 }))).toThrow(/InvalidReversion/);
    expect(() => buildCreateImageBoard(terms({ cooldownSecs: 604_801 }))).toThrow(/InvalidConfig/);
    expect(() => buildCreateImageBoard(terms({ cooldownSecs: 1.5 }))).toThrow(/whole number/);
  });

  it('accepts the largest grid', () => {
    expect(() => buildCreateImageBoard(createOptions({ width: 2569, height: 10_009 }))).not.toThrow();
  });
});

describe('buying', () => {
  const rect = { col: 4, row: 5, cols: 3, rows: 2 };
  const other = { col: 0, row: 0, cols: 1, rows: 1 };

  const buy = { board: BOARD, recipient: BUYER, maxTotal: 600_000n, deadline: 1_900_000_000n };

  it('buyBlocks names the recipient, every rectangle in order, the most it pays and the deadline', () => {
    const decoded = roundTrip(buildBuyBlocks({ ...buy, rects: [rect, other] }));
    expect(decoded.functionName).toBe('buyBlocks');
    expect(decoded.args).toEqual([BUYER, [rect, other], 600_000n, 1_900_000_000n]);
  });

  it('buyBlocksWithPermit carries the most it pays — what the permit signs — and the permit after the rectangles', () => {
    const permit = { deadline: 1_900_000_000n, v: 27, r: `0x${'aa'.repeat(32)}` as Hex, s: `0x${'bb'.repeat(32)}` as Hex };
    const decoded = roundTrip(buildBuyBlocksWithPermit({ board: BOARD, recipient: BUYER, rects: [rect], maxTotal: 600_000n, permit }));
    expect(decoded.functionName).toBe('buyBlocksWithPermit');
    expect(decoded.args).toEqual([BUYER, [rect], 600_000n, 1_900_000_000n, 27, permit.r, permit.s]);
  });

  it('refuses a buy that names no most', () => {
    expect(() => buildBuyBlocks({ ...buy, rects: [rect], maxTotal: 0n })).toThrow(/most/);
  });

  it('refuses an unnamed recipient — never the sender by default', () => {
    expect(() => buildBuyBlocks({ ...buy, recipient: ZERO, rects: [rect] })).toThrow(/recipient/);
  });

  it('refuses an empty buy, as the contract would', () => {
    expect(() => buildBuyBlocks({ ...buy, rects: [] })).toThrow(/at least one/);
  });

  it('refuses coordinates a uint16 cannot carry, in any rectangle', () => {
    expect(() => buildBuyBlocks({ ...buy, rects: [{ ...rect, col: 65_536 }] })).toThrow(/col/);
    expect(() => buildBuyBlocks({ ...buy, rects: [rect, { ...rect, rows: -1 }] })).toThrow(/rows/);
    expect(() => buildBuyBlocks({ ...buy, rects: [{ ...rect, cols: 1.5 }] })).toThrow(/cols/);
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
    // A block is an ERC-721: it moves by `transferFrom(from, to, id)`, sent by its owner or anyone they approved.
    const give = buildTransferBlock({ board: BOARD, from: SELLER, tokenId: 2n, to: BUYER });
    expect(give.functionName).toBe('transferFrom');
    expect(roundTrip(give).args).toEqual([SELLER, BUYER, 2n]);
    expect(() => buildTransferBlock({ board: BOARD, from: SELLER, tokenId: 2n, to: ZERO })).toThrow(/given to someone/);
    expect(() => buildTransferBlock({ board: BOARD, from: ZERO, tokenId: 2n, to: BUYER })).toThrow(/moved from/);
    expect(roundTrip(buildApproveBlock({ board: BOARD, spender: BUYER, tokenId: 2n })).args).toEqual([BUYER, 2n]);
    expect(roundTrip(buildSetBlockOperator({ board: BOARD, operator: BUYER, approved: true })).args).toEqual([BUYER, true]);
    expect(roundTrip(buildPokeBlock({ board: BOARD, tokenId: 2n })).args).toEqual([2n]);
    const withdraw = buildImageBoardWithdrawFor({ board: BOARD, account: SELLER });
    expect(withdraw.abi).toBe(IMAGE_BOARD_ABI);
    expect(roundTrip(withdraw).args).toEqual([SELLER]);
  });
});

/**
 * The token generation (spec §13) is on both chains. Mainnet settles in real USDG — the same address
 * the page boards settle in, since token identity is the address — and nothing there is mintable.
 */
describe('imageBoardDeploymentFor', () => {
  it('answers both chains with the token generation, and refuses any other by name', () => {
    expect(Object.keys(IMAGE_BOARD_DEPLOYMENTS).sort()).toEqual(['4663', '46630']);
    expect(imageBoardDeploymentFor(46630)).toBe(ROBINHOOD_TESTNET_IMAGE_BOARDS);
    expect(imageBoardDeploymentFor(46630).mintable).toBe(true);
    expect(imageBoardDeploymentFor(4663)).toBe(ROBINHOOD_MAINNET_IMAGE_BOARDS);
    expect(imageBoardDeploymentFor(4663).mintable).toBe(false);
    expect(imageBoardDeploymentFor(4663).token).toBe(ROBINHOOD_MAINNET_USDG.address);
    expect(() => imageBoardDeploymentFor(1)).toThrow('websitekit: image boards are not deployed on chain 1. Deployed chains: 4663, 46630.');
  });
});

describe('the cut and the royalties the contracts carry', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
  it('are the constants in the Solidity, and the protocol cut the deploy script insists on', () => {
    const collection = read('../../websitekit-contracts/src/ImageBoardCollection.sol');
    // The board's constants are declared in its storage base, which the board and its extension share.
    const board = read('../../websitekit-contracts/src/ImageBoardStorage.sol');
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

describe('renting a block (2026-10-20)', () => {
  const permit = { deadline: 1_900_000_000n, v: 27, r: `0x${'11'.repeat(32)}` as Hex, s: `0x${'22'.repeat(32)}` as Hex };

  it('quotes a term as the contract books it: 5% each to the protocol and the holder, truncated, the rest escrowed', () => {
    // 1,000,003 a day for 36 hours: 1,500,004.5 → 1,500,004; 5% of it is 75,000.2 → 75,000 each.
    expect(blockRentQuote(1_000_003n, 129_600n)).toEqual({ cost: 1_500_004n, protocolCut: 75_000n, royalty: 75_000n, net: 1_350_004n });
    const q = blockRentQuote(7n, 3_600n); // a sub-unit term truncates to nothing, as on chain
    expect(q).toEqual({ cost: 0n, protocolCut: 0n, royalty: 0n, net: 0n });
  });

  it('encodes each call with the tenant named and the term inside an hour to a year', () => {
    const rent = roundTrip(buildRentBlockWithPermit({ board: BOARD, tokenId: 3n, tenant: SELLER, durationSecs: 86_400n, expectedRatePerDay: 9n, permit }));
    expect(rent.functionName).toBe('rentWithPermit');
    expect(rent.args).toEqual([3n, SELLER, 86_400n, 9n, permit.deadline, 27, permit.r, permit.s]);
    expect(roundTrip(buildExtendRentalWithPermit({ board: BOARD, tokenId: 3n, durationSecs: 3_600n, expectedRatePerDay: 9n, permit })).functionName).toBe(
      'extendRentalWithPermit',
    );
    expect(roundTrip(buildListForRent({ board: BOARD, tokenId: 3n, ratePerDay: 9n, maxDurationSecs: 31_536_000n })).args).toEqual([3n, 9n, 31_536_000n]);
    expect(roundTrip(buildListForRent({ board: BOARD, tokenId: 3n, ratePerDay: 0n, maxDurationSecs: 99n })).args).toEqual([3n, 0n, 0n]);
    expect(roundTrip(buildClaimRent({ board: BOARD, tokenIds: [1n, 4n] })).args).toEqual([[1n, 4n]]);
    expect(roundTrip(buildEditRented({ board: BOARD, tokenId: 3n, contentHash: `0x${'ab'.repeat(32)}` as Hex })).functionName).toBe('editRented');
  });

  it('refuses before sending what the contract would refuse', () => {
    const base = { board: BOARD, tokenId: 3n, tenant: SELLER, expectedRatePerDay: 9n, permit };
    expect(() => buildRentBlockWithPermit({ ...base, durationSecs: 3_599n })).toThrow(/term/);
    expect(() => buildRentBlockWithPermit({ ...base, durationSecs: 31_536_001n })).toThrow(/term/);
    expect(() => buildRentBlockWithPermit({ ...base, durationSecs: 3_600n, tenant: ZERO })).toThrow(/named/);
    expect(() => buildListForRent({ board: BOARD, tokenId: 3n, ratePerDay: 9n, maxDurationSecs: 31_536_001n })).toThrow(/term/);
    expect(() => buildClaimRent({ board: BOARD, tokenIds: [] })).toThrow(/at least one/);
  });

  it('ends a term AT its expiry, and streams linearly to it', () => {
    const rental = { tenant: SELLER, start: 1_000n, expiry: 1_100n, prepaid: 1_000n, claimed: 200n, tenantHash: `0x${'00'.repeat(32)}` as Hex, poked: false };
    expect(rentalLive(rental, 1_099n)).toBe(true);
    expect(rentalLive(rental, 1_100n)).toBe(false);
    expect(rentUnclaimed(rental, 1_050n)).toBe(300n); // 500 streamed, 200 already credited
    expect(rentUnclaimed(rental, 9_999n)).toBe(800n); // stops at the end
  });

  it('says a poke is due only after a term that showed a tenant picture, and only once', () => {
    const picture = `0x${'ab'.repeat(32)}` as Hex;
    const none = `0x${'00'.repeat(32)}` as Hex;
    expect(pokeDue({ expiry: 1_100n, tenantHash: picture, poked: false }, 1_099n)).toBe(false);
    expect(pokeDue({ expiry: 1_100n, tenantHash: picture, poked: false }, 1_100n)).toBe(true);
    expect(pokeDue({ expiry: 1_100n, tenantHash: none, poked: false }, 1_100n)).toBe(false);
    expect(pokeDue({ expiry: 1_100n, tenantHash: picture, poked: true }, 1_100n)).toBe(false);
    expect(pokeDue({ expiry: 0n, tenantHash: picture, poked: false }, 1_100n)).toBe(false);
  });
});

describe('imageBoardTextProblem — bytes, as initialize counts them', () => {
  it('a name is 1 to 100 bytes', () => {
    expect(imageBoardTextProblem('', '')).toBe('name');
    expect(imageBoardTextProblem('a'.repeat(100), '')).toBeNull();
    expect(imageBoardTextProblem('a'.repeat(101), '')).toBe('name');
    // 25 four-byte emoji are 100 bytes; one more letter is over, though it is 26 "characters".
    expect(imageBoardTextProblem('🟦'.repeat(25), '')).toBeNull();
    expect(imageBoardTextProblem(`${'🟦'.repeat(25)}a`, '')).toBe('name');
  });

  it('a description is at most 1,000 bytes, and may be empty', () => {
    expect(imageBoardTextProblem('n', 'é'.repeat(500))).toBeNull();
    expect(imageBoardTextProblem('n', `${'é'.repeat(500)}a`)).toBe('description');
  });

  it('the builder refuses what it refuses', () => {
    expect(() => buildCreateImageBoard({ ...createOptions(), name: 'a'.repeat(101) })).toThrow(/1 to 100 bytes/);
    expect(() => buildCreateImageBoard({ ...createOptions(), description: 'a'.repeat(1_001) })).toThrow(/1,000/);
  });
});
