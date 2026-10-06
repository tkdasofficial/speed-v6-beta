// Static validation of .local files. Returns structured diagnostics with errors and warnings separated.
import { parse } from "acorn";
import { transform } from "sucrase";
import type { FileStore } from "../types/filesystem";
import { analyzeFile } from "./deps";
import { classify } from "./errors";
import type { Diagnostic } from "./types";
import { lineCol } from "./types";

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const d = (x: Omit<Diagnostic, "severity"> & { severity?: Diagnostic["severity"] }): Diagnostic => ({ severity: "error", ...x });

export function validateHtml(file: string, html: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const stack: { tag: string; at: number }[] = [];
  const clean = html.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length)).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, " "));
  const re = /<\/?([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g; let m;
  while ((m = re.exec(clean))) {
    const tag = m[1]!.toLowerCase();
    if (VOID.has(tag) || m[2] === "/") continue;
    if (m[0].startsWith("</")) {
      const i = stack.map((s) => s.tag).lastIndexOf(tag);
      if (i < 0) { const p = lineCol(html, m.index); out.push(d({ type: "html_error", file, ...p, message: `Closing </${tag}> has no matching opening tag`, code: "HTML_UNMATCHED_CLOSE" })); continue; }
      for (const s of stack.splice(i).slice(1)) if (!/^(p|li|td|th|tr|option|dt|dd)$/.test(s.tag)) { const p = lineCol(html, s.at); out.push(d({ severity: "warning", type: "html_error", file, ...p, message: `<${s.tag}> is never closed`, code: "HTML_UNCLOSED" })); }
    } else stack.push({ tag, at: m.index });
  }
  for (const s of stack) if (!/^(html|head|body|p|li|td|th|tr|option|dt|dd)$/.test(s.tag)) { const p = lineCol(html, s.at); out.push(d({ type: "html_error", file, ...p, message: `<${s.tag}> is never closed`, code: "HTML_UNCLOSED" })); }
  if (/index\.html$/i.test(file) && !/<!doctype html>/i.test(html)) out.push(d({ severity: "warning", type: "html_error", file, line: 1, column: 1, message: "Missing <!DOCTYPE html>", code: "HTML_NO_DOCTYPE" }));
  const ids = new Map<string, number>();
  for (const x of clean.matchAll(/\bid=["']([^"']+)["']/gi)) { const n = (ids.get(x[1]!) ?? 0) + 1; ids.set(x[1]!, n); if (n === 2) out.push(d({ severity: "warning", type: "html_error", file, ...lineCol(html, x.index), message: `Duplicate id "${x[1]}"`, code: "HTML_DUPLICATE_ID" })); }
  for (const x of html.matchAll(/<script\b(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/type=["'](?!module|text\/javascript)/i.test(x[1]!)) continue;
    const base = lineCol(html, x.index + x[0].indexOf(">") + 1);
    for (const e of validateJs(file, x[2]!, /type=["']module/i.test(x[1]!))) out.push({ ...e, line: base.line + e.line - 1 });
  }
  return out;
}

export function validateCss(file: string, css: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  if (/\/\*/.test(text)) out.push(d({ type: "css_error", file, ...lineCol(css, text.indexOf("/*")), message: "Unclosed comment", code: "CSS_UNCLOSED_COMMENT" }));
  const opens: number[] = []; let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) { if (c === q && text[i - 1] !== "\\") q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "{") opens.push(i);
    else if (c === "}" && opens.pop() === undefined) out.push(d({ type: "css_error", file, ...lineCol(css, i), message: "Unexpected }", code: "CSS_UNEXPECTED_BRACE" }));
  }
  if (opens.length) out.push(d({ type: "css_error", file, ...lineCol(css, opens[opens.length - 1]!), message: "Missing closing }", code: "CSS_UNCLOSED_BLOCK" }));
  for (const x of text.matchAll(/\{([^{}]*)\}/g)) for (const decl of x[1]!.split(";")) {
    const t = decl.trim();
    if (t && !t.includes(":") && !t.startsWith("@")) out.push(d({ severity: "warning", type: "css_error", file, ...lineCol(css, x.index + x[0].indexOf(t)), message: `Invalid declaration "${t.slice(0, 40)}"`, code: "CSS_INVALID_DECLARATION" }));
  }
  return out;
}

export function validateJs(file: string, code: string, module?: boolean): Diagnostic[] {
  const isModule = module ?? (/\.mjs$/.test(file) || /^\s*(import|export)\s/m.test(code));
  try { parse(code, { ecmaVersion: "latest", sourceType: isModule ? "module" : "script", allowHashBang: true }); return []; }
  catch (e) {
    const err = e as { message: string; loc?: { line: number; column: number } };
    return [d({ type: "syntax_error", file, line: err.loc?.line ?? 1, column: (err.loc?.column ?? 0) + 1, message: err.message.replace(/\s*\(\d+:\d+\)$/, ""), code: "JS_SYNTAX_ERROR" })];
  }
}

/** tsconfig/jsconfig and .vscode files are JSONC: comments and trailing commas are valid there (TypeScript and Vite
 *  accept them), so they are blanked out (keeping positions) before parsing. */
function stripJsonc(t: string): string {
  let out = "", i = 0;
  while (i < t.length) {
    const c = t[i]!;
    if (c === '"') { let j = i + 1; while (j < t.length && t[j] !== '"') { if (t[j] === "\\") j++; j++; } out += t.slice(i, j + 1); i = j + 1; continue; }
    if (c === "/" && t[i + 1] === "/") { const e = t.indexOf("\n", i); const end = e < 0 ? t.length : e; out += " ".repeat(end - i); i = end; continue; }
    if (c === "/" && t[i + 1] === "*") { const e = t.indexOf("*/", i + 2); const end = e < 0 ? t.length : e + 2; out += t.slice(i, end).replace(/[^\n]/g, " "); i = end; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, " $1");
}
export function validateJson(file: string, text0: string): Diagnostic[] {
  const text = /(^|\/)(tsconfig[\w.-]*|jsconfig[\w.-]*)\.json$|(^|\/)\.vscode\//i.test(file) ? stripJsonc(text0) : text0;
  try { JSON.parse(text); return []; }
  catch (e) {
    const pos = Number(/position (\d+)/.exec((e as Error).message)?.[1] ?? 0);
    return [d({ type: "syntax_error", file, ...lineCol(text, pos), message: (e as Error).message, code: "JSON_SYNTAX_ERROR" })];
  }
}

/** Syntax check for .ts/.tsx/.jsx in Vite projects: the build runtime fails the whole build on one syntax error
 *  (e.g. a stray `};`), so catch it before the agent reports success. Types are not checked, only syntax. */
export function validateTsxSyntax(file: string, code: string): Diagnostic[] {
  try {
    const out = transform(code, { transforms: /\.tsx?$/i.test(file) ? ["typescript", "jsx"] : ["jsx"], production: true, filePath: file }).code;
    const ast = parse(out, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true, locations: true });
    return undefinedNames(file, ast as unknown as AstNode);
  } catch (e) {
    const err = e as { message: string; loc?: { line: number; column: number } };
    return [d({ type: "syntax_error", file, line: err.loc?.line ?? 1, column: (err.loc?.column ?? 0) + 1, message: err.message.replace(/\s*\(\d+:\d+\)$/, ""), code: "TS_SYNTAX_ERROR" })];
  }
}

type AstNode = { type: string; [k: string]: unknown; loc?: { start: { line: number; column: number } } };
const JS_GLOBALS = new Set(["React", "undefined", "NaN", "Infinity", "globalThis", "window", "document", "console", "JSON", "Math", "Object", "Array", "String", "Number", "Boolean", "Symbol", "Promise", "Date", "Error", "Map", "Set", "Intl", "URL", "Fragment"]);
/** Names that can never resolve (the browser throws "X is not defined"): bare top-level expression statements and
 *  JSX component tags with no binding anywhere in the module. Every binding in any scope counts, so this never
 *  flags a valid name; it catches leftovers like `export default Home;mememe;` and `<Homeme />`. */
function undefinedNames(file: string, ast: AstNode): Diagnostic[] {
  const bound = new Set<string>();
  const used: { name: string; node: AstNode }[] = [];
  const bind = (n: unknown): void => {
    const x = n as AstNode | null;
    if (!x) return;
    if (x.type === "Identifier") bound.add(x["name"] as string);
    else if (x.type === "ObjectPattern") for (const p of x["properties"] as AstNode[]) bind(p.type === "RestElement" ? p["argument"] : p["value"]);
    else if (x.type === "ArrayPattern") for (const e of x["elements"] as AstNode[]) bind(e);
    else if (x.type === "AssignmentPattern") bind(x["left"]);
    else if (x.type === "RestElement") bind(x["argument"]);
  };
  const walk = (n: unknown, top: boolean): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const c of n) walk(c, top); return; }
    const x = n as AstNode;
    switch (x.type) {
      case "ImportSpecifier": case "ImportDefaultSpecifier": case "ImportNamespaceSpecifier": bind(x["local"]); break;
      case "VariableDeclarator": bind(x["id"]); break;
      case "FunctionDeclaration": case "FunctionExpression": case "ClassDeclaration": case "ClassExpression": bind(x["id"]); break;
      case "CatchClause": bind(x["param"]); break;
      case "ExpressionStatement": if (top && (x["expression"] as AstNode).type === "Identifier") used.push({ name: (x["expression"] as AstNode)["name"] as string, node: x }); break;
      case "CallExpression": {
        const callee = x["callee"] as AstNode, arg = (x["arguments"] as AstNode[])[0];
        const isCreate = (callee.type === "MemberExpression" && (callee["property"] as AstNode)["name"] === "createElement") || (callee.type === "Identifier" && /^_?jsxs?$|^_jsxDEV$/.test(callee["name"] as string));
        if (isCreate && arg?.type === "Identifier" && /^[A-Z]/.test(arg["name"] as string)) used.push({ name: arg["name"] as string, node: arg });
        break;
      }
    }
    if ("params" in x) for (const p of x["params"] as AstNode[]) bind(p);
    for (const k of Object.keys(x)) if (k !== "loc" && typeof x[k] === "object") walk(x[k], top && x.type === "Program" && k === "body");
  };
  walk(ast, true);
  return used.filter((u) => !bound.has(u.name) && !JS_GLOBALS.has(u.name)).slice(0, 5).map((u) => d({ type: "syntax_error", file, line: u.node.loc?.start.line ?? 1, column: (u.node.loc?.start.column ?? 0) + 1, message: `${u.name} is not defined — the page crashes with "ReferenceError: ${u.name} is not defined"`, code: "UNDEFINED_NAME" }));
}

export function validateTs(file: string): Diagnostic[] {
  return [d({ type: "typescript_error", file, line: 1, column: 1, message: "TypeScript can't run in a static site without a build step — use plain .js", code: "TS_NOT_SUPPORTED" })];
}

/** React/Vite projects (package.json depending on vite) are compiled by the build runtime, so TS, npm packages and extensionless imports are allowed. */
export function isViteProject(store: FileStore): boolean {
  const pkg = store.get("package.json");
  if (pkg && pkg.encoding !== "base64" && /"vite"\s*:/.test(pkg.content)) return true;
  if (store.get("vite.config.ts") || store.get("vite.config.js") || store.get("vite.config.mts")) return true;
  const html = store.get("index.html");
  return !!html && html.encoding !== "base64" && /<script[^>]+src=["'][^"']+\.tsx?["']/i.test(html.content);
}

const VITE_EXT = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

export function validateReferences(store: FileStore, files?: string[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const vite = isViteProject(store);
  for (const f of files ?? store.list().map((x) => x.path)) for (const r of analyzeFile(store, f).refs) {
    if (r.external || r.exists) continue;
    if (vite && r.bare) continue;
    if (vite && r.kind === "module" && VITE_EXT.some((e) => store.get(r.target.replace(/\.(m?js|jsx)$/, "") + e))) continue;
    const bare = !!r.bare;
    const type = bare ? "missing_module" : r.kind === "module" ? "broken_import" : r.kind === "asset" || r.kind === "css-url" ? "missing_asset" : r.kind === "link" ? "broken_reference" : "missing_file";
    out.push(d({ severity: r.kind === "link" ? "warning" : "error", type, file: f, line: r.line, column: 1, message: bare ? `"${r.ref}" is an npm package — packages can't load in a static site` : `${r.ref} not found (looked for ${r.target})`, code: `REF_${type.toUpperCase()}`, related: [r.target] }));
  }
  return out;
}

export function validatePaths(store: FileStore): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const f of store.list()) {
    if (/[\s#?%]/.test(f.path)) out.push(d({ severity: "warning", type: "invalid_path", file: f.path, line: 1, column: 1, message: "File name contains spaces or URL-special characters", code: "PATH_UNSAFE_CHARS" }));
    if (f.path.startsWith(".output/")) out.push(d({ type: "invalid_path", file: f.path, line: 1, column: 1, message: ".output is generated — source files belong in .local", code: "PATH_OUTPUT_IN_SOURCE" }));
  }
  return out;
}

export function validateFile(store: FileStore, file: string): Diagnostic[] {
  const f = store.get(file);
  if (!f) return [d({ type: "missing_file", file, line: 1, column: 1, message: `No such file: ${file}`, code: "FILE_NOT_FOUND" })];
  if (f.encoding === "base64") return [];
  if (/\.html?$/i.test(file)) return validateHtml(file, f.content);
  if (/\.css$/i.test(file)) return validateCss(file, f.content);
  if (/\.m?js$/i.test(file)) return validateJs(file, f.content);
  if (/\.(json|webmanifest)$/i.test(file)) return validateJson(file, f.content);
  if (/\.tsx?$/i.test(file)) return []; // checked project-wide: allowed only in React/Vite projects
  return [];
}

function exportsOf(code: string): { def: boolean; names: Set<string>; star: boolean } {
  const names = new Set<string>();
  for (const m of code.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|type|interface|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]!);
  for (const m of code.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) for (const p of m[1]!.split(",")) { const n = p.trim().split(/\s+as\s+/).pop()?.replace(/^type\s+/, "").trim(); if (n) names.add(n); }
  return { def: /export\s+default\b/.test(code) || names.has("default"), names, star: /export\s+\*\s+from/.test(code) };
}

/** Vite/Rollup fails the whole build when an import asks for an export the file doesn't have
 *  (e.g. `import Header from './Header'` while Header.tsx only has `export function Header`). Catch it before the build. */
export function validateViteExports(store: FileStore): Diagnostic[] {
  const out: Diagnostic[] = [];
  const src = store.list().filter((f) => /\.(tsx?|jsx?|mjs)$/.test(f.path) && !/\.d\.ts$/.test(f.path) && f.encoding !== "base64");
  for (const f of src) {
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    for (const m of f.content.matchAll(/import\s+(?!type\s)([^;"']*?)\s+from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      const clause = m[1]!.trim(), ref = m[2]!;
      const parts: string[] = [];
      for (const seg of (dir ? dir + "/" + ref : ref).split("/")) { if (seg === "..") parts.pop(); else if (seg !== "." && seg) parts.push(seg); }
      const base = parts.join("/").replace(/\.(m?js|jsx)$/, "");
      const target = VITE_EXT.map((e) => store.get(base + e)).find((t) => t && /\.(tsx?|jsx?|mjs)$/.test(t.path));
      if (!target || target.encoding === "base64") continue;
      const ex = exportsOf(target.content);
      const line = f.content.slice(0, m.index).split("\n").length;
      const fail = (message: string) => out.push(d({ type: "broken_import", file: f.path, line, column: 1, message, code: "IMPORT_MISSING_EXPORT", related: [target.path] }));
      const def = clause.match(/^([A-Za-z_$][\w$]*)\s*(,|$)/);
      if (def && !ex.def) fail(`"default" is not exported by ${target.path} — use \`import { ${def[1]} } from '${ref}'\` or add \`export default ${def[1]}\` there`);
      const named = clause.match(/\{([^}]*)\}/);
      if (named && !ex.star) for (const p of named[1]!.split(",")) {
        const n = p.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();
        if (!n || p.trim().startsWith("type ")) continue;
        if (n === "default" ? !ex.def : !ex.names.has(n)) fail(`"${n}" is not exported by ${target.path}`);
      }
    }
  }
  return out;
}

/** Vite resolves every relative import (including side-effect `import "./x.css"`) at build time; one missing file
 *  fails the whole build. The reference scan didn't cover side-effect imports in .tsx, so check them all here. */
export function validateViteImports(store: FileStore): Diagnostic[] {
  const out: Diagnostic[] = [];
  const src = store.list().filter((f) => /\.(tsx?|jsx?|mjs)$/.test(f.path) && !/\.d\.ts$/.test(f.path) && f.encoding !== "base64");
  for (const f of src) {
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    const code = f.content.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const m of code.matchAll(/(?:^|[;\n])\s*(?:import\s+(?:[^;"']*?\s+from\s+)?|export\s+[^;"']*?\s+from\s+)["'](\.{1,2}\/[^"'?#]+)["']/g)) {
      const ref = m[1]!;
      const parts: string[] = []; let escaped = false;
      for (const seg of (dir ? dir + "/" + ref : ref).split("/")) { if (seg === "..") { if (!parts.length) escaped = true; parts.pop(); } else if (seg !== "." && seg) parts.push(seg); }
      const base = parts.join("/");
      const found = !escaped && (store.get(base) || VITE_EXT.some((e) => store.get(base.replace(/\.(m?js|jsx)$/, "") + e)));
      if (found) continue;
      const line = code.slice(0, m.index).split("\n").length;
      const name = base.split("/").pop() ?? ref;
      const near = store.list().find((x) => x.path.endsWith("/" + name) || x.path === name)?.path;
      out.push(d({ type: "broken_import", file: f.path, line, column: 1, message: `Could not resolve "${ref}" from ${f.path}${escaped ? " (the path goes above the project root)" : ""}${near ? ` — the file is at ${near}` : ""}`, code: "IMPORT_NOT_FOUND", related: near ? [near] : [] }));
    }
  }
  return out;
}

/** Whole-project validation: syntax per file, paths, references, entry point. Enriched with cause/context. */
export function validateProject(store: FileStore): { errors: Diagnostic[]; warnings: Diagnostic[] } {
  const all: Diagnostic[] = [];
  if (!store.get("index.html")) all.push(d({ type: store.get("package.json") ? "build_configuration_error" : "missing_file", file: "index.html", line: 1, column: 1, message: store.get("package.json") ? "This project needs a build runtime (package.json, no index.html) — build runtimes aren't connected" : "No index.html at the project root", code: "BUILD_NO_ENTRY" }));
  const vite = isViteProject(store);
  for (const f of store.list()) {
    const tsx = /\.(tsx?|jsx)$/i.test(f.path) && !/\.d\.ts$/i.test(f.path) && f.encoding !== "base64";
    all.push(...validateFile(store, f.path), ...(tsx && !vite && !/\.jsx$/i.test(f.path) ? validateTs(f.path) : []), ...(tsx && vite ? validateTsxSyntax(f.path, f.content) : []));
  }
  all.push(...validatePaths(store), ...validateReferences(store), ...(vite ? [...validateViteExports(store), ...validateViteImports(store)] : []));
  const enriched = all.map((x) => classify(store, x));
  return { errors: enriched.filter((x) => x.severity === "error"), warnings: enriched.filter((x) => x.severity === "warning") };
}

const ROOT_SRC_OK = /^src\/(main|App|vite-env\.d)\.(tsx?|jsx?)$/;
/** React+Vite project convention, checked only on files the current task CREATED (existing projects are never
 *  reorganized): pages at src/pages/<name>/index.tsx, one shared stylesheet at src/styles/index.css. */
export function structureIssues(store: FileStore, created: readonly string[]): string[] {
  if (!isViteProject(store)) return [];
  const out: string[] = [];
  const existingCss = store.list().some((f) => f.path === "src/styles/index.css");
  for (const p of created) {
    if (!store.get(p)) continue;
    if (/^src\/.*\.(css|scss)$/i.test(p) && p !== "src/styles/index.css")
      out.push(`${p}: use the single shared stylesheet src/styles/index.css${existingCss ? " (it exists — move these rules there)" : ""} instead of a separate CSS file`);
    else if (/^src\/pages\/[^/]+\.(tsx|jsx)$/i.test(p)) {
      const name = p.slice(10).replace(/\.(tsx|jsx)$/i, "").replace(/Page$/, "").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
      out.push(`${p}: pages live in their own folder — use src/pages/${name}/index.tsx`);
    } else if (/^src\/pages\/[^/]+\/(?!index\.)[^/]+\.(tsx|jsx)$/i.test(p) && !store.get(p.replace(/[^/]+$/, "index.tsx")))
      out.push(`${p}: the page file must be named index.tsx (${p.replace(/[^/]+$/, "index.tsx")})`);
    else if (/^src\/[^/]+\.(tsx|jsx)$/i.test(p) && !ROOT_SRC_OK.test(p))
      out.push(`${p}: don't put pages/components directly in src/ — pages go in src/pages/<name>/index.tsx, components in src/components/`);
  }
  if (created.includes("src/main.tsx") && !store.get("src/styles/index.css")) out.push("src/styles/index.css is missing: create the shared stylesheet and import it once in src/main.tsx (import \"./styles/index.css\")");
  // A wrong-path file whose correct twin already exists is a leftover duplicate: say so explicitly.
  return out.map((m) => { const p = m.slice(0, m.indexOf(":")); const ok = conventionalPath(p); return ok !== p && store.get(ok) ? `${p}: duplicate of ${ok} — update imports to ${ok} and delete ${p}` : m; });
}

/** Maps a NEW file path to the React+Vite convention (pages in folders, one shared stylesheet). Pure; never applied to existing files. */
export function conventionalPath(p: string): string {
  if (/^src\/(styles|index|App|global|main)\.(css|scss)$/i.test(p)) return "src/styles/index.css";
  const m = /^src\/(?:pages\/)?([A-Z][A-Za-z0-9]*?)Page\.(tsx|jsx)$/.exec(p) ?? /^src\/pages\/([A-Za-z][A-Za-z0-9]*)\.(tsx|jsx)$/.exec(p);
  if (m) return `src/pages/${m[1]!.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}/index.${m[2]}`;
  return p;
}
