// Smart planning (deterministic, no AI): decide whether a request needs a plan the user must approve.
//   provided  — the user wrote a structured plan: follow it (translated to files, no new plan), start immediately.
//   direct    — a clear, focused change to an existing project: no plan call at all, start building.
//   auto      — a clear new build: an internal file plan (needed for first-pass generation), started without approval.
//   review    — ambiguous, vague or very large request: show the plan and wait for approval.
export type PlanMode = "provided" | "direct" | "auto" | "review";

const LIST_LINE = /^\s*(?:\d{1,2}[.)]|[-*•]|#{1,4}\s|step\s*\d+\s*[:.)-])/i;
const VAGUE = /\b(something|anything|whatever|not sure|no idea|surprise me|any ideas?|make it (?:better|nicer|good|cool|pop)|improve (?:it|this|everything)|fix everything|do (?:your|the) best)\b/i;

/** True when the prompt already contains the user's own structured plan. */
export function hasUserPlan(prompt: string): boolean {
  const lines = prompt.split(/\r?\n/).filter((l) => l.trim());
  const items = lines.filter((l) => LIST_LINE.test(l)).length;
  return prompt.length >= 120 && items >= 3;
}

export function planMode(prompt: string, o: { fileCount: number; forceReview?: boolean }): PlanMode {
  const text = prompt.trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  if (o.forceReview) return "review";
  if (hasUserPlan(text)) return "provided";
  if (VAGUE.test(text) || words < 4 || (o.fileCount === 0 && words < 6)) return "review";
  if (o.fileCount > 0) return words <= 60 ? "direct" : "auto";
  return words > 400 ? "review" : "auto";
}
