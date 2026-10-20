/**
 * db/memoryProvenanceV2.ts — Intelligence Layer v2 (WP1) provenance + versioned
 * supersession domain module.
 *
 * Builds on migration 202 (`202_memory_provenance_supersession.sql`) and
 * migration 197 (source / confidence / recorded_at + memory_audit).
 *
 * This module gives the extraction / memory_save paths a safe way to:
 *   - record provenance quotes (raw source text kept apart from the canonical
 *     fact, so review/correction is possible — spec B1);
 *   - supersede a memory with a new version on contradiction, preserving the
 *     old value in `memory_revisions` for audit/rollback (spec B2: "handle
 *     contradiction through versioned supersession, not silent overwriting");
 *   - update verification state / status / sensitivity as a memory is
 *     corroborated, disputed, quarantined or deleted.
 *
 * Raw SQL is allowed here (Hard Rule #5 — src/lib/db/ domain module).
 *
 * All writes are additive and idempotent-safe. Nothing is ever hard-deleted;
 * "deleted" is a status, and history is append-only.
 */
import { getDbInstance } from "./core";

export type MemoryStatus = "active" | "superseded" | "disputed" | "quarantined" | "deleted";
export type VerificationState =
  "unverified" | "corroborated" | "confirmed" | "disputed" | "rejected";
export type MemorySensitivity = "normal" | "sensitive" | "secret";

export interface ProvenanceQuote {
  quoteText?: string | null;
  sourceKind: string;
  sourceUri?: string | null;
  sourceTurnId?: string | null;
  observedAt?: string | null;
}

export interface RevisionRecord {
  id: number;
  memoryId: string;
  revisionNo: number;
  content: string;
  subject: string | null;
  predicate: string | null;
  sourceKind: string | null;
  verificationState: string | null;
  confidence: string | null;
  supersededReason: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface SupersedeInput {
  /** The memory row being replaced (must exist and be readable). */
  memoryId: string;
  /** The new canonical content that supersedes the old value. */
  content: string;
  /** Why the old value is being superseded (audit). */
  reason: string;
  /** Principal making the change (e.g. "operator", "extraction", a key id). */
  actor?: string | null;
  /** Optional provenance quote backing the new value. */
  provenance?: ProvenanceQuote;
  subject?: string | null;
  predicate?: string | null;
  sourceKind?: string | null;
  verificationState?: VerificationState;
  confidence?: string | null;
}

export interface SupersedeResult {
  supersededId: string;
  newId: string;
  revisionNo: number;
}

/**
 * Insert one provenance quote row for a memory. Returns the row id.
 */
export function addProvenance(memoryId: string, p: ProvenanceQuote): number {
  const db = getDbInstance();
  const info = db
    .prepare(
      `INSERT INTO memory_provenance
         (memory_id, quote_text, source_kind, source_uri, source_turn_id, observed_at, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .run(
      memoryId,
      p.quoteText ?? null,
      p.sourceKind,
      p.sourceUri ?? null,
      p.sourceTurnId ?? null,
      p.observedAt ?? null
    );
  return Number(info.lastInsertRowid);
}

/**
 * Return all provenance quotes recorded for a memory, oldest first.
 */
export function getProvenance(memoryId: string): {
  id: number;
  quoteText: string | null;
  sourceKind: string | null;
  sourceUri: string | null;
  sourceTurnId: string | null;
  observedAt: string | null;
  recordedAt: string;
}[] {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT id,
              quote_text AS quoteText,
              source_kind AS sourceKind,
              source_uri AS sourceUri,
              source_turn_id AS sourceTurnId,
              observed_at AS observedAt,
              recorded_at AS recordedAt
         FROM memory_provenance WHERE memory_id = ? ORDER BY id ASC`
    )
    .all(memoryId) as unknown as {
    id: number;
    quoteText: string | null;
    sourceKind: string | null;
    sourceUri: string | null;
    sourceTurnId: string | null;
    observedAt: string | null;
    recordedAt: string;
  }[];
}

/**
 * Fetch the full revision history for a memory (all superseded versions),
 * oldest first.
 */
export function getRevisions(memoryId: string): RevisionRecord[] {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT id,
              memory_id AS memoryId,
              revision_no AS revisionNo,
              content,
              subject,
              predicate,
              source_kind AS sourceKind,
              verification_state AS verificationState,
              confidence,
              superseded_reason AS supersededReason,
              created_by AS createdBy,
              created_at AS createdAt
         FROM memory_revisions WHERE memory_id = ? ORDER BY revision_no ASC`
    )
    .all(memoryId) as unknown as RevisionRecord[];
}

/**
 * Update a memory's verification state / status / sensitivity. Used when a
 * memory is corroborated, confirmed, disputed, quarantined or marked deleted
 * (a status change, not a row removal).
 */
export function updateMemoryVerification(input: {
  memoryId: string;
  verificationState?: VerificationState;
  status?: MemoryStatus;
  sensitivity?: MemorySensitivity;
  verifiedAt?: string | null;
}): boolean {
  const db = getDbInstance();
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.verificationState !== undefined) {
    sets.push("verification_state = ?");
    params.push(input.verificationState);
  }
  if (input.status !== undefined) {
    sets.push("status = ?");
    params.push(input.status);
  }
  if (input.sensitivity !== undefined) {
    sets.push("sensitivity = ?");
    params.push(input.sensitivity);
  }
  if (input.verifiedAt !== undefined) {
    sets.push("verified_at = ?");
    params.push(input.verifiedAt);
  }
  if (sets.length === 0) return false;
  sets.push("updated_at = datetime('now')");
  params.push(input.memoryId);
  const info = db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return info.changes > 0;
}

/**
 * Versioned supersession (spec B2).
 *
 * Given an existing memory row that is being replaced by a new (contradicting
 * or refined) value, this:
 *   1. snapshots the OLD value into `memory_revisions` (audit/rollback),
 *   2. marks the old row `status = 'superseded'`,
 *   3. creates a NEW row carrying the new content and `supersedes_id = oldId`,
 *   4. records the provenance quote for the new value, if provided.
 *
 * The old row is preserved — never overwritten or deleted — so correction and
 * rollback are possible. Returns the new memory id and the revision number
 * assigned to the old value.
 */
export function supersedeMemory(input: SupersedeInput): SupersedeResult {
  const db = getDbInstance();
  const old = db.prepare("SELECT * FROM memories WHERE id = ?").get(input.memoryId) as
    Record<string, unknown> | undefined;
  if (!old) throw new Error(`supersedeMemory: no such memory ${input.memoryId}`);

  // Read the inherited fields once, up front, so the INSERT below is a clean,
  // fully-explicit value list (no interleaved subquery placeholders).
  const oldContent = typeof old.content === "string" ? old.content : String(old.content);
  const str = (v: unknown): string | null =>
    typeof v === "string" ? v : v == null ? null : String(v);

  const newId = `${input.memoryId}#r${Date.now().toString(36)}`;
  let revisionNo = 1;

  const tx = db.transaction(() => {
    // 1. Snapshot the old value into the append-only revisions table.
    revisionNo =
      Number(
        (
          db
            .prepare("SELECT MAX(revision_no) AS m FROM memory_revisions WHERE memory_id = ?")
            .get(input.memoryId) as { m: number | null } | undefined
        )?.m ?? 0
      ) + 1;
    db.prepare(
      `INSERT INTO memory_revisions
         (memory_id, revision_no, content, subject, predicate, source_kind,
          verification_state, confidence, superseded_reason, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.memoryId,
      revisionNo,
      oldContent,
      input.subject ?? str(old.subject),
      input.predicate ?? str(old.predicate),
      input.sourceKind ?? str(old.source),
      str(old.verification_state),
      str(old.confidence),
      input.reason,
      input.actor ?? null
    );

    // 2. Mark the old row superseded (the value is preserved in revisions).
    db.prepare(
      `UPDATE memories SET status = 'superseded', updated_at = datetime('now') WHERE id = ?`
    ).run(input.memoryId);

    // 3. Create the new row, linked to the old via supersedes_id, inheriting
    //    owner / scope / embedding provenance from the old row.
    db.prepare(
      `INSERT INTO memories
         (id, api_key_id, session_id, type, key, content, metadata,
          created_at, updated_at, expires_at,
          source, confidence, recorded_at,
          scope, agent_id, workspace_id, subject, predicate,
          verification_state, sensitivity, status, supersedes_id,
          embedding_model, embedding_version)
       VALUES (?, ?, ?, ?, ?, ?, ?,
               datetime('now'), datetime('now'), ?,
               ?, ?, ?,
               ?, ?, ?, ?, ?,
               ?, ?, 'active', ?,
               ?, ?)`
    ).run(
      newId,
      str(old.api_key_id),
      str(old.session_id),
      str(old.type),
      str(old.key),
      input.content,
      str(old.metadata),
      str(old.expires_at),
      input.sourceKind ?? str(old.source),
      input.confidence ?? str(old.confidence),
      str(old.recorded_at),
      str(old.scope),
      str(old.agent_id),
      str(old.workspace_id),
      input.subject ?? str(old.subject),
      input.predicate ?? str(old.predicate),
      input.verificationState ?? "unverified",
      "normal",
      input.memoryId,
      str(old.embedding_model),
      str(old.embedding_version)
    );

    // 4. Provenance quote for the new value, if provided.
    if (input.provenance) {
      addProvenance(newId, input.provenance);
    }
  });
  tx();

  return { supersededId: input.memoryId, newId, revisionNo };
}

/**
 * Find the active memory for a (api_key_id, subject, predicate) tuple —
 * the dedup key for "semantically equivalent facts per trusted scope".
 * Returns the most recently updated active row, or null.
 */
export function findActiveByCanonicalKey(params: {
  apiKeyId: string;
  subject?: string | null;
  predicate?: string | null;
}): string | null {
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT id FROM memories
         WHERE api_key_id = ?
           AND subject = ?
           AND predicate = ?
           AND (status IS NULL OR status = 'active')
       ORDER BY updated_at DESC LIMIT 1`
    )
    .get(params.apiKeyId, params.subject ?? null, params.predicate ?? null) as
    { id: string } | undefined;
  return row?.id ?? null;
}
