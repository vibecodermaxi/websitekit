/**
 * Proves the BUILT reference renderer page against real bytecode: anvil as chain 46630, the four
 * image-board contracts deployed, a board with blocks bought, taken and written, and the page in
 * headless Chromium drawing it — its pixels compared with `composeBoard` on the pictures as made.
 *
 *   pnpm --filter @websitekit/sdk build:renderer
 *   PLAYWRIGHT_CORE=<dir with node_modules/playwright-core> \
 *     pnpm --filter @websitekit/sdk exec tsx renderer/prove-page.ts
 *
 * The page is loaded at `https://gw.test/ipfs/<cid>/?chain=46630&board=…` with every request
 * answered here: the chain's public RPC is forwarded to anvil, `gw.test` is the gateway serving the
 * page (so it is asked first, as on a real gateway), and the public gateways are refused. That
 * proves what the page reads and draws; whether real gateways and a marketplace's frame serve it is
 * a question for a deployment on a real chain.
 *
 * The board, 20×12 cells of 10 px over a 205×124 source (a strip no cell fits on both edges):
 *   1  (0,0) 4×4   a full-size picture
 *   2  (2,2) 4×3   a half-size picture with transparent pixels, taking part of 1
 *   3  (10,5) 3×3  no picture
 *   4  (14,8) 2×2  a picture the gateway answers with other bytes, of the right size
 *   5  (16,0) 4×4  a picture of neither accepted size
 *   6  (0,0) 1×1   a full-size picture, taking one more cell of 1, then rented: the tenant's
 *                  picture is the one drawn
 *
 * And two boards over the same source declared another size, 215×124 and 205×134: not the source
 * either was made from, so their blocks are drawn on nothing.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  sha256,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

import { IMAGE_BOARD_CONFIG_PARAMS, cellMapFromBlocks, composeBoard, contentHashToCid, type ComposedBlock, type RgbaPicture } from '../src/image-boards';
import { ROBINHOOD_TESTNET_CHAIN } from '../src/chains';

const here = path.dirname(fileURLToPath(import.meta.url));
const contractsOut = path.resolve(here, '../../websitekit-contracts/out');
const PORT = 8611;
const ANVIL = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = ROBINHOOD_TESTNET_CHAIN.id;
const GATEWAY = 'https://gw.test';
const PAGE_CID = 'bafybeipageundertest';

// anvil's first two dev keys.
const DEPLOYER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const BUYER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

const chain = { ...foundry, id: CHAIN_ID };
const client = createPublicClient({ chain, transport: http(ANVIL) });
const wallet = createWalletClient({ chain, transport: http(ANVIL) });

function artifact(solFile: string, name: string): { abi: Abi; bytecode: Hex } {
  const json = JSON.parse(readFileSync(path.join(contractsOut, solFile, `${name}.json`), 'utf-8'));
  return { abi: json.abi as Abi, bytecode: json.bytecode.object as Hex };
}

const usdArt = artifact('TestUSD.sol', 'TestUSD');
const boardArt = artifact('ImageBoard.sol', 'ImageBoard');
const extensionArt = artifact('ImageBoardExtension.sol', 'ImageBoardExtension');
const rendererArt = artifact('ImageBoardRenderer.sol', 'ImageBoardRenderer');
const collectionArt = artifact('ImageBoardCollection.sol', 'ImageBoardCollection');

type Account = typeof DEPLOYER;

async function deploy(art: { abi: Abi; bytecode: Hex }, args: readonly unknown[]): Promise<Address> {
  const hash = await wallet.deployContract({ ...art, args, account: DEPLOYER } as never);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`deploy reverted (${hash})`);
  return receipt.contractAddress!;
}

async function send(account: Account, address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<void> {
  const hash = await wallet.writeContract({ address, abi, functionName, args, account } as never);
  const receipt = await client.waitForTransactionReceipt({ hash });
  // A reverted transaction still resolves with a receipt; only `status` tells.
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted (${hash})`);
}

function read<T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
  return client.readContract({ address, abi, functionName, args } as never) as Promise<T>;
}

// ---------------------------------------------------------------------------
// Pictures: RGBA made here, PNG-encoded by Chromium (lossless at alpha 0 and 255)
// ---------------------------------------------------------------------------

function picture(width: number, height: number, px: (x: number, y: number) => [number, number, number, number]): RgbaPicture {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(px(x, y), (y * width + x) * 4);
  return { width, height, rgba };
}

const SOURCE = picture(205, 124, (x, y) => [(x * 5) % 256, (y * 7) % 256, 128, 255]);
const PICTURES: Record<string, RgbaPicture> = {
  one: picture(40, 40, (x, y) => [250, (x * 6) % 256, (y * 6) % 256, 255]),
  // Half of 40×30; a transparent checker every third pixel shows the source through.
  two: picture(20, 15, (x, y) => ((x + y) % 3 === 0 ? [0, 0, 0, 0] : [10, 200, (x * 12) % 256, 255])),
  four: picture(20, 20, () => [0, 0, 255, 255]),
  // What the gateway answers for four: the same size, other bytes.
  impostor: picture(20, 20, () => [255, 0, 255, 255]),
  five: picture(33, 40, () => [255, 255, 0, 255]),
  six: picture(10, 10, (x) => [x * 25, 0, 0, 255]),
  tenant: picture(10, 10, (_, y) => [0, y * 25, 0, 255]),
};

// ---------------------------------------------------------------------------

function newestHeadlessShell(): string {
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const dir = readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().at(-1);
  if (!dir) throw new Error(`no chromium_headless_shell in ${cache}`);
  return path.join(cache, dir, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
}

function pass(what: string): void {
  console.log(`  ok  ${what}`);
}

let anvil: ChildProcess | undefined;

async function main(): Promise<void> {
  const pwDir = process.env.PLAYWRIGHT_CORE;
  if (!pwDir) throw new Error('PLAYWRIGHT_CORE is not set: a directory whose node_modules has playwright-core, outside the repo');
  // Installed outside the repo, so it has no types here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { chromium } = createRequire(path.join(pwDir, 'x.js'))('playwright-core') as { chromium: { launch(o: object): Promise<any> } };
  const pageHtml = readFileSync(path.join(here, 'dist/index.html'), 'utf-8');

  anvil = spawn('anvil', ['--port', String(PORT), '--chain-id', String(CHAIN_ID), '--silent'], { stdio: 'ignore' });
  for (let i = 0; ; i++) {
    try {
      await client.getBlockNumber();
      break;
    } catch {
      if (i > 100) throw new Error('anvil did not start');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  // Multicall3's own code, from the chain the page reads, at its canonical address.
  const testnet = createPublicClient({ transport: http(ROBINHOOD_TESTNET_CHAIN.rpcUrl, { fetchOptions: { headers: { 'user-agent': 'Mozilla/5.0' } } }) });
  const multicall = await testnet.getCode({ address: '0xcA11bde05977b3631167028862bE2a173976CA11' });
  if (!multicall) throw new Error('no Multicall3 on the testnet');
  await client.request({ method: 'anvil_setCode' as never, params: ['0xcA11bde05977b3631167028862bE2a173976CA11', multicall] as never });

  const browser = await chromium.launch({ executablePath: newestHeadlessShell() });
  try {
    const page = await browser.newPage();
    // Chromium does the PNG encoding: the bytes the gateway serves and the chain hashes.
    await page.goto('about:blank');
    const png = async (p: RgbaPicture): Promise<Buffer> => {
      const b64 = await page.evaluate(
        ({ w, h, data }: { w: number; h: number; data: number[] }) => {
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
          return c.toDataURL('image/png').split(',')[1]!;
        },
        { w: p.width, h: p.height, data: Array.from(p.rgba) },
      );
      return Buffer.from(b64, 'base64');
    };
    const sourcePng = await png(SOURCE);
    const pngs = Object.fromEntries(await Promise.all(Object.entries(PICTURES).map(async ([k, p]) => [k, await png(p)] as const)));
    const hashOf = (b: Buffer): Hex => sha256(b);

    // Deploy, as `scripts/deploy-image-boards.ts` does.
    const usd = await deploy(usdArt, ['websitekit Test Dollar', 'tUSD', 6]);
    const extension = await deploy(extensionArt, [500n, DEPLOYER.address]);
    const renderer = await deploy(rendererArt, ['https://thumbs.test/', `ipfs://${PAGE_CID}/`]);
    const implementation = await deploy(boardArt, [extension, renderer]);
    const collection = await deploy(collectionArt, ['Image Boards', 'IMG', DEPLOYER.address, implementation, [usd], '']);

    const sourceHash = hashOf(sourcePng);
    const configFor = (width: number, height: number) => encodeAbiParameters(IMAGE_BOARD_CONFIG_PARAMS, [
      {
        settlementToken: usd,
        width,
        height,
        cellSize: 10,
        cellPrice: 10_000n,
        imageHash: sourceHash,
        // A source this small is one raw block, so its CID is its hash's.
        sourceCid: `0x01551220${sourceHash.slice(2)}`,
        name: 'Proof "board"',
        description: '',
        zones: [],
        terms: { takeBps: 14_000n, payoutBps: 11_500n, reversionBps: 9_700n, maxReversionWeeks: 52n, cooldownSecs: 0n },
      },
    ]);
    async function create(width: number, height: number): Promise<Address> {
      const config = configFor(width, height);
      const { result } = await client.simulateContract({ address: collection, abi: collectionArt.abi, functionName: 'createBoardFor', args: [DEPLOYER.address, config], account: DEPLOYER } as never);
      await send(DEPLOYER, collection, collectionArt.abi, 'createBoardFor', [DEPLOYER.address, config]);
      return (result as [Address, bigint])[0];
    }
    const board = await create(SOURCE.width, SOURCE.height);
    const misdeclared = [
      { width: 215, height: 124, board: await create(215, 124) },
      { width: 205, height: 134, board: await create(205, 134) },
    ];

    await send(DEPLOYER, usd, usdArt.abi, 'mint', [BUYER.address, 10n ** 12n]);
    await send(BUYER, usd, usdArt.abi, 'approve', [board, 10n ** 12n]);
    for (const m of misdeclared) {
      await send(BUYER, usd, usdArt.abi, 'approve', [m.board, 10n ** 12n]);
      await send(BUYER, m.board, boardArt.abi, 'buyBlocks', [BUYER.address, [{ col: 0, row: 0, cols: 4, rows: 4 }], 10n ** 12n, (await client.getBlock()).timestamp + 3600n]);
      await send(BUYER, m.board, boardArt.abi, 'edit', [1n, hashOf(pngs.one!)]);
    }
    const areas = [
      { col: 0, row: 0, cols: 4, rows: 4 },
      { col: 2, row: 2, cols: 4, rows: 3 },
      { col: 10, row: 5, cols: 3, rows: 3 },
      { col: 14, row: 8, cols: 2, rows: 2 },
      { col: 16, row: 0, cols: 4, rows: 4 },
      { col: 0, row: 0, cols: 1, rows: 1 },
    ];
    // One at a time, so 2 and 6 are takes of what came before.
    for (const area of areas) {
      const deadline = (await client.getBlock()).timestamp + 3600n;
      await send(BUYER, board, boardArt.abi, 'buyBlocks', [BUYER.address, [area], 10n ** 12n, deadline]);
    }
    const written: Record<number, Buffer> = { 1: pngs.one!, 2: pngs.two!, 4: pngs.four!, 5: pngs.five!, 6: pngs.six! };
    for (const [id, bytes] of Object.entries(written)) await send(BUYER, board, boardArt.abi, 'edit', [BigInt(id), hashOf(bytes)]);
    // Block 6 rented for an hour by the deployer, who writes its own picture over the owner's.
    const rate = 86_400n;
    await send(BUYER, board, boardArt.abi, 'listForRent', [6n, rate, 86_400n]);
    await send(DEPLOYER, usd, usdArt.abi, 'mint', [DEPLOYER.address, 10n ** 9n]);
    await send(DEPLOYER, usd, usdArt.abi, 'approve', [board, 10n ** 9n]);
    await send(DEPLOYER, board, boardArt.abi, 'rent', [6n, DEPLOYER.address, 3_600n, rate]);
    await send(DEPLOYER, board, boardArt.abi, 'editRented', [6n, hashOf(pngs.tenant!)]);
    pass(`board ${board}: 6 blocks bought (two of them takes), 5 written, one rented and written by its tenant`);

    // What the gateway serves, by CID; block 4's CID answers with other bytes.
    const served = new Map<string, Buffer>([[contentHashToCid(sourceHash), sourcePng]]);
    for (const [id, bytes] of Object.entries(written)) served.set(contentHashToCid(hashOf(bytes)), Number(id) === 4 ? pngs.impostor! : bytes);
    // The owner's picture for 6 is served too, so a page drawing it instead of the tenant's is caught.
    served.set(contentHashToCid(hashOf(pngs.tenant!)), pngs.tenant!);
    const asked: string[] = [];
    await page.route('**/*', async (route: any) => {
      const url = new URL(route.request().url());
      if (url.origin === ROBINHOOD_TESTNET_CHAIN.rpcUrl) {
        const res = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() ?? '' });
        return route.fulfill({ status: res.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await res.text() });
      }
      if (url.origin === GATEWAY) {
        asked.push(url.pathname);
        if (url.pathname === `/ipfs/${PAGE_CID}/`) return route.fulfill({ contentType: 'text/html', body: pageHtml });
        const bytes = served.get(url.pathname.replace('/ipfs/', ''));
        return bytes ? route.fulfill({ body: bytes, headers: { 'access-control-allow-origin': '*' } }) : route.fulfill({ status: 404, body: '' });
      }
      return route.abort();
    });

    // The address the renderer writes, read from the chain rather than assumed.
    const metadata = (uri: string) => JSON.parse(Buffer.from(uri.split(',')[1]!, 'base64').toString('utf-8')) as { animation_url: string };
    const boardPage = metadata(await read<string>(collection, collectionArt.abi, 'tokenURI', [1n])).animation_url;
    const blockPage = metadata(await read<string>(board, boardArt.abi, 'tokenURI', [1n])).animation_url;
    const toGateway = (u: string) => u.replace(`ipfs://${PAGE_CID}/`, `${GATEWAY}/ipfs/${PAGE_CID}/`);
    if (!boardPage.startsWith(`ipfs://${PAGE_CID}/?chain=${CHAIN_ID}&board=`)) throw new Error(`the board's animation_url is ${boardPage}`);
    if (blockPage !== `${boardPage}&block=1`) throw new Error(`block 1's animation_url is ${blockPage}`);

    const grid = { cols: 20, rows: 12 };
    const rects = areas.map((a, i) => ({ ...a, tokenId: i + 1 }));
    const cells = cellMapFromBlocks(grid, rects);
    const expectedBoard = composeBoard({
      source: SOURCE,
      cellSize: 10,
      grid,
      cells,
      blocks: rects.map((r): ComposedBlock => ({ ...r, picture: r.tokenId === 1 ? PICTURES.one! : r.tokenId === 2 ? PICTURES.two! : r.tokenId === 5 ? PICTURES.five! : r.tokenId === 6 ? PICTURES.tenant! : null })),
    });

    async function drawn(url: string): Promise<{ width: number; height: number; rgba: Uint8ClampedArray; status: string }> {
      await page.goto(url);
      await page.waitForFunction(() => document.documentElement.dataset.drawn || !document.getElementById('status')!.hidden && /could not|names no|not been/.test(document.getElementById('status')!.textContent ?? ''), null, { timeout: 30_000 });
      const out = await page.evaluate(() => {
        const c = document.getElementById('board') as HTMLCanvasElement;
        const status = document.getElementById('status')!;
        const data = c.hidden ? [] : Array.from(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data);
        return { width: c.width, height: c.height, data, status: status.hidden ? '' : status.textContent ?? '' };
      });
      return { width: out.width, height: out.height, rgba: Uint8ClampedArray.from(out.data), status: out.status };
    }
    // An empty canvas against a full expectation is every byte different, never none.
    const differing = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      if (a.length !== b.length) return Math.max(a.length, b.length);
      let n = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
      return n;
    };

    // The whole board.
    const whole = await drawn(toGateway(boardPage));
    if (whole.status) throw new Error(`the page said "${whole.status}"`);
    if (whole.width !== 205 || whole.height !== 124) throw new Error(`the board drew at ${whole.width}×${whole.height}`);
    const off = differing(whole.rgba, expectedBoard);
    if (off !== 0) throw new Error(`the board differs from composeBoard in ${off} bytes`);
    pass('the whole board, byte for byte composeBoard: half-size and transparent picture, takes, a tenant\'s picture, no picture, other bytes, wrong size, the edge strips');
    // The own gateway was asked first and the public ones never reached (they are refused here).
    if (!asked.includes(`/ipfs/${contentHashToCid(sourceHash)}`)) throw new Error('the source was not fetched from the page\'s own gateway');
    // Block 4's bytes failed the hash, so it shows the source: a check the comparison above already
    // made, asserted on its own so a page that drew those bytes is named.
    const at = (x: number, y: number) => Array.from(whole.rgba.slice((y * 205 + x) * 4, (y * 205 + x) * 4 + 4));
    if (at(145, 85).join() !== Array.from(SOURCE.rgba.slice((85 * 205 + 145) * 4, (85 * 205 + 145) * 4 + 4)).join()) throw new Error('block 4 drew bytes that do not match its hash');
    pass('block 4 (bytes not matching its hash) shows the source');

    // The misdeclared boards: picture one at the top-left, nothing anywhere else.
    for (const m of misdeclared) {
      const wrong = await drawn(toGateway(boardPage.replace(/board=0x[0-9a-fA-F]{40}/, `board=${m.board}`)));
      const label = `the board declared ${m.width}×${m.height}`;
      if (wrong.status) throw new Error(`${label} said "${wrong.status}"`);
      if (wrong.width !== m.width || wrong.height !== m.height) throw new Error(`${label} drew at ${wrong.width}×${wrong.height}`);
      const grid = { cols: Math.floor(m.width / 10), rows: Math.floor(m.height / 10) };
      const expectedWrong = composeBoard({
        source: { width: m.width, height: m.height, rgba: new Uint8ClampedArray(m.width * m.height * 4) },
        cellSize: 10,
        grid,
        cells: cellMapFromBlocks(grid, [{ col: 0, row: 0, cols: 4, rows: 4, tokenId: 1 }]),
        blocks: [{ col: 0, row: 0, cols: 4, rows: 4, tokenId: 1, picture: PICTURES.one! }],
      });
      const offWrong = differing(wrong.rgba, expectedWrong);
      if (offWrong !== 0) throw new Error(`${label} differs in ${offWrong} bytes`);
    }
    pass('boards declared another width or height than their source: their blocks on nothing');

    // One block: block 1 at its own 40×40, the cells 2 and 6 took left clear.
    const one = await drawn(toGateway(blockPage));
    if (one.status) throw new Error(`block 1 said "${one.status}"`);
    if (one.width !== 40 || one.height !== 40) throw new Error(`block 1 drew at ${one.width}×${one.height}`);
    const expectedOne = new Uint8ClampedArray(40 * 40 * 4);
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) {
        if (cells[Math.floor(y / 10) * 20 + Math.floor(x / 10)] !== 1) continue;
        expectedOne.set(expectedBoard.slice((y * 205 + x) * 4, (y * 205 + x) * 4 + 4), (y * 40 + x) * 4);
      }
    }
    const offOne = differing(one.rgba, expectedOne);
    if (offOne !== 0) throw new Error(`block 1 differs in ${offOne} bytes`);
    pass('block 1 alone: its own size, only the squares it still shows');

    const unsold = await drawn(toGateway(`${boardPage}&block=7`));
    if (unsold.status !== 'This block has not been sold.') throw new Error(`block 7 said "${unsold.status}"`);
    const unknown = await drawn(`${GATEWAY}/ipfs/${PAGE_CID}/?chain=1&board=${board}`);
    if (unknown.status !== 'This address names no board.') throw new Error(`chain 1 said "${unknown.status}"`);
    pass('an unsold block and an unknown chain are refused in words, nothing drawn');
    console.log('\nThe reference renderer page draws what composeBoard draws.');
  } finally {
    await browser.close();
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => anvil?.kill());
