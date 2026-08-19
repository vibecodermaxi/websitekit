import { Slot } from '@websitekit/react';

/**
 * DevConf Autumn — a conference site.
 *
 * Sponsor tiers are already an auction held over email; this board runs it in public. The visible
 * hierarchy — headline, gold, silver, booths — is the same hierarchy the floors encode, which is
 * what makes the take premium legible: moving up a tier means taking somebody's slot off them.
 */
export function DevConf() {
  return (
    <div className="ex ex-devconf">
      <Slot
        id="announce.bar"
        className="announce"
        fallback="This strip is for sale — 0.00006 ETH, above every ticket link on the page."
      />

      <nav className="topnav">
        <span>Schedule</span>
        <span>Tickets</span>
        <Slot id="nav.link.1" fallback="Your link — 0.00002 ETH" />
      </nav>

      <section className="hero">
        <p className="eyebrow">3 &ndash; 5 November · Lisbon</p>
        <h1>DevConf Autumn</h1>
        <p className="when">Two days on the parts of the job nobody writes docs for.</p>
      </section>

      <section className="tier">
        <h2>Headline sponsor</h2>
        <Slot
          id="sponsor.headline"
          className="headline-sponsor"
          fallback="This slot is open — take it and your name is the first thing anyone reads."
        />
      </section>

      <section className="tier">
        <h2>Gold</h2>
        <div className="grid gold">
          <Slot id="sponsor.gold.1" fallback="Open" />
          <Slot id="sponsor.gold.2" fallback="Open" />
          <Slot id="sponsor.gold.3" fallback="Open" />
        </div>
      </section>

      <section className="tier">
        <h2>Silver</h2>
        <div className="grid silver">
          <Slot id="sponsor.silver.1" fallback="Open" />
          <Slot id="sponsor.silver.2" fallback="Open" />
        </div>
      </section>

      <section className="tier">
        <h2>Booths</h2>
        <div className="booths">
          <Slot id="booth.1" as="div" fallback="Booth 1 — available" />
          <Slot id="booth.2" as="div" fallback="Booth 2 — available" />
        </div>
      </section>

      <p className="note">
        <Slot
          id="schedule.note"
          fallback="Full schedule lands four weeks out. Talks are 25 minutes, no keynotes, no sales pitches."
        />
      </p>

      <footer className="ex-foot">
        DevConf Autumn · Lisbon ·{' '}
        <Slot id="footer.link.1" fallback="Footer link for sale — 0.000008 ETH" />
      </footer>
    </div>
  );
}
