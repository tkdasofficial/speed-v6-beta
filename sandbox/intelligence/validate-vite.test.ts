import { describe, expect, it } from "vitest";
import { Sandbox } from "../core/sandbox";
import { createContext } from "../core/context";
import { memoryBackend } from "../storage/persistence";
import { validateProject } from "./validate";

function store(files: Record<string, string>) {
  const sb = new Sandbox(createContext("p1", "u1"), memoryBackend());
  sb.start();
  for (const [p, c] of Object.entries(files)) sb.createFile(p, c);
  return sb.workspace.files;
}

const html = `<!DOCTYPE html>\n<html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`;

describe("project type rules", () => {
  it("accepts a React + Vite + TypeScript project with npm and extensionless imports", () => {
    const s = store({
      "package.json": JSON.stringify({ dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" }, devDependencies: { vite: "^7.0.0" } }),
      "index.html": html,
      "src/main.tsx": `import { createRoot } from "react-dom/client";\nimport App from "./App";\ncreateRoot(document.getElementById("root")!).render(<App />);\n`,
      "src/App.tsx": `export default function App() { return <h1>Hi</h1>; }\n`,
    });
    expect(validateProject(s).errors.map((e) => e.code)).toEqual([]);
  });

  it("still rejects TypeScript in a plain static site", () => {
    const s = store({ "index.html": `<!DOCTYPE html>\n<html><body></body></html>`, "app.ts": "const a: number = 1;\n" });
    expect(validateProject(s).errors.map((e) => e.code)).toContain("TS_NOT_SUPPORTED");
  });
});

describe("vite relative imports", () => {
  it("flags a side-effect CSS import that points outside src (the real failing build)", async () => {
    const { MemoryFileStore } = await import("../workspace/workspace");
    const { validateViteImports } = await import("./validate");
    const s = new MemoryFileStore();
    s.write("package.json", '{"dependencies":{"vite":"5"}}');
    s.write("src/main.tsx", "import './App';\nimport '../styles/global.css';\n");
    s.write("src/App.tsx", "export default 1;");
    s.write("src/styles/global.css", "body{}");
    const e = validateViteImports(s);
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toMatch(/src\/styles\/global\.css/);
    s.write("src/main.tsx", "import './App';\nimport './styles/global.css';\n");
    expect(validateViteImports(s)).toHaveLength(0);
  });
});
