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

import { validateViteSetup } from "../../sandbox/intelligence/validate";
describe("vite setup", () => {
  const mk = (files: Record<string, string>) => { const m = new Map(Object.entries(files).map(([p, c]) => [p, { path: p, content: c, encoding: "utf8" }])); return { get: (p: string) => m.get(p), list: () => [...m.values()] } as never; };
  const base = { "package.json": '{"dependencies":{"react":"18","react-router-dom":"6"}}', "src/main.tsx": 'import App from "./App";\nimport "./styles/index.css";', "src/styles/index.css": "@tailwind base;\n@tailwind utilities;" };
  it("flags unconfigured tailwind and an unmounted router", () => {
    const r = validateViteSetup(mk({ ...base, "src/App.tsx": "export default () => <Outlet />", "src/routes.tsx": "createBrowserRouter([])" })).map((x) => x.code);
    expect(r).toEqual(["TAILWIND_NOT_CONFIGURED", "ROUTER_NOT_MOUNTED"]);
  });
  it("passes a fully set-up project", () => {
    const ok = mk({ ...base, "package.json": '{"dependencies":{"react":"18"},"devDependencies":{"tailwindcss":"^3.4.0","postcss":"8","autoprefixer":"10"}}', "tailwind.config.js": "", "postcss.config.js": "", "src/App.tsx": 'import R from "./routes";\nexport default () => <R />', "src/routes.tsx": "export default () => <Routes></Routes>" });
    expect(validateViteSetup(ok)).toEqual([]);
  });
});

import { validateTsxSyntax } from "../../sandbox/intelligence/validate";
describe("use before init", () => {
  it("flags a const read before its declaration at module level only", () => {
    const bad = validateTsxSyntax("src/mock/data.ts", "export const mockData = { transactions: MOCK_TRANSACTIONS };\nexport const MOCK_TRANSACTIONS = [];");
    expect(bad.map((x) => x.code)).toContain("USE_BEFORE_INIT");
    const ok = validateTsxSyntax("src/a.tsx", "export const get = () => LATER;\nconst o = { LATER: 1 };\nexport const LATER = 2;\nfunction f() { return LATER; }");
    expect(ok.filter((x) => x.code === "USE_BEFORE_INIT")).toEqual([]);
  });
});

import { fixUseBeforeInit } from "../../sandbox/intelligence/validate";
describe("fixUseBeforeInit", () => {
  it("moves a late declaration above its first use and leaves correct files alone", () => {
    const src = "export interface T { a: number }\nexport const mockData = {\n  transactions: MOCK_TRANSACTIONS,\n};\n\nexport const MOCK_TRANSACTIONS: T[] = [\n  { a: 1 },\n];\n";
    const out = fixUseBeforeInit("src/mock/data.ts", src)!;
    expect(out.indexOf("export const MOCK_TRANSACTIONS")).toBeLessThan(out.indexOf("export const mockData"));
    expect(validateTsxSyntax("src/mock/data.ts", out)).toEqual([]);
    expect(fixUseBeforeInit("src/a.ts", "export const A = 1;\nexport const B = A;")).toBeNull();
  });
});

import { validateViteStyles } from "../../sandbox/intelligence/validate";
import { styleVerdict } from "../functions/preview/analyze";
describe("style wiring", () => {
  const mk = (files: Record<string, string>) => { const m = new Map(Object.entries(files).map(([path, content]) => [path, { path, content, encoding: "utf8" as const, updatedAt: 0 }])); return { get: (p: string) => m.get(p), list: () => [...m.values()] } as any; };
  const pkg = JSON.stringify({ dependencies: { react: "^18" }, devDependencies: { vite: "^5" } });
  const app = 'export default function App(){return <div className="hero"><h1 className="title">Hi</h1></div>}';
  it("flags CSS that is never imported, and passes once main.tsx imports it", () => {
    const bad = validateViteStyles(mk({ "package.json": pkg, "src/main.tsx": 'import App from "./App";', "src/App.tsx": app, "src/styles/index.css": ".hero{}.title{}" })).map((x) => x.code);
    expect(bad).toContain("STYLE_NOT_IMPORTED");
    expect(bad).toContain("NO_STYLESHEET");
    expect(validateViteStyles(mk({ "package.json": pkg, "src/main.tsx": 'import App from "./App";\nimport "./styles/index.css";', "src/App.tsx": app, "src/styles/index.css": ".hero{}.title{}" }))).toEqual([]);
  });
  it("flags Tailwind classes without Tailwind and missing CSS-module keys", () => {
    const tw = 'export default function App(){return <div className="flex p-4 bg-white text-lg rounded-lg shadow-md gap-2 items-center justify-between">x</div>}';
    expect(validateViteStyles(mk({ "package.json": pkg, "src/main.tsx": 'import App from "./App";\nimport "./index.css";', "src/App.tsx": tw, "src/index.css": "body{margin:0}" })).map((x) => x.code)).toContain("TAILWIND_CLASSES_WITHOUT_TAILWIND");
    const mod = validateViteStyles(mk({ "package.json": pkg, "src/main.tsx": 'import App from "./App";', "src/App.tsx": 'import s from "./App.module.css";\nexport default function App(){return <div className={s.card}/>}', "src/App.module.css": ".box{}" }));
    expect(mod.map((x) => x.code)).toContain("CSS_MODULE_CLASS_MISSING");
  });
  it("browser gate fails an unstyled page and passes a styled one", () => {
    const st = (o: object) => ({ stage: "captured", build: { cssAssets: [] }, views: [{ viewport: "desktop", width: 1, height: 1, loaded: true, loadError: null, status: 200, consoleErrors: [], consoleWarnings: [], pageErrors: [], failedRequests: [], dom: { styles: { sheets: 0, rules: 0, unreadable: 0, links: [], classCount: 12, unmatchedClasses: [], unmatchedCount: 12, bodyMargin: "8px", bodyFont: "Times New Roman", bodyBg: "", defaultLinkColor: true, defaultButton: true, ...o } } }] }) as any;
    expect(styleVerdict(st({}))?.issueType).toBe("unstyled");
    const ok = st({ sheets: 1, rules: 120, unmatchedCount: 1, bodyMargin: "0px", bodyFont: "Inter" }); ok.build.cssAssets = [{ file: "assets/index.css", bytes: 4000 }];
    expect(styleVerdict(ok)).toBeNull();
  });
});
