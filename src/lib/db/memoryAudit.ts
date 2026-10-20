/**
 * db/memoryAudit.ts — append-only audit log for memory gate decisions.
 *
 * Intelligence Layer v2 (WP2). Raw SQL is allowed here (Hard Rule #5 —
 * src/lib/db/ domain module). Table `memory_audit` is created by migration
 * 201 (`201_memory_provenance_audit.sql`).
 *
 * Purpose: let operators (and the WP4 debugger) explain WHY a retrieval
 * query returned or dropped a candidate, and trace extraction provenance
 * back to the gate decision that created it.
 *
 * The write path is fire-and-forget at the caller side (never throws into
 * the request pipeline); reads are synchronous and return the most recent
 * `limit` rows for a given api key, optionally filtered by action.
 */

import { getDbInstance } from "./core";

export type MemoryAuditAction = "materialize" | "accept" | "extract" | "dedup" | "injection";
export type MemoryAuditOutcome = "accepted" | "dropped" | "created" | "merged" | "recorded";

export interface MemoryAuditEntry {
  id: number;
  apiKeyId: string;
  action: MemoryAuditAction;
  memoryId: string | null;
  query: string | null;
  outcome: MemoryAuditOutcome;
  reason: string | null;
  createdAt: Date;
}

/**
 * Append one audit row. Best-effort: returns `false` on any failure instead of
 * throwing, so callers can safely fire-and-forget from hot paths.
 */
export function recordMemoryAudit(input: {
  apiKeyId: string;
  action: MemoryAuditAction;
  memoryId?: string | null;
  query?: string | null;
  outcome: MemoryAuditOutcome;
  reason?: string | null;
}): boolean {
  try {
    const db = getDbInstance();
    db.prepare(
      "INSERT INTO memory_audit (api_key_id, action, memory_id, query, outcome, reason) " +
        "VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      input.apiKeyId,
      input.action,
      input.memoryId ?? null,
      input.query ?? null,
      input.outcome,
      input.reason ?? null
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * List the most recent audit rows for an api key, newest first.
 * `action` is optional — when omitted, all actions are returned.
 */
export function listMemoryAudit(
  apiKeyId: string,
  action?: MemoryAuditAction,
  limit = 100
): MemoryAuditEntry[] {
  const db = getDbInstance();
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const where = action ? "WHERE api_key_id = ? AND action = ?" : "WHERE api_key_id = ?";
  const rows = (
    action
      ? db
          .prepare(`SELECT * FROM memory_audit ${where} ORDER BY id DESC LIMIT ?`)
          .all(apiKeyId, action, safeLimit)
      : db
          .prepare(`SELECT * FROM memory_audit ${where} ORDER BY id DESC LIMIT ?`)
          .all(apiKeyId, safeLimit)
  ) as Array<{
    id: number;
    api_key_id: string;
    action: string;
    memory_id: string | null;
    query: string | null;
    outcome: string;
    reason: string | null;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    apiKeyId: String(row.api_key_id),
    action: row.action as MemoryAuditAction,
    memoryId: row.memory_id ? String(row.memory_id) : null,
    query: row.query ? String(row.query) : null,
    outcome: row.outcome as MemoryAuditOutcome,
    reason: row.reason ? String(row.reason) : null,
    createdAt: new Date(String(row.created_at)),
  }));
}

/**
 * Purge audit rows older than `beforeIso`. Returns the number of rows removed.
 * Intended for operators / retention sweeps, not for the request path.
 */
export function purgeMemoryAuditOlderThan(beforeIso: string): number {
  const db = getDbInstance();
  const info = db.prepare("DELETE FROM memory_audit WHERE created_at < datetime(?)").run(beforeIso);
  return Number(info.changes ?? 0);
}
