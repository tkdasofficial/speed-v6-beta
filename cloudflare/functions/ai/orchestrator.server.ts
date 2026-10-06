// AI orchestration: maps logical modes (speed/flash/heavy × quick/balanced/deep) to the configured model chains.
import { conventionalPath } from "../../../sandbox/intelligence/validate";
// Server-only. Model IDs, routing rules and provider keys never leave the Worker. Models are configured in ./models.ts.
import { envStr } from "../context";
import { chainFor, isNemotron, MAX_OUTPUT_TOKENS, PROVIDERS, type ModelTarget } from "./models";

export type AiModel = "speed" | "flash" | "heavy";
export type AiDepth = "quick" | "balanced" | "deep";
type Msg = { role: "system" | "user" | "assistant"; content: string };

const SPECIALIST: Record<"omni" | "safety", ModelTarget> = {
  omni: { provider: "nvidia", id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning" },
  safety: { provider: "nvidia", id: "nvidia/nemotron-3.5-content-safety" },
};

// Depth changes real orchestration: context window, reasoning, output budget, planning and a verification pass.
const DEPTH: Record<AiDepth, { history: number; maxTokens: number; think: boolean; verify: boolean; guide: string }> = {
  quick: { history: 6, maxTokens: MAX_OUTPUT_TOKENS, think: false, verify: false, guide: "Answer directly and concisely. Skip planning unless essential." },
  balanced: { history: 16, maxTokens: MAX_OUTPUT_TOKENS, think: true, verify: false, guide: "Briefly plan, then answer. Check your work where it matters." },
  deep: { history: 30, maxTokens: MAX_OUTPUT_TOKENS, think: true, verify: true, guide: "Plan thoroughly step by step, consider edge cases, then give a complete, carefully verified answer." },
};

export class AiError extends Error {
  /** Per-model failure reasons (internal; recorded on the task event, never shown as provider IDs in the UI). */
  failed: { model: string; reason: string }[] = [];
}
/** A real provider failure (rate limit, timeout, 5xx, outage, connection, bad response): the chain moves to the next model. */
class ProviderError extends Error {}

// A hung provider must surface as an error, never an endless "Thinking…".
const FIRST_BYTE_MS = 170_000, IDLE_MS = 30_000;

type CallOpts = { maxTokens: number; think: boolean; firstByteMs?: number; json?: boolean };

/** Provider-specific request shaping (reasoning flags differ per provider). JSON mode only where the provider supports it. */
function body(t: ModelTarget, messages: Msg[], o0: CallOpts) {
  const o = { ...o0, maxTokens: Math.min(o0.maxTokens, PROVIDERS[t.provider].maxOut) };
  const json = o.json ? { response_format: { type: "json_object" } } : {};
  if (isNemotron(t)) {
    const msgs = messages.map((m, i) => (i === 0 && m.role === "system" ? { ...m, content: `${m.content} ${o.think ? "/think" : "/no_think"}` } : m));
    return { model: t.id, messages: msgs, max_tokens: o.maxTokens, stream: true, chat_template_kwargs: { enable_thinking: o.think }, ...(o.think ? {} : { temperature: 0.3 }) };
  }
  if (t.provider === "groq") return { model: t.id, messages, max_tokens: o.maxTokens, stream: true, reasoning_effort: o.think ? "medium" : "low", ...json };
  return { model: t.id, messages, max_tokens: o.maxTokens, stream: true, ...json };
}

type CallResult = { text: string; finish: string };

// Providers that just refused (bad key / rate limit) are skipped for a while instead of being hit on every call.
const cooldown = new Map<string, number>();
/** Test hook: forget refusals. */
export const resetAiCooldowns = () => cooldown.clear();
const cooling = (t: ModelTarget) => (cooldown.get(t.provider) ?? 0) > Date.now();

async function callRaw(t: ModelTarget, messages: Msg[], opts: CallOpts): Promise<CallResult> {
  if (cooling(t)) throw new ProviderError(`${t.provider} skipped (cooling down after a recent refusal)`);
  const key = envStr(PROVIDERS[t.provider].secret);
  if (!key) throw new ProviderError(`${t.provider} is not configured`);
  const ctl = new AbortController();
  let timer = setTimeout(() => ctl.abort(), opts.firstByteMs ?? FIRST_BYTE_MS);
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), IDLE_MS); };
  let res: Response;
  try {
    res = await fetch(PROVIDERS[t.provider].url, {
      signal: ctl.signal,
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body(t, messages, opts)),
    });
  } catch {
    clearTimeout(timer);
    throw new ProviderError(ctl.signal.aborted ? "timeout" : "connection failed");
  }
  if (!res.ok) {
    clearTimeout(timer);
    if (res.status === 401 || res.status === 403) cooldown.set(t.provider, Date.now() + 10 * 60_000);
    else if (res.status === 429) cooldown.set(t.provider, Date.now() + Math.min(120, Number(res.headers.get("retry-after")) || 30) * 1000);
    const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    throw new ProviderError(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  // Streamed server-side so long generations never hit idle timeouts; only final text is kept.
  let out = "", buf = "", finish = "", streamErr = "";
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  for (;;) {
    bump();
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try { chunk = await reader.read(); } catch { clearTimeout(timer); throw new ProviderError("timeout"); }
    const { done, value } = chunk;
    if (done) { clearTimeout(timer); break; }
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) {
      const s = l.trim();
      if (!s.startsWith("data:") || s === "data: [DONE]") continue;
      try {
        const j = JSON.parse(s.slice(5)) as { error?: { message?: string; code?: string } | string; choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[] };
        // Providers (Groq) report mid-stream failures as an error frame; without this they looked like "empty response".
        if (j.error) streamErr = typeof j.error === "string" ? j.error : `${j.error.code ? `${j.error.code}: ` : ""}${j.error.message ?? "stream error"}`;
        const c = j.choices?.[0];
        out += c?.delta?.content ?? "";
        if (c?.finish_reason) finish = c.finish_reason;
      } catch { /* partial */ }
    }
  }
  const text = out.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!text && streamErr) throw new ProviderError(`stream error: ${streamErr.replace(/\s+/g, " ").slice(0, 200)}`);
  return { text, finish };
}

async function call(t: ModelTarget, messages: Msg[], opts: CallOpts) {
  return (await callRaw(t, messages, opts)).text;
}

export type ChainResult<T> = { value: T; text: string; used: ModelTarget; failed: { model: string; reason: string }[] };

const NOT_JSON = "That reply was not the required JSON object. Reply again with ONLY the JSON object {\"message\",\"actions\",\"done\"} (or the plan JSON you were asked for) — no prose before or after it.";
const CUT_OFF = "Your previous reply was cut off before the JSON ended. Reply again with the complete JSON object only, using at most 3 actions and keeping each file short (split big files across turns).";

/**
 * Runs the role's chain: primary, then the common fallbacks in order. Moves on only on a real provider failure
 * or a response `accept` rejects; never loops back. A reply cut off at the output limit gets one shorter retry
 * on the same model first. All failing → one clear AiError with per-model reasons.
 */
async function callChain<T>(chain: ModelTarget[], messages: Msg[], opts: CallOpts, accept: (text: string) => T | null): Promise<ChainResult<T>> {
  const failed: { model: string; reason: string }[] = [];
  for (const t of chain) {
    try {
      let r = await callRaw(t, messages, opts);
      let value = r.text ? accept(r.text) : null;
      if (value === null && r.finish === "length") {
        console.warn(`[ai] ${t.provider}/${t.id} hit the output limit (${r.text.length} chars); retrying shorter`);
        r = await callRaw(t, [...messages, { role: "user", content: CUT_OFF }], opts);
        value = r.text ? accept(r.text) : null;
      } else if (value === null && r.text && opts.json) {
        // A complete reply in prose (no JSON) gets one reminder on the same model before falling back.
        console.warn(`[ai] ${t.provider}/${t.id} replied without JSON (${r.text.length} chars); asking again for JSON`);
        r = await callRaw(t, [...messages, { role: "assistant", content: r.text.slice(0, 2000) }, { role: "user", content: NOT_JSON }], opts);
        value = r.text ? accept(r.text) : null;
      }
      if (value === null) {
        const why = !r.text ? "empty response" : r.finish === "length" ? "reply cut off at output limit" : "reply was not valid JSON";
        throw new ProviderError(`${why} (finish=${r.finish || "none"}, ${r.text.length} chars, start=${JSON.stringify(r.text.slice(0, 80))}, end=${JSON.stringify(r.text.slice(-80))})`);
      }
      if (failed.length) console.warn(`[ai] fell back to ${t.provider}/${t.id} after: ${failed.map((f) => `${f.model} (${f.reason})`).join(", ")}`);
      return { value, text: r.text, used: t, failed };
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      console.error(`[ai] ${t.provider}/${t.id} failed: ${e.message}`);
      failed.push({ model: `${t.provider}/${t.id}`, reason: e.message.slice(0, 400) });
    }
  }
  console.error(`[ai] all models failed: ${failed.map((f) => `${f.model} (${f.reason})`).join(", ")}`);
  const err = new AiError("All AI models are unavailable right now. Try again in a moment.");
  err.failed = failed;
  throw err;
}

const usedLabel = (t: ModelTarget) => `${t.provider}/${t.id}`;

/** Content-safety specialist; returns false only when the input is clearly flagged unsafe. Fails open on specialist errors. */
async function isSafe(text: string) {
  try {
    const out = await call(SPECIALIST.safety, [{ role: "user", content: text.slice(0, 4000) }], { maxTokens: 64, think: false, firstByteMs: 10_000 });
    return !/"?user safety"?\s*:\s*"?unsafe/i.test(out);
  } catch (e) {
    console.error("[ai] safety specialist failed:", (e as Error).message);
    return true;
  }
}

const PLAN_RULES = " PLAN MODE IS ON: only discuss and plan. Do not build, write code files, create, edit or delete files, or claim any change was made. Reply with a clear plan: goal, approach, steps, files likely affected, and open questions. End by telling the user to turn Plan off when they want it built.";

const hasMedia = (t: string) => /https?:\/\/\S+\.(png|jpe?g|gif|webp|mp4|mov|wav|mp3)(\?\S*)?/i.test(t);
const nonEmpty = (t: string) => (t ? t : null);

export async function runAgent(input: { model: AiModel; depth: AiDepth; plan?: boolean; history: Msg[]; projectName: string }) {
  const d = DEPTH[input.depth];
  const last = input.history[input.history.length - 1]?.content ?? "";
  const safe = isSafe(last);
  // Multimodal input is tried on the omni specialist first; the role's chain still backs it up.
  const chain = hasMedia(last) ? [SPECIALIST.omni, ...chainFor(input.model)] : chainFor(input.model);
  const system = `You are Speed, an AI software agent helping build the project "${input.projectName}". ${d.guide}${input.plan ? PLAN_RULES : ""}`;
  const messages: Msg[] = [{ role: "system", content: system }, ...input.history.slice(-d.history)];
  const opts = { maxTokens: d.maxTokens, think: d.think };
  const [first, ok] = await Promise.all([callChain(chain, messages, opts, nonEmpty), safe]);
  if (!ok) return "I can't help with that request.";
  let answer = first.value;
  if (d.verify) {
    // The verification pass stays on the model that answered; it never switches providers after success.
    const reviewed = await call(first.used, [
      ...messages,
      { role: "assistant", content: answer },
      { role: "user", content: "Review your answer above for errors, gaps or missed requirements. Reply with only the final corrected answer (or the same answer if it is already correct)." },
    ], opts).catch(() => "");
    if (reviewed) answer = reviewed;
  }
  return answer.slice(0, 20000);
}

/** The Agent's single final-summary call: polishes the structured, already-verified run result. Facts come only from `result`. */
export async function finalSummary(input: { model: AiModel; result: Record<string, unknown> }) {
  const t0 = Date.now();
  const messages: Msg[] = [
    { role: "system", content: "You are Speed, an AI software agent. Write the final message to the user about a finished task. Use ONLY the facts in the JSON you receive; never invent files, features or results. Plain, friendly language for a non-technical reader. 3–8 short lines: one opening sentence on what is done, then a short bullet list of what changed, then the check result. No code blocks." },
    { role: "user", content: JSON.stringify(input.result).slice(0, 12000) },
  ];
  const r = await callChain(chainFor(input.model), messages, { maxTokens: 1500, think: false, firstByteMs: 60_000 }, nonEmpty);
  return { text: r.value.trim().slice(0, 6000), provider: r.used.provider, model: r.used.id, latencyMs: Date.now() - t0, fallbacks: r.failed };
}

// ---- Agent loop: message → actions → message … ----
export type AgentActionKind = "read" | "create" | "edit" | "delete" | "think" | "check" | "tool";
export type AgentStepAction = { kind: AgentActionKind; path?: string; content?: string; find?: string; replace?: string; target?: Record<string, unknown>; note?: string; name?: string; args?: Record<string, unknown> };
const KINDS: AgentActionKind[] = ["read", "create", "edit", "delete", "think", "check", "tool"];
/** Internal tools that change files or build; stripped in plan mode. */
const WRITE_TOOLS = new Set(["create_file", "edit_file", "patch_file", "delete_file", "rename_file", "move_file", "rollback_change", "build_project", "build_static"]);
const WRITE_KINDS: AgentActionKind[] = ["create", "edit", "delete", "check"];

const TARGET_KEYS = ["lines", "expect", "symbol", "jsx", "selector", "media", "contains", "occurrence", "mode", "all"] as const;
function pickTarget(x: Record<string, unknown>): { target?: Record<string, unknown> } {
  const t: Record<string, unknown> = {};
  for (const k of TARGET_KEYS) if (x[k] !== undefined && x[k] !== null) t[k] = x[k];
  return Object.keys(t).length ? { target: t } : {};
}
const LOOP_RULES = (tools: string) => `You are a codebase editing agent working in a loop. Each turn reply with ONLY one JSON object, no prose:
{"message": "1-3 short sentences to the user: what you found/did and what's next", "actions": [...], "done": false}
Actions run on the project's real files through the tool orchestrator; structured results (success, error code, nextRecommendedAction) come back to you next turn.
Shorthands: {"kind":"read","path"}, {"kind":"create","path","content"}, {"kind":"edit","path","find","replace"} — or target one region instead of find: "lines":{"start","end"}+"expect" (the text you read there), "symbol" (function/component/const/Class.method), "jsx" ("section.hero"), "selector" (+"media") for one CSS rule; "contains"/"occurrence" pick among duplicates; "mode":"before"|"after"|"append" inserts instead of replacing (append builds a large file in chunks). Only the target changes; never rewrite a whole file for a small change ("content" = full rewrite, new/tiny files only), {"kind":"delete","path"}, {"kind":"check"} (validates the project), {"kind":"think","note"}.
Any other tool: {"kind":"tool","name":"<tool>","args":{...}}. Tools for this phase (args with ? are optional; ! = destructive):
${tools}
Need a capability not listed? Call find_tools{capability:"..."} — the orchestrator returns the right tool.`;
const RULES = `RULES:
1. Never guess a file location when the codebase can be searched. Search before editing; read the relevant lines before modifying.
2. Paths are project-relative. Generated output (.output, node_modules) and secret files are protected — never edit them.
3. Make the smallest possible change: touch only the files needed, preserve unrelated code, styles and behaviour; no refactors or renames unless required. CSS-only requests change only CSS.
4. If HTML and JS/CSS must change together, confirm the relationship (selectors, ids, imports) first.
5. Validate before building when possible; always read the actual errors. Fix the root cause with a targeted edit on the reported file/line — never regenerate the whole project for a localized error.
6. Each repair must be based on the latest real error. When a result says "same failure repeated", stop retrying, call diagnose_failure and change strategy.
7. Files you change are validated automatically at the end of the turn if you didn't run {"kind":"check"}; you only see that result next turn.
8. Two project types. Static site (default): index.html at the root, relative paths, plain HTML/CSS/JS (ES modules via relative .js imports or full CDN URLs), no npm. React + Vite (when the user asks for React/TypeScript/Vite or package.json already lists vite): keep real React + TypeScript with package.json (react, react-dom, vite, @vitejs/plugin-react, typescript), vite.config.ts, tsconfig.json, root index.html loading /src/main.tsx and .tsx files under src/; create package.json and vite.config.ts first; npm imports are fine — a separate build runtime compiles it after your turn. Never convert a React/TypeScript request into a CDN or plain-JS site.
9. New project? Create the files directly (still keep them small and linked correctly), then build.
10. New React + Vite project structure: src/main.tsx, src/App.tsx, src/pages/<name>/index.tsx (one folder per page, e.g. pages/home, pages/landing), src/components/<Name>.tsx, ONE shared stylesheet src/styles/index.css (imported once in main.tsx), and src/assets, src/hooks, src/utils, src/types only when actually needed. No duplicate components, no per-component CSS files unless asked. NEVER create src/styles.css, src/index.css, src/App.css or a page file directly in src/ or src/pages/ (src/pages/About.tsx is wrong; src/pages/about/index.tsx is right) — an automatic structure check refuses to finish until created files follow this. Applies to every NEW page in an existing project too; never reorganize existing files. Every npm package you import must be in package.json. Prefer plain CSS in src/styles/index.css; use Tailwind only with the full setup (tailwindcss@^3.4 + postcss + autoprefixer, tailwind.config.js, postcss.config.js). Mount exactly one router from src/main.tsx.
11. Before editing, know exactly what must change, which file/component/function/rule is responsible, and what uses it. After changing a shared file, review the automatic impact check: check the listed users/imports, but leave them untouched when they are already correct.
12. Reuse the project's existing design (colors, CSS variables, fonts, spacing, radius, shadows, buttons, cards, layout). Edit existing CSS rules in the shared stylesheet instead of adding new files. For UI changes, consider desktop, tablet and mobile; inspect the matching @media rules and fix only what is necessary.
13. Group small related edits (same section) in one turn; keep unrelated or risky changes in separate turns. If an edit fails, the next turn uses the current file text shown in the results — never resend the same failed edit.
At most 4 actions per turn, and at most 2 new or rewritten files per turn; keep every file focused (under ~150 lines) and prefer small find/replace edits over full rewrites. Read only the files you need. When the work is complete and the last build passed, reply with "actions": [] and "done": true, and a short final summary of what the user can try in the preview.
If the user only asked a question, answer in "message" with "done": true. Keep messages concise; tool details stay internal.`;
const PLAN_LOOP = " PLAN MODE IS ON: only use read/search/inspect/understand/validate tools and think, never edit, create, delete or build. When you have a plan, put it in message and set done true.";

/** The first complete top-level JSON object in `t` (string-aware brace matching), or null. Models sometimes emit
 *  several step objects back to back; the first one is the step for this turn. */
export function firstJsonObject(t: string): string | null {
  const a = t.indexOf("{");
  if (a < 0) return null;
  let depth = 0, str = false, esc = false;
  for (let i = a; i < t.length; i++) {
    const c = t[i]!;
    if (str) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') str = false; continue; }
    if (c === '"') str = true; else if (c === "{") depth++; else if (c === "}" && --depth === 0) return t.slice(a, i + 1);
  }
  return null;
}

function parseStep(text: string): { message: string; actions: AgentStepAction[]; done: boolean } | null {
  const t = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    let raw: unknown;
    try { raw = JSON.parse(t.slice(a, b + 1)); } catch { const first = firstJsonObject(t); if (!first) throw new Error("no JSON"); raw = JSON.parse(first); }
    const o = raw as { message?: unknown; actions?: unknown; done?: unknown };
    const message = typeof o.message === "string" ? o.message.trim() : "";
    // Models often name the tool directly ({"kind":"create_file"} / {"tool":"x"} / {"type":"x"}); normalize to the contract.
    const norm = (raw: unknown): unknown => {
      if (!raw || typeof raw !== "object") return raw;
      const x = { ...(raw as Record<string, unknown>) };
      const k = (x["kind"] ?? x["type"] ?? x["action"]) as string | undefined;
      const tool = (x["tool"] ?? x["name"]) as string | undefined;
      if (typeof k === "string" && KINDS.includes(k as AgentActionKind)) return { ...x, kind: k };
      const name = typeof k === "string" && /_/.test(k) ? k : typeof tool === "string" ? tool : undefined;
      if (!name) return x;
      const { kind: _k, type: _t, action: _a, tool: _o, name: _n, args, ...rest } = x;
      return { kind: "tool", name, args: args && typeof args === "object" ? args : rest };
    };
    const actions = (Array.isArray(o.actions) ? o.actions.map(norm) : []).filter((x): x is AgentStepAction => !!x && typeof x === "object" && KINDS.includes((x as AgentStepAction).kind)).slice(0, 12)
      .map((x) => ({ kind: x.kind, ...(typeof x.path === "string" ? { path: x.path.slice(0, 400) } : {}), ...(typeof x.content === "string" ? { content: x.content.slice(0, 200000) } : {}), ...(typeof x.find === "string" ? { find: x.find } : {}), ...(typeof x.replace === "string" ? { replace: x.replace } : {}), ...(pickTarget(x as unknown as Record<string, unknown>)), ...(typeof x.note === "string" ? { note: x.note.slice(0, 500) } : {}), ...(typeof x.name === "string" ? { name: x.name.slice(0, 60) } : {}), ...(x.args && typeof x.args === "object" && !Array.isArray(x.args) ? { args: x.args } : {}) }));
    if (!message && !actions.length) return null;
    return { message: message || "Working on it.", actions, done: o.done === true };
  } catch { return null; }
}

export async function runAgentRound(input: { model: AiModel; depth: AiDepth; plan?: boolean; history: Msg[]; projectName: string; round: number; files: string[]; results: string; approvedPlan?: string; tools: string }) {
  const d = DEPTH[input.depth];
  // Safety runs in parallel with the main call so it never adds latency.
  const safe = input.round === 0 && !input.approvedPlan ? isSafe(input.history[input.history.length - 1]?.content ?? "") : Promise.resolve(true);
  const system = `You are Speed, an AI software agent building the project "${input.projectName}". ${d.guide}\n${LOOP_RULES(input.tools)}\n${RULES}${input.plan ? PLAN_LOOP : ""}`;
  const approved = input.approvedPlan ? `APPROVED PLAN (implement all of it; every listed file must exist, be linked and contain the requested design/behaviour):\n${input.approvedPlan}\n` : "";
  const state = `${approved}Turn ${input.round + 1}. Project files (${input.files.length}): ${input.files.length ? input.files.join(", ") : "(empty project)"}\n${input.results ? `Results of your last actions:\n${input.results}` : "No actions run yet."}\nReply with the JSON object only.`;
  // Only recent turns, each capped: file contents never travel through chat history.
  const hist = input.history.slice(-Math.min(d.history, 8)).map((m) => ({ ...m, content: m.content.length > 1500 ? `${m.content.slice(0, 1500)}…` : m.content }));
  const messages: Msg[] = [{ role: "system", content: system }, ...hist, { role: "user", content: state }];
  const opts = { maxTokens: MAX_OUTPUT_TOKENS, think: d.think, json: true };
  // An unparseable reply counts as a provider failure, so the chain moves to the next model.
  const [res, ok] = await Promise.all([callChain(chainFor(input.model), messages, opts, parseStep), safe]);
  if (!ok) return { message: "I can't help with that request.", actions: [] as AgentStepAction[], done: true, usedModel: usedLabel(res.used), fallbacks: res.failed };
  const step = res.value;
  if (input.plan) step.actions = step.actions.filter((x) => !WRITE_KINDS.includes(x.kind) && !(x.kind === "tool" && WRITE_TOOLS.has(x.name ?? "")));
  if (!step.actions.length) step.done = true;
  return { ...step, message: step.message.slice(0, 4000), usedModel: usedLabel(res.used), fallbacks: res.failed };
}

// ---- Planning: one concise structured plan from the real project state, before anything is built ----
export type AgentPlan = { title: string; summary: string; create: string[]; modify: string[]; pages: string[]; design: string[]; functional: string[]; validation: string[] };
const PLAN_PROMPT = `You plan changes for a website project. Two project types: static site (plain HTML/CSS/JS, index.html at the root, relative paths, no build tools) and React + Vite (real React + TypeScript: package.json with react, react-dom, vite, @vitejs/plugin-react, typescript; vite.config.ts; tsconfig.json; root index.html loading /src/main.tsx; .tsx files under src/). A separate build runtime compiles React + Vite projects after editing, so never say they can't be built.
Reply with ONLY one JSON object, no prose:
{"type":"plan","title":"short title","summary":"1-2 sentences","create":["new file paths"],"modify":["existing file paths to change"],"pages":["pages/components/sections required"],"design":["design requirements"],"functional":["functional requirements"],"validation":["checks that prove the request is done"]}
Any request to build, create, make, design or change something ALWAYS returns a plan — even for an empty project (then "create" lists every file to add, including package.json and vite.config.ts for React requests). Only reply {"type":"answer","answer":"..."} when the user asked a pure question that needs no file changes at all.
Rules: base the plan on the real files shown; modify only files that exist; styling requests need a CSS file (or existing stylesheet) that is linked from the HTML; keep each list short (at most 8 items, each under 120 characters). React + Vite projects put index.html at the project ROOT (never public/index.html) and use src/main.tsx (never react-scripts / Create React App files). New React pages go in src/pages/<name>/index.tsx (e.g. src/pages/home/index.tsx, never src/pages/HomePage.tsx), components in src/components/, and styling in the ONE shared stylesheet src/styles/index.css.`;

const strs = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.trim().slice(0, 200)).slice(0, 12) : []);

export async function createPlan(input: { model: AiModel; depth: AiDepth; projectName: string; prompt: string; files: string[]; snippets: string; previous?: AgentPlan | undefined; feedback?: string | undefined }): Promise<({ answer: string } | { plan: AgentPlan }) & { usedModel?: string; fallbacks?: { model: string; reason: string }[] }> {
  const safe = input.previous ? Promise.resolve(true) : isSafe(input.prompt);
  const ctx = `Project "${input.projectName}". Files (${input.files.length}): ${input.files.join(", ") || "(empty project)"}\n${input.snippets ? `Relevant file contents:\n${input.snippets}` : ""}`;
  const messages: Msg[] = [
    { role: "system", content: PLAN_PROMPT },
    { role: "user", content: `${ctx}\n\nRequest: ${input.prompt}${input.previous ? `\n\nCurrent plan:\n${JSON.stringify(input.previous)}\n\nThe user wants this changed in the plan: ${input.feedback ?? ""}\nReturn the full updated plan.` : ""}` },
  ];
  const opts = { maxTokens: MAX_OUTPUT_TOKENS, think: false, json: true };
  const parse = (t: string) => {
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(t.slice(a, b + 1)) as Record<string, unknown>; } catch { return null; }
  };
  let [res, ok] = await Promise.all([callChain(chainFor(input.model), messages, opts, parse), safe]);
  if (!ok) return { answer: "I can't help with that request." };
  let o = res.value;
  let meta = { usedModel: usedLabel(res.used), fallbacks: res.failed };
  // Safety net: a build/create request must never be answered with prose. Retry once demanding a plan.
  const wantsBuild = /\b(build|create|make|design|develop|generate|add|implement|code|write)\b/i.test(input.prompt);
  if (o["type"] === "answer" && wantsBuild && !input.previous) {
    res = await callChain(chainFor(input.model), [...messages, { role: "assistant", content: JSON.stringify(o) }, { role: "user", content: "That is a build request, not a question. Reply with the {\"type\":\"plan\",...} JSON object only — list every file to create." }], opts, parse);
    o = res.value;
    meta = { usedModel: usedLabel(res.used), fallbacks: [...meta.fallbacks, ...res.failed] };
  }
  if (o["type"] === "answer" && typeof o["answer"] === "string" && !input.previous && !wantsBuild) return { answer: o["answer"].slice(0, 8000), ...meta };
  const plan: AgentPlan = {
    title: typeof o["title"] === "string" ? o["title"].slice(0, 120) : "Implementation plan",
    summary: typeof o["summary"] === "string" ? o["summary"].slice(0, 600) : "",
    create: [...new Set(strs(o["create"]).map((f) => (input.files.includes(f) ? f : conventionalPath(f))))], modify: strs(o["modify"]).filter((f) => input.files.includes(f)), pages: strs(o["pages"]),
    design: strs(o["design"]), functional: strs(o["functional"]), validation: strs(o["validation"]),
  };
  // A file the plan "modifies" that doesn't exist yet is really a creation.
  for (const f of strs(o["modify"])) if (!input.files.includes(f) && !plan.create.includes(f)) plan.create.push(f);
  plan.create = normalizePlanPaths(plan.create, input.files);
  return { plan, ...meta };
}

/** Vite serves index.html from the project root; models often plan Create-React-App paths (public/index.html)
 *  that the builder correctly refuses to create. Map them to the real Vite paths. */
export function normalizePlanPaths(create: string[], existing: string[]): string[] {
  const all = [...create, ...existing];
  const vite = all.some((f) => /^vite\.config\.(ts|js|mts|mjs)$/.test(f) || /^src\/.+\.tsx$/.test(f) || f === "package.json");
  const out: string[] = [];
  for (let f of create) {
    f = f.replace(/^\.?\//, "");
    if (vite && f === "public/index.html") f = "index.html";
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

export function planText(p: AgentPlan) {
  const sec = (h: string, l: string[]) => (l.length ? `${h}:\n${l.map((x) => `- ${x}`).join("\n")}` : "");
  return [p.title, p.summary, sec("Create", p.create), sec("Modify", p.modify), sec("Pages/components", p.pages), sec("Design", p.design), sec("Functional", p.functional), sec("Validation", p.validation)].filter(Boolean).join("\n\n");
}
