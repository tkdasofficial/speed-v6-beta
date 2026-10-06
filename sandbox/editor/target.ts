// Targeted (partial) file editing: locate exactly one region of the CURRENT file by line range, exact text,
// TS/TSX symbol, JSX element or CSS rule, then replace/insert only that region. Ambiguous or stale targets are
// refused with the real current text so the caller can re-read instead of guessing.
import { parse } from "@babel/parser";

export interface EditTarget {
  /** Exact text. Must be unique (inside the other target when combined) unless `occurrence` picks one. */
  find?: string;
  /** 1-based inclusive line range. Pair with `expect` (the text you read there) to detect shifted lines. */
  lines?: { start: number; end: number };
  expect?: string;
  /** Function, component, const, class, interface, type, enum, or `Class.method`. */
  symbol?: string;
  /** JSX element: `tag`, `tag.className` or `tag#id` (e.g. "section.hero", "Navbar"). */
  jsx?: string;
  /** CSS selector of a rule (e.g. ".hero-title"); `media` scopes it to an @media/@supports block. */
  selector?: string;
  media?: string;
  /** Disambiguates several symbol/jsx/selector matches: keep only regions containing this text. */
  contains?: string;
  /** 1-based pick among several matches, used only when the other narrowing still leaves duplicates. */
  occurrence?: number;
}
export type EditMode = "replace" | "before" | "after" | "append";
export interface Located { start: number; end: number; method: string; note?: string }

export class TargetError extends Error {
  constructor(readonly code: "NOT_FOUND" | "AMBIGUOUS" | "STALE" | "INVALID", message: string) { super(message); }
}

const W = /[\w$]/;
const lineOf = (s: string, at: number) => s.slice(0, at).split("\n").length;
const lineStart = (s: string, at: number) => s.lastIndexOf("\n", at - 1) + 1;
const lineEnd = (s: string, at: number) => { const e = s.indexOf("\n", at); return e < 0 ? s.length : e; };
const clip = (t: string, n = 300) => (t.length > n ? `${t.slice(0, n)}…` : t);

/** Numbered lines around [from, to) — what the editor shows back after an edit. */
export function excerpt(content: string, from: number, to: number, ctx = 2, maxLines = 40): string {
  const ls = content.split("\n");
  const a = Math.max(1, lineOf(content, from) - ctx), b = Math.min(ls.length, lineOf(content, Math.max(from, to - 1)) + ctx);
  const out: string[] = [];
  for (let i = a; i <= b && out.length < maxLines; i++) out.push(`${String(i).padStart(4)}| ${ls[i - 1]}`);
  if (b - a + 1 > maxLines) out.push(`    … ${b - a + 1 - maxLines} more lines`);
  return out.join("\n");
}

function pick(cands: Located[], t: EditTarget, content: string, what: string, region?: Located): Located {
  let c = cands;
  if (t.contains !== undefined && !t.find) c = c.filter((x) => content.slice(x.start, x.end).includes(t.contains!));
  if (region) c = c.filter((x) => x.start >= region.start && x.end <= region.end);
  if (!c.length) throw new TargetError("NOT_FOUND", `${what} not found${region ? ` inside ${region.method}` : ""}${t.contains ? ` containing ${JSON.stringify(clip(t.contains, 60))}` : ""}`);
  if (t.occurrence !== undefined) {
    const x = c[t.occurrence - 1];
    if (!x) throw new TargetError("NOT_FOUND", `${what}: only ${c.length} match(es), occurrence ${t.occurrence} doesn't exist`);
    return x;
  }
  if (c.length > 1) throw new TargetError("AMBIGUOUS", `${what} matches ${c.length} places (lines ${c.slice(0, 8).map((x) => lineOf(content, x.start)).join(", ")}) — narrow it with contains, a wider find, a symbol/selector, or occurrence`);
  return c[0]!;
}

// ---- line ranges ----
function byLines(content: string, t: EditTarget): Located {
  const { start, end } = t.lines!;
  const ls = content.split("\n");
  if (start < 1 || end < start) throw new TargetError("INVALID", `Invalid line range ${start}-${end}`);
  if (end > ls.length) throw new TargetError("STALE", `The file has only ${ls.length} lines (asked for ${start}-${end}) — re-read it`);
  let from = 0; for (let i = 0; i < start - 1; i++) from += ls[i]!.length + 1;
  let to = from; for (let i = start - 1; i < end; i++) to += ls[i]!.length + (i < end - 1 ? 1 : 0);
  if (t.expect === undefined) return { start: from, end: to, method: `lines ${start}-${end}` };
  const norm = (s: string) => s.split("\n").map((l) => l.trimEnd()).join("\n").trim();
  if (norm(content.slice(from, to)) === norm(t.expect)) return { start: from, end: to, method: `lines ${start}-${end}` };
  // The lines moved since they were read: follow the expected text when it is unique in the current file.
  const exp = t.expect.trim();
  const hits: number[] = []; for (let i = content.indexOf(exp); i >= 0 && hits.length < 3; i = content.indexOf(exp, i + 1)) hits.push(i);
  if (hits.length === 1) {
    const a = lineStart(content, hits[0]!), b = lineEnd(content, hits[0]! + exp.length);
    return { start: a, end: b, method: `lines ${lineOf(content, a)}-${lineOf(content, b)}`, note: `Lines moved: the expected text is now at ${lineOf(content, a)}-${lineOf(content, b)}` };
  }
  throw new TargetError("STALE", `Lines ${start}-${end} no longer contain the expected text — they are now:\n${excerpt(content, from, to, 0, 15)}`);
}

// ---- exact text ----
function byText(content: string, t: EditTarget, region?: Located): Located {
  const f = t.find!;
  const lo = region?.start ?? 0, hi = region?.end ?? content.length;
  const all: Located[] = [];
  for (let i = content.indexOf(f, lo); i >= 0 && i + f.length <= hi; i = content.indexOf(f, i + 1)) all.push({ start: i, end: i + f.length, method: "text" });
  if (!all.length) throw new TargetError("NOT_FOUND", `Text not found${region ? ` inside ${region.method}` : ""} — read the file and copy the exact current text`);
  // Never edit half a word ("Home" inside "Homeme"): drop matches that start or end inside an identifier.
  const whole = all.filter((m) => !((W.test(f[0]!) && m.start > 0 && W.test(content[m.start - 1]!)) || (W.test(f.at(-1)!) && W.test(content[m.end] ?? ""))));
  if (!whole.length) {
    const m = all[0]!;
    throw new TargetError("INVALID", `Find-text only matches inside a longer word. The full line is: ${JSON.stringify(clip(content.slice(lineStart(content, m.start), lineEnd(content, m.end))))} — use the whole word or line`);
  }
  return pick(whole, { ...t, contains: undefined }, content, `Text ${JSON.stringify(clip(f, 60))}`);
}

// ---- TS/TSX via Babel ----
type N = { type: string; start: number; end: number; [k: string]: unknown };
function ast(content: string, path: string): N {
  const ts = /\.(tsx?|mts|cts)$/i.test(path);
  try {
    return parse(content, { sourceType: "module", errorRecovery: true, plugins: [...(ts ? (["typescript"] as const) : []), ...(/\.(tsx|jsx|js|mjs)$/i.test(path) ? (["jsx"] as const) : [])] }) as unknown as N;
  } catch (e) {
    throw new TargetError("INVALID", `Can't parse ${path} to find the target (${(e as Error).message}) — use find or lines instead`);
  }
}
function walk(n: unknown, fn: (n: N, parents: N[]) => void, parents: N[] = []): void {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) { for (const x of n) walk(x, fn, parents); return; }
  const node = n as N;
  if (typeof node.type !== "string") return;
  fn(node, parents);
  const next = [...parents, node];
  for (const k of Object.keys(node)) if (k !== "loc" && k !== "leadingComments" && k !== "trailingComments" && k !== "innerComments" && k !== "extra") walk(node[k], fn, next);
}
const idName = (x: unknown) => (x && typeof x === "object" && (x as N).type === "Identifier" ? ((x as N)["name"] as string) : x && typeof x === "object" && (x as N).type === "StringLiteral" ? ((x as N)["value"] as string) : undefined);
/** Widens a declaration to its full statement: `export (default)` wrapper and single-declarator `const`. */
function statement(node: N, parents: N[]): N {
  let cur = node, i = parents.length - 1;
  if (cur.type === "VariableDeclarator") { const p = parents[i]; if (p?.type === "VariableDeclaration" && (p["declarations"] as N[]).length === 1) { cur = p; i--; } }
  const p = parents[i]; if (p && /^Export(Named|Default)Declaration$/.test(p.type)) cur = p;
  return cur;
}

function bySymbol(content: string, path: string, t: EditTarget): Located {
  const [owner, member] = t.symbol!.includes(".") ? t.symbol!.split(".", 2) as [string, string] : [null, t.symbol!];
  const cands: Located[] = [];
  walk(ast(content, path), (n, parents) => {
    let name: string | undefined, target: N = n;
    if (/^(FunctionDeclaration|ClassDeclaration|TSInterfaceDeclaration|TSTypeAliasDeclaration|TSEnumDeclaration|TSModuleDeclaration)$/.test(n.type)) name = idName(n["id"]);
    else if (n.type === "VariableDeclarator") name = idName(n["id"]);
    else if (/^(ClassMethod|ClassProperty|ClassPrivateMethod|ObjectMethod|TSDeclareMethod)$/.test(n.type) || (n.type === "ObjectProperty" && /Function|Arrow/.test(((n["value"] as N)?.type) ?? ""))) {
      name = idName(n["key"]);
      if (owner) {
        const cls = [...parents].reverse().find((p) => /^Class(Declaration|Expression)$/.test(p.type) || p.type === "VariableDeclarator");
        if (!cls || idName(cls["id"]) !== owner) return;
      }
      if (name === member) cands.push({ start: n.start, end: n.end, method: `${owner ? `${owner}.` : ""}${member}` });
      return;
    }
    if (owner || name !== member) return;
    target = statement(n, parents);
    cands.push({ start: target.start, end: target.end, method: `symbol ${member}` });
  });
  return pick(cands, t, content, `Symbol ${t.symbol}`);
}

function byJsx(content: string, path: string, t: EditTarget): Located {
  const m = /^([A-Za-z_$][\w$-]*(?:\.[A-Z][\w$]*)*)?(?:([.#])([\w-]+))?$/.exec(t.jsx!.trim());
  if (!m) throw new TargetError("INVALID", `Invalid jsx target ${JSON.stringify(t.jsx)} — use tag, tag.class or tag#id`);
  const [, tag, kind, val] = m;
  const nameOf = (x: N | undefined): string => !x ? "" : x.type === "JSXIdentifier" ? (x["name"] as string) : x.type === "JSXMemberExpression" ? `${nameOf(x["object"] as N)}.${nameOf(x["property"] as N)}` : "";
  const cands: Located[] = [];
  walk(ast(content, path), (n) => {
    if (n.type !== "JSXElement") return;
    const open = n["openingElement"] as N;
    if (tag && nameOf(open["name"] as N) !== tag) return;
    if (kind) {
      const attr = (open["attributes"] as N[]).find((a) => a.type === "JSXAttribute" && nameOf(a["name"] as N) === (kind === "." ? "className" : "id"));
      const v = attr ? content.slice((attr["value"] as N | null)?.start ?? 0, (attr["value"] as N | null)?.end ?? 0) : "";
      if (!new RegExp(kind === "." ? `(^|[\\s"'\`{])${val}($|[\\s"'\`}])` : `^["'{\`]*${val}["'}\`]*$`).test(v)) return;
    }
    cands.push({ start: n.start, end: n.end, method: `<${t.jsx}>` });
  });
  return pick(cands, t, content, `JSX element <${t.jsx}>`);
}

// ---- CSS rules ----
interface CssRule { prelude: string; start: number; end: number; parent: string | null }
export function cssRules(css: string): CssRule[] {
  const out: CssRule[] = [];
  const stack: { prelude: string; start: number }[] = [];
  let segStart = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (c === "/" && css[i + 1] === "*") { const e = css.indexOf("*/", i + 2); i = e < 0 ? css.length : e + 1; continue; }
    if (c === '"' || c === "'") { let j = i + 1; while (j < css.length && css[j] !== c) { if (css[j] === "\\") j++; j++; } i = j; continue; }
    if (c === ";" ) { segStart = i + 1; continue; }
    if (c === "{") {
      const raw = css.slice(segStart, i);
      const lead = raw.length - raw.trimStart().length;
      let start = segStart + lead;
      // Skip leading comments so the rule starts at its selector.
      while (css.startsWith("/*", start)) { const e = css.indexOf("*/", start); start = e < 0 ? i : e + 2; while (/\s/.test(css[start] ?? "")) start++; }
      stack.push({ prelude: css.slice(start, i).replace(/\s+/g, " ").trim(), start });
      segStart = i + 1; continue;
    }
    if (c === "}") {
      const r = stack.pop();
      if (r) out.push({ prelude: r.prelude, start: r.start, end: i + 1, parent: stack.length ? stack[stack.length - 1]!.prelude : null });
      segStart = i + 1;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
function bySelector(content: string, t: EditTarget): Located {
  const want = t.selector!.replace(/\s+/g, " ").trim();
  const rules = cssRules(content).filter((r) => (t.media ? (r.parent ?? "").replace(/\s+/g, " ").includes(t.media.replace(/\s+/g, " ").trim()) : r.parent === null));
  let hits = rules.filter((r) => r.prelude === want || (want.startsWith("@") && r.prelude.startsWith(want)));
  if (!hits.length) hits = rules.filter((r) => r.prelude.split(",").map((s) => s.trim()).includes(want));
  const label = `CSS rule ${want}${t.media ? ` in ${t.media}` : ""}`;
  return pick(hits.map((r) => ({ start: r.start, end: r.end, method: label })), t, content, label);
}

/** Resolves a target to exactly one region of the current content, or throws a TargetError. */
export function locate(content: string, path: string, t: EditTarget): Located {
  const scoped = t.symbol ? bySymbol(content, path, t) : t.jsx ? byJsx(content, path, t) : t.selector ? bySelector(content, t) : t.lines ? byLines(content, t) : null;
  if (t.find !== undefined) return byText(content, t, scoped ?? undefined);
  if (!scoped) throw new TargetError("INVALID", "No target given — pass find, lines, symbol, jsx or selector");
  return scoped;
}

/** Applies one targeted edit; returns the new content and the offsets of the inserted text. */
export function applyEdit(content: string, path: string, t: EditTarget, text: string, mode: EditMode = "replace"): { next: string; from: number; to: number; located: Located } {
  if (mode === "append" && t.find === undefined && !t.lines && !t.symbol && !t.jsx && !t.selector) {
    const sep = content && !content.endsWith("\n") ? "\n" : "";
    const ins = sep + text;
    return { next: content + ins, from: content.length + sep.length, to: content.length + ins.length, located: { start: content.length, end: content.length, method: "end of file" } };
  }
  const loc = locate(content, path, t);
  if (mode === "replace") return { next: content.slice(0, loc.start) + text + content.slice(loc.end), from: loc.start, to: loc.start + text.length, located: loc };
  if (mode === "before") {
    const at = lineStart(content, loc.start);
    const ins = text.endsWith("\n") ? text : `${text}\n`;
    return { next: content.slice(0, at) + ins + content.slice(at), from: at, to: at + ins.length - 1, located: loc };
  }
  // after / append-after-target: on the line after the target
  const at = lineEnd(content, loc.end);
  const ins = text.startsWith("\n") ? text : `\n${text}`;
  return { next: content.slice(0, at) + ins + content.slice(at), from: at + 1, to: at + ins.length, located: loc };
}

/** The region text plus surrounding lines, for context-efficient reads. */
export function readTarget(content: string, path: string, t: EditTarget, ctx = 3): { start: number; end: number; method: string; text: string } {
  const loc = locate(content, path, t);
  const a = lineOf(content, loc.start), b = lineOf(content, loc.end);
  const ls = content.split("\n");
  const s = Math.max(1, a - ctx), e = Math.min(ls.length, b + ctx);
  return { start: s, end: e, method: loc.method, text: ls.slice(s - 1, e).join("\n") };
}
