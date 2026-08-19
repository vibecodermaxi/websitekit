import { Slot } from '@websitekit/react';

/**
 * Remote Roles — a job board.
 *
 * The five featured rows are ranked, and the ranking is the product: `featured.1` costs three times
 * `featured.5` because it is read first. Two of the five and one category sponsor are deliberately
 * unclaimed, so the page shows both halves of the board — a market with no openings looks closed.
 */
export function RemoteRoles() {
  return (
    <div className="ex ex-remoteroles">
      <Slot
        id="banner.top"
        className="banner"
        fallback="Hiring? This banner is open — every visitor sees it first."
      />

      <header className="head">
        <h1>Remote Roles</h1>
        <p>Engineering and design jobs at companies that were remote before it was a policy.</p>
      </header>

      <nav className="cats">
        <Slot id="category.eng.sponsor" fallback="Engineering" />
        <Slot id="category.design.sponsor" fallback="Design" />
        <span>Product</span>
        <span>Data</span>
        <span>Support</span>
        <Slot id="nav.link.1" className="open-chip" fallback="+ your category — 0.00002 ETH" />
      </nav>

      <div className="listings">
        {[1, 2, 3, 4, 5].map((n) => (
          <div className="listing" key={n}>
            <span className="rank">{String(n).padStart(2, '0')}</span>
            <Slot
              id={`featured.${n}`}
              className="role"
              fallback={FALLBACK_ROLES[n - 1]}
            />
            <span className="tag">featured</span>
          </div>
        ))}
      </div>

      <div className="foot-links">
        <Slot id="footer.link.1" fallback="Post a role" />
        {' · '}
        <Slot id="footer.link.2" fallback="Footer link for sale — 0.000008 ETH" />
      </div>

      <footer className="ex-foot">Remote Roles · a websitekit example board</footer>
    </div>
  );
}

/**
 * Fallback copy for the featured rows.
 *
 * All five are now owned, so in practice none of these render — they are what the board would say
 * if its storage went dark, which is exactly the case `fallback` exists for. The open slots on this
 * page are the nav chip and the second footer link, not a listing row: an empty row in the middle of
 * a list reads as a broken site, while an obviously-purchasable extra reads as an available one.
 */
const FALLBACK_ROLES = [
  'Senior Platform Engineer — Arbor',
  'Design Engineer — Fieldnote',
  'Staff Backend Engineer — Kestrel',
  'Infrastructure Engineer — Halden',
  'Product Designer — Cormorant',
];
