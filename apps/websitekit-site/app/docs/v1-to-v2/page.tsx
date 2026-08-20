import Link from 'next/link';

import { DOC_NAV } from '../../../lib/docs';
import { GITHUB_URL, PACKAGES } from '../../../lib/links';
import { addedByGroup, readMigration } from '../../../lib/migration';

/**
 * What changed in the SDK between v1 and v2.
 *
 * Computed, not written: a frozen snapshot of v1's public surface on one side, the SDK's live types
 * on the other. The prose explains WHY each difference exists, which the compiler cannot supply —
 * and every one of those notes is asserted against the computed diff, so a note that stops being
 * true fails the build instead of misleading a reader.
 */
export const dynamic = 'force-static';

export const metadata = {
  title: 'websitekit — v1 to v2',
  description: "Every difference between v1 and v2 of @websitekit/sdk, computed from the package's own types.",
};

/**
 * Renders the `backticks` in a note as inline code.
 *
 * The notes are plain strings rather than markdown — they live next to the diff they explain, in
 * TypeScript, so the compiler sees the symbol names in them. That is worth keeping, but it means a
 * backtick has no renderer, and every note was showing its own punctuation.
 */
function withCode(text: string): React.ReactNode[] {
  return text.split('`').map((part, index) =>
    index % 2 === 1 ? <code key={index}>{part}</code> : <span key={index}>{part}</span>,
  );
}

const SECTIONS = [
  { id: 'breaking', title: 'What breaks' },
  { id: 'new', title: 'New in v2' },
  { id: 'kept', title: 'What stayed' },
];

export default function MigrationRoute() {
  const migration = readMigration();
  const added = addedByGroup(migration);

  return (
    <div className="site">
      <div className="docs-shell">
        <header className="docs-top">
          <Link href="/" className="back">
            websitekit
          </Link>
          <nav>
            {DOC_NAV.map((page) => (
              <Link
                key={page.slug}
                href={`/docs/${page.slug}`}
                className={page.slug === 'v1-to-v2' ? 'on' : undefined}
              >
                {page.title}
              </Link>
            ))}
            <Link href="/#examples">Examples</Link>
          </nav>
        </header>

        <aside className="docs-rail">
          <span className="rail-title">v1 → v2</span>
          <ul>
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>{section.title}</a>
              </li>
            ))}
            {added.map((group) => (
              <li key={group.title} className="sub">
                <a href={`#new-${group.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>{group.title}</a>
              </li>
            ))}
          </ul>
        </aside>

        <article className="prose api">
          <h1>v1 → v2</h1>

          <p>
            <strong>
              v1 exported {migration.v1Count} symbols. v2 exports {migration.v2Count}. Nothing was
              removed.
            </strong>{' '}
            {migration.changed.length} of the originals changed shape, {migration.unchangedCount} are
            byte-identical, and {migration.added.length} are new.
          </p>

          <p>
            This page is <strong>computed</strong>. One side is a frozen snapshot of v1&rsquo;s public
            surface, taken from git history before the port and never hand-edited; the other is read
            from the SDK&rsquo;s live types at build time. The explanations are written — and each one
            is checked against the computed diff, so a note that stops being true fails the build.
          </p>

          <p>
            This is the <em>SDK</em> surface. For what changed in the contracts — settlement in ERC-20,
            tenancy that survives displacement, the tiered mutability rules —{' '}
            <Link href="/docs/protocol-spec">the protocol spec opens with that table</Link>.
          </p>

          <div className="mig-stats">
            <div>
              <strong>{migration.changed.length}</strong>
              <span>changed shape</span>
            </div>
            <div>
              <strong>{migration.added.length}</strong>
              <span>added</span>
            </div>
            <div>
              <strong>{migration.removed.length}</strong>
              <span>removed</span>
            </div>
            <div>
              <strong>{migration.unchangedCount}</strong>
              <span>untouched</span>
            </div>
          </div>

          <h2 id="breaking">What breaks</h2>
          <p>
            These {migration.changed.length} exist in both versions with a different type. A v1 call
            site that touches one of them will not compile against v2 — which is the intended outcome:
            every change below is one where silently continuing to work would have been worse.
          </p>

          <dl className="api-list">
            {migration.changed.map((change) => (
              <div key={change.name} className="api-item" id={`sym-${change.name.toLowerCase()}`}>
                <dt>
                  <code className="api-name">{change.name}</code>
                  <span className="api-kind">{change.kind}</span>
                </dt>
                <dd>
                  {change.note ? <p className="api-doc mig-note">{withCode(change.note)}</p> : null}
                  <div className="mig-diff">
                    <div className="mig-side">
                      <span className="mig-label mig-v1">v1</span>
                      <pre className="api-sig">
                        <code>{change.before}</code>
                      </pre>
                    </div>
                    <div className="mig-side">
                      <span className="mig-label mig-v2">v2</span>
                      <pre className="api-sig">
                        <code>{change.after}</code>
                      </pre>
                    </div>
                  </div>
                </dd>
              </div>
            ))}
          </dl>

          <h2 id="new">New in v2</h2>
          <p>
            {migration.added.length} additions, grouped the way the SDK&rsquo;s entry point groups them.
            Full signatures are on the <Link href="/docs/api">API reference</Link>.
          </p>

          {added.map((group) => (
            <section key={group.title}>
              <h3 id={`new-${group.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>
                {group.title} <span className="mig-count">{group.changes.length}</span>
              </h3>
              <dl className="api-list">
                {group.changes.map((change) => (
                  <div key={change.name} className="api-item">
                    <dt>
                      <code className="api-name">{change.name}</code>
                      <span className="api-kind">{change.kind}</span>
                    </dt>
                    <dd>
                      {change.note ? <p className="api-doc mig-note">{withCode(change.note)}</p> : null}
                      <pre className="api-sig">
                        <code>{change.after}</code>
                      </pre>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}

          <h2 id="kept">What stayed</h2>
          <p>
            <strong>Every v1 export still exists in v2</strong>, and {migration.unchangedCount} of them
            are unchanged down to the byte. The keyed slot model, the pricing math, the pull ledger,
            the recipient-taking builders and clone-per-site fund isolation were not up for
            renegotiation — v2 is additive at the surface and breaking only where a type had to admit
            something new.
          </p>
          <p>
            The v1 <em>contracts</em> are a different story: they are deleted, and the boards cloned
            from them are unreadable by this SDK. If you have a deployed v1 board, its ABIs are in{' '}
            <a href={GITHUB_URL}>git history</a> — nothing in{' '}
            <a href={PACKAGES[1].url}>{PACKAGES[1].name}</a> can talk to it.
          </p>
        </article>
      </div>
    </div>
  );
}
