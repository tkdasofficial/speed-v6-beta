// Visual Analyzer Provider: sends one screenshot + browser diagnostics + the user's request to the first available
// vision-capable model (models.ts VISION_CHAIN; only those targets ever receive images) and returns a validated
// structured verdict. Provider failures fall through to the next model; keys never leave the Worker.
import { envStr } from "../context";
import { PROVIDERS, VISION_CHAIN, type VisionTarget } from "./models";
import { parseVerdict, type VisualVerdict } from "../preview/analyze";

export interface VisionInput { image: string; mime: "image/jpeg"; viewport: string; requirements: string; diagnostics: string; files: string[] }
export interface VisionResult { verdict: VisualVerdict; provider: string; model: string; latencyMs: number; attempts: { model: string; reason: string }[] }
export class VisionUnavailable extends Error { constructor(public attempts: { model: string; reason: string }[]) { super(`No vision model available: ${attempts.map((a) => `${a.model} (${a.reason})`).join("; ")}`); } }

const SYSTEM = `You verify that a generated web app actually works, by looking at a real browser screenshot plus runtime diagnostics.
Judge function, not taste. PASS when the app is visibly rendered and nothing significant prevents the requested app from working.
FAIL only with concrete evidence: blank page, error message shown, main content or a requested section missing, layout collapsed,
severe overlap, text clipped/unreadable, broken images, stuck loading, unusable navigation, sideways overflow on mobile.
Check only requirements the user actually asked for; never invent requirements; ignore small design imperfections.
Reply with ONLY one JSON object:
{"status":"PASS"|"FAIL","severity":"none"|"low"|"medium"|"high"|"critical","issueType":"none"|"blank_screen"|"runtime_error"|"broken_layout"|"missing_content"|"overflow"|"broken_assets"|"visual_defect"|"loading_stuck"|"navigation_failure"|"unknown","diagnosis":"one or two sentences","evidence":["what you see"],"suggestedFiles":["project paths from the file list"],"suggestedFix":"short concrete fix","confidence":0.0-1.0}`;

const failures = new Map<string, number>(); // provider → cool-down until (refused key / rate limit)

async function callVision(t: VisionTarget, input: VisionInput): Promise<string> {
  if ((failures.get(t.provider) ?? 0) > Date.now()) throw new Error("cooling down after a recent refusal");
  const key = envStr(PROVIDERS[t.provider].secret);
  if (!key) throw new Error("not configured");
  const user = `User request:\n${input.requirements.slice(0, 2000)}\n\nViewport: ${input.viewport}\n\nBrowser diagnostics:\n${input.diagnostics.slice(0, 3500)}\n\nProject files:\n${input.files.slice(0, 60).join(", ")}`;
  const res = await fetch(PROVIDERS[t.provider].url, {
    method: "POST", signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: t.id, max_tokens: t.maxOut, temperature: 0.1,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: [{ type: "text", text: user }, { type: "image_url", image_url: { url: `data:${input.mime};base64,${input.image}` } }] }],
    }),
  }).catch((e: Error) => { throw new Error(e.name === "TimeoutError" ? "timeout" : "connection failed"); });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) failures.set(t.provider, Date.now() + 10 * 60_000);
    else if (res.status === 429) failures.set(t.provider, Date.now() + 60_000);
    throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160)}`);
  }
  const j = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
  return (j.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export async function analyzeScreenshot(input: VisionInput, chain: VisionTarget[] = VISION_CHAIN): Promise<VisionResult> {
  const attempts: { model: string; reason: string }[] = [];
  for (const t of chain) {
    if (!t.image) continue; // never send an image to a model without confirmed image input
    const t0 = Date.now();
    try {
      const text = await callVision(t, input);
      const verdict = parseVerdict(text);
      if (!verdict) { attempts.push({ model: `${t.provider}/${t.id}`, reason: `unusable reply (${text.slice(0, 80)})` }); continue; }
      return { verdict, provider: t.provider, model: t.id, latencyMs: Date.now() - t0, attempts };
    } catch (e) { attempts.push({ model: `${t.provider}/${t.id}`, reason: (e as Error).message.slice(0, 200) }); }
  }
  throw new VisionUnavailable(attempts);
}

/** Test hook. */
export const resetVisionCooldowns = () => failures.clear();
