import { Slot } from '@websitekit/react';

/**
 * Vaultline — a DeFi protocol landing page.
 *
 * The one board here whose real-world analogue is *already* a market: ecosystem placement, launch
 * partner rows and integration logos get bought and sold off-chain today, over Telegram, at BD-deal
 * pace. This puts the same trade on-chain at market pace, which is the argument websitekit has to make
 * to a crypto-native audience and cannot make with a newsletter.
 *
 * The TVL and APY figures are the protocol's own numbers — deliberately NOT slots. A site that sold
 * its own metrics would be selling the ability to lie about them, and the line between "attention is
 * for sale" and "facts are for sale" is the one that keeps this mechanic honest.
 */
export function Vaultline() {
  return (
    <div className="ex ex-vaultline">
      <Slot
        id="announce.bar"
        className="announce"
        fallback="This strip is unclaimed — it is the most-seen row on the page."
      />

      <header className="chrome">
        <strong className="wordmark">Vaultline</strong>
        <nav>
          <span>Docs</span>
          <span>Governance</span>
          <span>Audits</span>
          <Slot id="nav.link.1" className="open-chip" fallback="Your link — 0.00003 ETH" />
        </nav>
      </header>

      <section className="hero">
        <Slot id="hero.headline" as="h1" fallback="Vaults that settle where the liquidity already is." />
        <Slot
          id="hero.sub"
          as="p"
          className="sub"
          fallback="Non-custodial yield routing across 14 venues. No lockups, no rehypothecation, no surprises in the withdrawal queue."
        />
        <Slot id="hero.cta" className="cta" fallback="Open app" />

        {/* The protocol's own numbers. Not slots, on purpose — see the note above. */}
        <dl className="stats">
          <div>
            <dt>TVL</dt>
            <dd>$412.8M</dd>
          </div>
          <div>
            <dt>30d volume</dt>
            <dd>$1.07B</dd>
          </div>
          <div>
            <dt>Vaults</dt>
            <dd>26</dd>
          </div>
          <div>
            <dt>Since</dt>
            <dd>2024</dd>
          </div>
        </dl>
      </section>

      <section className="strip">
        <h2>Integrates with</h2>
        <div className="logos">
          <Slot id="integration.1" fallback="Your protocol" />
          <Slot id="integration.2" fallback="Your protocol" />
          <Slot id="integration.3" fallback="Your protocol" />
          <Slot id="integration.4" fallback="Your protocol" />
        </div>
      </section>

      <section className="strip">
        <h2>Built on Vaultline</h2>
        <div className="eco">
          <Slot id="ecosystem.1" as="div" fallback="This card is open — ship on Vaultline and claim it." />
          <Slot id="ecosystem.2" as="div" fallback="This card is open — ship on Vaultline and claim it." />
          <Slot id="ecosystem.3" as="div" fallback="This card is open — ship on Vaultline and claim it." />
        </div>
      </section>

      <p className="audit">
        <Slot
          id="audit.note"
          fallback="Audited twice. Contracts are immutable and the deployer key is burned."
        />
      </p>

      <footer className="ex-foot">
        <Slot id="footer.link.1" fallback="Read the docs" /> · Vaultline ·{' '}
        <Slot id="footer.link.2" fallback="Footer link for sale — 0.00001 ETH" />
      </footer>
    </div>
  );
}
