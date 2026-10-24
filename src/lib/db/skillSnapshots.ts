/**
 * db/skillSnapshots.ts — Durable Skill Hub catalog snapshots (WP6 hardening).
 *
 * A snapshot is an immutable record of the skill catalog state (built-in +
 * imported skills) captured at a point in time: whenever a skill is added,
 * updated or removed, and on explicit operator/AI refresh. Snapshots are kept
 * for 30 days (SNAPSHOT_RETENTION_DAYS) so the catalog state can be inspected
 * or restored without re-scanning the source directories, and `purgeExpired()`
 * trims anything older than the retention window.
 *
 * Raw SQL is allowed here (Hard Rule #5 — src/lib/db/ domain module).
 *
 * All functions are additive and idempotent-safe: creating a snapshot never
 * modifies existing ones; purging only deletes expired rows.
 */
import { randomUUID } from "node:crypto";
import { getDbInstance } from "./core";

/** Snapshots are retained for this many days before purgeExpired() removes them. */
export const SNAPSHOT_RETENTION_DAYS = 30;

export interface SkillSnapshotMetadata {
  total: number;
  builtinCount: number;
  importedCount: number;
  domains: string[];
  /** Number of registered executable skills (skillRegistry) at snapshot time. */
  registeredCount?: number;
  /** Stable names ("name@version") of registered executable skills. */
  registeredIds?: string[];
  /** Free-form provenance: e.g. "manual-refresh", "skill-added", "skill-updated". */
  origin?: string;
}

export interface SkillSnapshotRow {
  id: string;
  createdAt: string;
  type: string;
  metadata: SkillSnapshotMetadata;
  retentionUntil: string;
  origin?: string;
}

interface RawRow {
  id: string;
  created_at: string;
  type: string;
  metadata: string;
  retention_until: string;
}

function parse(row: RawRow): SkillSnapshotRow {
  let metadata: SkillSnapshotMetadata = {
    total: 0,
    builtinCount: 0,
    importedCount: 0,
    domains: [],
  };
  let origin: string | undefined;
  try {
    const parsed = JSON.parse(row.metadata) as Record<string, unknown>;
    metadata = {
      total: typeof parsed.total === "number" ? parsed.total : 0,
      builtinCount: typeof parsed.builtinCount === "number" ? parsed.builtinCount : 0,
      importedCount: typeof parsed.importedCount === "number" ? parsed.importedCount : 0,
      domains: Array.isArray(parsed.domains)
        ? (parsed.domains as unknown[]).filter((d): d is string => typeof d === "string")
        : [],
      registeredCount: typeof parsed.registeredCount === "number" ? parsed.registeredCount : 0,
      registeredIds: Array.isArray(parsed.registeredIds)
        ? (parsed.registeredIds as unknown[]).filter((s): s is string => typeof s === "string")
        : [],
      origin: typeof parsed.origin === "string" ? parsed.origin : undefined,
    };
  } catch {
    // Corrupt metadata: keep the row visible with zeroed metadata rather than
    // throwing — a broken snapshot must not take the catalog down.
  }
  return {
    id: row.id,
    createdAt: row.created_at,
    type: row.type,
    metadata,
    retentionUntil: row.retention_until,
    origin,
  };
}

/**
 * Create a new catalog snapshot and return its id.
 * `now` is injectable for deterministic tests (ISO-8601 string).
 */
export function createSnapshot(metadata: SkillSnapshotMetadata, now?: string): string {
  const db = getDbInstance();
  const id = randomUUID();
  const at = now ?? new Date().toISOString();
  const retention = new Date(new Date(at).getTime() + SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  const payload = JSON.stringify({
    ...metadata,
    origin: metadata.origin,
  });
  db.prepare(
    `INSERT INTO skill_snapshots (id, created_at, type, metadata, retention_until)
     VALUES (?, ?, 'full', ?, ?)`
  ).run(id, at.slice(0, 19).replace("T", " "), payload, retention);
  return id;
}

/** List snapshots newest-first (metadata decoded). */
export function listSnapshots(limit = 50): SkillSnapshotRow[] {
  const db = getDbInstance();
  const rows = db
    .prepare("SELECT * FROM skill_snapshots ORDER BY created_at DESC LIMIT ?")
    .all(limit) as RawRow[];
  return rows.map(parse);
}

/** The most recent snapshot, or null when none exist yet. */
export function latestSnapshot(): SkillSnapshotRow | null {
  const db = getDbInstance();
  const row = db.prepare("SELECT * FROM skill_snapshots ORDER BY created_at DESC LIMIT 1").get() as
    RawRow | undefined;
  return row ? parse(row) : null;
}

/**
 * Snapshot the current catalog state after a skill add/update/delete (or an
 * explicit refresh). Pure computation + one DB insert — safe to call from any
 * mutation path. `extras` carries the registered executable-skill set, which
 * is a separate store from the discovery catalog and must be part of the
 * composition so install/update/delete produce a meaningful snapshot.
 */
export function snapshotFromCatalog(
  skills: Array<{ id: string; source: string; domain: string }>,
  origin: string,
  extras?: {
    registeredCount?: number;
    registeredIds?: string[];
  },
  now?: string
): string {
  const domains = [...new Set(skills.map((s) => s.domain).filter(Boolean))].sort();
  const builtinCount = skills.filter((s) => s.source === "builtin").length;
  const importedCount = skills.filter((s) => s.source === "imported").length;
  return createSnapshot(
    {
      total: skills.length,
      builtinCount,
      importedCount,
      domains,
      registeredCount: extras?.registeredCount ?? 0,
      registeredIds: extras?.registeredIds ?? [],
      origin,
    },
    now
  );
}

/** Delete one snapshot by id. Returns true when a row was removed. */
export function deleteSnapshot(id: string): boolean {
  const db = getDbInstance();
  const res = db.prepare("DELETE FROM skill_snapshots WHERE id = ?").run(id);
  return res.changes > 0;
}

/**
 * Delete every snapshot whose retention window has passed (default: now).
 * Returns the number of rows purged. `now` is injectable for tests.
 */
export function purgeExpired(now?: Date): number {
  const db = getDbInstance();
  const cutoff = (now ?? new Date()).toISOString().slice(0, 19).replace("T", " ");
  const res = db.prepare("DELETE FROM skill_snapshots WHERE retention_until < ?").run(cutoff);
  return res.changes;
}
