/**
 * The dialog states amounts in the BOARD's currency and, on a token board, says there are two
 * wallet prompts and hands the approval to `onConfirm`. Every assertion here uses a 6-decimal
 * amount, which is the input on which `formatEther` and the right formatting disagree.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { formatAmount } from './format';

const state: { current: Record<string, unknown> } = { current: {} };
vi.mock('./useBuy', () => ({ useBuy: () => state.current }));

import { BuyDialog } from './BuyDialog';

const TOKEN = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const NATIVE = '0x0000000000000000000000000000000000000000';
const REQUEST = { functionName: 'buy' };
const APPROVAL = { functionName: 'approve' };

function quote(settlementToken: string, currency: { symbol: string; decimals: number }) {
  return {
    charged: 2_500_000n,
    payout: 0n,
    isClaim: true,
    settlementToken,
    currency,
    unaccruedRent: 0n,
    netCost: 2_500_000n,
    isFreeCarry: false,
  };
}

function setState(q: ReturnType<typeof quote>, approval: unknown) {
  state.current = {
    phase: 'ready',
    quote: q,
    error: null,
    prepare: vi.fn(),
    reset: vi.fn(),
    buildRequest: vi.fn(() => REQUEST),
    buildApproval: vi.fn(() => approval),
  };
}

describe('formatAmount', () => {
  it('formats with the currency it is given, never 18 by default', () => {
    expect(formatAmount(2_500_000n, { symbol: 'USDG', decimals: 6 })).toBe('2.5 USDG');
    expect(formatAmount(10n ** 15n, { symbol: 'ETH', decimals: 18 })).toBe('0.001 ETH');
  });
});

describe('<BuyDialog> on a token board', () => {
  beforeEach(() => setState(quote(TOKEN, { symbol: 'USDG', decimals: 6 }), APPROVAL));

  it('states the price in the token, and warns of two prompts', () => {
    render(<BuyDialog slotId="hero.headline" open onClose={() => {}} onConfirm={() => {}} />);
    expect(screen.getByText('2.5 USDG')).toBeTruthy();
    expect(screen.getByText(/ask twice/)).toBeTruthy();
  });

  it('hands the approval to onConfirm alongside the request', () => {
    const onConfirm = vi.fn();
    render(<BuyDialog slotId="hero.headline" open onClose={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalledWith(REQUEST, expect.anything(), APPROVAL);
  });
});

describe('<BuyDialog> on a native board', () => {
  beforeEach(() => setState(quote(NATIVE, { symbol: 'ETH', decimals: 18 }), null));

  it('says nothing about a second prompt, and passes a null approval', () => {
    const onConfirm = vi.fn();
    render(<BuyDialog slotId="hero.headline" open onClose={() => {}} onConfirm={onConfirm} />);
    expect(screen.queryByText(/ask twice/)).toBeNull();
    fireEvent.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalledWith(REQUEST, expect.anything(), null);
  });
});
