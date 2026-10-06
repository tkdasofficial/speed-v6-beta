// Preview verification result model + deterministic gate. Pure (no IO) so it is unit-tested.
// Deterministic signals (build failure, uncaught errors, blank DOM, failed local assets, overflow) always win over
// the vision model: the screenshot analysis is supporting evidence, never an override of a hard runtime error.

export type IssueType = "none" | "build_error" | "blank_screen" | "runtime_error" | "broken_layout" | "missing_content" | "overflow" | "broken_assets" | "visual_defect" | "loading_stuck" | "navigation_failure" | "unknown";
export type Severity = "none" | "low" | "medium" | "high" | "critical";

export interface VisualVerdict {
  status: "PASS" | "FAIL";
  severity: Severity;
  issueType: IssueType;
  diagnosis: string;
  evidence: string[];
  suggestedFiles: string[];
  suggestedFix: string;
  confidence: number;
}

export interface ViewDiag {
  viewport: string; width: number; height: number; loaded: boolean; loadError: string | null; status: number | null;
  consoleErrors: string[]; consoleWarnings: string[]; pageErrors: string[];
  failedRequests: { url: string; status: number | null; error: string | null; type: string }[];
  dom: null | {
    title?: string; bodyText?: string; bodyTextLength?: number; rootFound?: boolean; rootChildren?: number | null; visibleElements?: number;
    headings?: string[]; hasNav?: boolean; hasFooter?: boolean; images?: number; brokenImages?: string[]; scrollWidth?: number; viewportWidth?: number;
    horizontalOverflow?: boolean; elementsOutsideViewport?: number; errorOverlay?: boolean; evaluateError?: string;
  };
}
export interface PreviewDiag { stage: string; error?: string; url?: string; views?: ViewDiag[] }

/** Final outcome of one verification cycle. `unverifiable` = the check itself could not run (infrastructure), which
 *  is reported honestly and never treated as a code defect to "repair". */
export interface PreviewOutcome {
  status: "PASS" | "FAIL" | "UNVERIFIABLE";
  verdict: VisualVerdict;
  deterministic: boolean;
  vision: { provider: string; model: string } | null;
  visionNote?: string;
}

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;
const FATAL_CONSOLE = /(Uncaught|TypeError|ReferenceError|SyntaxError|RangeError|is not defined|is not a function|Cannot read propert|Failed to fetch dynamically imported module|Minified React error|The above error occurred)/;
const SRC_FILE = /(?:^|[\s(/"'`])((?:src|public)\/[\w@./-]+\.(?:tsx?|jsx?|css|json))/g;

export const pass = (note = ""): VisualVerdict => ({ status: "PASS", severity: "none", issueType: "none", diagnosis: note, evidence: [], suggestedFiles: [], suggestedFix: "", confidence: 1 });
const fail = (issueType: IssueType, severity: Severity, diagnosis: string, evidence: string[], suggestedFix: string, files: string[] = []): VisualVerdict =>
  ({ status: "FAIL", severity, issueType, diagnosis, evidence: evidence.slice(0, 8).map((e) => e.slice(0, 500)), suggestedFiles: [...new Set(files)].slice(0, 4), suggestedFix, confidence: 1 });

/** Source files named in error text (stack traces, build output). */
export function filesIn(text: string): string[] {
  return [...new Set([...text.matchAll(SRC_FILE)].map((m) => m[1]!))];
}

/** Deterministic checks over the captured diagnostics. Returns a FAIL verdict, `null` when nothing is wrong, or
 *  `{ unverifiable }` when the runtime could not produce a preview for reasons outside the project's code. */
export function deterministicVerdict(d: PreviewDiag): VisualVerdict | null | { unverifiable: string } {
  // Dependency install failures caused by the project's package.json (non-existent package/version, peer conflict) are code defects.
  if (/npm (?:error|ERR!) code (?:ETARGET|E404|ERESOLVE|EINVALIDTAGNAME|EJSONPARSE)|No matching version found|is not in this registry/i.test(d.error ?? "")) {
    const pkg = /(?:No matching version found for|'|")(@?[\w./-]+@[^\s.'"]+)/.exec(d.error ?? "")?.[1];
    return fail("build_error", "critical", `Installing the project's dependencies failed${pkg ? ` (${pkg} does not exist)` : ""}, so there is no preview to open.`, [(d.error ?? "").slice(0, 600)], "Fix package.json: remove or correct the package/version that npm cannot install (e.g. drop @types packages for libraries that ship their own types).", ["package.json"]);
  }
  if (d.stage === "build") return fail("build_error", "critical", "The production build failed, so there is no preview to open.", [d.error ?? ""], "Fix the build error shown in the evidence.", filesIn(d.error ?? ""));
  if (d.stage === "server") return fail("navigation_failure", "critical", "The built app could not be served by the preview server.", [d.error ?? ""], "Check vite.config and index.html for invalid configuration.", ["vite.config.ts", "index.html"]);
  if (d.stage !== "captured" || !d.views?.length) return { unverifiable: d.error || `Preview check did not complete (stage: ${d.stage})` };
  const desktop = d.views[0]!;
  const all = d.views;
  if (!desktop.loaded) return fail("navigation_failure", "critical", "The preview page did not load in the browser.", [desktop.loadError ?? "load failed"], "Make sure index.html loads the app entry script.", ["index.html", "src/main.tsx"]);
  const pageErrors = [...new Set(all.flatMap((v) => v.pageErrors))];
  const fatalConsole = [...new Set(all.flatMap((v) => v.consoleErrors.filter((e) => FATAL_CONSOLE.test(e))))];
  const dom = desktop.dom ?? {};
  const blank = !!desktop.dom && ((dom.bodyTextLength ?? 0) === 0 && (dom.visibleElements ?? 0) < 3 || dom.rootChildren === 0);
  if (pageErrors.length || fatalConsole.length || dom.errorOverlay) {
    const ev = [...pageErrors, ...fatalConsole];
    return fail("runtime_error", "critical", `${blank ? "The page is blank because the app crashed" : "The app throws a runtime error"} in the browser: ${ev[0]?.split("\n")[0] ?? "error overlay shown"}`, ev, "Fix the runtime error at its source (the component or module named in the error).", [...filesIn(ev.join("\n")), ...(blank ? ["src/main.tsx", "src/App.tsx"] : [])]);
  }
  if (blank) return fail("blank_screen", "critical", "The page renders blank: the React app did not mount any visible content.", [`visible elements: ${dom.visibleElements ?? 0}`, `root children: ${dom.rootChildren ?? "n/a"}`, `text length: ${dom.bodyTextLength ?? 0}`], "Check that src/main.tsx renders <App /> into #root and that App returns visible content.", ["src/main.tsx", "src/App.tsx", "index.html"]);
  const badLocal = all.flatMap((v) => v.failedRequests).filter((r) => LOCAL.test(r.url) && /^(script|stylesheet|document|image|font)$/.test(r.type));
  if (badLocal.length) {
    const paths = [...new Set(badLocal.map((r) => r.url.replace(LOCAL, "/")))];
    return fail("broken_assets", "high", `The app requests files that do not exist: ${paths.slice(0, 3).join(", ")}`, badLocal.map((r) => `${r.status ?? r.error} ${r.url.replace(LOCAL, "/")}`), "Fix the asset paths (files in public/ are referenced from /, files in src/ must be imported).", [...filesIn(paths.join(" ")), "index.html"]);
  }
  const mobile = all.find((v) => v.viewport === "mobile");
  if (mobile?.dom?.horizontalOverflow && (mobile.dom.scrollWidth ?? 0) > (mobile.dom.viewportWidth ?? 390) + 40) {
    return fail("overflow", "medium", `On mobile the page is ${mobile.dom.scrollWidth}px wide for a ${mobile.dom.viewportWidth}px screen, so it scrolls sideways.`, [`${mobile.dom.elementsOutsideViewport ?? 0} elements extend past the right edge`], "Remove fixed widths wider than the screen; use max-width:100%, flex-wrap and responsive units.", []);
  }
  return null;
}

/** Validates/clamps a vision model reply into a verdict; null when the reply is not a usable verdict. */
export function parseVerdict(text: string): VisualVerdict | null {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>; } catch { return null; }
  const status = String(o["status"] ?? "").toUpperCase();
  if (status !== "PASS" && status !== "FAIL") return null;
  const types: IssueType[] = ["none", "build_error", "blank_screen", "runtime_error", "broken_layout", "missing_content", "overflow", "broken_assets", "visual_defect", "loading_stuck", "navigation_failure", "unknown"];
  const sev: Severity[] = ["none", "low", "medium", "high", "critical"];
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 300)).slice(0, 6) : []);
  const conf = Number(o["confidence"]);
  return {
    status,
    severity: sev.includes(o["severity"] as Severity) ? (o["severity"] as Severity) : status === "PASS" ? "none" : "medium",
    issueType: types.includes(o["issueType"] as IssueType) ? (o["issueType"] as IssueType) : status === "PASS" ? "none" : "unknown",
    diagnosis: String(o["diagnosis"] ?? "").slice(0, 600),
    evidence: arr(o["evidence"]),
    suggestedFiles: arr(o["suggestedFiles"]).filter((f) => /^[\w@./-]+\.\w+$/.test(f)),
    suggestedFix: String(o["suggestedFix"] ?? "").slice(0, 600),
    confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.5,
  };
}

/** A vision FAIL blocks completion only with concrete, confident evidence of a functional problem (not taste). */
export function visionBlocks(v: VisualVerdict): boolean {
  return v.status === "FAIL" && (v.severity === "high" || v.severity === "critical") && v.confidence >= 0.6;
}

/** Compact text summary of diagnostics for prompts (never includes screenshots). */
export function diagSummary(d: PreviewDiag): string {
  return (d.views ?? []).map((v) => {
    const dom = v.dom ?? {};
    return [`[${v.viewport} ${v.width}x${v.height}] loaded=${v.loaded} title=${JSON.stringify(dom.title ?? "")}`,
      `visibleElements=${dom.visibleElements ?? "?"} rootChildren=${dom.rootChildren ?? "?"} textLength=${dom.bodyTextLength ?? "?"} nav=${dom.hasNav ?? "?"} footer=${dom.hasFooter ?? "?"} overflow=${dom.horizontalOverflow ?? "?"} (scrollWidth ${dom.scrollWidth ?? "?"})`,
      `headings: ${(dom.headings ?? []).join(" | ").slice(0, 400)}`,
      `visible text: ${(dom.bodyText ?? "").slice(0, 700)}`,
      v.pageErrors.length ? `page errors: ${v.pageErrors.join(" || ").slice(0, 600)}` : "page errors: none",
      v.consoleErrors.length ? `console errors: ${v.consoleErrors.join(" || ").slice(0, 600)}` : "console errors: none",
      v.failedRequests.length ? `failed requests: ${v.failedRequests.map((r) => `${r.status ?? r.error} ${r.url}`).join(" | ").slice(0, 500)}` : "failed requests: none",
      dom.brokenImages?.length ? `broken images: ${dom.brokenImages.join(", ").slice(0, 300)}` : ""].filter(Boolean).join("\n");
  }).join("\n\n");
}
