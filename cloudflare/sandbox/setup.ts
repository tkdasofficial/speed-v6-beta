// Deploy-time setup: finds or creates the "sandbox" D1 database and applies its migrations, plus pending
// main-database migrations from cloudflare/migrations (tracked in a _migrations table). Idempotent.
import { readdirSync, readFileSync } from "node:fs";
const env = process.env;
const API = `https://api.cloudflare.com/client/v4/accounts/${env["CLOUDFLARE_ACCOUNT_ID"]}/d1/database`;
const H = { Authorization: `Bearer ${env["CLOUDFLARE_API_TOKEN"]}`, "Content-Type": "application/json" };

async function cf<T>(path: string, init?: RequestInit): Promise<T> {
  const r = (await (await fetch(`${API}${path}`, { ...init, headers: H })).json()) as { success: boolean; result: T; errors: unknown };
  if (!r.success) throw new Error(`D1 API ${path}: ${JSON.stringify(r.errors)}`);
  return r.result;
}
export const query = (db: string, sql: string, params: unknown[] = []) => cf<{ results: Record<string, unknown>[] }[]>(`/${db}/query`, { method: "POST", body: JSON.stringify({ sql, params }) });

export async function migrate(db: string, dir: string) {
  await query(db, "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))");
  const done = new Set(((await query(db, "SELECT name FROM _migrations"))[0]?.results ?? []).map((r) => String(r["name"])));
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    await query(db, readFileSync(`${dir}/${f}`, "utf8"));
    await query(db, "INSERT INTO _migrations (name) VALUES (?)", [f]);
    console.log(`applied ${f}`);
  }
}

export async function ensureSandboxDb(): Promise<string> {
  const list = await cf<{ uuid: string; name: string }[]>(`?name=sandbox`);
  const id = list.find((d) => d.name === "sandbox")?.uuid ?? (await cf<{ uuid: string }>("", { method: "POST", body: JSON.stringify({ name: "sandbox" }) })).uuid;
  await migrate(id, `${import.meta.dir}/../migrations-sandbox`);
  return id;
}

/** Agent D1 (agent runtime state): found or created by name "agent", migrations from cloudflare/migrations-agent. */
export async function ensureAgentDb(): Promise<string> {
  const list = await cf<{ uuid: string; name: string }[]>(`?name=agent`);
  const id = list.find((d) => d.name === "agent")?.uuid ?? (await cf<{ uuid: string }>("", { method: "POST", body: JSON.stringify({ name: "agent" }) })).uuid;
  await migrate(id, `${import.meta.dir}/../migrations-agent`);
  await seedKnowledge(id);
  return id;
}

/** Main database: applies pending cloudflare/migrations. Databases created before tracking existed get
 *  001–009 recorded as applied (their tables are present), so only newer migrations run. */
export async function migrateMain(id: string) {
  await query(id, "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))");
  const tracked = (await query(id, "SELECT COUNT(*) AS n FROM _migrations"))[0]?.results?.[0]?.["n"];
  const legacy = (await query(id, "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'"))[0]?.results?.length;
  if (!Number(tracked) && legacy) {
    for (const f of readdirSync(`${import.meta.dir}/../migrations`).filter((x) => x.endsWith(".sql") && x < "010").sort())
      await query(id, "INSERT OR IGNORE INTO _migrations (name) VALUES (?)", [f]);
  }
  await migrate(id, `${import.meta.dir}/../migrations`);
}

/** Upserts the Agent knowledge bases (cloudflare/agent/knowledge/*.json) into agent_knowledge_bases when their content changed. */
export async function seedKnowledge(db: string) {
  const { createHash } = await import("node:crypto");
  const dir = `${import.meta.dir}/../agent/knowledge`;
  const have = new Map(((await query(db, "SELECT id, content_hash FROM agent_knowledge_bases"))[0]?.results ?? []).map((r) => [String(r["id"]), String(r["content_hash"])]));
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const raw = readFileSync(`${dir}/${f}`, "utf8");
    const j = JSON.parse(raw) as { dataset: { id: string; name: string; version: string } };
    const json = JSON.stringify(j);
    const hash = createHash("sha256").update(json).digest("hex");
    if (have.get(j.dataset.id) === hash) continue;
    await query(db, "INSERT INTO agent_knowledge_bases (id, name, version, content_hash, content_json, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version, content_hash=excluded.content_hash, content_json=excluded.content_json, updated_at=excluded.updated_at", [j.dataset.id, j.dataset.name, j.dataset.version, hash, json]);
    console.log(`seeded knowledge ${j.dataset.id}`);
  }
}
