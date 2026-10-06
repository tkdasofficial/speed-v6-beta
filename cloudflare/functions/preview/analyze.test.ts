import { describe, it, expect } from "vitest";
import { deterministicVerdict, parseVerdict, visionBlocks, type PreviewDiag, type ViewDiag } from "./analyze";

const view = (o: Partial<ViewDiag> = {}, dom: Partial<NonNullable<ViewDiag["dom"]>> = {}): ViewDiag => ({
  viewport: "desktop", width: 1440, height: 900, loaded: true, loadError: null, status: 200, consoleErrors: [], consoleWarnings: [], pageErrors: [], failedRequests: [],
  dom: { title: "Cafe", bodyText: "Brew Haven", bodyTextLength: 400, rootFound: true, rootChildren: 1, visibleElements: 60, horizontalOverflow: false, scrollWidth: 1440, viewportWidth: 1440, ...dom }, ...o,
});
const diag = (...views: ViewDiag[]): PreviewDiag => ({ stage: "captured", views });

describe("preview deterministic gate", () => {
  it("passes a rendered page", () => expect(deterministicVerdict(diag(view(), view({ viewport: "mobile", width: 390 }, { viewportWidth: 390, scrollWidth: 390 })))).toBeNull());
  it("blank screen is critical", () => expect(deterministicVerdict(diag(view({}, { bodyTextLength: 0, visibleElements: 0, rootChildren: 0 })))).toMatchObject({ status: "FAIL", issueType: "blank_screen", severity: "critical" }));
  it("runtime error wins over blank and names the file", () => {
    const v = deterministicVerdict(diag(view({ pageErrors: ["ReferenceError: Hero is not defined\n at src/components/Hero.tsx:4"] }, { bodyTextLength: 0, visibleElements: 0, rootChildren: 0 })));
    expect(v).toMatchObject({ issueType: "runtime_error" });
    expect((v as { suggestedFiles: string[] }).suggestedFiles).toContain("src/components/Hero.tsx");
  });
  it("build failure", () => expect(deterministicVerdict({ stage: "build", error: "src/App.tsx:3:1 error" })).toMatchObject({ issueType: "build_error" }));
  it("missing local asset", () => expect(deterministicVerdict(diag(view({ failedRequests: [{ url: "http://127.0.0.1:4173/logo.png", status: 404, error: null, type: "image" }] })))).toMatchObject({ issueType: "broken_assets" }));
  it("mobile overflow", () => expect(deterministicVerdict(diag(view(), view({ viewport: "mobile", width: 390 }, { viewportWidth: 390, scrollWidth: 900, horizontalOverflow: true })))).toMatchObject({ issueType: "overflow" }));
  it("infrastructure failure is unverifiable, not a code defect", () => expect(deterministicVerdict({ stage: "browser", error: "install failed" })).toEqual({ unverifiable: "install failed" }));
});

describe("vision verdict parsing", () => {
  it("parses and clamps", () => {
    const v = parseVerdict('ok {"status":"fail","severity":"high","issueType":"missing_content","diagnosis":"No footer","confidence":3}');
    expect(v).toMatchObject({ status: "FAIL", issueType: "missing_content", confidence: 1 });
    expect(visionBlocks(v!)).toBe(true);
  });
  it("low-severity or unsure FAIL does not block", () => expect(visionBlocks(parseVerdict('{"status":"FAIL","severity":"low","confidence":0.9}')!)).toBe(false));
  it("rejects garbage", () => expect(parseVerdict("looks fine")).toBeNull());
});
