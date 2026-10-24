/**
 * The duel's import rules (DUEL.md "Modules"):
 *
 *  - nothing outside src/versus and src/link imports them, except types:
 *    main.ts reaches them through exactly one `import("./versus/lobby")`, so
 *    the duel is a lazily loaded chunk (and main.ts keeps its two
 *    `import("./game/replay")`: Save battle doesn't load the viewer);
 *  - src/game imports neither, except types;
 *  - src/versus and src/link use only `import type` from src/arena.
 *
 * The sources are read with the TypeScript parser, so comments and strings
 * never count and `import { type A }` is told from `import { A }`.
 *
 * Where the spec is silent:
 *  - type-only is `import type …`, `export type … from`, or a list whose
 *    names are all marked `type` (erased: the project has no
 *    verbatimModuleSyntax). A bare `import "…"` and a stylesheet count as
 *    value imports;
 *  - "outside" is everything under src/ but src/versus and src/link, and a
 *    computed `import(x)` there fails (it can't be checked).
 */
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** Every module under src/, as text, keyed "../src/…". */
const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** One import of a module: what it names, how, and whether it is erased (types only). */
interface Ref {
  spec: string;
  /** Resolved: a source file ("../src/…"), another file it names (a stylesheet), or null (a package). */
  path: string | null;
  kind: "static" | "dynamic" | "reexport";
  typeOnly: boolean;
  line: number;
}

/** `spec` from `from` as a key of `sources`, or the path of another file it names (a stylesheet); null: a package. */
function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("?")[0]!.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  const base = parts.join("/");
  for (const p of [base, `${base}.ts`, `${base}/index.ts`]) if (p in sources) return p;
  return /\.[a-z]+$/.test(base) ? base : null;
}

const parsed = new Map<string, ts.SourceFile>();
function parse(path: string): ts.SourceFile {
  let sf = parsed.get(path);
  if (!sf) {
    sf = ts.createSourceFile(path, sources[path]!, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    parsed.set(path, sf);
  }
  return sf;
}

/** Every import, re-export and dynamic import() in a file (`typeof import("…")` is a type: left out). */
function refsOf(path: string): Ref[] {
  const sf = parse(path);
  const out: Ref[] = [];
  const add = (spec: ts.Expression | undefined, kind: Ref["kind"], typeOnly: boolean, node: ts.Node) => {
    if (!spec || !ts.isStringLiteralLike(spec)) {
      // (a computed import() can't be checked: only allowed where nothing is at stake)
      if (kind === "dynamic") out.push({ spec: "<computed>", path: null, kind, typeOnly: false, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
      return;
    }
    out.push({ spec: spec.text, path: resolve(path, spec.text), kind, typeOnly, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const c = node.importClause;
      // `import type …`, or `import { type A, type B }` (erased: no verbatimModuleSyntax); a bare `import "…"` runs the module
      const named = c?.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements : null;
      const typeOnly = !!c && (c.isTypeOnly || (!c.name && !!named && named.length > 0 && named.every((e) => e.isTypeOnly)));
      add(node.moduleSpecifier, "static", typeOnly, node);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const named = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : null;
      const typeOnly = node.isTypeOnly || (!!named && named.length > 0 && named.every((e) => e.isTypeOnly));
      add(node.moduleSpecifier, "reexport", typeOnly, node);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, "static", node.isTypeOnly, node);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.arguments[0], "dynamic", false, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const all = Object.keys(sources).sort();
const inDuel = (p: string) => p.startsWith("../src/versus/") || p.startsWith("../src/link/");
const where = (from: string, r: Ref) => `${from.slice(3)}:${r.line} ${r.kind === "dynamic" ? `import("${r.spec}")` : `imports "${r.spec}"`}`;

describe("the duel's import rules", () => {
  it("finds the modules it checks", () => {
    for (const p of ["../src/main.ts", "../src/versus/lobby.ts", "../src/versus/feed.ts", "../src/game/GameScene.ts", "../src/arena/record.ts"])
      expect(all, p).toContain(p);
    // (the parser sees through comments: the lobby's header names the import it is reached by)
    expect(refsOf("../src/versus/lobby.ts").some((r) => r.spec === "./versus/lobby")).toBe(false);
  });

  it("nothing outside src/versus and src/link imports them, except types; main.ts's one import(\"./versus/lobby\") aside", () => {
    const bad: string[] = [];
    const entries: string[] = [];
    for (const from of all) {
      if (inDuel(from)) continue;
      for (const r of refsOf(from)) {
        if (r.kind === "dynamic" && r.path === null && r.spec === "<computed>") bad.push(`${where(from, r)}: a computed import()`);
        if (!r.path || !inDuel(r.path) || r.typeOnly) continue;
        if (from === "../src/main.ts" && r.kind === "dynamic" && r.path === "../src/versus/lobby.ts") entries.push(where(from, r));
        else bad.push(where(from, r));
      }
    }
    expect(bad).toEqual([]);
    expect(entries).toHaveLength(1);
  });

  it("main.ts has exactly one import(\"./versus/lobby\") and exactly two import(\"./game/replay\")", () => {
    const refs = refsOf("../src/main.ts").filter((r) => r.kind === "dynamic");
    expect(refs.filter((r) => r.path === "../src/versus/lobby.ts")).toHaveLength(1);
    expect(refs.filter((r) => r.path === "../src/game/replay.ts")).toHaveLength(2);
    // (and the text says so, as tests/arena.test.ts reads it)
    const main = sources["../src/main.ts"]!;
    expect(main.match(/import\(["']\.\/versus\/lobby["']\)/g)?.length).toBe(1);
    expect(main.match(/import\("\.\/game\/replay"\)/g)?.length).toBe(2);
  });

  it("src/game imports neither src/link nor src/versus, except types", () => {
    const bad: string[] = [];
    for (const from of all.filter((p) => p.startsWith("../src/game/")))
      for (const r of refsOf(from)) if (r.path && inDuel(r.path) && !r.typeOnly) bad.push(where(from, r));
    expect(bad).toEqual([]);
  });

  it("src/versus and src/link use only import type from src/arena", () => {
    const bad: string[] = [];
    for (const from of all.filter(inDuel))
      for (const r of refsOf(from)) if (r.path?.startsWith("../src/arena/") && !r.typeOnly) bad.push(where(from, r));
    expect(bad).toEqual([]);
  });
});
