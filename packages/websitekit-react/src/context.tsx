'use client';

/**
 * `<SlotProvider>` — one chain read for the whole page, shared by every `<Slot>` under it.
 *
 * §5: a page with twelve slots is ONE `getSlots` call. That only holds if the provider owns the
 * read; twelve components each fetching their own slot would be twelve round trips and would
 * quietly reintroduce the indexer this design exists without.
 *
 * Live updates are an optional upgrade, not a default — polling on focus covers 95% of it, and a
 * slot changing hands is not a sub-second concern at this scale. `refetchOnFocus` is on by default
 * for that reason; `pollMs` is off by default because a page left open in a background tab should
 * not bill someone's RPC quota all afternoon.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { readSlots, type SiteConfig, type SlotState } from '@websitekit/sdk';
import type { PublicClient } from 'viem';

import { ContentStore } from './content-store';

export interface WebsitekitContextValue {
  config: SiteConfig;
  client: PublicClient;
  slots: Record<string, SlotState>;
  contentStore: ContentStore;
  /** True only during the FIRST load. A background refetch must not blank a rendered page. */
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

const WebsitekitContext = createContext<WebsitekitContextValue | null>(null);

export interface SlotProviderProps {
  config: SiteConfig;
  client: PublicClient;
  /**
   * Slot state read on the server, so the first paint has real prices and owners instead of a
   * skeleton. Pass the result of `readSlots` from a Server Component.
   */
  initialSlots?: SlotState[];
  /**
   * Content bytes resolved on the server, keyed by content hash. Re-verified on arrival — they
   * crossed a serialization boundary, and nothing crosses that boundary unchecked.
   */
  initialContent?: Record<string, Uint8Array>;
  /** Refetch when the tab regains focus. The cheapest liveness that matters. */
  refetchOnFocus?: boolean;
  /** Poll interval in ms. Off by default. */
  pollMs?: number;
  children: ReactNode;
}

export function SlotProvider({
  config,
  client,
  initialSlots,
  initialContent,
  refetchOnFocus = true,
  pollMs,
  children,
}: SlotProviderProps) {
  const [slots, setSlots] = useState<Record<string, SlotState>>(() =>
    Object.fromEntries((initialSlots ?? []).map((slot) => [slot.key, slot])),
  );
  const [isLoading, setIsLoading] = useState(!initialSlots);
  const [error, setError] = useState<Error | null>(null);

  const contentStore = useMemo(() => {
    const store = new ContentStore({ contentUrl: config.contentUrl });
    for (const [hash, bytes] of Object.entries(initialContent ?? {})) {
      store.hydrate(hash as `0x${string}`, bytes);
    }
    return store;
    // Intentionally not keyed on `initialContent`: it is a first-paint seed, and rebuilding the
    // store on every render would throw away the cache and refetch the whole page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.contentUrl]);

  // A refetch that resolves after a newer one must not overwrite it. Focus and poll can overlap
  // trivially — alt-tab twice while a slow RPC is in flight — and out-of-order responses would show
  // a stale owner on a page that had already updated.
  const generation = useRef(0);

  const refetch = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await readSlots(client, config.ref, config.keys);
      if (mine !== generation.current) return;
      setSlots(Object.fromEntries(next.map((slot) => [slot.key, slot])));
      setError(null);
    } catch (cause) {
      if (mine !== generation.current) return;
      setError(cause as Error);
    } finally {
      if (mine === generation.current) setIsLoading(false);
    }
  }, [client, config.ref, config.keys]);

  useEffect(() => {
    if (!initialSlots) void refetch();
    // Server-seeded pages skip the mount fetch entirely; focus and poll still apply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refetch]);

  useEffect(() => {
    if (!refetchOnFocus || typeof window === 'undefined') return;
    const onFocus = () => void refetch();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refetchOnFocus, refetch]);

  useEffect(() => {
    if (!pollMs) return;
    const timer = setInterval(() => void refetch(), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, refetch]);

  const value = useMemo<WebsitekitContextValue>(
    () => ({ config, client, slots, contentStore, isLoading, error, refetch }),
    [config, client, slots, contentStore, isLoading, error, refetch],
  );

  return <WebsitekitContext.Provider value={value}>{children}</WebsitekitContext.Provider>;
}

export function useWebsitekit(): WebsitekitContextValue {
  const value = useContext(WebsitekitContext);
  if (!value) {
    throw new Error(
      '@websitekit/react: no <SlotProvider> above this component. Every <Slot> and every hook needs ' +
        'one, because the provider is what makes a whole page a single chain read.',
    );
  }
  return value;
}
