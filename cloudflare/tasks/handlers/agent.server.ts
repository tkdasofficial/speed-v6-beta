// ai_agent tasks: the full agent workflow, running entirely on the server as one durable task.
// Phases (persisted in state, mirrored as `phase` events):
//   planning (Thinking → analyze → Creating Plan) → awaiting_approval (task parked, no alarm)
//   → building (Thinking → Action → … rounds) → validating → testing → completed
// Exits: denied (user denied the plan), cancelled (Stop), failed (errors / repair limit).
// Every action emits `action.started` before it runs and `action` (completed/failed) after, so the UI
// shows Processing only while the server is really doing the work, and rebuilds it from events on reload.
import type { Json, Message } from "@realtime/events";
import type { TaskHandler, TaskContext, StepResult } from "../registry";
import { FatalError } from "../registry";
import type { AgentPlan } from "../../functions/ai/orchestrator.server";
import type { MemoryFileStore } from "../../../sandbox/workspace/workspace";
import { AgentRun } from "../../agent/run.server";
import type { Batch, SubTask } from "../../agent/grouping";

// Persistent execution: no fixed repair counts. Work continues while repairs make progress (cloudflare/agent/recovery.ts)
// and stops only when the same failure repeats unchanged, the build stalls, or a high safety ceiling is reached.
import { RECOVERY, failureSignature, trackFailure } from "../../agent/recovery";
const MAX_ROUNDS = RECOVERY.maxRounds;
type Step = { kind: "read" | "create" | "edit" | "delete" | "think" | "check" | "tool"; path?: string; content?: string; find?: string; replace?: string; target?: Record<string, unknown>; note?: string; name?: string; args?: Record<string, unknown> };
type Phase = "planning" | "awaiting" | "building" | "validating" | "previewing";
const PREVIEW_INFRA_ATTEMPTS = 3; // build/preview infrastructure retries before reporting a server-side failure
type State = {
  phase?: Phase; changed?: string[]; created?: string[]; lastCheck?: boolean | null; round?: number; results?: string; failedBuilds?: number;
  failedIds?: string[]; failedPatches?: string[]; pendingCreates?: number; structureFixes?: number; baseRevision?: number; mutated?: boolean; plan?: AgentPlan; planMode?: import("../../agent/planning").PlanMode; planVersion?: number; decisionSeq?: number;
  feedback?: string; snippets?: string; knowledge?: string; fixAttempts?: number; validation?: string; test?: string; n?: number;
  /** Agent Core: analyzed sub-tasks, batches (with their agent_steps ids), relevant files and summary status. */
  ag?: { tasks: SubTask[]; batches: Batch[]; batchSteps: Record<string, string>; relevant?: string[] };
  finalSummaryStatus?: string;
  /** Visual preview verification (React/Vite): current runtime job, cycle count and the reported outcome. */
  previewJob?: string | null; previewStartedAt?: number; visualAttempts?: number; preview?: string; previewWaits?: number; buildFails?: string[]; fixSigs?: string[]; visualSigs?: string[]; stall?: number; infraAttempts?: number;
};
type P = { prompt?: string; model?: "speed" | "flash" | "heavy"; depth?: "quick" | "balanced" | "deep"; plan?: boolean; clientMessageId?: string; parentRunId?: string };

/** Running / completed labels for one action ("Creating styles.css" → "Created styles.css"). */
function labels(name: string, target: string | null): { kind: string; running: string; done: string; failed: string } {
  const t = target ?? "";
  const v = (kind: string, ing: string, ed: string) => ({ kind, running: `${ing}${t ? ` ${t}` : ""}`, done: `${ed}${t ? ` ${t}` : ""}`, failed: `Couldn't ${ing.toLowerCase().replace(/ing$/, "")}${t ? ` ${t}` : ""}` });
  if (name === "create_file" || name === "create_directory" || /^generate_/.test(name)) return v("create", "Creating", "Created");
  if (/^(update_file|write_file|apply_patch|format_file|refactor_code|replace_in_file)$/.test(name)) return v("edit", "Editing", "Edited");
  if (/^delete_/.test(name)) return v("delete", "Deleting", "Deleted");
  if (name === "rename_file" || name === "move_file") return v("edit", "Moving", "Moved");
  if (/^(read|get_file|get_project_structure)/.test(name)) return v("read", "Reading", "Read");
  if (/(search|find)/.test(name)) return v("search", "Searching", "Searched");
  if (/^list_/.test(name)) return v("read", "Exploring", "Explored");
  if (/^(verify_|run_|check_|detect_|scan_)/.test(name)) return { kind: "check", running: "Checking project", done: "Check passed", failed: "Check failed" };
  if (/^(add|remove|update|install)_dependenc/.test(name)) return v("edit", "Updating dependencies", "Updated dependencies");
  if (/^git_/.test(name)) return v("inspect", `Git ${name.slice(4).replace(/_/g, " ")}`, `Git ${name.slice(4).replace(/_/g, " ")} done`);
  if (/(rollback|restore|recover)/.test(name)) return v("fix", "Undoing change", "Undid change");
  return v("inspect", "Inspecting", "Inspected");
}
/** Legacy/shorthand names the model may still use → the orchestrated tool that does the same work. */
const ALIASES: Record<string, string> = { edit_file: "update_file", search_text: "search_files", search_filename: "search_files", build_project: "verify_project", build_static: "verify_project", validate_project: "verify_project", get_errors: "detect_errors", get_file_tree: "get_project_structure" };
/** Some models double-escape a whole file ("line1\\nline2" with no real newlines); unescape that one case. */
export function unescapeContent(c: unknown): unknown {
  if (typeof c !== "string" || c.includes("\n") || (c.match(/\\n/g) ?? []).length < 2) return c;
  return c.replace(/\\r\\n|\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
}
function toTool(s: Step): { name: string; args: Record<string, unknown> } {
  const t = toToolRaw(s);
  if (t.name === "write_file") t.args["content"] = unescapeContent(t.args["content"]);
  return t;
}
function toToolRaw(s: Step): { name: string; args: Record<string, unknown> } {
  switch (s.kind) {
    case "read": return { name: "read_file", args: { path: s.path } };
    case "create": return { name: "write_file", args: { path: s.path, content: s.content ?? "" } };
    case "edit": return s.find === undefined && !s.target && s.content !== undefined ? { name: "write_file", args: { path: s.path, content: s.content } } : { name: "update_file", args: { ...(s.target ?? {}), path: s.path, ...(s.find !== undefined ? { find: s.find } : {}), replace: s.replace ?? s.content ?? "" } };
    case "delete": return { name: "delete_file", args: { path: s.path, confirm: true } };
    case "check": return { name: "verify_project", args: {} };
    case "tool": {
      const raw = s.name ?? ""; const args = { ...(s.args ?? {}) };
      if (raw === "edit_file" && typeof args["content"] === "string" && args["find"] === undefined && !["lines", "symbol", "jsx", "selector", "mode"].some((k) => args[k] !== undefined)) return { name: "write_file", args };
      if (raw === "patch_file") return { name: "apply_patch", args: { path: args["path"], edits: args["edits"] } };
      return { name: ALIASES[raw] ?? raw, args };
    }
    default: return { name: "", args: {} };
  }
}
const VERIFY = new Set(["verify_project"]);

/** Compact, machine-readable result for the model (success/error code/next action). */
function fmt(r: import("../../tools/types").ToolResult, max0 = 3000): string {
  // Write results only need confirmation; reads keep a bounded excerpt. Full contents stay in the sandbox.
  const max = /^(write|create|edit|patch|delete|rename|move|update|apply|replace)_/.test(r.toolName) ? 300 : max0;
  if (!r.success) return `${r.toolName} [${r.operationId}]: ERROR ${r.error?.code} — ${r.error?.message}${r.nextRecommendedAction ? ` (next: ${r.nextRecommendedAction})` : ""}`;
  const d = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
  return `${r.toolName} [${r.operationId}]: ok${r.warnings.length ? ` (warnings: ${r.warnings.join("; ").slice(0, 300)})` : ""}${r.nextRecommendedAction ? ` (next: ${r.nextRecommendedAction})` : ""}\n${(d ?? "").slice(0, max)}`;
}
const verifyOk = (r: import("../../tools/types").ToolResult) => r.success && (r.data as { ok?: boolean } | null)?.ok !== false;

async function session(c: TaskContext, readOnly = false) {
  const { openToolSession } = await import("../../tools/session.server");
  return openToolSession({ userId: c.task.user_id, projectId: c.task.project_id!, taskId: c.task.id, confirmed: true, readOnly });
}

async function saveMessage(c: TaskContext, role: "user" | "assistant", content: string): Promise<Message> {
  const { d1 } = await import("@backend/d1");
  const { publish } = await import("@realtime/publish.server");
  const pid = c.task.project_id!;
  await d1("INSERT OR IGNORE INTO conversations (id, project_id) VALUES (?, ?)", [pid, pid]);
  const [row] = await d1<{ id: string; created_at: string }>("INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?) RETURNING id, created_at", [crypto.randomUUID(), pid, role, content]);
  const m: Message = { id: row!.id, projectId: pid, role, content, createdAt: row!.created_at, version: 1 };
  await publish(c.task.user_id, "message", "upsert", m.id, 1, m);
  return m;
}
async function say(c: TaskContext, st: State, text: string, role: "user" | "assistant" = "assistant") {
  const m = await saveMessage(c, role, text);
  await c.emit("message", { messageId: m.id, round: st.round ?? 0 });
}
const phase = (c: TaskContext, name: string) => c.emit("phase", { phase: name });
/** Locally generated progress (no AI), shown in chat and recorded in Agent D1. */
async function tell(c: TaskContext, st: State, e: import("../../agent/messages").ProgressEvent, stepId?: string | null) {
  const text = await (await AgentRun.for(c)).progress(e, stepId);
  await say(c, st, text);
}
const batchOf = (st: State) => (st.ag?.batches.length === 1 ? st.ag.batches[0]!.id : null);

/** Emits action.started, runs the work, then emits the completed/failed action with its real result. */
async function act<T>(c: TaskContext, st: State, a: { kind: string; running: string; done: string; failed?: string; round?: number }, work: () => Promise<{ ok: boolean; result?: T; error?: string; done?: string }> | { ok: boolean; result?: T; error?: string; done?: string }) {
  const id = `${c.task.id}-a${(st.n = (st.n ?? 0) + 1)}`;
  const round = a.round ?? st.round ?? 0;
  await c.emit("action.started", { id, round, kind: a.kind, title: a.running, target: null });
  let r: { ok: boolean; result?: T; error?: string; done?: string };
  try { r = await work(); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  await c.emit("action", { id, round, kind: a.kind, title: r.ok ? (r.done ?? a.done) : (a.failed ?? a.running), target: null, ok: r.ok, error: r.ok ? null : (r.error ?? "Failed").slice(0, 600) });
  return { id, ...r };
}

/** Stop takes effect while the model is still answering: poll the persisted cancel flag alongside the call. */
async function withCancel<T>(c: TaskContext, p: Promise<T>): Promise<T | null> {
  let poll: ReturnType<typeof setTimeout> | undefined;
  const watch = new Promise<null>((resolve) => { const tick = async () => { if (await c.cancelled().catch(() => false)) resolve(null); else poll = setTimeout(() => void tick(), 2000); }; poll = setTimeout(() => void tick(), 2000); });
  return Promise.race([p, watch]).finally(() => clearTimeout(poll));
}

async function end(c: TaskContext, st: State, status: "done" | "failed" | "denied", text: string, error?: string): Promise<StepResult> {
  await say(c, st, text);
  const ar = await AgentRun.for(c);
  await ar.store.addMessage(ar.runId, { role: "agent", type: status === "done" ? "final_summary" : "error", content: text }).catch((e) => console.error("[agent-d1]", (e as Error).message));
  for (const [, sid] of Object.entries(st.ag?.batchSteps ?? {})) await ar.finishStep(sid, { status: status === "done" ? "succeeded" : status === "denied" ? "cancelled" : "failed", ...(status === "failed" ? { error: error ?? null } : {}) });
  await ar.progress({ type: "complete", changed: st.changed?.length ?? 0, ok: status === "done" });
  await ar.checkpoint({ type: "stage", state: { phase: status, revision: st.baseRevision ?? 0 }, completed: st.changed ?? [], pending: [], next: null });
  await ar.finish(status === "done" ? "completed" : status === "denied" ? "cancelled" : "failed", { failureReason: status === "done" ? null : (error ?? (status === "denied" ? "Plan denied" : text.slice(0, 500))), finalSummaryStatus: st.finalSummaryStatus ?? "skipped", metadata: { changed: (st.changed ?? []).slice(0, 100), created: (st.created ?? []).slice(0, 100), validation: st.validation ?? null, test: st.test ?? null } });
  await phase(c, status === "done" ? "completed" : status);
  await c.emit("run.end", { status, ...(error ? { error } : {}), mutated: !!st.mutated, revision: st.baseRevision ?? 0 });
  // Successful builds of React + Vite projects start a runtime preview build (unchanged sources are skipped).
  if (status === "done" && c.task.project_id) {
    const { startBuild } = await import("@backend/build/pipeline.server");
    await startBuild(c.task.user_id, c.task.project_id).catch((e) => console.warn(`[build] auto preview skipped: ${(e as Error).message}`));
  }
  return { done: true, result: { status, mutated: !!st.mutated } };
}

// ---------------- planning ----------------
async function planStep(c: TaskContext, st: State, p: P): Promise<StepResult> {
  const pid = c.task.project_id!;
  const fs = await import("../../sandbox/fs.server");
  const { d1 } = await import("@backend/d1");
  await phase(c, "thinking");
  await c.progress(0.02, "Thinking");
  const { store } = await fs.loadStore(pid);
  const files = store.list().map((f) => f.path).sort();
  const ar = await AgentRun.for(c);
  if (st.snippets === undefined) {
    const { buildContext, contextSnippets } = await import("../../agent/context");
    const actx = buildContext({ request: p.prompt ?? "", projectId: pid, projectName: "", files: store.list(), tasks: st.ag?.tasks ?? [], stage: "planning" });
    await ar.progress({ type: "inspect", fileCount: files.length });
    // Inspect only the files that matter for a plan: small text sources, entry page first, capped context.
    const r = await act(c, st, { kind: "inspect", running: "Analyzing existing project", done: "Project analyzed" }, () => {
      const text = store.list().filter((f) => f.encoding === "utf8" && /\.(html?|css|js|mjs|json|md|txt|svg)$/i.test(f.path) && f.content.length < 60000)
        .sort((a, b) => (a.path === "index.html" ? -1 : b.path === "index.html" ? 1 : a.content.length - b.content.length)).slice(0, 8);
      let budget = 16000; const parts: string[] = [];
      for (const f of text) { if (budget <= 0) break; const s = f.content.slice(0, Math.min(4000, budget)); budget -= s.length; parts.push(`--- ${f.path}${f.content.length > s.length ? " (truncated)" : ""}\n${s}`); }
      const rel = contextSnippets(actx);
      return { ok: true, result: rel ? `${rel}\n${parts.filter((x) => !actx.relevantFiles.some((f) => x.startsWith(`--- ${f.path}`))).join("\n")}`.slice(0, 20000) : parts.join("\n"), done: files.length ? `Project analyzed · ${files.length} file${files.length === 1 ? "" : "s"}` : "Project analyzed · empty project" };
    });
    st.snippets = (r.result as string | undefined) ?? "";
    if (st.ag) st.ag.relevant = actx.relevantFiles.map((f) => f.path);
    await ar.progress({ type: "identify", files: st.ag?.relevant ?? [], taskCount: st.ag?.tasks.length ?? 1 });
  }
  if (await c.cancelled()) return { done: false, delayMs: 10 };
  // Smart planning: only ambiguous requests (or explicit plan mode) wait for approval; a user-written plan is followed.
  const { planMode } = await import("../../agent/planning");
  if (!st.planMode) st.planMode = planMode(p.prompt ?? "", { fileCount: files.length, forceReview: p.plan === true });
  if (st.planMode === "direct" && !st.plan) return startBuilding(c, st, "On it.");
  await phase(c, "planning");
  await c.progress(0.08, st.planMode === "provided" ? "Following your plan" : "Creating Plan");
  const [proj] = await d1<{ name: string }>("SELECT name FROM projects WHERE id = ?", [pid]);
  const { createPlan } = await import("../../functions/ai/orchestrator.server");
  const planT0 = Date.now();
  await ensureKnowledge(c, st, p.prompt ?? "", files);
  const out = await withCancel(c, createPlan({ model: p.model ?? "speed", depth: p.depth ?? "balanced", projectName: proj?.name ?? "project", prompt: p.prompt ?? "", files, snippets: [st.knowledge, st.snippets].filter(Boolean).join("\n\n"), previous: st.plan, feedback: st.feedback, userPlan: st.planMode === "provided" }));
  if (!out) return { done: false, delayMs: 10 };
  if (out.usedModel) await c.emit("model", { stage: "plan", model: out.usedModel, fallbacks: (out.fallbacks ?? []) as unknown as Json });
  // Real execution call (planning), recorded honestly; progress text never creates usage rows.
  await ar.usage({ provider: (out.usedModel ?? "unknown").split("/")[0]!, model: out.usedModel ?? "unknown", requestType: "plan", latencyMs: Date.now() - planT0, status: "succeeded" });
  if ("answer" in out) return end(c, st, "done", out.answer);
  // Complete the plan deterministically: every file the stack needs is known before generation, not found by a failed build.
  const { completePlan } = await import("../../../sandbox/intelligence/scaffold");
  st.plan = completePlan(out.plan, files); st.planVersion = (st.planVersion ?? 0) + 1; delete st.feedback;
  if (st.planMode !== "review") {
    await c.emit("plan", { version: st.planVersion, plan: st.plan as unknown as Json });
    return startBuilding(c, st, st.planMode === "provided" ? "Following your plan — starting now." : "I'll start building the project now.");
  }
  await ar.checkpoint({ type: "stage", state: { phase: "awaiting", planVersion: st.planVersion, baseRevision: st.baseRevision }, completed: ["analyze", "plan"], pending: (st.ag?.batches ?? []).map((b) => b.id), next: "awaiting_approval" });
  await ar.stage("awaiting_approval");
  await c.emit("plan", { version: st.planVersion, plan: st.plan as unknown as Json });
  await phase(c, "awaiting_approval");
  st.phase = "awaiting";
  return { done: false, wait: true };
}

async function decisionStep(c: TaskContext, st: State): Promise<StepResult> {
  const { d1 } = await import("@backend/d1");
  const [row] = await d1<{ seq: number; data: string }>("SELECT seq, data FROM task_events WHERE task_id = ? AND kind = 'plan.decision' AND seq > ? ORDER BY seq DESC LIMIT 1", [c.task.id, st.decisionSeq ?? 0]);
  if (!row) return { done: false, wait: true };
  st.decisionSeq = row.seq;
  const d = JSON.parse(row.data) as { decision: "approve" | "deny" | "edit"; feedback?: string | null };
  if (d.decision === "deny") return end(c, st, "denied", "Plan denied. No files were changed.");
  if (d.decision === "edit") {
    st.feedback = d.feedback ?? ""; st.phase = "planning";
    await say(c, st, st.feedback, "user");
    return { done: false, delayMs: 10 };
  }
  return startBuilding(c, st, "I'll start building the project now.");
}

/** Approval (by the user, or automatic when no review is needed) → building. */
async function startBuilding(c: TaskContext, st: State, note: string): Promise<StepResult> {
  if (st.plan) await c.emit("plan.approved", { version: st.planVersion ?? 1 });
  await phase(c, "thinking");
  await c.progress(0.12, "Thinking");
  await say(c, st, note);
  await phase(c, "building");
  st.phase = "building"; st.round = 0;
  {
    const ar = await AgentRun.for(c);
    await ar.stage("building", "running");
    for (const sid of Object.values(st.ag?.batchSteps ?? {})) await ar.finishStep(sid, { status: "running" });
    const { batchPrompt } = await import("../../agent/grouping");
    st.results = st.ag ? `TASK BATCHES (do each batch's related edits together, in as few rounds as possible):\n${batchPrompt(st.ag.tasks, st.ag.batches)}${st.ag.relevant?.length ? `\nMost relevant files: ${st.ag.relevant.join(", ")}` : ""}` : "";
    // Fresh React project: write the stack configuration deterministically (no AI) so generation only writes real UI.
    if (st.plan) {
      const fs = await import("../../sandbox/fs.server");
      const { d1 } = await import("@backend/d1");
      const { stackFiles, manifestPrompt } = await import("../../../sandbox/intelligence/scaffold");
      const pid = c.task.project_id!;
      const paths = (await fs.loadStore(pid)).store.list().map((f) => f.path);
      const [proj] = await d1<{ name: string }>("SELECT name FROM projects WHERE id = ?", [pid]);
      const stack = stackFiles(st.plan, paths, proj?.name ?? st.plan.title ?? "Website");
      const written: string[] = [];
      if (stack.length) {
        const sess = await session(c);
        const r = await act(c, st, { kind: "edit", running: "Setting up project", done: `Project set up · ${stack.length} files`, failed: "Project setup failed" }, async () => {
          for (const f of stack) { const res = await ar.tool(sess, "write_file", { path: f.path, content: f.content }); if (res.success) written.push(f.path); }
          if (!written.length) return { ok: false, error: "No setup files could be written" };
          const cm = await sess.commit("Project setup");
          if (cm.changed.length) { st.mutated = true; st.changed = [...new Set([...(st.changed ?? []), ...cm.changed])]; await c.emit("files", { revision: cm.revision, changed: cm.changed.slice(0, 50) }); }
          return { ok: true };
        });
        if (r.ok) st.created = [...new Set([...(st.created ?? []), ...written])];
      }
      if (st.plan.create.length) st.results = `${st.results}\n${manifestPrompt(st.plan, [...paths, ...written], written)}`;
    }
  }
  return { done: false, delayMs: 10 };
}

// ---------------- building ----------------
async function buildStep(c: TaskContext, st: State, p: P): Promise<StepResult> {
  const pid = c.task.project_id!;
  const round = st.round ?? 0;
  if (round >= MAX_ROUNDS) { st.phase = "validating"; return { done: false, delayMs: 10 }; }
  const fs = await import("../../sandbox/fs.server");
  const { d1 } = await import("@backend/d1");
  const prog = (label: string, frac = 0) => c.progress(0.15 + 0.6 * Math.min(1, (round + frac) / (round + 6)), label);
  await c.emit("step", { label: "Thinking", round });
  await prog("Thinking");

  const { store } = await fs.loadStore(pid);
  const existing = new Set(store.list().map((f) => f.path));
  const hist = await d1<{ role: "user" | "assistant"; content: string }>(
    "SELECT role, content FROM (SELECT role, content, created_at, rowid AS r FROM messages WHERE conversation_id = ? AND role IN ('user','assistant') ORDER BY created_at DESC, r DESC LIMIT 12) ORDER BY created_at, r", [pid]);
  const [proj] = await d1<{ name: string }>("SELECT name FROM projects WHERE id = ?", [pid]);
  const { runAgentRound, planText } = await import("../../functions/ai/orchestrator.server");
  const { loadTools } = await import("../../tools/index");
  const { catalogText } = await import("../../tools/exposure");
  loadTools();
  const ar = await AgentRun.for(c);
  const batchId = batchOf(st);
  const roundT0 = Date.now();
  const step = await withCancel(c, runAgentRound({ model: p.model ?? "speed", depth: p.depth ?? "balanced", plan: false, projectName: proj?.name ?? "project", round, files: store.list().map((f) => f.path).sort(), results: [(await ensureKnowledge(c, st, p.prompt ?? "", store.list().map((f) => f.path))), st.results ?? "", (await import("../../agent/context")).designTokens(store.list())].filter(Boolean).join("\n"), history: hist, tools: catalogText("building"), ...(st.plan ? { approvedPlan: planText(st.plan) } : {}) }));
  if (!step) return { done: false, delayMs: 10 };
  await c.emit("model", { stage: "build", round, model: step.usedModel, fallbacks: step.fallbacks as unknown as Json });
  const rid = await ar.step({ type: "edit", name: `Build round ${round + 1}`, batchId, description: step.message.slice(0, 500), metadata: { actions: (step.actions as Step[]).length } });
  await ar.usage({ stepId: rid, provider: String(step.usedModel ?? "unknown").split("/")[0]!, model: String(step.usedModel ?? "unknown"), requestType: "build_round", latencyMs: Date.now() - roundT0, status: "succeeded" });
  if (await c.cancelled()) return { done: false, delayMs: 10 };
  {
    const acts = step.actions as Step[];
    const writes = [...new Set(acts.filter((a) => a.kind === "create" || a.kind === "edit" || a.kind === "delete" || (a.kind === "tool" && /^(write|update|create|delete|apply|replace)_/.test(a.name ?? ""))).map((a) => a.path ?? (a.args?.["path"] as string | undefined)).filter((x): x is string => !!x))];
    const reads = [...new Set(acts.filter((a) => a.kind === "read").map((a) => a.path!).filter(Boolean))];
    if (writes.length) await tell(c, st, { type: "apply", files: writes, batchLabel: st.ag?.batches.find((b) => b.id === batchId)?.label }, rid);
    else if (reads.length) await ar.progress({ type: "read", files: reads }, rid);
    else if (step.message && !step.done) await say(c, st, step.message);
  }

  // Every action goes through the ToolOrchestrator: policy → args → prerequisites → execute → audit (tool_operations).
  const sess = await session(c);
  await c.emit("step", { label: "Working", round });
  const log: string[] = [];
  let built: boolean | null = null, stopped = false;
  const failedIds = st.failedIds ?? [];
  const created = new Set(st.created ?? []);
  for (const s of step.actions as Step[]) {
    // Cancellation is honoured between actions: no new file change starts after Stop.
    if (await c.cancelled()) { stopped = true; sess.cancel(); break; }
    if (s.kind === "think") { await act(c, st, { kind: "think", running: "Thinking", done: s.note ? `Planned: ${s.note.slice(0, 120)}` : "Planned next step", round }, () => ({ ok: true })); log.push("think: noted"); continue; }
    const { name, args } = toTool(s);
    if (!name) continue;
    const target = typeof args["path"] === "string" ? (args["path"] as string) : typeof args["query"] === "string" ? `"${args["query"] as string}"` : typeof args["name"] === "string" ? (args["name"] as string) : null;
    const L = VERIFY.has(name) ? labels("verify_project", null) : labels(name, target);
    const sig = /^(update_file|apply_patch|write_file)$/.test(name) ? `${name}:${JSON.stringify(args).length}:${JSON.stringify(args).slice(0, 400)}` : null;
    if (sig && (st.failedPatches ?? []).includes(sig)) { log.push(`${name}: SKIPPED — this exact edit already failed; read the current file and recalculate the edit`); continue; }
    const r = await act(c, st, { kind: L.kind, running: L.running, done: L.done, failed: L.failed, round }, async () => {
      const res = await ar.tool(sess, name, args, { stepId: rid, batchId });
      if (!res.success && sig) st.failedPatches = [...(st.failedPatches ?? []), sig].slice(-30);
      log.push(fmt(res));
      // A failed find/replace gets the file's real current text, so the next round can copy it instead of guessing.
      if (!res.success && res.toolName === "update_file" && typeof args["path"] === "string") {
        const cur = await ar.tool(sess, "read_file", { path: args["path"] }, { stepId: rid, batchId }).catch(() => null);
        if (cur?.success) log.push(`(automatic, current content of ${args["path"] as string}) ${fmt(cur)}`);
      }
      const ok = VERIFY.has(res.toolName) ? verifyOk(res) : res.success;
      return ok ? { ok: true } : { ok: false, error: (res.error?.message ?? fmt(res)).slice(0, 600) };
    });
    if (VERIFY.has(name)) built = r.ok;
    if (!r.ok) failedIds.push(r.id);
    if (r.ok && target && (name === "write_file" || name === "create_file") && !existing.has(target)) created.add(target);
  }
  st.created = [...created].slice(0, 200);
  // Declarations used before they exist crash the page; reorder them deterministically before checking.
  if (!stopped) {
    const { fixUseBeforeInit, fixUnclosedJsxBrace } = await import("../../../sandbox/intelligence/validate");
    const lastErr = log.filter((l) => /USE_BEFORE_INIT/.test(l)).slice(-1)[0] ?? "";
    const flagged = [...lastErr.matchAll(/"file":"([^"]+)"/g)].map((m) => m[1]!);
    // Invisible characters (zero-width spaces, BOMs) some models emit break parsing and can't be "seen" to fix by hand.
    const cleaned = await sess.autoFix(sess.pendingChanges.filter((p) => /\.(m?[jt]sx?|css|html?|json)$/.test(p)), (_p, c) => { const n = c.replace(/[\u200B-\u200D\u2060\uFEFF]/g, ""); return n === c ? null : n; });
    if (cleaned.length) log.push(`(automatic) Removed invisible characters from ${cleaned.join(", ")}.`);
    // Scaffold leftovers: a favicon link to a file that doesn't exist (e.g. /vite.svg) only wastes repair attempts.
    const braces = await sess.autoFix([...new Set([...sess.pendingChanges, ...[...(log.filter((l) => /TS_SYNTAX_ERROR/.test(l)).slice(-1)[0] ?? "").matchAll(/"file":"([^"]+)"/g)].map((m) => m[1]!)])].filter((p) => /\.[jt]sx$/.test(p)), fixUnclosedJsxBrace);
    if (braces.length) log.push(`(automatic) Closed an unclosed JSX {…} expression in ${braces.join(", ")}.`);
    // A stylesheet that nothing imports does nothing: link it deterministically (sibling component first, else the entry).
    {
      const all = new Set(await sess.paths());
      const lastStyle = log.filter((l) => /STYLE_NOT_IMPORTED/.test(l)).slice(-1)[0] ?? "";
      const unlinked = [...new Set([...lastStyle.matchAll(/([\w./-]+\.css) is never imported/g)].map((m) => m[1]!))].filter((f) => all.has(f));
      for (const css of unlinked) {
        const dir = css.replace(/\/[^/]+$/, ""); const base = css.split("/").pop()!;
        const sib = ["index.tsx", "index.jsx", base.replace(/\.css$/, ".tsx"), base.replace(/\.css$/, ".jsx")].map((n) => `${dir}/${n}`).find((f) => all.has(f));
        const host = sib ?? ["src/main.tsx", "src/main.jsx"].find((f) => all.has(f));
        if (!host) continue;
        const spec = sib ? `./${base}` : `./${css.replace(/^src\//, "")}`;
        const done = await sess.autoFix([host], (_p, c) => c.includes(spec) ? null : `import "${spec}";\n${c}`);
        if (done.length) log.push(`(automatic) Linked ${css} by importing it from ${host}.`);
      }
    }
    const present = new Set(await sess.paths()); const hasFile = (h: string) => present.has(h) || present.has(`public/${h}`);
    const ico = await sess.autoFix(["index.html"], (_p, c) => { const n = c.replace(/^[ \t]*<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*>[ \t]*\r?\n?/gim, (m) => { const h = /href=["']\/?([^"']+)["']/.exec(m)?.[1]; return h && !/^(https?:|data:)/.test(h) && !hasFile(h) ? "" : m; }); return n === c ? null : n; });
    if (ico.length) log.push("(automatic) Removed a favicon link to a missing file from index.html.");
    const moved = await sess.autoFix([...new Set([...sess.pendingChanges, ...flagged])].filter((p) => /\.[jt]sx?$/.test(p)), fixUseBeforeInit);
    if (moved.length) log.push(`(automatic) Moved declarations above their first use in ${moved.join(", ")} (they were used before being defined).`);
  }
  const wrote = sess.pendingChanges.length > 0;
  // Manifest gate: while planned files are still unwritten the project is incomplete by definition — checking it now
  // only reports the missing files and burns repair attempts. Continue generation with the exact remaining list.
  const remaining = stopped ? [] : (await import("../../../sandbox/intelligence/scaffold")).remainingPlanned(st.plan, await sess.paths());
  const deferCheck = remaining.length > 0 && round < MAX_ROUNDS - 3;
  if (deferCheck) {
    log.push(`(automatic) Generation is not complete — these planned files don't exist yet: ${remaining.join(", ")}. Write each of them completely now (with its styles in src/styles/index.css and its import where it is rendered). Do not mark the task done before they exist.`);
    step.done = false;
    if (built === false) { built = null; }
    await c.emit("step", { label: `Generating ${remaining.length} remaining file${remaining.length === 1 ? "" : "s"}`, round });
  }
  if (wrote && built === null && !stopped && !deferCheck) {
    const r = await act(c, st, { kind: "check", running: "Checking project", done: "Check passed", failed: "Check failed", round }, async () => {
      const res = await ar.tool(sess, "verify_project", {}, { stepId: rid, batchId });
      log.push(`(automatic) ${fmt(res)}`);
      return verifyOk(res) ? { ok: true } : { ok: false, error: fmt(res).slice(0, 600) };
    });
    built = r.ok; if (!r.ok) failedIds.push(r.id);
  }
  // Persist the round's changes as one revision through the session (conflicts surface as CONFLICT results).
  if (wrote) {
    await prog("Saving changes", 0.9);
    const r = await sess.commit(step.message.slice(0, 80) || "Agent changes");
    if (r.changed.length) {
      st.mutated = true;
      st.changed = [...new Set([...(st.changed ?? []), ...r.changed])].slice(0, 200);
      const { publish } = await import("@realtime/publish.server");
      await publish(c.task.user_id, "filerev", "upsert", `${pid}:${r.revision}`, r.revision, { id: `${pid}:${r.revision}`, projectId: pid, revision: r.revision, changed: r.changed.slice(0, 200), version: r.revision });
      await c.emit("files", { revision: r.revision, changed: r.changed.slice(0, 50) });
      // Folders appear in the revision's change list; file events are for files only.
      const folders = new Set((await fs.loadStore(pid)).store.folders());
      const fileChanges = r.changed.filter((x) => !folders.has(x));
      await ar.files(fileChanges, r.revision, { stepId: rid, batchId });
      await ar.progress({ type: "applied", files: fileChanges, ok: true }, rid);
      // Dependency/impact analysis (deterministic, no AI): the next round sees who uses the changed files.
      try {
        const { relatedFiles } = await import("../../../sandbox/intelligence/deps");
        const { impactNote } = await import("../../agent/context");
        const cur = (await fs.loadStore(pid)).store;
        const note = impactNote(fileChanges, (f) => relatedFiles(cur, f));
        if (note) { log.push(note); await c.emit("step", { label: "Checking related files", round }); }
      } catch { /* impact analysis never blocks a run */ }
    }
  }
  await ar.finishStep(rid, { status: stopped ? "cancelled" : failedIds.length && built !== true ? "failed" : "succeeded", outputRef: `rev:${st.baseRevision ?? 0}`, ...(built === false ? { error: log.filter((l) => /error/i.test(l)).slice(-1)[0]?.slice(0, 600) ?? "Check failed" } : {}) });
  await ar.checkpoint({ stepId: rid, type: "batch", state: { phase: "building", round: round + 1, lastCheck: built, failedBuilds: st.failedBuilds ?? 0 }, completed: st.changed ?? [], pending: (st.ag?.batches ?? []).map((b) => b.id), next: step.done ? "validating" : "building" });
  if (stopped) return { done: false, delayMs: 10 };
  if (built !== null) st.lastCheck = built;
  // While a new project is still being created, a check that only reports files not written yet (missing entry,
  // unresolved import) is unfinished work, not a failed repair: list what to create next and don't spend a repair.
  if (built === false && (st.created ?? []).length) {
    const lastErr = log.filter((l) => /verify_project/.test(l)).slice(-1)[0] ?? "";
    const types = [...lastErr.matchAll(/"type":"([a-z_]+)"/g)].map((m) => m[1]!);
    const codes = [...lastErr.matchAll(/"code":"([A-Z_]+)"/g)].map((m) => m[1]!);
    // Checks that only describe a half-built project (no entry yet, pages/styles not written yet) while the Agent is still creating it.
    const unfinished = new Set(["BUILD_NO_ENTRY", "CLASSES_WITHOUT_STYLES", "NO_STYLESHEET", "COMPONENT_NOT_RENDERED", "STYLE_NOT_IMPORTED"]);
    const onlyUnfinished = !step.done && codes.length > 0 && codes.every((k) => unfinished.has(k) || /MISSING|NOT_FOUND|BROKEN_IMPORT/.test(k));
    if (types.length && (onlyUnfinished || types.filter((t) => t === "missing_asset" || t === "broken_import" || t === "missing_file").length * 2 >= types.length) && (st.pendingCreates = (st.pendingCreates ?? 0) + 1) <= 6) {
      const refs = [...new Set([...lastErr.matchAll(/(?:resolve|find|missing|No such file:?)\s*\\*"?([\w./-]+)\\*"?(?:\s+from\s+([\w./-]+))?/gi)].map((m) => m[2] ? `${m[1]} (imported by ${m[2]})` : m[1]!))].slice(0, 6);
      log.push(`(automatic) The project is not finished yet — files it references don't exist${refs.length ? `: ${refs.join(", ")}` : ""}. Create the missing files next (e.g. src/main.tsx, src/App.tsx) instead of removing the references, and fix the other reported problems too. The task is not done until the check passes.`);
      step.done = false;
      built = null; st.lastCheck = null;
    }
  }
  if (built === false) {
    const err = log.filter((l) => /error/i.test(l)).slice(-1)[0] ?? "Check failed";
    await ar.progress({ type: "build", ok: false, error: err }, rid);
  } else if (built === true) await ar.progress({ type: "build", ok: true }, rid);
  if (built === true) { if (failedIds.length) await c.emit("fixed", { ids: failedIds }); st.failedIds = []; st.failedPatches = []; st.failedBuilds = 0; st.buildFails = []; }
  else st.failedIds = failedIds.slice(-50);
  if (built === false) {
    // Detect → Diagnose → Fix → Rebuild → Verify, for as long as the failure keeps changing.
    const lastErr = log.filter((l) => /error/i.test(l)).slice(-1)[0] ?? "Check failed";
    const t = trackFailure(st.buildFails, failureSignature(lastErr));
    st.buildFails = t.history; st.failedBuilds = t.attempt;
    if (t.unrecoverable) return end(c, st, "failed", `Not finished. ${t.repeated ? `The same problem came back unchanged after ${RECOVERY.sameFailureLimit} different fixes` : `The project check still fails after ${t.attempt} repair attempts`}:\n\n${lastErr.slice(0, 800)}`, t.repeated ? "Stopped: the same failure repeated after several fixes." : `Stopped after ${t.attempt} repair attempts.`);
    await ar.step({ type: "recover", name: `Repair after failed check (attempt ${t.attempt})`, parentStepId: rid, status: "succeeded" });
    await ar.progress({ type: "retry", what: "the failed check", attempt: t.attempt + 1, max: 0 });
  }
  st.results = log.join("\n").slice(-12000);
  if (built === false) {
    // A failed check only shows a few lines around each error; the real cause of an "Unexpected token" is often far
    // above it. Attach the current text of the failing files (saved revision) so the repair edits exact lines.
    const bad = [...new Set([...log.join("\n").matchAll(/"file":"([^"]+)"/g)].map((m) => m[1]!))].slice(0, 2);
    const { store: now } = await fs.loadStore(pid);
    const attached = bad.map((f) => now.get(f)).filter((f): f is NonNullable<typeof f> => !!f && f.encoding === "utf8").map((f) => `--- ${f.path} (current content, numbered)\n${f.content.split("\n").map((l, i) => `${i + 1}| ${l}`).join("\n").slice(0, 7000)}`);
    if (attached.length) st.results = `${st.results.slice(-5000)}\nFix the check errors above. Current text of the failing files is below — copy find-text exactly (without the line numbers), or rewrite a short broken file completely with "content".\n${attached.join("\n")}`;
  }
  st.round = round + 1;
  // Stall detection: rounds that change nothing and fix nothing aren't meaningful work; move on to validation.
  st.stall = wrote || built === true ? 0 : (st.stall ?? 0) + 1;
  if (st.stall >= RECOVERY.stallRounds && !step.done) { st.stall = 0; st.phase = "validating"; return { done: false, delayMs: 10 }; }
  // A round that only re-runs a passing check has nothing left to do; continuing just burns AI calls.
  const acts = step.actions as Step[];
  if (!step.done && !wrote && built === true && acts.length > 0 && acts.every((a) => a.kind === "check" || (a.kind === "tool" && VERIFY.has(ALIASES[a.name ?? ""] ?? a.name ?? "")))) step.done = true;
  // Structure gate (deterministic): files this task created in a React+Vite project must follow the convention.
  if (step.done && built !== false && (st.created ?? []).length && (st.structureFixes ?? 0) < 3) {
    const { structureIssues } = await import("../../../sandbox/intelligence/validate");
    const issues = structureIssues((await fs.loadStore(pid)).store, st.created ?? []);
    if (issues.length) {
      st.structureFixes = (st.structureFixes ?? 0) + 1;
      await c.emit("step", { label: "Checking project structure", round });
      st.results = `${(st.results ?? "").slice(-6000)}\n(automatic) Not done yet — the project structure check failed:\n- ${issues.join("\n- ")}\nCreate the file at the required path (move_file or write_file + delete_file), update every import that points to it, and keep everything else unchanged.`;
      return { done: false, delayMs: 50 };
    }
  }
  if (step.done && built !== false) {
    // A pure answer with no file work and nothing changed ends here; real builds go through validation.
    if (!st.mutated && !st.changed?.length) return end(c, st, "done", step.message || "Done. No files were changed.");
    st.phase = "validating";
    return { done: false, delayMs: 10 };
  }
  if (step.done && built === false) st.results += "\nYou said done, but the check failed — fix the errors above with targeted edits.";
  return { done: false, delayMs: 50 };
}

// ---------------- validating + testing ----------------
async function validateStep(c: TaskContext, st: State): Promise<StepResult> {
  const pid = c.task.project_id!;
  const fs = await import("../../sandbox/fs.server");
  const { store } = await fs.loadStore(pid);
  const { validateProject, validateReferences, isViteProject } = await import("../../../sandbox/intelligence/validate");
  const sess = await session(c);
  await phase(c, "validating");
  await c.progress(0.8, "Validating");
  const ar = await AgentRun.for(c);
  await ar.stage("verifying", "verifying");
  const vid = await ar.step({ type: "verify", name: "Validate requirements", batchId: batchOf(st) });
  await ar.progress({ type: "verify" }, vid);
  const plan = st.plan;
  const changed = new Set(st.changed ?? []);
  const v = await act(c, st, { kind: "check", running: "Validating requirements", done: "Requirements verified", failed: "Validation failed" }, async () => {
    const issues: string[] = [];
    // Vite keeps index.html at the root, so a planned CRA-style public/index.html is satisfied by it.
    const exists = (f: string) => !!store.get(f) || (f === "public/index.html" && !!store.get("index.html"));
    for (const f of plan?.create ?? []) if (!exists(f)) issues.push(`Planned file ${f} was not created.`);
    // A planned modification the agent judged unnecessary (file read, build passing) is not a failure: blocking on it
    // made the fix loop re-read the same file until the run failed. Missing planned files still block.
    for (const f of plan?.modify ?? []) if (!store.get(f)) issues.push(`Planned file ${f} is missing.`);
    if (!store.get("index.html") && store.list().some((f) => /\.html?$/.test(f.path))) issues.push("index.html is missing at the project root.");
    // Every stylesheet / script must be linked from some page, otherwise the requested design/behaviour never shows.
    const pages = store.list().filter((f) => /\.html?$/.test(f.path)).map((f) => f.content).join("\n");
    for (const f of store.list()) {
      if (!/\.(css|js)$/.test(f.path) || !changed.has(f.path)) continue;
      const base = f.path.split("/").pop()!;
      const usedByOther = store.list().some((o) => o.path !== f.path && o.content.includes(base));
      if (!pages.includes(base) && !usedByOther) issues.push(`${f.path} is not linked from any page.`);
    }
    const proj = validateProject(store);
    for (const e of proj.errors.slice(0, 10)) { const d = e as unknown as { path?: string; line?: number; message?: string }; issues.push(`${d.path ? `${d.path}${d.line ? `:${d.line}` : ""}: ` : ""}${d.message ?? JSON.stringify(e).slice(0, 300)}`); };
    for (const d of validateReferences(store).filter((x) => x.severity === "error").slice(0, 10)) issues.push(`${d.file}${d.line ? `:${d.line}` : ""}: ${d.message}`);
    const sec = await ar.tool(sess, "scan_secrets", {}, { stepId: vid });
    if (sec.success && ((sec.data as { findings?: unknown[] })?.findings?.length ?? 0) > 0) issues.push(`Secrets found in source files — move them to environment variables: ${JSON.stringify((sec.data as { findings: unknown[] }).findings.slice(0, 5))}`);
    return issues.length ? { ok: false, result: issues, error: issues.slice(0, 6).join("\n") } : { ok: true, result: [] };
  });
  let issues = (v.result as string[] | undefined) ?? [];
  st.validation = v.ok ? "Passed" : "Failed";
  await ar.finishStep(vid, { status: v.ok ? "succeeded" : "failed", error: v.ok ? null : issues.slice(0, 6).join("\n") });
  await ar.progress({ type: "verify", ok: v.ok, issues }, vid);
  if (v.ok) {
    // Testing: the Sandbox-only architecture has no terminal/browser runtime yet, so the test is the transactional
    // static build (validate → stage → verify). Speed Runtime can replace this step with a real build + run later.
    await phase(c, "testing");
    await c.progress(0.9, "Testing");
    const tid = await ar.step({ type: "test", name: "Build and test project", batchId: batchOf(st) });
    await ar.progress({ type: "test" }, tid);
    const t = await act(c, st, { kind: "check", running: "Building and testing project", done: "Build test passed", failed: "Build test failed" }, async () => {
      const res = await ar.tool(sess, "verify_project", {}, { stepId: tid });
      return verifyOk(res) ? { ok: true } : { ok: false, error: fmt(res).slice(0, 800) };
    });
    st.test = t.ok ? "Passed" : "Failed";
    await ar.finishStep(tid, { status: t.ok ? "succeeded" : "failed", error: t.ok ? null : (t.error ?? null) });
    await ar.progress({ type: "test", ok: t.ok, ...(t.ok ? {} : { error: t.error ?? "" }) }, tid);
    if (!t.ok) issues = [t.error ?? "Build test failed"];
  }
  if (!issues.length) {
    // React/Vite: a passing build only proves the code compiles; the task completes only after the real preview has
    // been opened in a browser and verified (previewStep). Plain HTML projects keep the static checks.
    if (isViteProject(store) && !st.preview?.startsWith("Passed")) {
      st.phase = "previewing"; st.previewJob = null;
      return { done: false, delayMs: 10 };
    }
    return complete(c, st, store);
  }
  return repair(c, st, store, issues);
}

async function complete(c: TaskContext, st: State, store: MemoryFileStore): Promise<StepResult> {
  const plan = st.plan;
  const ar = await AgentRun.for(c);
  {
    const created = (st.created ?? []).filter((f) => store.get(f));
    const modified = (st.changed ?? []).filter((f) => !created.includes(f) && store.get(f));
    const deleted = (st.changed ?? []).filter((f) => !store.get(f));
    const feats = [...(plan?.pages ?? []), ...(plan?.functional ?? []), ...(plan?.design ?? [])].slice(0, 8);
    const list = (h: string, l: string[]) => (l.length ? `${h}:\n${l.slice(0, 20).map((x) => `- ${x}`).join("\n")}` : "");
    const text = ["Build Complete", plan?.summary || plan?.title || "", list("Implemented", feats), list("Files created", created), list("Files modified", modified), list("Files deleted", deleted), `Validation: ${st.validation}\nBuild/Test: ${st.test ?? "Passed"}${st.preview ? `\nPreview: ${st.preview}` : ""}`].filter(Boolean).join("\n\n");
    // The run's single final-summary AI call, over the structured, verified result. Falls back to the factual text.
    const sid = await ar.step({ type: "summary", name: "Final summary" });
    let finalText = text; const t0 = Date.now();
    try {
      const { finalSummary } = await import("../../functions/ai/orchestrator.server");
      const r = await finalSummary({ model: (c.payload as P).model ?? "speed", result: {
        request: (c.payload as P).prompt ?? "", tasks: (st.ag?.tasks ?? []).map((t) => t.text), batches: (st.ag?.batches ?? []).map((b) => ({ id: b.id, kind: b.kind, tasks: b.taskIds.length })),
        filesCreated: created, filesModified: modified, filesDeleted: deleted, planned: feats, validation: st.validation, buildTest: st.test ?? "Passed", ...(st.preview ? { previewVerification: st.preview } : {}),
      } });
      finalText = r.text; st.finalSummaryStatus = "generated";
      await ar.usage({ stepId: sid, provider: r.provider, model: r.model, requestType: "final_summary", latencyMs: r.latencyMs, status: "succeeded", metadata: { fallbacks: r.fallbacks } });
      await ar.finishStep(sid, { status: "succeeded" });
    } catch (e) {
      st.finalSummaryStatus = "failed";
      await ar.usage({ stepId: sid, provider: "unknown", model: "unknown", requestType: "final_summary", latencyMs: Date.now() - t0, status: "failed", metadata: { error: (e as Error).message.slice(0, 300) } });
      await ar.finishStep(sid, { status: "failed", error: (e as Error).message });
    }
    return end(c, st, "done", finalText);
  }
}

async function repair(c: TaskContext, st: State, store: MemoryFileStore, issues: string[]): Promise<StepResult> {
  const ar = await AgentRun.for(c);
  const t = trackFailure(st.fixSigs, failureSignature(issues.slice().sort().join("\n")));
  st.fixSigs = t.history; st.fixAttempts = t.attempt;
  if (t.unrecoverable) {
    return end(c, st, "failed", `Not finished. Validation still fails after ${t.attempt} automatic fixes${t.repeated ? " (the same problems kept coming back)" : ""}:\n\n${issues.slice(0, 6).map((i) => `- ${i}`).join("\n")}`, "Validation failed after automatic fixes.");
  }
  await ar.step({ type: "recover", name: `Automatic fix (attempt ${st.fixAttempts})`, status: "succeeded", metadata: { issues: issues.slice(0, 6) } });
  await tell(c, st, { type: "fix", attempt: st.fixAttempts, max: 0, issues });
  await ar.checkpoint({ type: "recovery", state: { phase: "building", fixAttempts: st.fixAttempts }, completed: st.changed ?? [], pending: issues.slice(0, 20), next: "building" });
  // Automatic fix: back to Thinking → Action with the real failures, then validate again.
  st.phase = "building";
  // The files named in the problems are attached verbatim: without them the model guessed find-text, every edit
  // failed with "Text not found", and the two-round fix budget ran out on re-reads.
  const named = [...new Set(issues.join("\n").match(/[\w@.\/-]+\.(?:tsx?|jsx?|css|html?|json)\b/g) ?? [])].filter((f) => store.get(f)).slice(0, 4);
  const attached = named.map((f) => `--- ${f} (current content)\n${store.get(f)!.content.slice(0, 3000)}`).join("\n");
  st.results = `VALIDATION FAILED (fix attempt ${st.fixAttempts}). Fix exactly these problems with targeted edits (copy find-text exactly from the contents below, or rewrite the file with "content"), then set done:\n${issues.map((i) => `- ${i}`).join("\n")}${attached ? `\n${attached}` : ""}`;
  st.stall = 0;
  await phase(c, "building");
  return { done: false, delayMs: 10 };
}

// ---------------- visual preview verification ----------------
// Real build → vite preview → headless Chromium (desktop + mobile screenshots, console/page errors, failed requests,
// DOM state) in the runtime, then deterministic checks + vision analysis. FAIL feeds the diagnosis and the current
// text of the affected files back into building; PASS (or an honest "could not verify") completes the task.
async function previewStep(c: TaskContext, st: State, p: P): Promise<StepResult> {
  const pid = c.task.project_id!;
  const pv = await import("../../functions/preview/verify.server");
  const ar = await AgentRun.for(c);
  if (!st.previewJob) {
    await phase(c, "testing");
    await c.progress(0.92, "Verifying preview");
    const s = await act(c, st, { kind: "check", running: "Starting preview in browser", done: "Preview check started", failed: "Couldn't start preview check" }, async () => {
      try { const r = await pv.startPreview(c.task.user_id, pid); return { ok: true, result: r.jobId }; }
      catch (e) { return { ok: false, error: (e as Error).message.slice(0, 300) }; }
    });
    if (!s.ok) {
      // Another runtime job for this project may still be running: try again shortly, then report honestly.
      if (/still running|already running/i.test(s.error ?? "") && (st.previewWaits = (st.previewWaits ?? 0) + 1) < 20) return { done: false, delayMs: 15_000 };
      st.preview = `Not verified (${s.error ?? "preview check could not start"})`;
      const { store } = await (await import("../../sandbox/fs.server")).loadStore(pid);
      return complete(c, st, store);
    }
    st.previewWaits = 0;
    st.previewJob = s.result as string; st.previewStartedAt = Date.now();
    return { done: false, delayMs: 30_000 };
  }
  if (await c.cancelled()) return { done: false, delayMs: 10 };
  const read = await pv.readPreview(pid, st.previewJob);
  if (read && !read.done && Date.now() - (st.previewStartedAt ?? 0) < pv.PREVIEW_TIMEOUT_MS) {
    await c.progress(0.93, "Verifying preview in browser");
    return { done: false, delayMs: 15_000 };
  }
  const jobId = st.previewJob;
  st.previewJob = null;
  const fs = await import("../../sandbox/fs.server");
  const { store } = await fs.loadStore(pid);
  const files = store.list().map((f) => f.path).filter((f) => !/^(node_modules|\.output|dist)\//.test(f));
  const requirements = [p.prompt ?? "", st.plan?.summary ?? "", ...(st.plan?.pages ?? []), ...(st.plan?.functional ?? [])].filter(Boolean).join("\n").slice(0, 2000);
  const vid = await ar.step({ type: "verify", name: "Visual preview verification", batchId: batchOf(st) });
  const t0 = Date.now();
  const a = await act(c, st, { kind: "check", running: "Analyzing preview screenshots", done: "Preview verified", failed: "Preview check failed" }, async () => {
    if (!read || !read.done) return { ok: false, result: null, error: "The preview check did not finish in time." };
    try {
      const o = await pv.evaluatePreview(read, requirements, files);
      return o.status === "FAIL" ? { ok: false, result: o, error: o.verdict.diagnosis } : { ok: true, result: o, done: o.status === "UNVERIFIABLE" ? "Preview not verified" : o.vision ? "Preview verified" : "Preview rendered" };
    } finally { await pv.clearScreenshots(jobId).catch(() => undefined); }
  });
  const o = a.result as import("../../functions/preview/analyze").PreviewOutcome | null | undefined;
  // Compact metadata only (no screenshots) in the agent D1.
  const meta = { jobId, status: o?.status ?? "TIMEOUT", issueType: o?.verdict.issueType ?? "loading_stuck", severity: o?.verdict.severity ?? "high", diagnosis: (o?.verdict.diagnosis ?? a.error ?? "").slice(0, 400), confidence: o?.verdict.confidence ?? 0, provider: o?.vision?.provider ?? null, model: o?.vision?.model ?? null, deterministic: o?.deterministic ?? true, attempt: (st.visualAttempts ?? 0) + 1, visionNote: o?.visionNote?.slice(0, 300) ?? null };
  await ar.finishStep(vid, { status: a.ok ? "succeeded" : "failed", error: a.ok ? null : meta.diagnosis });
  if (o?.vision) await ar.usage({ stepId: vid, provider: o.vision.provider, model: o.vision.model, requestType: "visual_verification", latencyMs: Date.now() - t0, status: "succeeded", metadata: meta });
  await ar.progress({ type: "test", ok: a.ok, ...(a.ok ? {} : { error: meta.diagnosis }) }, vid);
  if (o && o.status !== "FAIL") {
    st.preview = o.status === "UNVERIFIABLE" ? `Not verified (${(o.visionNote ?? "browser check unavailable").slice(0, 200)})` : o.vision ? `Passed (rendered on desktop and mobile; visual check by ${o.vision.provider})` : `Passed (rendered with no runtime errors; visual AI check unavailable${o.visionNote ? `: ${o.visionNote.slice(0, 160)}` : ""})`;
    return complete(c, st, store);
  }
  // FAIL (or timeout): repair with the real evidence and the current file contents, then rebuild and re-verify.
  st.visualAttempts = (st.visualAttempts ?? 0) + 1;
  const v = o?.verdict;
  const diagnosis = v?.diagnosis || a.error || "The preview did not render.";
  st.preview = `Failed: ${diagnosis.slice(0, 200)}`;
  if (st.visualAttempts > MAX_VISUAL_REPAIRS) {
    return end(c, st, "failed", `Not finished. The website builds, but the preview still has a problem after ${MAX_VISUAL_REPAIRS} automatic fixes:\n\n- ${diagnosis}${v?.evidence.length ? `\n- Evidence: ${v.evidence.slice(0, 2).join(" · ").slice(0, 400)}` : ""}`, "Preview verification failed after automatic fixes.");
  }
  await ar.step({ type: "recover", name: `Preview fix ${st.visualAttempts}/${MAX_VISUAL_REPAIRS}`, status: "succeeded", metadata: { issueType: meta.issueType, diagnosis: meta.diagnosis } });
  await tell(c, st, { type: "fix", attempt: st.visualAttempts, max: MAX_VISUAL_REPAIRS, issues: [diagnosis] });
  const want = [...(v?.suggestedFiles ?? []), "src/App.tsx", "src/main.tsx", "src/App.jsx", "src/main.jsx"].filter((f, i, all) => store.get(f) && all.indexOf(f) === i).slice(0, 3);
  const attached = want.map((f) => `--- ${f} (current content, numbered)\n${store.get(f)!.content.split("\n").map((l, i) => `${i + 1}| ${l}`).join("\n").slice(0, 7000)}`).join("\n");
  st.results = [`PREVIEW VERIFICATION FAILED (fix ${st.visualAttempts}/${MAX_VISUAL_REPAIRS}). The project builds, but in a real browser: ${diagnosis}`,
    v?.issueType ? `Issue type: ${v.issueType} (${v.severity})` : "",
    v?.evidence.length ? `Evidence:\n${v.evidence.map((e) => `- ${e}`).join("\n")}` : "",
    v?.suggestedFix ? `Suggested fix: ${v.suggestedFix}` : "",
    `Original request: ${(p.prompt ?? "").slice(0, 600)}`,
    "Fix the real cause with targeted edits (copy find-text exactly from the numbered contents below, without line numbers, or rewrite a short file with \"content\"), then set done. Do not re-read these files.",
    attached].filter(Boolean).join("\n");
  st.phase = "building";
  st.stall = 0;
  await phase(c, "building");
  return { done: false, delayMs: 10 };
}

export const agentHandler: TaskHandler = {
  maxRetries: 3,
  async step(c) {
    const pid = c.task.project_id;
    if (!pid) throw new FatalError("A project is required");
    const p = c.payload as P;
    const st = c.state as State;
    if (!st.phase) {
      if (!p.prompt) throw new FatalError("A prompt is required");
      const fs = await import("../../sandbox/fs.server");
      st.baseRevision = await fs.ensureProject(c.task.user_id, pid);
      const um = await saveMessage(c, "user", p.prompt);
      await c.emit("run.start", { prompt: p.prompt.slice(0, 500), messageId: um.id, clientMessageId: p.clientMessageId ?? null, revision: st.baseRevision });
      st.phase = "planning";
      const ar = await AgentRun.for(c);
      await ar.start({ projectId: pid, userId: c.task.user_id, taskText: p.prompt, parentRunId: p.parentRunId ?? null, metadata: { model: p.model ?? "speed", depth: p.depth ?? "balanced" } });
      const { analyzeTask, groupTasks } = await import("../../agent/grouping");
      const tasks = analyzeTask(p.prompt); const batches = groupTasks(tasks);
      const aid = await ar.step({ type: "analyze", name: "Analyze and group task", metadata: { tasks, batches } });
      const batchSteps: Record<string, string> = {};
      for (const b of batches) batchSteps[b.id] = (await ar.step({ type: "batch", name: b.label || b.id, batchId: b.id, status: "pending", parentStepId: aid, metadata: { taskIds: b.taskIds, kind: b.kind, risk: b.risk } })) ?? "";
      await ar.finishStep(aid, { status: "succeeded" });
      st.ag = { tasks, batches, batchSteps };
      await ar.progress({ type: "plan", batches: batches.length, tasks: tasks.length }, aid);
      await ar.checkpoint({ stepId: aid, type: "stage", state: { phase: "planning", baseRevision: st.baseRevision }, completed: ["analyze"], pending: batches.map((b) => b.id), next: "planning" });
      await ar.stage("planning", "running");
    }
    switch (st.phase) {
      case "planning": return planStep(c, st, p);
      case "awaiting": return decisionStep(c, st);
      case "building": return buildStep(c, st, p);
      case "validating": return validateStep(c, st);
      case "previewing": return previewStep(c, st, p);
    }
  },
  async onCancel(c) {
    const st = c.state as State;
    await c.emit("phase", { phase: "cancelled" }).catch(() => undefined);
    await c.emit("run.end", { status: "stopped", mutated: !!st.mutated, revision: st.baseRevision ?? 0 });
    const ar = await AgentRun.for(c);
    for (const sid of Object.values(st.ag?.batchSteps ?? {})) await ar.finishStep(sid, { status: "cancelled" });
    await ar.checkpoint({ type: "stage", state: { phase: st.phase ?? "planning", round: st.round ?? 0, revision: st.baseRevision ?? 0 }, completed: st.changed ?? [], pending: (st.ag?.batches ?? []).map((b) => b.id), next: st.phase ?? "planning" });
    await ar.finish("cancelled", { failureReason: "Stopped by user" });
  },
};

/** Knowledge-base guidance for this run (cloudflare/agent/agent.ts over the Agent D1 knowledge bases): resolved once,
 *  kept in task state, and fed to planning and every build round. Fail-soft: missing knowledge never blocks a run. */
async function ensureKnowledge(c: TaskContext, st: State, prompt: string, files: string[]): Promise<string> {
  if (st.knowledge === undefined) {
    const { knowledgeForRequest } = await import("../../agent/agent");
    const k = await knowledgeForRequest(prompt, files.join(" "));
    st.knowledge = k.text;
    if (k.components.length) await c.emit("step", { label: `Using knowledge: ${k.components.slice(0, 6).join(", ")}` });
  }
  return st.knowledge;
}
