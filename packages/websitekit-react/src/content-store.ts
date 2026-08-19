/**
 * Fetching content bytes and proving they are the right ones.
 *
 * **The rule this file exists to enforce: unverified bytes never reach a render path.** §3 is
 * explicit — `<Slot>` must degrade to `fallback` on a fetch or hash-mismatch failure, and must
 * never render unverified bytes. That is stronger than it first sounds, and it is what rules out
 * the obvious implementation for images.
 *
 * The obvious implementation is `<img src={gatewayUrl}>`. It is wrong: the browser fetches those
 * bytes and paints them without anyone ever checking them against the on-chain hash, so a
 * compromised or merely wrong gateway substitutes content silently on a page whose whole premise is
 * that content is verifiable. So images go through the same path as everything else — fetch,
 * verify, then hand the render layer bytes it can trust.
 *
 * The cost is real and worth stating: no browser image cache across page loads, no progressive
 * decode, and a blob URL per image that has to be revoked. That is the price of the guarantee, and
 * the guarantee is the product.
 */
import { readContent, contentHashToCid, type ContentFailure, type ContentResult } from '@websitekit/sdk';
import type { Hex } from 'viem';

export type ContentStatus =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; kind: number; payload: Uint8Array }
  | { state: 'failed'; reason: ContentFailure | 'fetch-failed' };

/**
 * §3's second honest caveat, as a type. The chain will happily say a slot is owned and priced while
 * its content 404s — v1 never had that failure mode because Postgres and R2 were the same system
 * as the renderer, and the framework introduces it. `fetch-failed` is that case, and it is
 * deliberately distinct from `hash-mismatch`: one is a gateway problem the site can fix, the other
 * is a content problem it cannot.
 */
export interface FetchContentOptions {
  contentUrl: (cid: string) => string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function fetchAndVerify(
  contentHash: Hex,
  options: FetchContentOptions,
): Promise<ContentStatus> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  let bytes: Uint8Array;

  try {
    const response = await doFetch(options.contentUrl(contentHashToCid(contentHash)), {
      signal: options.signal,
    });
    if (!response.ok) return { state: 'failed', reason: 'fetch-failed' };
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    // Includes aborts. A caller that aborted is unmounting or refetching and discards this anyway;
    // treating it as a failure is harmless and keeps the branch count down.
    return { state: 'failed', reason: 'fetch-failed' };
  }

  const result: ContentResult = readContent(bytes, contentHash);
  if (!result.ok) return { state: 'failed', reason: result.reason };
  return { state: 'ready', kind: result.kind, payload: result.payload };
}

/**
 * Content is immutable under its hash, so it is cached by hash forever and never invalidated. An
 * edit produces a NEW hash, which is a cache miss by construction — there is no staleness to
 * manage and no revalidation to get wrong.
 *
 * In-flight requests are deduped through the same map, so twelve slots sharing one headline (which
 * dedup across slots makes possible, §3) issue one fetch.
 */
export class ContentStore {
  private readonly entries = new Map<Hex, ContentStatus>();
  private readonly inFlight = new Map<Hex, Promise<ContentStatus>>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: FetchContentOptions) {}

  get(contentHash: Hex): ContentStatus {
    return this.entries.get(contentHash) ?? { state: 'idle' };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Idempotent. Safe to call from a render effect on every commit. */
  load(contentHash: Hex): Promise<ContentStatus> {
    const existing = this.inFlight.get(contentHash);
    if (existing) return existing;

    const cached = this.entries.get(contentHash);
    if (cached && cached.state !== 'idle') return Promise.resolve(cached);

    this.entries.set(contentHash, { state: 'loading' });
    const request = fetchAndVerify(contentHash, this.options).then((status) => {
      this.entries.set(contentHash, status);
      this.inFlight.delete(contentHash);
      this.emit();
      return status;
    });

    this.inFlight.set(contentHash, request);
    // Emit the `loading` transition too, or a component that mounted in `idle` never re-renders
    // into its own pending state.
    this.emit();
    return request;
  }

  /**
   * Seeds content resolved on the server, so SSR'd text renders in the first paint instead of
   * flashing `fallback` and then filling in. The bytes are re-verified here rather than trusted:
   * they crossed a serialization boundary, and the point of the gate is that nothing crosses it
   * unchecked.
   */
  hydrate(contentHash: Hex, bytes: Uint8Array): void {
    const result = readContent(bytes, contentHash);
    this.entries.set(
      contentHash,
      result.ok
        ? { state: 'ready', kind: result.kind, payload: result.payload }
        : { state: 'failed', reason: result.reason },
    );
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
