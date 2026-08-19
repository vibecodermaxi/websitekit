import Link from 'next/link';

import { apiSymbolCount, readApiReference } from '../../../lib/api-reference';
import { DOC_NAV } from '../../../lib/docs';
import { GITHUB_URL, PACKAGES } from '../../../lib/links';

/**
 * The SDK's public API, generated from the SDK's own types.
 *
 * A static route rather than another `DOC_PAGES` entry, because there is no markdown file behind it
 * — `readApiReference` runs the TypeScript checker over `packages/websitekit-sdk/src/index.ts` at
 * build time. Next resolves a static segment ahead of the sibling `[slug]`, so `/docs/api` lands
 * here and the markdown route never sees it.
 */
export const dynamic = 'force-static';

export const metadata = {
  title: 'websitekit — API reference',
  description: "Every export of @websitekit/sdk, generated from the package's own type declarations.",
};

function anchorFor(name: string): string {
  return `sym-${name.toLowerCase()}`;
}

export default function ApiReferenceRoute() {
  const groups = readApiReference();
  const total = apiSymbolCount(groups);

  return (
    <div className="site">
      <div className="docs-shell">
        <header className="docs-top">
          <Link href="/" className="back">
            websitekit
          </Link>
          <nav>
            {DOC_NAV.map((page) => (
              <Link key={page.slug} href={`/docs/${page.slug}`} className={page.slug === 'api' ? 'on' : undefined}>
                {page.title}
              </Link>
            ))}
            <Link href="/#examples">Examples</Link>
          </nav>
        </header>

        <aside className="docs-rail">
          <span className="rail-title">API reference</span>
          <ul>
            {groups.map((group) => (
              <li key={group.title}>
                <a href={`#${anchorFor(group.title)}`}>{group.title}</a>
              </li>
            ))}
          </ul>
        </aside>

        <article className="prose api">
          <h1>API reference</h1>
          <p>
            Every export of <code>@websitekit/sdk</code> — <strong>{total}</strong> of them, across{' '}
            {groups.length} groups. <strong>This page is generated from the package&rsquo;s own type
            declarations at build time</strong>, so it cannot describe a function that does not
            exist, miss one that does, or show a signature the compiler disagrees with.
          </p>
          <p>
            The grouping and the section notes come from the SDK&rsquo;s entry point, which is where
            the API is deliberately ordered for a reader. <code>§</code> references point into the{' '}
            <Link href="/docs/protocol-spec">protocol spec</Link>.
          </p>
          <p>
            Install <a href={PACKAGES[1].url}>{PACKAGES[1].name}</a>, or read the{' '}
            <a href={GITHUB_URL}>source</a>.
          </p>

          {groups.map((group) => (
            <section key={group.title}>
              <h2 id={anchorFor(group.title)}>{group.title}</h2>
              {group.blurb ? <p className="api-blurb">{group.blurb}</p> : null}
              <dl className="api-list">
                {group.symbols.map((symbol) => (
                  <div key={symbol.name} className="api-item" id={anchorFor(symbol.name)}>
                    <dt>
                      <code className="api-name">{symbol.name}</code>
                      <span className="api-kind">{symbol.kind}</span>
                    </dt>
                    <dd>
                      {symbol.signature ? (
                        <pre className="api-sig">
                          <code>
                            {symbol.signature}
                            {symbol.truncated ? '' : null}
                          </code>
                        </pre>
                      ) : null}
                      {symbol.summary ? <p className="api-doc">{symbol.summary}</p> : null}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </article>
      </div>
    </div>
  );
}
