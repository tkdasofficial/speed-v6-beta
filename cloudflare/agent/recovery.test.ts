import { describe, expect, it } from "bun:test";
import { failureSignature, RECOVERY, trackFailure } from "./recovery";

describe("persistent recovery", () => {
  it("keeps going while the failure changes", () => {
    let h: string[] = [];
    for (const s of ["a", "b", "c", "a", "b"]) { const r = trackFailure(h, s); expect(r.unrecoverable).toBe(false); h = r.history; }
  });
  it("stops when the same failure repeats unchanged", () => {
    let r = trackFailure([], "x"); r = trackFailure(r.history, "x"); expect(r.unrecoverable).toBe(false);
    r = trackFailure(r.history, "x"); expect(r.unrecoverable).toBe(true); expect(r.repeated).toBe(true);
  });
  it("has a safety ceiling", () => {
    const h = Array.from({ length: RECOVERY.maxAttempts - 1 }, (_, i) => `s${i}`);
    expect(trackFailure(h, "new").unrecoverable).toBe(true);
  });
  it("ignores volatile ids and numbers in signatures", () => {
    expect(failureSignature('[op_abc_123] {"code":"TS_SYNTAX_ERROR","file":"src/App.tsx","line":4}')).toBe(failureSignature('[op_zz_9] {"code":"TS_SYNTAX_ERROR","file":"src/App.tsx","line":9}'));
  });
});
