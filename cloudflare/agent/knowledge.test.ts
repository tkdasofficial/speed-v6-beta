import { describe, expect, it } from "vitest";
import components from "./knowledge/components.json";
import architecture from "./knowledge/architecture.json";
import { buildKnowledgePlan, identifyComponents, indexKnowledge, knowledgeText, loadKnowledge, validateKnowledge, architectureFor } from "./agent";

const kb = { components, architecture };
const ix = indexKnowledge(kb);

describe("knowledge engine (agent.ts)", () => {
  it("datasets satisfy their own schemas", () => { expect(validateKnowledge(kb)).toEqual([]); });
  it("architecture KB names the component App Drawer, keeping 'sidebar' only as user terminology", () => {
    const e = (architecture as any).entities.find((x: any) => x.id === "app-drawer");
    expect(JSON.stringify([e.implementations, e.variations, e.examples, e.placement])).not.toMatch(/sidebar/i);
    expect(e.aliases).toContain("sidebar");
  });
  it("resolves aliases and semantic terms to canonical names", () => {
    const r = identifyComponents("Add a sidebar with a left menu, a popup for login and a date picker", ix).map((c) => c.canonical);
    expect(r).toContain("App Drawer");
    expect(r).toContain("Date Picker");
    expect(r).not.toContain("Calendar");
  });
  it("combines WHAT (component KB) with WHERE/HOW (architecture KB)", () => {
    const p = buildKnowledgePlan("make a dashboard with a sidebar and cards", ix);
    const d = p.components.find((c) => c.canonical === "App Drawer")!;
    expect(d.what.length).toBeGreaterThan(20);
    expect(d.placement?.preferred.join(" ")).toMatch(/desktop application shell/);
    expect(d.ambiguity).toMatch(/primary application navigation/);
    expect(architectureFor("button", ix)?.id).toBe("button");
    const t = knowledgeText(p);
    expect(t).toMatch(/App Drawer \(user said "sidebar"\)/);
    expect(t.length).toBeLessThanOrEqual(3200);
  });
  it("loads both knowledge bases from the Agent D1 table", async () => {
    const rows = [{ id: "component-identifier", content_json: JSON.stringify(components) }, { id: "web-architecture-infrastructure", content_json: JSON.stringify(architecture) }];
    const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } as any;
    const l = await loadKnowledge(db);
    expect(identifyComponents("hamburger menu", l!).length).toBeGreaterThan(0);
  });
});
