import { describe, it, expect } from "vitest";
import { designTokens, impactNote } from "./context";
describe("phase 2 context helpers", () => {
  it("summarizes existing design tokens from the shared stylesheet", () => {
    const t = designTokens([{ path: "src/styles/index.css", content: ":root{--brand:#1d4ed8;--radius:12px}body{font-family:Manrope,sans-serif}@media (max-width: 640px){.a{b:c}}" }]);
    expect(t).toContain("--brand: #1d4ed8"); expect(t).toContain("Manrope"); expect(t).toContain("max-width: 640px");
    expect(designTokens([{ path: "a.ts", content: "" }])).toBe("");
  });
  it("lists users of changed files as check-only impact", () => {
    const n = impactNote(["src/components/Header.tsx"], () => ({ usedBy: ["src/App.tsx"], uses: ["src/styles/index.css"] }));
    expect(n).toMatch(/used by: src\/App.tsx/); expect(n).toMatch(/ONLY if a real problem/);
  });
});
