/**
 * Builds the reference renderer page into `renderer/dist/index.html`: one file, script and style
 * inline, nothing fetched but the chain and IPFS. That directory is what gets pinned, and its
 * `ipfs://<cid>/` is `IMAGE_BOARD_RENDERER_PAGE` — a renderer deploy argument, fixed for every board
 * of that implementation, so a build that is pinned is never changed, only replaced for later ones.
 *
 * esbuild and one file, like `packages/websitekit-loader/build.mjs`.
 */
import { build } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'dist');

const result = await build({
  entryPoints: [path.join(root, 'page.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  write: false,
});
// Inline, a `</script` anywhere in the bundle would end the element.
const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Image board</title>
<style>
html, body { margin: 0; height: 100%; background: transparent; }
body { display: flex; align-items: center; justify-content: center; font: 14px/1.4 system-ui, sans-serif; color: #888; }
canvas { display: block; width: 100vw; height: 100vh; object-fit: contain; }
[hidden] { display: none !important; }
</style>
</head>
<body>
<canvas id="board" hidden></canvas>
<p id="status">Reading the board…</p>
<script type="module">${script}</script>
</body>
</html>
`;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'index.html'), html);
const bytes = Buffer.byteLength(html);
console.log(`renderer/dist/index.html  ${bytes} B, ${gzipSync(html).length} B gzipped`);
