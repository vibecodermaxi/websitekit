'use client';

import { useEffect, useSyncExternalStore } from 'react';
import type { SlotDefinition, SlotState } from '@websitekit/sdk';

import { useWebsitekit } from './context';
import type { ContentStatus } from './content-store';

export interface UseSlotResult {
  /** The config entry — kind and configured floor. */
  definition: SlotDefinition;
  /** On-chain state, or `undefined` until the first read lands. */
  state: SlotState | undefined;
  /** Verified content, or why there is none. */
  content: ContentStatus;
  /**
   * Whether `fallback` should render. True whenever there is no verified content to show, for ANY
   * reason — unclaimed, never edited, gateway down, hash mismatch, or written under a scheme this
   * version cannot read. A renderer that branched on each of those separately would eventually miss
   * one and paint a blank box.
   */
  showFallback: boolean;
  isLoading: boolean;
}

/**
 * Everything one slot needs to render itself.
 *
 * Reads from the provider's single page-wide fetch rather than doing its own — see `<SlotProvider>`
 * for why that is load-bearing rather than an optimization.
 */
export function useSlot(key: string): UseSlotResult {
  const { config, slots, contentStore, isLoading } = useWebsitekit();

  const definition = config.slotsByKey[key];
  if (!definition) {
    throw new Error(
      `@websitekit/react: "${key}" is not in the site config. Slot keys are on-chain identities — ` +
        'add it to websitekit.config.ts and register it, rather than passing a key that resolves to nothing.',
    );
  }

  const state = slots[key];
  const contentHash = state?.contentHash ?? null;

  const content = useSyncExternalStore(
    (onChange) => contentStore.subscribe(onChange),
    () => (contentHash ? contentStore.get(contentHash) : IDLE),
    // Server snapshot. `useSyncExternalStore` requires this to be referentially stable across
    // calls or React throws an infinite-loop error, which is why IDLE is a module constant rather
    // than an object literal.
    () => (contentHash ? contentStore.get(contentHash) : IDLE),
  );

  useEffect(() => {
    if (contentHash) void contentStore.load(contentHash);
  }, [contentHash, contentStore]);

  return {
    definition,
    state,
    content,
    showFallback: content.state !== 'ready',
    isLoading,
  };
}

const IDLE: ContentStatus = { state: 'idle' };
