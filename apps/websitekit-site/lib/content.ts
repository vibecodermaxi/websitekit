import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { contentHashToCid, readContent } from '@websitekit/sdk';

/**
 * Resolves content on the SERVER so the words someone paid for are in the HTML.
 *
 * Without this the page ships `fallback` copy and the browser swaps in real content after
 * hydrating — a visible flash, and a crawler that only ever sees the placeholder. On a page whose
 * entire premise is that the headline belongs to somebody, serving the placeholder to search
 * engines is the wrong output.
 *
 * Reads `content/` off disk directly rather than going back out through this app's own HTTP route,
 * which would be a pointless round trip. The verification is identical either way, and it is not
 * optional on either path — these bytes came off a disk this process does not own in any meaningful
 * sense, and the gate is the gate wherever the bytes came from.
 *
 * Returns base64: raw bytes cannot cross the server/client boundary.
 */
export async function resolveContent(hashes: `0x${string}`[]): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  await Promise.all(
    hashes.map(async (hash) => {
      try {
        const bytes = await readFile(path.join(process.cwd(), 'content', `${contentHashToCid(hash)}.bin`));
        if (readContent(new Uint8Array(bytes), hash).ok) {
          resolved[hash] = bytes.toString('base64');
        }
      } catch {
        // Missing or unreadable — the slot renders its fallback, which is the designed behaviour
        // for unavailable content, not an error worth failing a page render over.
      }
    }),
  );

  return resolved;
}
