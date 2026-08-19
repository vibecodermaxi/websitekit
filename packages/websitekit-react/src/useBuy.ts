'use client';

/**
 * `useBuy` — the buy flow as state, with no UI attached.
 *
 * Headless on purpose. `<BuyDialog>` is a thin default on top of this, and every real site will
 * restyle or replace it; the part that must not be reimplemented is the ordering below, because
 * getting it wrong is how a buyer signs terms they were never shown.
 *
 * The ordering, and why each step is where it is:
 *
 *   1. `readBuyContext` — quote, `expectedTerms` and the CHAIN's clock, all at one pinned block.
 *      Not three reads: a torn read across blocks means the buyer confirms a price from block N
 *      against terms from block N+1, and the anti-frontrun guard is then guarding a state that
 *      never existed.
 *   2. Show the buyer that exact context and wait.
 *   3. Build from the SAME context that was displayed. Never re-read at submit time — a fresh read
 *      would pick up the very change `expectedTerms` exists to reject, which is the one way to turn
 *      the guard into decoration.
 */
import { useCallback, useState } from 'react';
import {
  buildBuyFrom,
  computeBuyBreakdown,
  economicsFromTerms,
  readBuyContext,
  readSiteTerms,
  type BuyContext,
} from '@websitekit/sdk';
import type { Address } from 'viem';

import { useWebsitekit } from './context';

export type BuyPhase = 'idle' | 'quoting' | 'ready' | 'submitting' | 'confirmed' | 'error';

export interface BuyQuote {
  context: BuyContext;
  /** What this buyer pays: the effective floor on a claim, the take price on a take. */
  charged: bigint;
  /** What the displaced owner receives. `0n` on a claim — there is nobody to pay. */
  payout: bigint;
  /** True when nobody owns the slot yet, which is the cheaper branch. */
  isClaim: boolean;
  /** `0x0` for native settlement. Carried so `buildRequest` sends the right `msg.value`. */
  settlementToken: Address;
  /**
   * Escrowed rent this buyer would INHERIT (§2.4.2).
   *
   * A confirm dialog that shows only `charged` on an encumbered position is telling the buyer they
   * are paying full price for something they cannot use — when they are in fact buying an asset
   * that hands this much back over the remaining term.
   */
  unaccruedRent: bigint;
  /** `charged - unaccruedRent`, floored at zero. The number to lead with. */
  netCost: bigint;
  /** True when the inherited rent stream exceeds the purchase price outright. */
  isFreeCarry: boolean;
}

export interface UseBuyResult {
  phase: BuyPhase;
  quote: BuyQuote | null;
  error: Error | null;
  /** Read the context and compute the breakdown. Call this when the dialog opens. */
  prepare: () => Promise<BuyQuote | null>;
  /**
   * Build the transaction request for the quote already shown. Returns `null` if `prepare` has not
   * run — the alternative, silently quoting inside `submit`, is exactly the re-read this flow
   * exists to prevent.
   */
  buildRequest: (options?: { recipient?: Address; slippageBps?: bigint }) => ReturnType<typeof buildBuyFrom> | null;
  reset: () => void;
}

export function useBuy(key: string): UseBuyResult {
  const { config, client, refetch } = useWebsitekit();
  const [phase, setPhase] = useState<BuyPhase>('idle');
  const [quote, setQuote] = useState<BuyQuote | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const prepare = useCallback(async () => {
    setPhase('quoting');
    setError(null);
    try {
      const context = await readBuyContext(client, config.ref, key);
      if (!context.slot.registered) {
        throw new Error(
          `"${key}" is not registered on this site. Slots are closed by default — the site owner ` +
            'has to register it before it can be bought.',
        );
      }

      // Pinned to the SAME block as the quote. The terms are frozen for the site's lifetime so
      // this could be cached — but a cached value belonging to a DIFFERENT site the app also
      // renders is a real bug, and one call is cheaper than the invalidation logic that avoids it.
      const terms = await readSiteTerms(client, config.ref, context.blockNumber);

      const breakdown = computeBuyBreakdown(
        context.slot.lastPrice,
        context.slot.floor,
        elapsedWeeks(context),
        economicsFromTerms(terms),
        context.slot.isUnclaimed,
      );

      // The chain's own `getSlots` already returned the charged amount. Recomputing it locally and
      // asserting they agree is what catches a client/chain price divergence AT QUOTE TIME rather
      // than as a revert the buyer cannot interpret.
      if (breakdown.charged !== context.slot.charged) {
        throw new Error(
          `websitekit: price divergence on "${key}" — the chain quotes ${context.slot.charged} and the ` +
            `SDK computes ${breakdown.charged}. Refusing to build a transaction against either.`,
        );
      }

      const next: BuyQuote = {
        context,
        charged: context.slot.charged,
        payout: breakdown.payout,
        isClaim: context.slot.isUnclaimed,
        settlementToken: terms.settlementToken,
        unaccruedRent: context.slot.unaccruedRent,
        netCost: context.slot.netCost,
        isFreeCarry: context.slot.isFreeCarry,
      };
      setQuote(next);
      setPhase('ready');
      return next;
    } catch (cause) {
      setError(cause as Error);
      setPhase('error');
      return null;
    }
  }, [client, config.ref, key]);

  const buildRequest = useCallback(
    (options?: { recipient?: Address; slippageBps?: bigint }) =>
      quote ? buildBuyFrom(config.address, quote.context, quote.settlementToken, options) : null,
    [config.address, quote],
  );

  const reset = useCallback(() => {
    setPhase('idle');
    setQuote(null);
    setError(null);
    void refetch();
  }, [refetch]);

  return { phase, quote, error, prepare, buildRequest, reset };
}

function elapsedWeeks(context: BuyContext): bigint {
  const last = context.slot.lastPurchaseTs;
  if (context.now < last) return 0n;
  return (context.now - last) / 604_800n;
}
