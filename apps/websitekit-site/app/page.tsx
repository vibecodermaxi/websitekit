import Link from 'next/link';

import { EXAMPLES } from '../lib/sites';
import { DOC_PAGES } from '../lib/docs';

export const metadata = {
  title: 'websitekit — the issuance and settlement layer for tokenized page inventory',
};

export default function Home() {
  return (
    <div className="site">
      <div className="wrap">
        <header className="top">
          <div className="home-nav">
            <h1>websitekit</h1>
            <nav>
              {DOC_PAGES.map((page) => (
                <Link key={page.slug} href={`/docs/${page.slug}`}>
                  {page.title}
                </Link>
              ))}
              <a href="#examples">Examples</a>
            </nav>
          </div>
          <p className="lede">The issuance and settlement layer for tokenized page inventory.</p>
          <p className="sub">
            A publisher registers regions of a rendered page as discrete, transferable positions.
            Investors acquire those positions at issue and trade them in a permissionless secondary
            market. A holder can then delegate write access on a position <em>without surrendering
            it</em> — the primitive a rental market for advertising demand plugs into.
          </p>
          <p className="sub">
            Conventional ad inventory is rented by the impression and settled by an intermediary that
            owns the measurement, the auction and the ledger. websitekit unbundles it: the publisher
            sells the position once, the market prices it continuously, and the holder retains a
            rentable asset.
          </p>

          <ul className="benefits">
            <li>
              <b>Publisher — ships</b>
              <span>
                Defines inventory, sets floors, freezes terms of issue. Takes 0.95× the floor at
                issue and a frozen cut of every resale after it.
              </span>
            </li>
            <li>
              <b>Holder — ships</b>
              <span>
                Acquires at issue or by displacing an incumbent. Holds a transferable ERC-721
                carrying both an income right and a write right.
              </span>
            </li>
            <li>
              <b>Tenant — primitive only</b>
              <span>
                Writes into a position they do not own, under a revocable grant. The on-chain
                primitive ships; discovery and pricing above it do not.
              </span>
            </li>
            <li>
              <b>Terms are underwritable</b>
              <span>
                Economics freeze at <code>createSite</code> — no setter, no admin key, no timelock.
                An investor reads them once and knows the issuer cannot dilute them.
              </span>
            </li>
          </ul>

          <p className="sub stack-note">
            Demand routing, rental auction and measurement are companion products and are not built.
            The SDK is the first layer of that stack.
          </p>
        </header>

        <h2>Documentation</h2>
        <p className="section-note">
          Rendered from the markdown in <code>docs/websitekit/</code>, so the site and the repository
          cannot drift apart.
        </p>

        <div className="cards docs-cards">
          {DOC_PAGES.map((page) => (
            <Link key={page.slug} className="card" href={`/docs/${page.slug}`}>
              <span className="kicker">docs/websitekit/{page.file}</span>
              <strong>{page.title}</strong>
              <p>{page.blurb}</p>
            </Link>
          ))}
        </div>

        <h2 id="examples">Reference inventory configurations</h2>
        <p className="section-note">
          Four contracts on Robinhood Chain testnet, cloned from the same implementation. Every price
          and holder below is read from the chain when the page renders. They differ in the only two
          dimensions that vary between publishers: what gets carved into inventory, and the terms
          frozen at <code>createSite</code>. Each page ends with per-position revenue computed from
          that board&rsquo;s own on-chain terms.
        </p>

        <div className="cards">
          {EXAMPLES.map((example) => (
            <Link key={example.slug} className="card" href={`/examples/${example.slug}`}>
              <span className="kicker">{example.premise}</span>
              <strong>{example.site}</strong>
              <span className="terms">{example.terms}</span>
              <p>{example.why}</p>
            </Link>
          ))}
        </div>
      </div>

      <div className="wrap">
        <footer className="bottom">
          Robinhood Chain testnet (46630) · unaudited · mainnet is gated on an audit
        </footer>
      </div>
    </div>
  );
}
