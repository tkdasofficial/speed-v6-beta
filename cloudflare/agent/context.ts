// Structured Agent context: only the files relevant to the task, plus stage/actions/results. Pure.
import type { SubTask } from "./grouping";

export interface FileLike { path: string; content: string; encoding?: string }
export interface AgentContext {
  request: string;
  project: { id: string; name: string; fileCount: number };
  tasks: SubTask[];
  stage: string;
  relevantFiles: { path: string; score: number; snippet: string }[];
  completedActions: string[];
  pendingActions: string[];
  build: string | null;
  verification: string | null;
  previousMessages: string[];
  checkpoint: Record<string, unknown> | null;
}

const TEXT = /\.(html?|css|scss|jsx?|tsx?|mjs|json|md|txt|svg|vue)$/i;
const STOP = new Set(["the", "and", "a", "an", "to", "of", "in", "on", "for", "with", "change", "update", "modify", "make", "set", "add", "text", "primary", "new", "it", "my"]);
const words = (t: string) => [...new Set(t.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])].filter((w) => !STOP.has(w));

/** Scores files by path hints and content keywords; never returns the whole project. */
export function selectRelevantFiles(files: FileLike[], tasks: SubTask[], limit = 8): { path: string; score: number }[] {
  const hints = tasks.flatMap((t) => t.hints);
  const kw = words(tasks.map((t) => t.text).join(" "));
  const scored = files.filter((f) => (f.encoding ?? "utf8") === "utf8" && TEXT.test(f.path) && f.content.length < 200_000 && !/(^|\/)(node_modules|dist|\.output)\//.test(f.path))
    .map((f) => {
      const p = f.path.toLowerCase(); const c = f.content.toLowerCase();
      let s = 0;
      for (const h of hints) if (p.includes(h)) s += 5;
      for (const w of kw) { if (p.includes(w)) s += 3; if (c.includes(w)) s += 1; }
      if (/(^|\/)(index\.html|app\.[jt]sx?|main\.[jt]sx?)$/.test(p)) s += 1;
      return { path: f.path, score: s };
    })
    .filter((x) => x.score > 1)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit);
}

export function buildContext(i: { request: string; projectId: string; projectName: string; files: FileLike[]; tasks: SubTask[]; stage: string; completed?: string[]; pending?: string[]; build?: string | null; verification?: string | null; previous?: string[]; checkpoint?: Record<string, unknown> | null; snippetBudget?: number }): AgentContext {
  const picked = selectRelevantFiles(i.files, i.tasks);
  let budget = i.snippetBudget ?? 16_000;
  const relevantFiles = picked.map((p) => {
    const f = i.files.find((x) => x.path === p.path)!;
    const snippet = budget > 0 ? f.content.slice(0, Math.min(4000, budget)) : "";
    budget -= snippet.length;
    return { ...p, snippet };
  });
  return {
    request: i.request, project: { id: i.projectId, name: i.projectName, fileCount: i.files.length }, tasks: i.tasks, stage: i.stage, relevantFiles,
    completedActions: i.completed ?? [], pendingActions: i.pending ?? [], build: i.build ?? null, verification: i.verification ?? null,
    previousMessages: (i.previous ?? []).slice(-6), checkpoint: i.checkpoint ?? null,
  };
}

export function contextSnippets(c: AgentContext): string {
  return c.relevantFiles.filter((f) => f.snippet).map((f) => `--- ${f.path}\n${f.snippet}`).join("\n");
}

/** The project's existing design tokens (CSS custom properties + font families) from its stylesheets, so new UI
 *  reuses them instead of inventing a new design system. Empty when the project has none. */
export function designTokens(files: FileLike[], max = 900): string {
  const css = files.filter((f) => /\.css$/i.test(f.path) && !/(node_modules|\.output|dist)\//.test(f.path))
    .sort((a, b) => Number(/(^|\/)(styles\/)?(index|global|globals|style|styles|main)\.css$/i.test(b.path)) - Number(/(^|\/)(styles\/)?(index|global|globals|style|styles|main)\.css$/i.test(a.path)));
  if (!css.length) return "";
  const vars = new Map<string, string>(); const fonts = new Set<string>(); const media = new Set<string>();
  for (const f of css) {
    for (const m of f.content.matchAll(/(--[\w-]+)\s*:\s*([^;}{]+)/g)) if (!vars.has(m[1]!)) vars.set(m[1]!, m[2]!.trim().slice(0, 40));
    for (const m of f.content.matchAll(/font-family\s*:\s*([^;}{]+)/g)) fonts.add(m[1]!.trim().slice(0, 60));
    for (const m of f.content.matchAll(/@media\s*([^{]+)\{/g)) media.add(m[1]!.trim().slice(0, 50));
  }
  const parts = [`stylesheets: ${css.map((f) => f.path).slice(0, 4).join(", ")}`];
  if (vars.size) parts.push(`tokens: ${[...vars].slice(0, 30).map(([k, v]) => `${k}: ${v}`).join("; ")}`);
  if (fonts.size) parts.push(`fonts: ${[...fonts].slice(0, 3).join(" | ")}`);
  if (media.size) parts.push(`breakpoints: ${[...media].slice(0, 5).join(" | ")}`);
  return `(automatic, existing design system — reuse it) ${parts.join(". ")}`.slice(0, max);
}

/** Impact analysis for changed files: who uses them and what they use. Check-only — nothing here asks for edits. */
export function impactNote(changed: string[], related: (file: string) => { uses: string[]; usedBy: string[] }, max = 1200): string {
  const lines: string[] = [];
  for (const f of changed.filter((p) => /\.(tsx?|jsx?|mjs|html?|css)$/i.test(p)).slice(0, 6)) {
    const r = related(f);
    if (!r.usedBy.length && !r.uses.length) continue;
    lines.push(`${f} — used by: ${r.usedBy.slice(0, 6).join(", ") || "nothing"}; uses: ${r.uses.slice(0, 6).join(", ") || "nothing"}`);
  }
  return lines.length ? `(automatic impact check — verify these still connect correctly; modify them ONLY if a real problem is found)\n${lines.join("\n")}`.slice(0, max) : "";
}
