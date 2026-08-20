import Link from 'next/link';

import { EXAMPLES } from '../lib/sites';
import { DOC_NAV, DOC_PAGES } from '../lib/docs';
import { CREATE_COMMAND, GITHUB_URL, PACKAGES } from '../lib/links';

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
              {DOC_NAV.map((page) => (
                <Link key={page.slug} href={`/docs/${page.slug}`}>
                  {page.title}
                </Link>
              ))}
              <a href="#examples">Examples</a>
              <a href={GITHUB_URL}>GitHub &#8599;</a>
              <a href={PACKAGES[0].url}>npm &#8599;</a>
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
              <b>Tenant — ships</b>
              <span>
                Rents write access for a term without the holder giving up the asset. Priced terms,
                escrowed prepayment, rent streamed by the second, and a fee split — all on chain. A
                take clears the listing but <em>preserves</em> the tenancy.
              </span>
            </li>
            <li>
              <b>Terms are underwritable</b>
              <span>
                Take economics are free until the first position is claimed, then <em>ratchet</em>:
                they may only move where they cannot strand a holder — takes down, payout up,
                reversion slower. No admin key, no timelock. An investor reads them once and knows
                which way they can go.
              </span>
            </li>
          </ul>

          <p className="sub stack-note">
            Issuance, the secondary market and the rental market are built and on chain. Demand
            routing, an auction over tenancies, and measurement are companion products and are not.
          </p>

          <div className="install">
            <code className="install-cmd">{CREATE_COMMAND}</code>
            <p className="install-note">
              Runs with no credentials — the scaffold renders a live, already-traded board on
              Robinhood Chain testnet.
            </p>
            <ul className="install-pkgs">
              {PACKAGES.map((pkg) => (
                <li key={pkg.name}>
                  <a href={pkg.url}>{pkg.name}</a>
                  <span>{pkg.blurb}</span>
                </li>
              ))}
            </ul>
          </div>
        </header>

        <h2>Documentation</h2>
        <p className="section-note">
          Rendered from the markdown in <code>docs/</code>, so the site and the repository cannot
          drift apart. The API reference is generated from the SDK&rsquo;s own types.
        </p>

        <div className="cards docs-cards">
          {DOC_PAGES.map((page) => (
            <Link key={page.slug} className="card" href={`/docs/${page.slug}`}>
              <span className="kicker">docs/{page.file}</span>
              <strong>{page.title}</strong>
              <p>{page.blurb}</p>
            </Link>
          ))}
          <Link className="card" href="/docs/v1-to-v2">
            <span className="kicker">computed diff</span>
            <strong>v1 &rarr; v2</strong>
            <p>
              Every difference between the two SDK generations, diffed from a frozen snapshot of
              v1&rsquo;s surface against v2&rsquo;s live types. Nothing was removed; 16 signatures
              changed.
            </p>
          </Link>
          <Link className="card" href="/docs/api">
            <span className="kicker">generated from the types</span>
            <strong>API reference</strong>
            <p>
              Every export of <code>@websitekit/sdk</code>, read out of the package&rsquo;s own type
              declarations at build time — so it cannot drift from the code it documents.
            </p>
          </Link>
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
          Robinhood Chain testnet (46630) · unaudited, and no audit is planned · experimental
          software ·{' '}
          <a href={GITHUB_URL}>GitHub</a> ·{' '}
          <a href={PACKAGES[1].url}>npm</a>
        </footer>
      </div>
    </div>
  );
}
