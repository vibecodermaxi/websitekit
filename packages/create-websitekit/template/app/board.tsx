'use client';

import { useState, type ReactNode } from 'react';
import { createPublicClient, http } from 'viem';
import { BuyDialog, SlotProvider } from '@websitekit/react';
import type { SlotState } from '@websitekit/sdk';

import config from '../websitekit.config';

/**
 * The client boundary: everything above this is server-rendered with real prices, everything below
 * can react to a purchase.
 *
 * `initialSlots` is what the server already read, so the first paint has real owners and prices
 * rather than a skeleton that fills in.
 */
export function Board({
  initialSlots,
  initialContent,
  children,
}: {
  initialSlots: SlotState[];
  /** Base64 by content hash. Bytes cannot cross the server/client boundary as-is. */
  initialContent: Record<string, string>;
  children: ReactNode;
}) {
  const [client] = useState(() => createPublicClient({ chain: config.chain, transport: http() }));
  const [buying, setBuying] = useState<string | null>(null);

  // Decoded once. `SlotProvider` re-verifies every entry against its hash before trusting it —
  // these crossed a serialization boundary, and the gate does not take anything on faith just
  // because our own server sent it.
  const [content] = useState(() =>
    Object.fromEntries(
      Object.entries(initialContent).map(([hash, base64]) => [
        hash,
        Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
      ]),
    ),
  );

  return (
    <SlotProvider config={config} client={client} initialSlots={initialSlots} initialContent={content}>
      {/*
        Alt-click to buy. A real site would put an affordance on each slot; the scaffold keeps the
        page looking like an ordinary product page, because that is the joke and it only works if
        the disguise holds until someone goes looking.
      */}
      <div
        onClick={(event) => {
          if (!event.altKey) return;
          const slot = (event.target as HTMLElement).closest('[data-slot]')?.getAttribute('data-slot');
          if (slot) setBuying(slot);
        }}
      >
        {children}
      </div>

      {buying && (
        <BuyDialog
          slotId={buying}
          open
          onClose={() => setBuying(null)}
          onConfirm={async (request) => {
            // Wire this to whatever wallet layer you already have — wagmi, wallet-adapter, a raw
            // window.ethereum call. `request` is a viem writeContract argument built from the exact
            // quote the dialog showed, so do not re-read anything before sending it.
            console.log('send this with your wallet:', request);
            setBuying(null);
          }}
        />
      )}
    </SlotProvider>
  );
}
