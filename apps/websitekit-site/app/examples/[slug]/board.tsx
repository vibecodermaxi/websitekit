'use client';

import { useState, type ReactNode } from 'react';
import { createPublicClient, http } from 'viem';
import { SlotProvider } from '@websitekit/react';
import type { SlotState } from '@websitekit/sdk';

import { exampleFor } from '../../../lib/sites';

/**
 * The client boundary for an example board.
 *
 * The config is imported here rather than passed down as a prop on purpose: it holds a `chain`
 * object and a `contentUrl` FUNCTION, and functions do not cross the server/client boundary. The
 * slug is a string, so it does.
 *
 * `initialSlots` is what the server already read, so the first paint carries real owners and real
 * prices rather than a skeleton that fills in afterwards.
 */
export function Board({
  slug,
  initialSlots,
  initialContent,
  children,
}: {
  slug: string;
  initialSlots: SlotState[];
  /** Base64 by content hash. Raw bytes cannot cross the boundary. */
  initialContent: Record<string, string>;
  children: ReactNode;
}) {
  const config = exampleFor(slug)!.config;
  const [client] = useState(() => createPublicClient({ chain: config.chain, transport: http() }));

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
      {children}
    </SlotProvider>
  );
}
