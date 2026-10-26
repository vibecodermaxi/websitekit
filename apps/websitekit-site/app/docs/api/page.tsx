import Link from 'next/link';

import {
  apiSymbolCount,
  readApiReference,
  readImageBoardsReference,
  type ApiGroup,
  type ApiSymbol,
} from '../../../lib/api-reference';
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
  description:
    "Every export of @websitekit/sdk and @websitekit/sdk/image-boards, generated from the package's own type declarations.",
};

function anchorFor(name: string): string {
  return `sym-${name.toLowerCase()}`;
}

/**
 * The image-board entry point re-exports some of the main one's names (`contentHashToCid`) and has
 * groups named like its groups (`Reads`), so its anchors carry their own prefix.
 */
function imageBoardAnchorFor(name: string): string {
  return `ib-${name.toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^-|-$/g, '')}`;
}

/**
 * A symbol's anchor. Names are lowercased for the URL, so a type and a value that differ only in
 * case (`Accrual` and `accrual`) shared one id; the type takes a `-type` suffix, and the value keeps
 * the anchor existing links point at.
 */
function symbolAnchors(groups: ApiGroup[], anchor: (name: string) => string): (symbol: ApiSymbol) => string {
  const isType = (symbol: ApiSymbol) => symbol.kind === 'type' || symbol.kind === 'interface';
  const values = new Set(
    groups.flatMap((group) => group.symbols).filter((symbol) => !isType(symbol)).map((symbol) => anchor(symbol.name)),
  );
  return (symbol) => {
    const base = anchor(symbol.name);
    return isType(symbol) && values.has(base) ? `${base}-type` : base;
  };
}

function GroupSection({
  group,
  anchor,
  symbolAnchor,
}: {
  group: ApiGroup;
  anchor: (name: string) => string;
  symbolAnchor: (symbol: ApiSymbol) => string;
}) {
  return (
    <section>
      <h2 id={anchor(group.title)}>{group.title}</h2>
      {group.blurb ? <p className="api-blurb">{group.blurb}</p> : null}
      <dl className="api-list">
        {group.symbols.map((symbol) => (
          <div key={symbol.name} className="api-item" id={symbolAnchor(symbol)}>
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
  );
}

export default function ApiReferenceRoute() {
  const groups = readApiReference();
  const total = apiSymbolCount(groups);
  const imageBoardGroups = readImageBoardsReference();
  const imageBoardTotal = apiSymbolCount(imageBoardGroups);
  const symbolAnchor = symbolAnchors(groups, anchorFor);
  const imageBoardSymbolAnchor = symbolAnchors(imageBoardGroups, imageBoardAnchorFor);

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
          <span className="rail-title">Image boards</span>
          <ul>
            {imageBoardGroups.map((group) => (
              <li key={group.title}>
                <a href={`#${imageBoardAnchorFor(group.title)}`}>{group.title}</a>
              </li>
            ))}
          </ul>
        </aside>

        <article className="prose api">
          <h1>API reference</h1>
          <p>
            Every export of <code>@websitekit/sdk</code> — <strong>{total}</strong> of them, across{' '}
            {groups.length} groups — and <strong>{imageBoardTotal}</strong> more from its image-board
            entry point, <a href="#image-boards">
              <code>@websitekit/sdk/image-boards</code>
            </a>. <strong>This page is generated from the package&rsquo;s own type declarations at build
            time</strong>, so it cannot describe a function that does not exist, miss one that does, or
            show a signature the compiler disagrees with.
          </p>
          <p>
            The grouping and the section notes come from the SDK&rsquo;s entry points, which is where
            the API is deliberately ordered for a reader. <code>§</code> references point into the{' '}
            <Link href="/docs/protocol-spec">protocol spec</Link>, and under image boards into the{' '}
            <Link href="/docs/image-board-spec">image-board spec</Link>.
          </p>
          <p>
            Install <a href={PACKAGES[1].url}>{PACKAGES[1].name}</a>, or read the{' '}
            <a href={GITHUB_URL}>source</a>.
          </p>

          {groups.map((group) => (
            <GroupSection key={group.title} group={group} anchor={anchorFor} symbolAnchor={symbolAnchor} />
          ))}

          <h2 id="image-boards">
            <code>@websitekit/sdk/image-boards</code>
          </h2>
          <p>
            The image-board client, under its own entry point because its names (<code>quote</code>,{' '}
            <code>readBlock</code>, <code>Rect</code>) are generic. Groups are the banner comments in{' '}
            <code>image-boards.ts</code>, then each file it re-exports.
          </p>
          {imageBoardGroups.map((group) => (
            <GroupSection
              key={group.title}
              group={group}
              anchor={imageBoardAnchorFor}
              symbolAnchor={imageBoardSymbolAnchor}
            />
          ))}
        </article>
      </div>
    </div>
  );
}
