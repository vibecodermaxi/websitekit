'use client';

/**
 * `<BuyDialog>` — the default confirm step.
 *
 * Deliberately unstyled and deliberately thin. Every real site will restyle or replace it, so the
 * value here is not the markup: it is that the numbers shown are the numbers `useBuy` will build
 * the transaction from, and that the two cannot drift. A site that writes its own dialog on
 * `useBuy` inherits that; a site that quotes separately from what it submits does not.
 *
 * What it deliberately does NOT do is send anything. Signing belongs to whatever wallet layer the
 * app already has, so `onConfirm` receives a built request and the app decides.
 */
import { useEffect, type ReactNode } from 'react';
import { formatEther } from 'viem';
import type { Address } from 'viem';

import { useBuy, type BuyQuote } from './useBuy';
import type { buildBuyFrom } from '@websitekit/sdk';

export interface BuyDialogProps {
  slotId: string;
  open: boolean;
  onClose: () => void;
  /** Receives the request built from the quote the user was actually shown. */
  onConfirm: (request: NonNullable<ReturnType<typeof buildBuyFrom>>, quote: BuyQuote) => void | Promise<void>;
  /** Buy on someone else's behalf — §10.7's sponsored path. */
  recipient?: Address;
  children?: (state: ReturnType<typeof useBuy>) => ReactNode;
}

export function BuyDialog({ slotId, open, onClose, onConfirm, recipient, children }: BuyDialogProps) {
  const buy = useBuy(slotId);
  const { phase, quote, error, prepare, buildRequest, reset } = buy;

  useEffect(() => {
    if (open && phase === 'idle') void prepare();
    if (!open && phase !== 'idle') reset();
  }, [open, phase, prepare, reset]);

  if (!open) return null;
  if (children) return <>{children(buy)}</>;

  return (
    <div role="dialog" aria-label={`Buy ${slotId}`}>
      {phase === 'quoting' && <p>Reading the current price…</p>}

      {phase === 'error' && (
        <>
          <p role="alert">{error?.message}</p>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </>
      )}

      {phase === 'ready' && quote && (
        <>
          {/*
            On an ENCUMBERED position the headline number is `netCost`, not `charged` (§2.4.2). The
            buyer inherits the unaccrued rent, so `charged` alone tells them they are paying full
            price for something they cannot use — when they are buying an asset that hands part of
            that back over the remaining term. `charged` is still shown, because it is what leaves
            their wallet and what the transaction is built from.
          */}
          {quote.unaccruedRent > 0n ? (
            <>
              <p>
                Take <code>{slotId}</code> for{' '}
                <strong>{formatEther(quote.netCost)} ETH</strong> net
              </p>
              <p>
                You pay {formatEther(quote.charged)} ETH now and inherit{' '}
                {formatEther(quote.unaccruedRent)} ETH of rent already escrowed on this slot, which
                streams to you over the rest of the tenancy.
                {quote.isFreeCarry
                  ? ' That is more than the purchase price: this position pays for itself.'
                  : ''}
              </p>
              <p>
                It is rented right now, so the tenant — not you — controls its content until the term
                ends.
              </p>
            </>
          ) : (
            <p>
              {quote.isClaim ? 'Claim' : 'Take'} <code>{slotId}</code> for{' '}
              <strong>{formatEther(quote.charged)} ETH</strong>
            </p>
          )}

          {/*
            What the payout guarantees, and what it does NOT.

            This used to read "more than they paid — being taken is a profit event". That is false in
            general and the invariant campaign measured it: the payout is `payoutBps` of the CURRENT
            effective floor, not of what the displaced holder paid, and reversion separates the two.
            In a 128,000-call campaign 33 of 73 takes credited the displaced owner LESS than they
            paid. The guarantee that survives every input is the floor one, so that is what this
            says. Overclaiming here is worse than saying nothing: it is a promise made at the moment
            of purchase, to the person who will be on the other side of it.
          */}
          {!quote.isClaim && (
            <p>
              The current owner receives {formatEther(quote.payout)} ETH — never less than this
              slot&rsquo;s floor, which is guaranteed. Whether it beats what they paid is not: the
              payout tracks the slot&rsquo;s floor now, and a price that has reverted since they
              bought can leave them below it.
            </p>
          )}

          {/*
            Said plainly rather than buried: the same thing that just happened to them can happen to
            you, at a price this page will compute the same way.
          */}
          <p>Anyone can take this slot from you later at a formula price. That is the mechanic.</p>

          <button
            type="button"
            onClick={() => {
              const request = buildRequest({ recipient });
              if (request) void onConfirm(request, quote);
            }}
          >
            Confirm
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
