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

export interface ApiSymbol {
  name: string;
  /** `function`, `const`, `type`, `interface`, `class`, `enum` — what a reader needs to know first. */
  kind: string;
  /** The rendered type. Truncated: see MAX_SIGNATURE. */
  signature: string;
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

export function readApiReference(): ApiGroup[] {
  if (cached) return cached;

  const program = ts.createProgram([SDK_ENTRY], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const entry = program.getSourceFile(SDK_ENTRY);
  if (!entry) throw new Error(`api-reference: cannot read the SDK entry point at ${SDK_ENTRY}`);

  const moduleSymbol = checker.getSymbolAtLocation(entry);
  if (!moduleSymbol) throw new Error('api-reference: the SDK entry point resolved to no module symbol');

  const exported = checker.getExportsOfModule(moduleSymbol);
  if (exported.length === 0) throw new Error('api-reference: the SDK exports nothing — the program did not resolve');

  const { order, blurbs, of } = groupsFromEntry(entry.getFullText());
  const byGroup = new Map<string, ApiSymbol[]>();

  for (const symbol of exported) {
    const resolved = symbol.getFlags() & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
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
    const truncated = signature.length > MAX_SIGNATURE;
    if (truncated) signature = `${signature.slice(0, MAX_SIGNATURE)}…`;

    const summary = ts
      .displayPartsToString(resolved.getDocumentationComment(checker))
      .split(/\n\s*\n/)[0]
      .replace(/\s+/g, ' ')
      .trim();

    const group = of.get(symbol.getName()) ?? 'Other';
    const list = byGroup.get(group) ?? [];
    list.push({
      name: symbol.getName(),
      kind,
      signature,
      truncated,
      summary,
    });
    byGroup.set(group, list);
  }

  const titles = [...order.filter((title) => byGroup.has(title))];
  for (const title of byGroup.keys()) if (!titles.includes(title)) titles.push(title);

  cached = titles.map((title) => ({
    title,
    blurb: blurbs.get(title) ?? '',
    symbols: byGroup.get(title)!.sort((a, b) => a.name.localeCompare(b.name)),
  }));
  return cached;
}

/** Total exports documented — shown on the page, and the number that makes a regression obvious. */
export function apiSymbolCount(groups: ApiGroup[]): number {
  return groups.reduce((total, group) => total + group.symbols.length, 0);
}
