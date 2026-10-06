import { describe, it, expect } from "vitest";
import { applyEdit, readTarget, TargetError } from "./target";
import { Sandbox } from "../core/sandbox";
import { createContext } from "../core/context";
import { memoryBackend } from "../storage/persistence";
import { MemoryFileStore } from "../workspace/workspace";
import { loadTools, ToolSession } from "../../cloudflare/tools/index";

const fifty = Array.from({ length: 55 }, (_, i) => `line ${i + 1}`).join("\n");
const TSX = `import "./index.css";

export function Header() {
  return <header className="top"><a href="/">Home</a></header>;
}

export const Hero = () => (
  <section className="hero big">
    <h1 className="hero-title">Coffee</h1>
    <a href="/">Home</a>
  </section>
);

export function Footer() {
  return <footer><a href="/">Home</a></footer>;
}
`;
const CSS = `body { margin: 0; }
/* hero */
.hero-title { font-size: 2rem; color: #000; }
.hero { padding: 4rem; }
@media (max-width: 600px) {
  .hero-title { font-size: 1.2rem; }
}
.footer { color: #fff; }
`;

describe("targeted edits", () => {
  it("Test 3: replaces only lines 25-30", () => {
    const r = applyEdit(fifty, "a.txt", { lines: { start: 25, end: 30 } }, "NEW A\nNEW B");
    const before = fifty.split("\n"), after = r.next.split("\n");
    expect(after.slice(0, 24)).toEqual(before.slice(0, 24));
    expect(after.slice(24, 26)).toEqual(["NEW A", "NEW B"]);
    expect(after.slice(26)).toEqual(before.slice(30));
  });

  it("Test 4: edits one React component, others untouched", () => {
    const r = applyEdit(TSX, "src/App.tsx", { symbol: "Hero" }, `export const Hero = () => (\n  <section className="hero"><h1>Fresh</h1></section>\n);`);
    expect(r.next).toContain("<h1>Fresh</h1>");
    expect(r.next.slice(0, r.next.indexOf("export const Hero"))).toBe(TSX.slice(0, TSX.indexOf("export const Hero")));
    expect(r.next.slice(r.next.indexOf("export function Footer"))).toBe(TSX.slice(TSX.indexOf("export function Footer")));
    // JSX targeting by tag.class
    const j = applyEdit(TSX, "src/App.tsx", { jsx: "h1.hero-title" }, `<h1 className="hero-title">Tea</h1>`);
    expect(j.next.replace("Tea", "Coffee")).toBe(TSX);
  });

  it("Test 5: edits one CSS rule (and only the mobile one when media is given)", () => {
    const r = applyEdit(CSS, "src/index.css", { selector: ".hero-title" }, ".hero-title { font-size: 3rem; color: #000; }");
    expect(r.next).toBe(CSS.replace("2rem", "3rem"));
    const m = applyEdit(CSS, "src/index.css", { selector: ".hero-title", media: "max-width: 600px" }, ".hero-title { font-size: 1rem; }");
    expect(m.next).toBe(CSS.replace("1.2rem", "1rem"));
    expect(readTarget(CSS, "src/index.css", { selector: ".hero" }, 0).text).toBe(".hero { padding: 4rem; }");
  });

  it("Test 6: duplicate text is refused, then resolved by scope — the right occurrence only", () => {
    expect(() => applyEdit(TSX, "src/App.tsx", { find: "Home" }, "Start")).toThrow(TargetError);
    try { applyEdit(TSX, "src/App.tsx", { find: "Home" }, "Start"); } catch (e) { expect((e as TargetError).code).toBe("AMBIGUOUS"); }
    const r = applyEdit(TSX, "src/App.tsx", { symbol: "Footer", find: "Home" }, "Start");
    expect(r.next.match(/Home/g)!.length).toBe(2);
    expect(r.next).toContain("<footer><a href=\"/\">Start</a></footer>");
    // partial words are never edited
    expect(() => applyEdit("const Homeme = 1;\n", "a.ts", { find: "Home" }, "X")).toThrow(/longer word/);
  });

  it("Test 7: second edit finds its target after the first shifted line numbers", () => {
    const first = applyEdit(fifty, "a.txt", { lines: { start: 5, end: 5 } }, "a\nb\nc\nd");
    // the caller read "line 40" at line 40 before the first edit; now it is at line 43
    const second = applyEdit(first.next, "a.txt", { lines: { start: 40, end: 40 }, expect: "line 40" }, "LINE FORTY");
    expect(second.located.note).toMatch(/43-43/);
    expect(second.next.split("\n")[42]).toBe("LINE FORTY");
    expect(second.next.split("\n")[39]).toBe("line 37");
    // without a unique expected text it refuses instead of guessing
    expect(() => applyEdit(first.next, "a.txt", { lines: { start: 40, end: 40 }, expect: "nope" }, "x")).toThrow(/no longer contain/);
  });

  it("Test 8: large change assembled in chunks against the current file", () => {
    let cur = `export function A() { return 1; }\n`;
    for (let c = 0; c < 5; c++) {
      const chunk = Array.from({ length: 25 }, (_, i) => `export const v${c}_${i} = ${c * 25 + i};`).join("\n");
      cur = applyEdit(cur, "src/big.ts", {}, chunk, "append").next;
    }
    cur = applyEdit(cur, "src/big.ts", { symbol: "A" }, "export function B() { return 0; }", "after").next;
    const lines = cur.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(127);
    expect(lines[1]).toBe("export function B() { return 0; }");
    expect(cur).toContain("export const v4_24 = 124;");
  });
});

describe("update_file tool (integrity + build)", () => {
  it("Test 9: refuses syntax-breaking edits, applies valid ones, project still validates", async () => {
    loadTools();
    const store = new MemoryFileStore();
    store.set({ path: "index.html", content: `<!DOCTYPE html><html><head><link rel="stylesheet" href="style.css"></head><body><h1 class="t">Hi</h1></body></html>`, encoding: "utf8", updatedAt: 0 });
    store.set({ path: "style.css", content: CSS, encoding: "utf8", updatedAt: 0 });
    const ops = { async start() {}, async finish() {}, async cancelRequested() { return false; } };
    const io = { async load() { return { store, revision: 1 }; }, snapshot: () => null, async commit(_p: string, b: number) { return { revision: b + 1, changed: ["x"] }; }, async revision() { return 1; }, async settings() { return {}; }, async patchSettings() {} };
    const s = new ToolSession({ userId: "u", projectId: "p", ops, io } as never);
    const bad = await s.execute("update_file", { path: "style.css", selector: ".hero", replace: ".hero { padding: 4rem;" });
    expect(bad.success).toBe(false);
    expect(store.get("style.css")!.content).toBe(CSS);
    const ok = await s.execute("update_file", { path: "style.css", selector: ".footer", replace: ".footer { color: #1d4ed8; }" });
    expect(ok.success).toBe(true);
    expect(store.get("style.css")!.content).toBe(CSS.replace(".footer { color: #fff; }", ".footer { color: #1d4ed8; }"));
    const v = await s.execute("verify_project", {});
    expect(v.success).toBe(true);
  });
});

describe("temporary workspace lifecycle", () => {
  const files = (n: string) => [{ path: "index.html", content: `<h1>${n}</h1>`, encoding: "utf8" as const, updatedAt: 1 }];
  it("Tests 1, 2, 10, 11, 12: open → edit → close clears → other project isolated → reopen rebuilds from server", () => {
    const kv = memoryBackend();
    const server: Record<string, ReturnType<typeof files>> = { A: files("A"), B: files("B") };
    // open A: loaded from the server copy
    const a = new Sandbox(createContext("A", "u"), kv); a.start();
    a.replaceLocal(server.A!, []);
    expect(a.read("index.html").content).toBe("<h1>A</h1>");
    a.write("index.html", "<h1>A2</h1>");
    server.A = files("A2"); // the existing sync sends the edit to the server
    a.write("tmp.txt", "scratch");
    a.save({});
    expect(kv.get("speed.sandbox.A.state")).not.toContain("A2");
    // close A
    a.clearTemporary(); a.dispose();
    expect(a.workspace.files.list()).toHaveLength(0);
    expect(a.output.list()).toHaveLength(0);
    // open B: nothing of A leaks
    const b = new Sandbox(createContext("B", "u"), kv); b.start();
    expect(b.workspace.files.list()).toHaveLength(0);
    b.replaceLocal(server.B!, []);
    expect(b.workspace.files.list().map((f) => f.content)).toEqual(["<h1>B</h1>"]);
    b.clearTemporary(); b.dispose();
    // reopen A: rebuilt from the server, no stale scratch file
    const a2 = new Sandbox(createContext("A", "u"), kv); a2.start();
    expect(a2.workspace.files.list()).toHaveLength(0);
    a2.replaceLocal(server.A!, []);
    expect(a2.workspace.files.list().map((f) => f.path)).toEqual(["index.html"]);
    expect(a2.read("index.html").content).toBe("<h1>A2</h1>");
  });
});

import { validateJson } from "../intelligence/validate";
describe("tsconfig is JSONC", () => {
  it("accepts comments and trailing commas in tsconfig, still catches a missing comma", () => {
    expect(validateJson("tsconfig.json", `{\n  // c\n  "a": 1, /* x */\n  "b": [1,],\n}`)).toEqual([]);
    expect(validateJson("tsconfig.json", `{ "a": 1\n "b": 2 }`).length).toBe(1);
    expect(validateJson("package.json", `{ "a": 1, }`).length).toBe(1);
  });
});
