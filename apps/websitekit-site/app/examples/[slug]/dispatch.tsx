import { Slot } from '@websitekit/react';

/**
 * The Weekly Dispatch — a newsletter archive.
 *
 * The issues themselves are the publisher's own content and are not for sale. What IS for sale is
 * everything a sponsor would want: the masthead, the top banner, a per-issue credit, and the
 * recommendation slots. That split is the realistic one — an owner sells attention, not editorial.
 */
export function Dispatch() {
  return (
    <div className="ex ex-dispatch">
      <Slot
        id="announce.bar"
        className="announce"
        fallback="This strip is for sale — 0.00005 ETH, and every reader sees it first."
      />

      <nav className="topnav">
        <span>Archive</span>
        <span>About</span>
        <Slot id="nav.link.1" fallback="Your link here — 0.00002 ETH" />
      </nav>

      <header className="masthead">
        <Slot id="masthead.title" as="h1" fallback="The Weekly Dispatch" />
        <Slot id="masthead.tagline" as="p" fallback="Notes on building things that outlast their launch." />
      </header>

      <div className="sponsor-primary">
        <span className="label">This week&rsquo;s sponsor</span>
        <Slot
          id="sponsor.primary"
          fallback="Your company here — 6,400 engineers read this on a Tuesday."
        />
      </div>

      <div className="issues">
        <article className="issue">
          <span className="date">Issue 42 · 14 August</span>
          <h2>The cost of a decision you cannot undo</h2>
          <p>
            Every irreversible choice buys something: usually trust. The trick is noticing which ones
            are actually irreversible, because most of the ones that feel permanent are not, and a
            few of the ones that feel routine are.
          </p>
          <p className="issue-sponsor">
            <Slot id="issue.latest.sponsor" fallback="Sponsored by — this slot is open." />
          </p>
        </article>

        <article className="issue">
          <span className="date">Issue 41 · 7 August</span>
          <h2>Everything is a market if you let it be</h2>
          <p>
            Pricing something changes what it is. Once a queue has a fast lane it stops being a queue
            and becomes a market, and the people in it start behaving like traders whether or not
            anybody told them to.
          </p>
          <p className="issue-sponsor">
            <Slot id="issue.prev.sponsor" fallback="Sponsored by — this slot is open." />
          </p>
        </article>
      </div>

      <div className="recs">
        <h3>Also worth reading</h3>
        <ul>
          <li>
            <Slot id="recommended.1" fallback="Your newsletter — swap with us." />
          </li>
          <li>
            <Slot id="recommended.2" fallback="Your newsletter — swap with us." />
          </li>
          <li>
            <Slot id="recommended.3" fallback="Your newsletter — swap with us." />
          </li>
        </ul>
      </div>

      <footer className="ex-foot">
        <Slot id="footer.credit" fallback="© The Weekly Dispatch. Unsubscribe any time." />
        {' · '}
        <Slot id="footer.link.1" fallback="Footer link for sale — 0.000008 ETH" />
      </footer>
    </div>
  );
}
