/**
 * db/skillHub.ts — Intelligence Layer v2 (WP6) durable Skill Hub domain module.
 *
 * Tables are created by migration 200 (`200_skill_hub_durable.sql`). This is the
 * persistence + policy backplane for WP4's `SkillDiscoveryService`: it stores
 * skill collections (the "skillset" concept), per-agent grants, import-job
 * audit, and execution approvals — the things that WP4's in-memory index
 * cannot express.
 *
 * Raw SQL is allowed here (Hard Rule #5 — src/lib/db/ domain module).
 *
 * Design notes:
 *   - A "collection" is a named, policy-checked bundle of skills (a skillset).
 *     Six seed skillsets are provisioned idempotently on first use (the spec's
 *     "six skillsets"), plus operator-created ones.
 *   - An agent (identified by agentId or api_key_id) may only see the
 *     collections it has been granted. `searchCatalog` in WP4 consults
 *     `discoverDomainsForAgent()` to apply this policy.
 *   - Everything is additive and idempotent; seed rows use INSERT OR IGNORE.
 */
import { getDbInstance } from "./core";

export type CollectionKind = "seed" | "manual" | "learned";
export type GrantPermission = "discover" | "execute";

/**
 * The six seed skillsets from the spec (A2 "skillsets"). Ids are stable and
 * slug-ified so grants can reference them by name.
 */
export const SEED_SKILLSETS: { id: string; name: string; description: string }[] = [
  { id: "devops", name: "DevOps", description: "CI/CD, deployment, observability, infrastructure" },
  { id: "frontend", name: "Frontend", description: "UI components, design systems, accessibility" },
  { id: "backend", name: "Backend", description: "APIs, services, data access, background jobs" },
  { id: "data", name: "Data & ML", description: "Analytics, ETL, ML pipelines, vector ops" },
  {
    id: "security",
    name: "Security",
    description: "Vulnerability review, hardening, secrets hygiene",
  },
  { id: "general", name: "General", description: "Cross-cutting skills not tied to a domain" },
];

export interface SkillCollection {
  id: string;
  name: string;
  description: string | null;
  kind: CollectionKind;
  visible: number;
  skillCount: number;
}

/**
 * Idempotently ensure the six seed skillsets exist. Safe to call repeatedly
 * (INSERT OR IGNORE on the unique name). Returns the ids created (0 if all
 * already present).
 */
export function seedSkillsets(): number {
  const db = getDbInstance();
  let created = 0;
  for (const s of SEED_SKILLSETS) {
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO skill_collections (id, name, description, kind)
         VALUES (?, ?, ?, 'seed')`
      )
      .run(s.id, s.name, s.description);
    if (info.changes > 0) created++;
  }
  return created;
}

// One-time seed guard per process: the first caller provisions the six seed
// skillsets; subsequent calls are a no-op. `seedSkillsets()` is still exported
// for explicit use (and tests).
let seeded = false;
/**
 * Provision the seed skillsets exactly once per process, then return the
 * visible skillsets. This is the natural "ensure" point for the UI / MCP
 * listing paths — it keeps the six seed skillsets available without a boot
 * hook and is cheap (guarded) after the first call.
 */
export function ensureSeeded(): void {
  if (seeded) return;
  seedSkillsets();
  seeded = true;
}

/**
 * List all visible skillsets with their membership counts.
 */
export function listSkillsets(): SkillCollection[] {
  ensureSeeded();
  const db = getDbInstance();
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.description, c.kind, c.visible,
              COUNT(m.id) AS skillCount
         FROM skill_collections c
         LEFT JOIN skill_collection_members m ON m.collection_id = c.id
        WHERE c.visible = 1
        GROUP BY c.id
        ORDER BY c.name ASC`
    )
    .all() as unknown as {
    id: string;
    name: string;
    description: string | null;
    kind: CollectionKind;
    visible: number;
    skillCount: number;
  }[];
  return rows;
}

/**
 * Add a skill package to a collection (idempotent per the UNIQUE constraint).
 */
export function addToCollection(collectionId: string, skillId: string): boolean {
  const db = getDbInstance();
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO skill_collection_members (collection_id, skill_id)
       VALUES (?, ?)`
    )
    .run(collectionId, skillId);
  return info.changes > 0;
}

/**
 * Remove a skill package from a collection.
 */
export function removeFromCollection(collectionId: string, skillId: string): boolean {
  const db = getDbInstance();
  const info = db
    .prepare(`DELETE FROM skill_collection_members WHERE collection_id = ? AND skill_id = ?`)
    .run(collectionId, skillId);
  return info.changes > 0;
}

/**
 * List the skill ids in a collection.
 */
export function collectionMembers(collectionId: string): string[] {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT skill_id FROM skill_collection_members WHERE collection_id = ? ORDER BY added_at ASC`
    )
    .all(collectionId)
    .map((r) => String((r as { skill_id: string }).skill_id));
}

/**
 * Grant an agent permission on a skillset. `permission` is 'discover' (see it
 * in search) or 'execute' (run it). Idempotent per (agent, collection, perm).
 */
export function grantAgent(
  agentId: string,
  collectionId: string,
  permission: GrantPermission = "discover"
): boolean {
  const db = getDbInstance();
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO skill_agent_grants (agent_id, collection_id, permission)
       VALUES (?, ?, ?)`
    )
    .run(agentId, collectionId, permission);
  // true = newly granted; false = grant already existed (idempotent no-op).
  return info.changes > 0;
}

/**
 * Revoke an agent's permission on a skillset.
 */
export function revokeAgent(
  agentId: string,
  collectionId: string,
  permission: GrantPermission = "discover"
): boolean {
  const db = getDbInstance();
  const info = db
    .prepare(
      `DELETE FROM skill_agent_grants WHERE agent_id = ? AND collection_id = ? AND permission = ?`
    )
    .run(agentId, collectionId, permission);
  return info.changes > 0;
}

/**
 * The set of skillset (collection) ids an agent has `discover` access to.
 * Seed skillsets use domain slugs as their ids (devops / frontend / backend /
 * data / security / general), so callers can treat a granted seed collection
 * as a granted domain. Returns `null` when the agent has NO discover grants —
 * the "fail closed" signal (missing trusted scope means reject, not global).
 *
 * This is the policy set WP4's `searchCatalog` consults to scope results
 * per-agent.
 */
export function discoverDomainsForAgent(agentId: string): string[] | null {
  const db = getDbInstance();
  const rows = db
    .prepare(
      `SELECT collection_id FROM skill_agent_grants
        WHERE agent_id = ? AND permission = 'discover'`
    )
    .all(agentId) as { collection_id: string }[];
  if (rows.length === 0) return null;
  return rows.map((r) => String(r.collection_id));
}

/**
 * Whether an agent has `execute` permission on a skillset containing the given
 * skill id. Used by `omr_catalog_execute` to gate execution by policy.
 */
export function agentCanExecute(agentId: string, skillId: string): boolean {
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT 1 AS ok
         FROM skill_agent_grants g
         JOIN skill_collection_members m ON m.collection_id = g.collection_id
        WHERE g.agent_id = ? AND g.permission = 'execute' AND m.skill_id = ?`
    )
    .get(agentId, skillId) as { ok?: number } | undefined;
  return Boolean(row?.ok);
}
