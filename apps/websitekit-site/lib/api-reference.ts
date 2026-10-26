import path from 'node:path';
import ts from 'typescript';

/**
 * The SDK's public API, read out of the SDK's own types at build time.
 *
 * **Generated, not written — and that is a decision with history.** `docs/sdk.md` was a
 * hand-maintained list of every exported function, the one document in this repo with no compiler
 * behind it, and it spent a full release describing the v1 API while the SDK shipped v2. It taught
 * `readSlots(client, site, keys)` after reads had moved to a `SiteRef`. It was retired with the note
 * that if an SDK page ever came back it should be generated. This is that page.
 *
 * What that buys: this cannot describe a function that does not exist, cannot miss one that does,
 * and cannot show a stale signature — the type checker is the source. If an export is renamed the
 * page renames with it, and if `index.ts` stops exporting something it leaves here in the same
 * commit. The failure mode of the old page is now structurally unavailable.
 */

// Mirrors `DOCS_DIR` in ./docs — the app runs from `apps/websitekit-site`, so the workspace root is
// two levels up. Reading the SDK's SOURCE rather than its `dist/` on purpose: nothing in the site's
// build pipeline builds the SDK first, and a reference that silently disappears when `dist/` is
// absent is worse than one that never depended on it.
const SDK_ENTRY = path.resolve(process.cwd(), '../../packages/websitekit-sdk/src/index.ts');

// The image-board client is a second entry point, `@websitekit/sdk/image-boards`, because its names
// (`quote`, `readBlock`, `Rect`) are generic. Until 2026-10-27 this page read only the first, and
// claimed every export while missing the whole of the second.
const IMAGE_BOARDS_ENTRY = path.resolve(process.cwd(), '../../packages/websitekit-sdk/src/image-boards.ts');

export interface ApiSymbol {
  name: string;
  /** `function`, `const`, `type`, `interface`, `class`, `enum` — what a reader needs to know first. */
  kind: string;
  /** The rendered type, capped for display: see MAX_SIGNATURE. */
  signature: string;
  /**
   * The same type, uncapped.
   *
   * Kept because the v1-to-v2 page compares signatures for equality, and the display cap made every
   * export longer than the cap compare unequal to its own frozen v1 snapshot — six types were
   * reported as breaking changes when they were byte-identical past the ellipsis. A truncated string
   * is fine to show and never safe to diff.
   */
  signatureFull: string;
  /** True when the signature was too long to show in full. */
  truncated: boolean;
  /** First paragraph of the JSDoc, or '' when the export carries none. */
  summary: string;
}

export interface ApiGroup {
  /** The heading, taken from the section comment in `index.ts`. */
  title: string;
  /** The rest of that comment — the sentence explaining what the group is for. */
  blurb: string;
  symbols: ApiSymbol[];
}

/**
 * Some exports are ABIs: `as const` arrays whose rendered type runs to tens of thousands of
 * characters. Printing one would bury the page, so signatures are capped and the overflow is marked
 * rather than silently cut.
 */
const MAX_SIGNATURE = 240;

function kindOf(symbol: ts.Symbol, declaration: ts.Declaration | undefined): string {
  const flags = symbol.getFlags();
  if (flags & ts.SymbolFlags.Interface) return 'interface';
  if (flags & ts.SymbolFlags.TypeAlias) return 'type';
  if (flags & ts.SymbolFlags.Class) return 'class';
  if (flags & ts.SymbolFlags.Enum || flags & ts.SymbolFlags.RegularEnum) return 'enum';
  if (flags & ts.SymbolFlags.Function) return 'function';
  if (declaration && ts.isVariableDeclaration(declaration)) {
    const type = declaration.type?.getText() ?? '';
    if (type.includes('=>') || declaration.initializer && ts.isArrowFunction(declaration.initializer)) {
      return 'function';
    }
  }
  return 'const';
}

/**
 * Groups come from the section comments already in `index.ts` — `// Reads — one call per page,
 * through \`SlotReader\` (§5, §11.4).` and its siblings.
 *
 * Reusing them rather than inventing a taxonomy here matters: that file is the one place the API is
 * deliberately ordered for a reader, complete with spec references, and a second ordering would be
 * a second thing to keep in sync. A symbol whose group cannot be determined falls through to
 * "Other", which is visible on the page rather than silently dropped.
 */
function groupsFromEntry(source: string): { order: string[]; blurbs: Map<string, string>; of: Map<string, string> } {
  const order: string[] = [];
  const blurbs = new Map<string, string>();
  const of = new Map<string, string>();

  let current: string | null = null;
  // A section comment, then everything exported until the next one belongs to it.
  const lines = source.split('\n');
  let buffer = '';
  let inExport = false;

  for (const line of lines) {
    const comment = line.match(/^\/\/\s*(.+?)\s*(?:—|--)\s*(.+)$/);
    if (comment && !inExport) {
      current = comment[1];
      if (!blurbs.has(current)) {
        order.push(current);
        blurbs.set(current, comment[2]);
      }
      continue;
    }
    if (/^export\s+(type\s+)?\{/.test(line)) inExport = true;
    if (inExport) {
      buffer += `${line}\n`;
      if (line.includes('}')) {
        const names = buffer.slice(buffer.indexOf('{') + 1, buffer.lastIndexOf('}'));
        for (const raw of names.split(',')) {
          const name = raw.replace(/\/\/[^\n]*/g, '').trim().split(/\s+as\s+/).pop()?.trim();
          if (name && /^[A-Za-z_$][\w$]*$/.test(name) && current) of.set(name, current);
        }
        buffer = '';
        inExport = false;
      }
    }
  }
  return { order, blurbs, of };
}

let cached: ApiGroup[] | null = null;
let cachedFlat: Map<string, ApiSymbol> | null = null;

/**
 * Every export, flat and keyed by name.
 *
 * Shared with the v1-to-v2 page so the two never disagree about what the SDK currently exports, and
 * so a single TypeScript program serves both — creating a second one doubles the slowest part of
 * the build for an identical answer.
 */
export function readSdkSurface(): Map<string, ApiSymbol> {
  if (!cachedFlat) {
    cachedFlat = new Map(readApiReference().flatMap((group) => group.symbols.map((s) => [s.name, s] as const)));
  }
  return cachedFlat;
}

let program: ts.Program | null = null;

/** Both entry points from one program, because building it is the slowest part of the build. */
function exportsOf(entryPath: string): { checker: ts.TypeChecker; entry: ts.SourceFile; exported: ts.Symbol[] } {
  program ??= ts.createProgram([SDK_ENTRY, IMAGE_BOARDS_ENTRY], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const entry = program.getSourceFile(entryPath);
  if (!entry) throw new Error(`api-reference: cannot read the SDK entry point at ${entryPath}`);

  const moduleSymbol = checker.getSymbolAtLocation(entry);
  if (!moduleSymbol) throw new Error(`api-reference: ${path.basename(entryPath)} resolved to no module symbol`);

  const exported = checker.getExportsOfModule(moduleSymbol);
  if (exported.length === 0) {
    throw new Error(`api-reference: ${path.basename(entryPath)} exports nothing — the program did not resolve`);
  }
  return { checker, entry, exported };
}

function resolvedOf(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.getFlags() & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function describe(checker: ts.TypeChecker, symbol: ts.Symbol): ApiSymbol {
  const resolved = resolvedOf(checker, symbol);
  const declaration = resolved.getDeclarations()?.[0];

  const kind = kindOf(resolved, declaration);

  // A type alias or interface is not a value, so asking for its value type answers `any`. Its
  // declaration IS the documentation — the field list is the whole point of looking it up.
  let signature = '';
  try {
    if ((kind === 'interface' || kind === 'type') && declaration) {
      signature = declaration.getText().replace(/\s+/g, ' ').replace(/^export\s+/, '').trim();
    } else {
      const type = declaration
        ? checker.getTypeOfSymbolAtLocation(resolved, declaration)
        : checker.getDeclaredTypeOfSymbol(resolved);
      signature = checker.typeToString(type, declaration, ts.TypeFormatFlags.NoTruncation);
    }
  } catch {
    signature = '';
  }
  const signatureFull = signature;
  const truncated = signature.length > MAX_SIGNATURE;
  if (truncated) signature = `${signature.slice(0, MAX_SIGNATURE)}…`;

  const summary = ts
    .displayPartsToString(resolved.getDocumentationComment(checker))
    .split(/\n\s*\n/)[0]
    .replace(/\s+/g, ' ')
    .trim();

  return { name: symbol.getName(), kind, signature, signatureFull, truncated, summary };
}

/** Authored groups first, in their order; any other group after them, as it was first met. */
function grouped(byGroup: Map<string, ApiSymbol[]>, order: string[], blurbs: Map<string, string>): ApiGroup[] {
  const titles = [...order.filter((title) => byGroup.has(title))];
  for (const title of byGroup.keys()) if (!titles.includes(title)) titles.push(title);

  return titles.map((title) => ({
    title,
    blurb: blurbs.get(title) ?? '',
    symbols: byGroup.get(title)!.sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

export function readApiReference(): ApiGroup[] {
  if (cached) return cached;

  const { checker, entry, exported } = exportsOf(SDK_ENTRY);
  const { order, blurbs, of } = groupsFromEntry(entry.getFullText());
  const byGroup = new Map<string, ApiSymbol[]>();

  for (const symbol of exported) {
    const group = of.get(symbol.getName()) ?? 'Other';
    byGroup.set(group, [...(byGroup.get(group) ?? []), describe(checker, symbol)]);
  }

  cached = grouped(byGroup, order, blurbs);
  return cached;
}

/**
 * The banner comments in an entry point — a title line between two rules of dashes — with the
 * line each title sits on. A title with a colon is split there into the heading and its note.
 */
function bannersOf(entry: ts.SourceFile): { line: number; title: string; blurb: string }[] {
  const lines = entry.getFullText().split('\n');
  const rule = /^\/\/ -{20,}\s*$/;
  const banners: { line: number; title: string; blurb: string }[] = [];
  for (let i = 1; i + 1 < lines.length; i++) {
    const text = lines[i].match(/^\/\/ (.+?)\s*$/)?.[1];
    if (!text || !rule.test(lines[i - 1]) || !rule.test(lines[i + 1])) continue;
    // Backticks come off the heading, which renders as plain text in the page and the rail.
    const colon = text.indexOf(': ');
    banners.push(
      colon === -1
        ? { line: i, title: text.replace(/`/g, ''), blurb: '' }
        : { line: i, title: text.slice(0, colon).replace(/`/g, ''), blurb: text.slice(colon + 2) },
    );
  }
  return banners;
}

/** The first sentence of a file's leading doc comment: what the file says it is. */
function firstSentenceOf(file: ts.SourceFile): string {
  const doc = file.getFullText().match(/^\s*\/\*\*([\s\S]*?)\*\//)?.[1] ?? '';
  const paragraph = doc
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim()
    .split(/\n\s*\n/)[0]
    .replace(/\s+/g, ' ');
  return paragraph.match(/^(.+?\.)(\s|$)/)?.[1] ?? paragraph;
}

let cachedImageBoards: ApiGroup[] | null = null;

/**
 * Every export of `@websitekit/sdk/image-boards`.
 *
 * Grouped differently from the main entry because it is written differently: its own exports are
 * declarations under banner comments (`// Reads` between two rules of dashes), and the rest arrive
 * by `export *` from the grid twin, the compositor and content addressing. A declaration takes the
 * banner above it; a re-export takes the file it is declared in, with that file's first sentence as
 * the note. Both are read from the source, so neither is a second taxonomy to keep in sync.
 *
 * Kept apart from `readSdkSurface`, which the v1-to-v2 page diffs against v1's main entry: these
 * exports never had a v1 and would all read as additions.
 */
export function readImageBoardsReference(): ApiGroup[] {
  if (cachedImageBoards) return cachedImageBoards;

  const { checker, entry, exported } = exportsOf(IMAGE_BOARDS_ENTRY);
  const banners = bannersOf(entry);
  const blurbs = new Map(banners.map((banner) => [banner.title, banner.blurb] as const));
  const byGroup = new Map<string, ApiSymbol[]>();

  for (const symbol of exported) {
    const declaration = resolvedOf(checker, symbol).getDeclarations()?.[0];
    const file = declaration?.getSourceFile();
    let group = 'Other';
    if (declaration && file === entry) {
      const line = file.getLineAndCharacterOfPosition(declaration.getStart()).line;
      group = banners.filter((banner) => banner.line < line).pop()?.title ?? 'Other';
    } else if (file) {
      group = `From ${path.basename(file.fileName)}`;
      blurbs.set(group, firstSentenceOf(file));
    }
    byGroup.set(group, [...(byGroup.get(group) ?? []), describe(checker, symbol)]);
  }

  // Banners in file order, then each re-exported file in the order the entry re-exports it, then
  // whatever had no banner above it.
  const reexported = [...entry.getFullText().matchAll(/^export (?:\*|\{[^}]*\}) from '\.\/([\w-]+)'/gm)].map(
    (match) => `From ${match[1]}.ts`,
  );
  cachedImageBoards = grouped(byGroup, [...banners.map((banner) => banner.title), ...reexported, 'Other'], blurbs);
  return cachedImageBoards;
}

/** Which authored group a symbol belongs to, for pages that need the grouping but not the layout. */
export function groupOf(name: string): string {
  for (const group of readApiReference()) {
    if (group.symbols.some((symbol) => symbol.name === name)) return group.title;
  }
  return 'Other';
}

/** Total exports documented — shown on the page, and the number that makes a regression obvious. */
export function apiSymbolCount(groups: ApiGroup[]): number {
  return groups.reduce((total, group) => total + group.symbols.length, 0);
}
