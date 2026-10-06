// verify_preview_visually: Preview launcher (runtime `preview` job: real build → vite preview → headless Chromium),
// diagnostics reader, and verdict (deterministic gate first, then the vision analyzer on desktop and mobile).
// Screenshots live only in the job row until analyzed, then are deleted; only compact metadata is kept.
import { d1 } from "../d1";
import { deterministicVerdict, diagSummary, pass, visionBlocks, type PreviewDiag, type PreviewOutcome } from "./analyze";

export const PREVIEW_TIMEOUT_MS = 14 * 60_000;

export async function startPreview(userId: string, projectId: string, operationId?: string | null) {
  const { startJob } = await import("../build/jobs.server");
  return startJob(userId, projectId, "preview", { operationId: operationId ?? null });
}

export type PreviewRead =
  | { done: false; status: string }
  | { done: true; status: string; diag: PreviewDiag; shots: (string | null)[]; output: string };

export async function readPreview(projectId: string, jobId: string): Promise<PreviewRead | null> {
  const now = Date.now();
  await d1("UPDATE runtime_jobs SET status = 'expired', token_hash = '', completed_at = datetime('now') WHERE id = ? AND status IN ('queued','running') AND expires_at < ?", [jobId, now]);
  const [r] = await d1<{ status: string; diagnostics: string | null; files: string | null; output: string | null }>("SELECT status, diagnostics, files, output FROM runtime_jobs WHERE id = ? AND project_id = ? AND kind = 'preview'", [jobId, projectId]);
  if (!r) return null;
  if (r.status === "queued" || r.status === "running") return { done: false, status: r.status };
  let diag: PreviewDiag = { stage: r.status === "expired" ? "expired" : "unknown", error: r.status === "expired" ? "The preview check did not finish in time." : (r.output ?? "").slice(-1500) };
  try { if (r.diagnostics) { const d = JSON.parse(r.diagnostics) as PreviewDiag; if (d && typeof d === "object" && !Array.isArray(d) && d.stage) diag = d.error ? d : { ...d, error: (r.output ?? "").slice(-1500) }; } } catch { /* keep fallback */ }
  let shots: (string | null)[] = [];
  try { shots = r.files ? (JSON.parse(r.files) as { data: string | null }[]).map((s) => s?.data ?? null) : []; } catch { shots = []; }
  return { done: true, status: r.status, diag, shots, output: r.output ?? "" };
}

/** Deletes the temporary screenshots once analyzed. */
export async function clearScreenshots(jobId: string) {
  await d1("UPDATE runtime_jobs SET files = NULL WHERE id = ? AND kind = 'preview'", [jobId]);
}

export async function evaluatePreview(read: Extract<PreviewRead, { done: true }>, requirements: string, files: string[]): Promise<PreviewOutcome> {
  const det = deterministicVerdict(read.diag);
  if (det && "unverifiable" in det) return { status: "UNVERIFIABLE", verdict: { ...pass(det.unverifiable), status: "FAIL", severity: "none", issueType: "unknown", confidence: 0 }, deterministic: true, vision: null, visionNote: det.unverifiable };
  if (det) return { status: "FAIL", verdict: det, deterministic: true, vision: null };
  const { analyzeScreenshot, VisionUnavailable } = await import("../ai/vision.server");
  const summary = diagSummary(read.diag);
  const views = read.diag.views ?? [];
  let used: { provider: string; model: string } | null = null;
  let note = "";
  // Desktop first; mobile only when desktop passes (one image per call keeps every vision model eligible).
  for (let i = 0; i < views.length; i++) {
    const image = read.shots[i];
    if (!image) { note ||= `No ${views[i]!.viewport} screenshot was captured.`; continue; }
    try {
      const r = await analyzeScreenshot({ image, mime: "image/jpeg", viewport: `${views[i]!.viewport} ${views[i]!.width}x${views[i]!.height}`, requirements, diagnostics: summary, files });
      used = { provider: r.provider, model: r.model };
      if (visionBlocks(r.verdict)) {
        const known = r.verdict.suggestedFiles.filter((f) => files.includes(f));
        return { status: "FAIL", verdict: { ...r.verdict, suggestedFiles: known, evidence: [`(${views[i]!.viewport} screenshot)`, ...r.verdict.evidence] }, deterministic: false, vision: used };
      }
    } catch (e) {
      if (e instanceof VisionUnavailable) { note = e.message.slice(0, 500); break; }
      throw e;
    }
  }
  if (!used) return { status: "PASS", verdict: pass("Rendered with no runtime errors; the visual AI check could not run."), deterministic: true, vision: null, visionNote: note || "No screenshot captured." };
  return { status: "PASS", verdict: pass("Rendered correctly with no runtime errors, and the visual check passed."), deterministic: false, vision: used, ...(note ? { visionNote: note } : {}) };
}
