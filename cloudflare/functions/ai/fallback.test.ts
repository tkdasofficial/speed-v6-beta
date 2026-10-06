import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("../context", () => ({ envStr: () => "test-key" }));
import { runAgent, runAgentRound, resetAiCooldowns } from "./orchestrator.server";

function sse(text: string, finish = "stop") {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const CAP: Record<string, number> = { groq: 8000, gemini: 8000, nvidia: 3000 };
const prov = (url: string) => (url.includes("groq") ? "groq" : url.includes("nvidia") ? "nvidia" : "gemini");
const round = () => runAgentRound({ model: "heavy", depth: "quick", history: [{ role: "user", content: "build" }], projectName: "p", round: 1, files: [], results: "", tools: "", approvedPlan: "x" });

beforeEach(() => resetAiCooldowns());

describe("server-side model fallback", () => {
  it.each([
    ["flash", ["openai/gpt-oss-20b", "nvidia/nemotron-3-super-120b-a12b", "gemini-3.5-flash-lite"]],
    ["speed", ["nvidia/nemotron-3-super-120b-a12b", "openai/gpt-oss-20b", "gemini-3.5-flash-lite"]],
    ["heavy", ["openai/gpt-oss-120b", "nvidia/nemotron-3-super-120b-a12b", "gemini-3.5-flash-lite"]],
  ] as const)("%s falls through its chain on 429/5xx within each provider's output cap", async (model, ids) => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      if (b.model.includes("safety")) return sse("safe");
      seen.push(b.model);
      expect(b.max_tokens).toBe(CAP[prov(url)]);
      if (seen.length === 1) return new Response("rate", { status: 429 });
      if (seen.length === 2) return new Response("down", { status: 503 });
      return sse("hello");
    }));
    await runAgent({ model, depth: "balanced", history: [{ role: "user", content: "hi" }], projectName: "p" });
    expect(seen).toEqual(ids);
  });

  it("fails clearly when every model fails, with per-model reasons", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 500 })));
    await expect(runAgent({ model: "flash", depth: "quick", history: [{ role: "user", content: "hi" }], projectName: "p" })).rejects.toMatchObject({ message: expect.stringMatching(/unavailable/), failed: expect.arrayContaining([expect.objectContaining({ reason: expect.stringMatching(/HTTP 500/) })]) });
  });

  it("retries a cut-off reply once, shorter, on the same model", async () => {
    const calls: { model: string; last: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      calls.push({ model: b.model, last: b.messages[b.messages.length - 1].content });
      expect(b.response_format).toEqual({ type: "json_object" });
      return calls.length === 1 ? sse('{"message":"hi","actions":[{"kind":"create","path":"a.html","content":"<ht', "length") : sse('{"message":"ok","actions":[],"done":true}');
    }));
    const r = await round();
    expect(calls.map((c) => c.model)).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-120b"]);
    expect(calls[1]!.last).toMatch(/cut off/);
    expect(r.message).toBe("ok");
  });

  it("a prose reply gets one JSON reminder, then moves to the next provider; a refused key is skipped on later calls", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body));
      seen.push(prov(url));
      if (prov(url) === "groq") return sse("not json at all");
      if (prov(url) === "nvidia") return new Response("denied", { status: 403 });
      return sse('{"message":"from gemini","actions":[],"done":true}');
    }));
    expect((await round()).message).toBe("from gemini");
    expect(seen).toEqual(["groq", "groq", "nvidia", "gemini"]);
    seen.length = 0;
    await round();
    expect(seen).toEqual(["groq", "groq", "gemini"]);
  });

  it("a prose reply that becomes JSON after the reminder stays on the same provider", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (n++ === 0 ? sse("I'll read the file first.") : sse('{"message":"ok","actions":[],"done":true}'))));
    expect((await round()).message).toBe("ok");
    expect(n).toBe(2);
  });

  it("a mid-stream error frame is reported with its real reason, not as an empty reply", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('data: {"error":{"code":"json_validate_failed","message":"Failed to generate JSON"}}\n\n', { headers: { "content-type": "text/event-stream" } })));
    const e = await round().catch((x) => x);
    expect(JSON.stringify(e.failed)).toMatch(/json_validate_failed/);
  });
});

describe("step parsing", () => {
  it("takes the first step when a model sends several JSON objects back to back", async () => {
    const { firstJsonObject } = await import("./orchestrator.server");
    expect(firstJsonObject('{"message":"a }{ b","actions":[]}, {"message":"next"}')).toBe('{"message":"a }{ b","actions":[]}');
  });
});
