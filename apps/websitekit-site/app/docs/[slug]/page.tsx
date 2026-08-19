import Link from 'next/link';
import { notFound } from 'next/navigation';

import { DOC_PAGES, docFor, renderDoc } from '../../../lib/docs';

/**
 * A documentation page, rendered from the markdown in `docs/websitekit/` at build time.
 *
 * Fully static — the markdown is read during the build and baked into the output, so there is no
 * filesystem access on the request path in production.
 */
export const dynamic = 'force-static';

export function generateStaticParams() {
  return DOC_PAGES.map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = docFor(slug);
  if (!page) return {};
  return { title: `websitekit — ${page.title}`, description: page.blurb };
}

export default async function DocPageRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = docFor(slug);
  if (!page) notFound();

  const { html, headings } = await renderDoc(page);

  return (
    <div className="site">
      <div className="docs-shell">
        <header className="docs-top">
          <Link href="/" className="back">
            websitekit
          </Link>
          <nav>
            {DOC_PAGES.map((other) => (
              <Link
                key={other.slug}
                href={`/docs/${other.slug}`}
                className={other.slug === page.slug ? 'on' : undefined}
              >
                {other.title}
              </Link>
            ))}
            <Link href="/#examples">Examples</Link>
          </nav>
        </header>

        <aside className="docs-rail">
          <span className="rail-title">{page.title}</span>
          <ul>
            {headings.map((heading) => (
              <li key={heading.id} className={heading.depth === 3 ? 'sub' : undefined}>
                <a href={`#${heading.id}`}>{heading.text.replace(/<[^>]*>/g, '')}</a>
              </li>
            ))}
          </ul>
        </aside>

        <article className="prose" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
