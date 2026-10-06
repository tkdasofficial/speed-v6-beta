// Centralized model configuration. Change models here only; orchestration logic reads this table.
// Server-only: provider IDs and secret names never reach the frontend.

export type Provider = "gemini" | "groq" | "nvidia";
export type ModelTarget = { provider: Provider; id: string };
export type ModelRole = "speed" | "flash" | "heavy";

/** `maxOut` keeps each request safely below the provider's free-tier output budget (a cap, never a target). */
export const PROVIDERS: Record<Provider, { url: string; secret: string; maxOut: number }> = {
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", secret: "GEMINI_API_KEY", maxOut: 8_000 },
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", secret: "GROQ_API_KEY", maxOut: 3_000 },
  nvidia: { url: "https://integrate.api.nvidia.com/v1/chat/completions", secret: "NVIDIA_API_KEY", maxOut: 3_000 },
};

const GPT_OSS_20B: ModelTarget = { provider: "groq", id: "openai/gpt-oss-20b" };
const GPT_OSS_120B: ModelTarget = { provider: "groq", id: "openai/gpt-oss-120b" };
const NEMOTRON_SUPER: ModelTarget = { provider: "nvidia", id: "nvidia/nemotron-3-super-120b-a12b" };
const GEMINI_FLASH_LITE: ModelTarget = { provider: "gemini", id: "gemini-3.5-flash-lite" };

/** Requested output-token allowance; each provider's `maxOut` lowers it further. */
export const MAX_OUTPUT_TOKENS = 8_000;

/** Ordered chain per role: primary first, then fallbacks tried only on real provider failure. */
export const CHAINS: Record<ModelRole, ModelTarget[]> = {
  flash: [GPT_OSS_20B, NEMOTRON_SUPER, GEMINI_FLASH_LITE],
  speed: [NEMOTRON_SUPER, GPT_OSS_20B, GEMINI_FLASH_LITE],
  heavy: [GPT_OSS_120B, NEMOTRON_SUPER, GEMINI_FLASH_LITE],
};

export const PRIMARY: Record<ModelRole, ModelTarget> = { flash: CHAINS.flash[0]!, speed: CHAINS.speed[0]!, heavy: CHAINS.heavy[0]! };

const same = (a: ModelTarget, b: ModelTarget) => a.provider === b.provider && a.id === b.id;

/** Primary followed by its fallbacks; duplicates are dropped so no model is retried. */
export function chainFor(role: ModelRole): ModelTarget[] {
  return CHAINS[role].filter((t, i, all) => all.findIndex((o) => same(o, t)) === i);
}

export const isNemotron = (t: ModelTarget) => t.provider === "nvidia" && t.id.includes("nemotron");
