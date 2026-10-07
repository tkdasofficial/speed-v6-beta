// First-pass generation support (deterministic, no AI).
// The plan is completed with every file the selected stack needs, stack configuration is written before the
// first AI round, and the build loop knows which planned files are still unwritten so incomplete work is never
// "checked" (and never spends repair attempts) before it exists.

export type PlanLike = { title?: string; create: string[]; modify: string[]; pages?: string[] };

const STACK = ["package.json", "vite.config.ts", "tsconfig.json", "index.html", "src/main.tsx", "src/App.tsx", "src/styles/index.css"];

/** A React + Vite plan: it names TSX/Vite files, or the project already is one. */
export function isReactPlan(plan: PlanLike, paths: readonly string[]): boolean {
  const all = [...plan.create, ...plan.modify, ...paths];
  return all.some((p) => /\.(tsx|jsx)$/.test(p) || /^vite\.config\./.test(p) || p === "src/main.tsx");
}

/** Normalise planned paths to the project convention and add every stack file a fresh React project needs. */
export function completePlan<T extends PlanLike>(plan: T, paths: readonly string[]): T {
  const have = new Set(paths);
  const norm = (p: string) => {
    let x = p.replace(/^\.?\//, "").replace(/^public\/index\.html$/, "index.html");
    const m = /^src\/pages\/([A-Za-z0-9_-]+)\.(tsx|jsx)$/.exec(x);
    if (m) x = `src/pages/${m[1]!.replace(/Page$/, "").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}/index.tsx`;
    if (/^src\/.*\.(css|scss)$/.test(x)) x = "src/styles/index.css";
    if (/^src\/(index|main)\.(jsx|js|ts)$/.test(x)) x = "src/main.tsx";
    return x;
  };
  const create = [...new Set(plan.create.map(norm))];
  if (isReactPlan(plan, paths) && !have.has("package.json")) for (const f of STACK) if (!create.includes(f)) create.push(f);
  return { ...plan, create: create.filter((f) => !have.has(f)), modify: [...new Set(plan.modify.map(norm))].filter((f) => have.has(f)) };
}

const pkgName = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "site";

/** Deterministic stack configuration for a fresh React + Vite project (only files that don't exist yet). */
export function stackFiles(plan: PlanLike, paths: readonly string[], title: string): { path: string; content: string }[] {
  if (!isReactPlan(plan, paths) || paths.includes("package.json")) return [];
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: pkgName(title), private: true, version: "0.0.0", type: "module", scripts: { dev: "vite", build: "tsc --noEmit && vite build", preview: "vite preview" }, dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" }, devDependencies: { "@types/react": "^18.3.3", "@types/react-dom": "^18.3.0", "@vitejs/plugin-react": "^4.3.1", typescript: "^5.5.4", vite: "^5.4.0" } }, null, 2) + "\n",
    "vite.config.ts": `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({ plugins: [react()] });\n`,
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2020", lib: ["ES2020", "DOM", "DOM.Iterable"], module: "ESNext", moduleResolution: "bundler", jsx: "react-jsx", strict: true, noEmit: true, skipLibCheck: true, isolatedModules: true, allowImportingTsExtensions: false, resolveJsonModule: true }, include: ["src"] }, null, 2) + "\n",
    "index.html": `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${title.replace(/[<>&"]/g, "")}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`,
    "src/main.tsx": `import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App";\nimport "./styles/index.css";\n\ncreateRoot(document.getElementById("root")!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`,
  };
  return Object.entries(files).filter(([p]) => !paths.includes(p)).map(([path, content]) => ({ path, content }));
}

/** Planned files that still don't exist (stack config written by the scaffold counts as present). */
export function remainingPlanned(plan: PlanLike | undefined, paths: readonly string[]): string[] {
  if (!plan) return [];
  const have = new Set(paths);
  return plan.create.filter((f) => !have.has(f) && !(f === "public/index.html" && have.has("index.html")));
}

/** The generation brief for the first round: the full manifest, in dependency order, so it is written in one pass. */
export function manifestPrompt(plan: PlanLike, present: readonly string[], scaffolded: readonly string[] = []): string {
  const order = (p: string) => (p === "src/styles/index.css" ? 0 : /^src\/components\//.test(p) ? 1 : /^src\/pages\//.test(p) ? 2 : p === "src/App.tsx" ? 3 : 4);
  const todo = remainingPlanned(plan, present).sort((a, b) => order(a) - order(b));
  return [
    `FIRST-PASS MANIFEST — write every file below with complete, real content (no placeholders, no TODOs). Write whole files only; if they don't all fit in one reply, finish the ones you start and continue with the rest next round:`,
    ...todo.map((f) => `- ${f}`),
    scaffolded.length ? `Already created deterministically (do not rewrite unless needed): ${scaffolded.join(", ")}. src/main.tsx imports ./App and ./styles/index.css.` : "",
    `Every className used in TSX must have a rule in src/styles/index.css (with responsive @media rules); every component must be imported and rendered by App or a page; every import must point to a file in this manifest.`,
  ].filter(Boolean).join("\n");
}
