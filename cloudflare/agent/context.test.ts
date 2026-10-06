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

import { structureIssues } from "../../sandbox/intelligence/validate";
describe("structureIssues", () => {
  const mk = (paths: string[]) => { const m = new Map(paths.map((p) => [p, { path: p, content: p === "package.json" ? '{"devDependencies":{"vite":"5"}}' : "x", encoding: "utf8" }])); return { get: (p: string) => m.get(p), list: () => [...m.values()] } as never; };
  it("flags wrong page/css paths only among created files", () => {
    const s = mk(["package.json", "vite.config.ts", "index.html", "src/main.tsx", "src/App.tsx", "src/styles.css", "src/pages/About.tsx", "src/Hero.tsx", "src/pages/home/index.tsx", "src/styles/index.css", "src/old.css"]);
    const r = structureIssues(s, ["src/main.tsx", "src/App.tsx", "src/styles.css", "src/pages/About.tsx", "src/Hero.tsx", "src/pages/home/index.tsx", "src/styles/index.css"]);
    expect(r.length).toBe(3); expect(structureIssues(s, ["src/main.tsx"]).length).toBe(0);
    expect(r.join()).toContain("src/pages/about/index.tsx");
    expect(r.join()).not.toContain("old.css");
  });
});

import { validateViteDeps } from "../../sandbox/intelligence/validate";
import { deterministicVerdict } from "../functions/preview/analyze";
describe("undeclared packages", () => {
  const mk = (files: Record<string, string>) => { const m = new Map(Object.entries(files).map(([p, c]) => [p, { path: p, content: c, encoding: "utf8" }])); return { get: (p: string) => m.get(p), list: () => [...m.values()] } as never; };
  it("flags bare imports missing from package.json, ignores declared/relative/subpaths/types", () => {
    const s = mk({ "package.json": '{"dependencies":{"react":"18","react-dom":"18","@tanstack/query":"1"}}', "src/App.tsx": 'import { Link } from "react-router-dom";\nimport x from "react-dom/client";\nimport "./a.css";\nimport type { T } from "zod";\nimport q from "@tanstack/query/core";\nconst L = import("lodash");' });
    const r = validateViteDeps(s).map((x) => x.message).join("\n");
    expect(r).toContain('"react-router-dom"'); expect(r).toContain('"lodash"');
    expect(r).not.toContain("react-dom\""); expect(r).not.toContain("zod"); expect(r).not.toContain("tanstack");
  });
  it("preview build failure on an unresolved package points at package.json", () => {
    const v = deterministicVerdict({ stage: "build", error: '[vite]: Rollup failed to resolve import "react-router-dom" from "/w/src/App.tsx".' }) as { suggestedFiles: string[]; diagnosis: string };
    expect(v.suggestedFiles[0]).toBe("package.json"); expect(v.diagnosis).toContain("react-router-dom");
  });
});
