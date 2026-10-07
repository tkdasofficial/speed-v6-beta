-- Knowledge bases the Agent reads at runtime (component identifier + web architecture). Seeded by deploy from
-- cloudflare/agent/knowledge/*.json; the JSON stays the source of truth and the engine (cloudflare/agent/agent.ts) reads it here.
CREATE TABLE IF NOT EXISTS agent_knowledge_bases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
