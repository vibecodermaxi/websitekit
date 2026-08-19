import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Marked } from 'marked';
import { DEMO_SITE_V1, EXAMPLE_SITES_V1 } from '@websitekit/sdk';

/**
 * Renders the markdown in the repo's `docs/` as pages on this site.
 *
 * **The markdown files stay the single source of truth.** The alternative — hand-porting the guide
 * into JSX — produces two copies of the same prose that drift the first time either is edited, and
 * the copy on the public site is the one nobody remembers to update. This reads the real files at
 * build time, so a docs edit is a redeploy rather than a rewrite.
 *
 * Read at build, not at request: every page here is statically generated, so the markdown is baked
 * into the output and no filesystem access happens in production.
 */

// `../../docs`, not `../../docs/websitekit`: the second was the path when this app lived beside
// websitekit inside a larger monorepo. Carrying it across to the standalone repo left `next build`
// failing at prerender with ENOENT — a build-time-only break, so nothing in dev or in the test
// suite ever saw it.
const DOCS_DIR = path.resolve(process.cwd(), '../../docs');

export interface DocPage {
  slug: string;
  file: string;
  title: string;
  blurb: string;
}

/**
 * `STATUS.md`, `STATE.md`, `NEW-REPO-HANDOFF.md` and `PIVOT-MAP.md` are deliberately absent.
 *
 * They are the internal record: next steps, funding state, orphaned deployments, unpushed work and
 * the decision register's deliberation. Useful to whoever picks the build up, wrong to publish on
 * the site the product is sold from. If one ever ships it needs its own pass first, not an entry
 * here.
 */
export const DOC_PAGES: DocPage[] = [
  {
    slug: 'guide',
    file: 'README.md',
    title: 'Guide',
    blurb: 'The model, the layers, and every mechanism — issuance, secondary market, tenancy, terms of issue.',
  },
  {
    // Not optional. The shipping source carries **192 `§` references** into this document and five
    // contracts name it outright, so a developer reading the code to decide whether to trust it is
    // sent here. Without a page, every one of those is a pointer into a file on GitHub.
    slug: 'protocol-spec',
    file: 'PROTOCOL-SPEC.md',
    title: 'Protocol spec',
    blurb: 'The contract design: state, pricing, tenancy, terms of issue, and why every parameter is what it is.',
  },
];

/**
 * **There is no `sdk` page any more.** `docs/sdk.md` was a hand-maintained list of every exported
 * function — the one document in this repo with no compiler behind it — and it went a whole release
 * describing the v1 API while the SDK shipped v2. It taught `readSlots(client, site, keys)` after
 * reads had moved to a `SiteRef`, which is worse than no reference at all.
 *
 * The reference is now the TypeScript types plus each package's README, both of which fail loudly
 * when they drift. If a narrative SDK page comes back, it should be generated, not written.
 */

/**
 * What the docs nav shows, markdown pages plus the generated ones.
 *
 * `DOC_PAGES` cannot carry `/docs/api`: it is a list of markdown files, and the API reference has no
 * file — it is read out of the SDK's types at build time. Keeping one nav list means adding a page
 * cannot leave the header pointing at three of four pages.
 */
export const DOC_NAV: { slug: string; title: string }[] = [
  ...DOC_PAGES.map((page) => ({ slug: page.slug, title: page.title })),
  { slug: 'api', title: 'API reference' },
];

export function docFor(slug: string): DocPage | undefined {
  return DOC_PAGES.find((page) => page.slug === slug);
}

export interface Heading {
  depth: number;
  id: string;
  text: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Where a repo-relative link to source should point once it is on the web. */
const REPO_BLOB = 'https://github.com/vibecodermaxi/websitekit/blob/main/';

/**
 * Rewrites the repo-relative links the markdown carries so they resolve on the web.
 *
 * `./PROTOCOL-SPEC.md` is correct in a repo and a 404 on a site. Documents that are published get
 * their route; source files get a link into the public repo; documents that are deliberately NOT
 * published are flattened to plain text rather than left as dead anchors — a link that goes nowhere
 * is worse than no link, because the reader spends a click finding out.
 */
function rewriteLinks(html: string): string {
  return html
    .replace(/href="\.\/README\.md"/g, 'href="/docs/guide"')
    .replace(/href="\.\/PROTOCOL-SPEC\.md"/g, 'href="/docs/protocol-spec"')
    // Private by decision — see the note on DOC_PAGES above. The link text is matched lazily rather
    // than as `[^<]*`, because markdown like [`PIVOT-MAP.md`](./PIVOT-MAP.md) renders its label as a
    // nested <code>, and a character class that stops at `<` never reaches the closing tag.
    .replace(/<a href="\.\/(PIVOT-MAP|STATE|STATUS|NEW-REPO-HANDOFF)\.md">([\s\S]*?)<\/a>/g,
      '<span class="unlinked">$2</span>')
    // `../packages/…/foo.ts` and friends: real files, just not on this host.
    .replace(/href="\.\.\/([^"]+)"/g, `href="${REPO_BLOB}$1"`);
}

/**
 * **Fails the build on any repo-relative link that survived the rewrite.**
 *
 * The rules above are a list, and a list rots: `./sdk.md` had a rule long after the file was
 * deleted, while `./PROTOCOL-SPEC.md` — which the guide actually links — had none, and rendered as a
 * dead `href="./PROTOCOL-SPEC.md"` on the live site. Neither is visible in dev, because in a repo
 * both paths are correct. This is the check that makes the omission loud: a missing rule is now a
 * failed `next build`, not a 404 somebody else finds.
 */
function assertNoRepoRelativeLinks(html: string, file: string): void {
  const leftovers = [...html.matchAll(/href="(\.[^"]*)"/g)].map((match) => match[1]);
  if (leftovers.length) {
    throw new Error(
      `${file}: ${leftovers.length} repo-relative link(s) survived rewriteLinks and would 404 on the ` +
        `site: ${[...new Set(leftovers)].join(', ')}. Add a rule in rewriteLinks.`,
    );
  }
}

/**
 * **Fails the build if a published document links a superseded board.**
 *
 * The guide's four "see them on chain" links pointed at the v1 example boards for the whole life of
 * this site — clones of an implementation that has since been deleted, which nothing in this
 * codebase can read. They were correct when written and rotted silently, because an address is
 * opaque: nothing about `0x895Fb4Ba…` says which generation it belongs to, and it renders and links
 * exactly as well when it is wrong.
 *
 * The SDK keeps the superseded addresses as provenance, which is what makes this checkable at all —
 * every retired board is a named constant, so the check is a set membership rather than a guess.
 */
const SUPERSEDED_ADDRESSES = new Map<string, string>([
  ...Object.entries(EXAMPLE_SITES_V1).map(
    ([name, address]) => [address.toLowerCase(), `EXAMPLE_SITES_V1.${name}`] as const,
  ),
  [DEMO_SITE_V1.toLowerCase(), 'DEMO_SITE_V1'],
]);

function assertNoSupersededAddresses(html: string, file: string): void {
  const hits = [...html.matchAll(/0x[a-fA-F0-9]{40}/g)]
    .map((match) => match[0])
    .filter((address) => SUPERSEDED_ADDRESSES.has(address.toLowerCase()))
    .map((address) => `${address} (${SUPERSEDED_ADDRESSES.get(address.toLowerCase())})`);
  if (hits.length) {
    throw new Error(
      `${file} links ${new Set(hits).size} superseded board(s): ${[...new Set(hits)].join(', ')}. ` +
        `These are retired generations and cannot be read by this SDK — use the current constants.`,
    );
  }
}

export async function renderDoc(page: DocPage): Promise<{ html: string; headings: Heading[] }> {
  const source = await readFile(path.join(DOCS_DIR, page.file), 'utf-8');
  const headings: Heading[] = [];

  const marked = new Marked({ gfm: true });

  // Heading ids are added here rather than taken from a plugin so the id in the rendered HTML and
  // the id in the contents rail are produced by the same function and cannot disagree.
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const id = slugify(text);
        if (depth >= 2 && depth <= 3) headings.push({ depth, id, text });
        return `<h${depth} id="${id}">${text}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${depth}>\n`;
      },
      table(token) {
        // Wrapped so a wide table scrolls inside its own container instead of forcing the page to
        // scroll sideways on a phone.
        const header = token.header
          .map((cell) => `<th>${this.parser.parseInline(cell.tokens)}</th>`)
          .join('');
        const body = token.rows
          .map(
            (row) =>
              `<tr>${row.map((cell) => `<td>${this.parser.parseInline(cell.tokens)}</td>`).join('')}</tr>`,
          )
          .join('');
        return `<div class="table-scroll"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
      },
    },
  });

  const html = rewriteLinks(await marked.parse(source));
  assertNoRepoRelativeLinks(html, page.file);
  assertNoSupersededAddresses(html, page.file);
  return { html, headings };
}
