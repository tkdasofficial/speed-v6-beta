// Knowledge engine over the two Agent D1 knowledge bases (table agent_knowledge_bases, seeded at deploy from
// cloudflare/agent/knowledge/*.json). The datasets are the only source of truth: nothing here names a component;
// every alias, rule, placement and relationship is read from them at runtime.
//
//   prompt → identifyComponents (Component KB: WHAT) → architectureFor (Architecture KB: WHERE/HOW) → buildKnowledgePlan → knowledgeText → planning/building prompts

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;
export interface KnowledgeBases { components: J; architecture: J }
export interface KnowledgeIndex {
  kb: KnowledgeBases;
  /** normalized phrase → matches (longest phrases are tried first) */
  phrases: Map<string, { entityId: string; source: "canonical" | "alias" | "semantic" | "pattern"; confidence: number }[]>;
  components: Map<string, J>; // component entity id → entity
  arch: Map<string, J>;       // architecture entity id → entity
}
export interface IdentifiedComponent { term: string; id: string; canonical: string; confidence: number; source: string; ambiguity?: string }

export const KB_IDS = { components: "component-identifier", architecture: "web-architecture-infrastructure" } as const;
const norm = (s: string) => s.toLowerCase().replace(/[_-]+/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const arr = (v: J): J[] => (Array.isArray(v) ? v : []);
const strs = (v: J): string[] => arr(v).map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? (x.rule ?? x.check ?? x.name ?? JSON.stringify(x)) : String(x)));

/** Validates the datasets against their own declared schemas (component_schema.required_fields, validation.*). */
export function validateKnowledge(kb: KnowledgeBases): string[] {
  const issues: string[] = [];
  const req: string[] = kb.components?.component_schema?.required_fields ?? [];
  for (const e of arr(kb.components?.entities)) for (const f of req) if (!(f in e)) issues.push(`component ${e.id}: missing ${f}`);
  const declared: string[] = arr(kb.components?.dataset?.canonical_components);
  const names = new Set(arr(kb.components?.entities).map((e) => e.canonical_name));
  for (const n of declared) if (!names.has(n)) issues.push(`component KB declares "${n}" without an entity`);
  for (const s of arr(kb.architecture?.validation?.required_top_level_sections)) if (!(s in (kb.architecture ?? {}))) issues.push(`architecture KB: missing section ${s}`);
  return issues;
}

/** Builds lookup maps from the datasets (canonical names, aliases, semantic terms, architecture semantic patterns). */
export function indexKnowledge(kb: KnowledgeBases): KnowledgeIndex {
  const phrases: KnowledgeIndex["phrases"] = new Map();
  const add = (p: string, entityId: string, source: "canonical" | "alias" | "semantic" | "pattern", confidence: number) => {
    const k = norm(p); if (!k) return;
    const list = phrases.get(k) ?? [];
    const prev = list.find((x) => x.entityId === entityId);
    if (prev) { if (confidence > prev.confidence) { prev.confidence = confidence; prev.source = source; } } else list.push({ entityId, source, confidence });
    phrases.set(k, list);
  };
  const components = new Map<string, J>();
  for (const e of arr(kb.components?.entities)) {
    components.set(e.id, e);
    add(e.canonical_name, e.id, "canonical", 1);
    add(e.id, e.id, "canonical", 1);
    for (const a of strs(e.aliases)) add(a, e.id, "alias", 0.9);
    for (const s of strs(e.semantic_terms)) add(s, e.id, "semantic", 0.75);
  }
  const arch = new Map<string, J>();
  for (const e of arr(kb.architecture?.entities)) arch.set(e.id, e);
  // Architecture semantic patterns ("left menu" → app-drawer) resolve only to entities the component KB defines.
  for (const sp of arr(kb.architecture?.semantic_patterns)) if (components.has(sp.possible_meaning)) add(sp.user_phrase, sp.possible_meaning, "pattern", Number(sp.confidence) || 0.8);
  return { kb, phrases, components, arch };
}

/** Identifies components named in user text and resolves aliases/semantic terms to canonical names.
 *  Longest phrases win, so "date picker" is never also read as "picker"; ambiguity rules from both KBs are attached. */
export function identifyComponents(text: string, ix: KnowledgeIndex, max = 12): IdentifiedComponent[] {
  let hay = ` ${norm(text)} `;
  const out = new Map<string, IdentifiedComponent>();
  const keys = [...ix.phrases.keys()].sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const at = hay.indexOf(` ${k} `), plural = at < 0 ? hay.indexOf(` ${k}s `) : -1;
    if (at < 0 && plural < 0) continue;
    const best = [...ix.phrases.get(k)!].sort((a, b) => b.confidence - a.confidence)[0]!;
    const e = ix.components.get(best.entityId);
    if (!e) continue;
    const amb = arr(ix.kb.architecture?.ambiguity_rules).find((r) => norm(r.term) === k);
    const cur = out.get(e.id);
    if (!cur || best.confidence > cur.confidence) out.set(e.id, { term: k, id: e.id, canonical: e.canonical_name, confidence: best.confidence, source: best.source, ...(amb ? { ambiguity: amb.resolution_hint } : {}) });
    // consume the matched words so shorter phrases inside them don't match again
    const len = at >= 0 ? k.length : k.length + 1, pos = at >= 0 ? at : plural;
    hay = `${hay.slice(0, pos + 1)}${" ".repeat(len)}${hay.slice(pos + 1 + len)}`;
  }
  return [...out.values()].sort((a, b) => b.confidence - a.confidence).slice(0, max);
}

/** Architecture entity for a component (WHERE/HOW): same id, canonical name, or an alias declared by either KB. */
export function architectureFor(componentId: string, ix: KnowledgeIndex): J | null {
  if (ix.arch.has(componentId)) return ix.arch.get(componentId);
  const c = ix.components.get(componentId);
  const names = new Set([componentId, c?.canonical_name, ...strs(c?.aliases)].filter(Boolean).map((x) => norm(String(x))));
  for (const e of ix.arch.values()) if ([e.id, e.canonical_name, ...strs(e.aliases)].some((x) => names.has(norm(String(x))))) return e;
  return null;
}

export interface ComponentKnowledge {
  id: string; canonical: string; matchedTerm: string; category: string; what: string; purpose: string;
  content: { required: string[]; optional: string[]; conditional: string[]; forbidden: string[] };
  states: string[]; variations: string[]; relationships: string[]; responsive: string[]; accessibility: string[];
  identification: string[]; problems: string[]; antiPatterns: string[]; verification: string[]; ambiguity?: string;
  placement: null | { where: string; why: string; parents: string[]; children: string[]; preferred: string[]; avoid: string[] };
  rules: string[]; examples: { correct: string[]; incorrect: string[] };
}
export interface KnowledgePlan {
  components: ComponentKnowledge[];
  identificationRules: string[];
  architecture: { decisions: string[]; patterns: string[]; antiPatterns: string[]; diagnostics: string[]; quality: string[]; principles: string[] };
  verification: string[];
}

/** Combines both KBs for the request: component identity (component KB) + placement/rules (architecture KB),
 *  relevant identification rules, decisions, patterns, diagnostics and verification checks. */
export function buildKnowledgePlan(request: string, ix: KnowledgeIndex, o: { max?: number; context?: string } = {}): KnowledgePlan {
  const found = identifyComponents(request, ix, o.max ?? 8);
  const ids = new Set(found.map((f) => f.id));
  const names = new Set(found.map((f) => f.canonical));
  const components: ComponentKnowledge[] = found.map((f) => {
    const e = ix.components.get(f.id); const a = architectureFor(f.id, ix);
    const rels = [...arr(e.relationships), ...arr(ix.kb.components?.component_relationships).filter((r) => r.source === e.canonical_name).map((r) => ({ type: r.relationship, target: r.target }))];
    const pl = a?.placement;
    return {
      id: e.id, canonical: e.canonical_name, matchedTerm: f.term, category: e.category, what: e.definition, purpose: e.purpose,
      content: { required: strs(e.content_model?.required), optional: strs(e.content_model?.optional), conditional: strs(e.content_model?.conditional), forbidden: strs(e.content_model?.forbidden) },
      states: strs(e.states), variations: strs(e.variations),
      relationships: [...new Set(rels.map((r) => `${r.type} ${r.target}`))],
      responsive: [...strs(e.responsive_behavior), ...strs(a?.responsive_behavior)],
      accessibility: [...strs(e.accessibility), ...strs(a?.accessibility)],
      identification: strs(e.identification_signals), problems: [...strs(e.common_problems), ...strs(a?.common_problems)],
      antiPatterns: [...strs(e.anti_patterns), ...strs(a?.anti_patterns)],
      verification: [...strs(e.verification), ...arr(a?.verification).map((v) => (typeof v === "string" ? v : `${v.type}: ${v.check}`))],
      ...(f.ambiguity ? { ambiguity: f.ambiguity } : {}),
      placement: pl ? { where: pl.where, why: pl.why_here, parents: strs(pl.typical_parent), children: strs(pl.typical_children), preferred: strs(pl.preferred_locations), avoid: strs(pl.avoid_locations) } : null,
      rules: arr(a?.rules).map((r) => `${r.rule} (${r.strength}${r.exception ? `; except: ${r.exception}` : ""})`),
      examples: { correct: strs(a?.examples?.correct), incorrect: strs(a?.examples?.incorrect) },
    };
  });
  const words = new Set(norm(`${request} ${o.context ?? ""}`).split(" ").filter((w) => w.length > 3));
  const mentions = (s: string) => norm(s).split(" ").some((w) => words.has(w));
  const touches = (s: string) => [...names].some((n) => norm(s).includes(norm(n))) || [...ids].some((i) => norm(s).includes(norm(i)));
  const A = ix.kb.architecture ?? {};
  return {
    components,
    identificationRules: arr(ix.kb.components?.identification_rules).filter((r) => touches(`${r.id} ${r.rule}`)).map((r) => r.rule),
    architecture: {
      decisions: arr(A.decisions).filter((d) => mentions(d.question) || arr(d.decision_rules).some((r) => touches(`${r.condition} ${r.preferred}`))).map((d) => `${d.question} → ${arr(d.decision_rules).map((r) => `${r.condition}: ${r.preferred}`).join("; ")}`),
      patterns: arr(A.patterns).filter((p) => mentions(`${p.name} ${p.when_to_use}`)).map((p) => `${p.name}: ${p.when_to_use}`),
      antiPatterns: arr(A.anti_patterns).filter((p) => mentions(`${p.name} ${p.description}`)).map((p) => `${p.name}: ${p.preferred_direction}`),
      diagnostics: arr(A.diagnostic_rules).filter((d) => mentions(`${d.problem} ${strs(d.symptoms).join(" ")}`)).map((d) => `${d.problem} — check ${strs(d.inspection_targets).slice(0, 4).join(", ")}; fixes: ${strs(d.possible_fixes).slice(0, 3).join("; ")}`),
      quality: arr(A.quality_rules).filter((q) => q.severity === "critical" || q.severity === "high").map((q) => q.rule),
      principles: strs(A.dataset?.principles).slice(0, 4),
    },
    verification: [...strs(ix.kb.components?.verification?.identity_checks), ...strs(ix.kb.components?.verification?.responsive_checks), ...strs(ix.kb.components?.verification?.accessibility_checks)],
  };
}

/** Compact prompt text (free-tier budget): components first, then architecture guidance; hard character cap. */
export function knowledgeText(p: KnowledgePlan, max = 3200): string {
  if (!p.components.length && !p.architecture.diagnostics.length) return "";
  const j = (xs: string[], n: number) => xs.slice(0, n).join("; ");
  const L: string[] = ["KNOWLEDGE BASE (canonical components + architecture; follow it, use the canonical names):"];
  for (const c of p.components) {
    L.push(`- ${c.canonical}${norm(c.matchedTerm) !== norm(c.canonical) ? ` (user said "${c.matchedTerm}")` : ""}: ${c.what}`);
    if (c.placement) L.push(`  where: ${c.placement.where}; prefer ${j(c.placement.preferred, 3)}; avoid ${j(c.placement.avoid, 2)}`);
    if (c.content.required.length || c.content.optional.length) L.push(`  contains: ${j(c.content.required, 4)}${c.content.optional.length ? ` (+ optional ${j(c.content.optional, 4)})` : ""}`);
    if (c.states.length) L.push(`  states: ${j(c.states, 6)}`);
    if (c.responsive.length) L.push(`  responsive: ${j(c.responsive, 2)}`);
    if (c.accessibility.length) L.push(`  a11y: ${j(c.accessibility, 2)}`);
    if (c.rules.length) L.push(`  rule: ${j(c.rules, 1)}`);
    if (c.antiPatterns.length) L.push(`  avoid: ${j(c.antiPatterns, 1)}`);
    if (c.ambiguity) L.push(`  note: ${c.ambiguity}`);
  }
  for (const r of p.identificationRules.slice(0, 2)) L.push(`- rule: ${r}`);
  for (const d of p.architecture.decisions.slice(0, 2)) L.push(`- decide: ${d}`);
  for (const d of p.architecture.diagnostics.slice(0, 1)) L.push(`- diagnose: ${d}`);
  if (p.architecture.quality.length) L.push(`- quality: ${j(p.architecture.quality, 3)}`);
  let s = L.join("\n");
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s;
}

// ---- D1 access (AGENT_DB, table agent_knowledge_bases) ----
let cache: { at: number; ix: KnowledgeIndex } | null = null;
const TTL = 10 * 60_000;

/** Loads both knowledge bases from the Agent D1 (cached per isolate). Returns null if they are not seeded, so the
 *  Agent keeps working without them rather than failing a run. */
export async function loadKnowledge(db?: { prepare(sql: string): { bind(...p: unknown[]): { all<T>(): Promise<{ results?: T[] }> } } }): Promise<KnowledgeIndex | null> {
  if (cache && Date.now() - cache.at < TTL) return cache.ix;
  const d = db ?? (((await import("@backend/context")).ctx().env as Record<string, unknown>)["AGENT_DB"] as typeof db);
  if (!d) return null;
  const rows = (await d.prepare("SELECT id, content_json FROM agent_knowledge_bases WHERE id IN (?, ?)").bind(KB_IDS.components, KB_IDS.architecture).all<{ id: string; content_json: string }>()).results ?? [];
  const by = Object.fromEntries(rows.map((r) => [r.id, JSON.parse(r.content_json)]));
  if (!by[KB_IDS.components] || !by[KB_IDS.architecture]) return null;
  const ix = indexKnowledge({ components: by[KB_IDS.components], architecture: by[KB_IDS.architecture] });
  cache = { at: Date.now(), ix };
  return ix;
}

/** One call for the Agent flow: request → identified components + architecture → compact prompt text. Fail-soft. */
export async function knowledgeForRequest(request: string, context = "", max = 3200): Promise<{ text: string; components: string[] }> {
  try {
    const ix = await loadKnowledge();
    if (!ix) return { text: "", components: [] };
    const plan = buildKnowledgePlan(request, ix, { context });
    return { text: knowledgeText(plan, max), components: plan.components.map((c) => c.canonical) };
  } catch { return { text: "", components: [] }; }
}
