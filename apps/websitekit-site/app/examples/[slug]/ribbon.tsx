import Link from 'next/link';
import { ROBINHOOD_TESTNET_CHAIN } from '@websitekit/sdk';

import type { ExampleMeta } from '../../../lib/sites';

/**
 * The only piece of websitekit chrome on an example page.
 *
 * Without it a visitor sees a newsletter and has no idea any of it is for sale, which defeats the
 * entire point of showing them one. It says what the page is, what its frozen terms are, and how
 * many of its slots are currently owned — the three facts that make the rest of the page legible as
 * a market rather than as a website.
 */
export function Ribbon({
  example,
  claimed,
  total,
}: {
  example: ExampleMeta;
  claimed: number;
  total: number;
}) {
  // The example boards are seeded on the testnet, so their contracts are on its explorer.
  const explorer = `${ROBINHOOD_TESTNET_CHAIN.explorer}/address/${example.config.address}`;

  return (
    <div className="ribbon">
      <span>
        <Link href="/">websitekit</Link> <span className="sep">/</span> example <span className="sep">/</span>{' '}
        {example.premise.toLowerCase()}
      </span>
      <span className="sep">·</span>
      <span>
        {claimed}/{total} slots owned
      </span>
      <span className="sep">·</span>
      <span>{example.terms}</span>
      <span className="grow" />
      <a href={explorer} target="_blank" rel="noreferrer">
        contract ↗
      </a>
    </div>
  );
}
