import { describe, expect, it } from "vitest";
import { completePlan, manifestPrompt, remainingPlanned, stackFiles } from "./scaffold";

const plan = { title: "Bakery", create: ["src/pages/HomePage.tsx", "src/components/Hero.tsx", "src/components/Hero.css", "public/index.html"], modify: [], pages: [] };

describe("first-pass scaffold", () => {
  it("completes a fresh React plan with every stack file and the project convention", () => {
    const p = completePlan(plan, []);
    expect(p.create).toEqual(expect.arrayContaining(["src/pages/home/index.tsx", "src/components/Hero.tsx", "src/styles/index.css", "index.html", "package.json", "vite.config.ts", "tsconfig.json", "src/main.tsx", "src/App.tsx"]));
    expect(p.create).not.toContain("src/components/Hero.css");
  });
  it("leaves existing projects' stack alone", () => {
    const p = completePlan({ ...plan, create: ["src/components/Faq.tsx"], modify: ["src/App.tsx", "src/Nope.tsx"] }, ["package.json", "src/App.tsx"]);
    expect(p.create).toEqual(["src/components/Faq.tsx"]);
    expect(p.modify).toEqual(["src/App.tsx"]);
  });
  it("writes deterministic, linked stack config only for missing files", () => {
    const f = stackFiles(completePlan(plan, []), [], "Sweet <Bakery>");
    const main = f.find((x) => x.path === "src/main.tsx")!.content;
    expect(main).toContain('import "./styles/index.css"');
    expect(main).toContain('import App from "./App"');
    expect(f.find((x) => x.path === "index.html")!.content).toContain('src="/src/main.tsx"');
    expect(stackFiles(plan, ["package.json"], "x")).toEqual([]);
  });
  it("tracks remaining planned files and orders the manifest styles-first", () => {
    const p = completePlan(plan, []);
    const done = stackFiles(p, [], "B").map((x) => x.path);
    const left = remainingPlanned(p, done);
    expect(left).toEqual(expect.arrayContaining(["src/App.tsx", "src/styles/index.css", "src/components/Hero.tsx"]));
    expect(left).not.toContain("package.json");
    const m = manifestPrompt(p, done, done);
    expect(m.indexOf("src/styles/index.css")).toBeLessThan(m.indexOf("src/components/Hero.tsx"));
  });
});
