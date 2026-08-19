import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Serves content bytes by CID out of this app's `content/` directory.
 *
 * §3's middle storage tier — the dev's own upload route — which is what lets these example boards
 * show real owner-written content with no pinning credential and no network beyond the chain.
 *
 * Nothing here is trusted. `<Slot>` re-hashes whatever this returns and compares it against the
 * chain before rendering a pixel, so a wrong file produces a fallback rather than wrong content.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;

  // The CID is an attacker-controlled path segment. Constrain it to the base32 alphabet before it
  // reaches the filesystem — `..%2f..%2f.env` is a perfectly good CID as far as this route knows.
  if (!/^b[a-z2-7]{20,120}$/.test(cid)) {
    return new Response('not a CID', { status: 400 });
  }

  try {
    const bytes = await readFile(path.join(process.cwd(), 'content', `${cid}.bin`));
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': 'application/octet-stream',
        // Immutable under its own hash — an edit produces a different CID, so there is nothing to
        // invalidate and no staleness to manage.
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}
