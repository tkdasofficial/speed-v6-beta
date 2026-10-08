// Persistent recovery (pure): the working stage keeps going while repairs make progress, and stops only when the same
// failure keeps coming back unchanged (genuinely unrecoverable) or a high safety ceiling is reached. No fixed "3 tries".
export const RECOVERY = {
  /** Safety ceiling on build rounds; the stall detector normally ends work long before this. */
  maxRounds: 60,
  /** Safety ceiling on repair attempts of one kind (check, validation, preview). */
  maxAttempts: 12,
  /** The same failure this many times in a row, with no change, means the fix strategy is not working. */
  sameFailureLimit: 3,
  /** Rounds in a row with no file change and no new result before the build stage moves on. */
  stallRounds: 4,
};

/** A stable fingerprint of a failure: error codes, files and the message with volatile parts (ids, numbers) removed. */
export function failureSignature(text: string): string {
  const codes = [...new Set([...text.matchAll(/"code":"([A-Z_]+)"/g)].map((m) => m[1]!))].sort();
  const files = [...new Set([...text.matchAll(/"file":"([^"]+)"/g)].map((m) => m[1]!))].sort();
  const msg = text.replace(/op_[a-z0-9_]+/gi, "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 160);
  return codes.length || files.length ? `${codes.join(",")}|${files.join(",")}` : msg;
}

/** Records one failure; `unrecoverable` when it repeats unchanged or the safety ceiling is reached. */
export function trackFailure(history: readonly string[] | undefined, sig: string): { history: string[]; attempt: number; unrecoverable: boolean; repeated: boolean } {
  const h = [...(history ?? []), sig].slice(-RECOVERY.maxAttempts);
  const attempt = (history?.length ?? 0) + 1;
  const tail = h.slice(-RECOVERY.sameFailureLimit);
  const repeated = tail.length === RECOVERY.sameFailureLimit && tail.every((x) => x === sig);
  return { history: h, attempt, repeated, unrecoverable: repeated || attempt >= RECOVERY.maxAttempts };
}
