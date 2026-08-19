import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Serves content bytes by CID, out of the `content/` directory in this repo.
 *
 * This is §3's middle storage tier — "the dev's own upload route" — shipped as the scaffold's
 * default so `pnpm dev` works with no credentials and no network beyond the chain itself. A public
 * pinning gateway would also work for text; swap `contentUrl` in websitekit.config.ts when you have
 * somewhere real to put bytes.
 *
 * There is no authentication and no write path here on purpose. Content is addressed by the hash of
 * its own bytes, so serving it is not a privileged operation — and a route that could WRITE would
 * need to be, which is a decision for whoever runs the site rather than for a scaffold.
 *
 * Nothing here is trusted. `<Slot>` re-hashes whatever this returns and compares it to the chain
 * before rendering a pixel, so a wrong file produces a fallback rather than wrong content.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;

  // The CID is a path segment, so it is attacker-controlled in the general case. Constrain it to
  // the base32 alphabet before it reaches the filesystem — `..%2f..%2f.env` is otherwise a
  // perfectly good CID as far as this route is concerned.
  if (!/^b[a-z2-7]{20,120}$/.test(cid)) {
    return new Response('not a CID', { status: 400 });
  }

  try {
    const bytes = await readFile(path.join(process.cwd(), 'content', `${cid}.bin`));
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': 'application/octet-stream',
        // Content is immutable under its hash — an edit produces a different CID, so there is
        // nothing to invalidate and no staleness to manage.
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}
