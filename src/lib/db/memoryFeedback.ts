/**
 * db/memoryFeedback.ts — Intelligence Layer v2 (WP5) durable feedback /
 * retrieval-event / reindex-job domain module.
 *
 * Tables are created by migration 199
 * (`199_memory_feedback_retrieval_reindex.sql`).
 *
 * Raw SQL is allowed here (Hard Rule #5 — src/lib/db/ domain module).
 *
 * Purpose:
 *   - memory_feedback: capture operator/user/agent signal on whether a returned
 *     memory was actually useful; the source signal for ranking recalibration
 *     and for quarantining consistently-wrong memories.
 *   - memory_retrieval_events: one row per retrieval decision, recording
 *     candidate vs returned counts and drop reasons — a full decision trail
 *     that pairs with memory_audit (per-candidate gate log, migration 197).
 *   - memory_reindex_jobs: durable record of background reindex runs so a model
 *     swap or a failed batch is diagnosable and retryable.
 *
 * All writes are best-effort from the hot path (the feedback/event helpers never
 * throw into the request pipeline); the reindex-job helpers are used from the
 * reindex batch runner.
 */
import { getDbInstance } from "./core";

export type FeedbackSignal = "useful" | "not_useful" | "wrong" | "outdated" | "off_topic";
export type FeedbackSource = "operator" | "user" | "agent" | "auto";
export type ReindexTrigger = "manual" | "model_swap" | "failure_retry" | "scheduled";
export type ReindexJobStatus = "pending" | "running" | "done" | "failed";

export interface FeedbackRow {
  id: number;
  apiKeyId: string;
  memoryId: string;
  signal: string;
  sourceKind: string | null;
  comment: string | null;
  createdAt: string;
}

export interface RetrievalEventInput {
  apiKeyId: string;
  query?: string | null;
  strategy: string;
  backend: string;
  candidateCount: number;
  returnedCount: number;
  droppedReasons?: Array<{ memoryId: string; reason: string }> | null;
  durationMs?: number | null;
}

export interface ReindexJobInput {
  apiKeyId?: string | null;
  trigger: ReindexTrigger;
  embeddingModel?: string | null;
  embeddingDim?: number | null;
}

/**
 * Record a feedback signal for a returned memory. Returns the row id, or
 * `null` if the write failed (best-effort).
 */
export function recordMemoryFeedback(input: {
  apiKeyId: string;
  memoryId: string;
  signal: FeedbackSignal;
  sourceKind?: FeedbackSource | null;
  comment?: string | null;
}): number | null {
  try {
    const db = getDbInstance();
    const info = db
      .prepare(
        `INSERT INTO memory_feedback (api_key_id, memory_id, signal, source_kind, comment)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        input.apiKeyId,
        input.memoryId,
        input.signal,
        input.sourceKind ?? null,
        input.comment ?? null
      );
    return Number(info.lastInsertRowid);
  } catch {
    return null;
  }
}

/**
 * Aggregate feedback signals for a memory. Powers the "is this memory
 * consistently wrong?" quarantine decision: a memory with more negative than
 * positive signals should be demoted.
 */
export function getMemoryFeedbackStats(memoryId: string): {
  useful: number;
  notUseful: number;
  wrong: number;
  outdated: number;
  offTopic: number;
  total: number;
} {
  const db = getDbInstance();
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN signal = 'useful' THEN 1 ELSE 0 END) AS useful,
         SUM(CASE WHEN signal = 'not_useful' THEN 1 ELSE 0 END) AS notUseful,
         SUM(CASE WHEN signal = 'wrong' THEN 1 ELSE 0 END) AS wrong,
         SUM(CASE WHEN signal = 'outdated' THEN 1 ELSE 0 END) AS outdated,
         SUM(CASE WHEN signal = 'off_topic' THEN 1 ELSE 0 END) AS offTopic,
         COUNT(*) AS total
       FROM memory_feedback WHERE memory_id = ?`
    )
    .get(memoryId) as Record<string, number | null> | undefined;
  const n = (v: number | null | undefined) => (typeof v === "number" ? v : 0);
  return {
    useful: n(row?.useful),
    notUseful: n(row?.notUseful),
    wrong: n(row?.wrong),
    outdated: n(row?.outdated),
    offTopic: n(row?.offTopic),
    total: n(row?.total),
  };
}

/**
 * Record a retrieval decision event. Best-effort (never throws).
 */
export function recordRetrievalEvent(input: RetrievalEventInput): number | null {
  try {
    const db = getDbInstance();
    const droppedJson =
      input.droppedReasons && input.droppedReasons.length > 0
        ? JSON.stringify(input.droppedReasons)
        : null;
    const info = db
      .prepare(
        `INSERT INTO memory_retrieval_events
           (api_key_id, query, strategy, backend, candidate_count, returned_count,
            dropped_reasons, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.apiKeyId,
        input.query ?? null,
        input.strategy,
        input.backend,
        input.candidateCount,
        input.returnedCount,
        droppedJson,
        input.durationMs ?? null
      );
    return Number(info.lastInsertRowid);
  } catch {
    return null;
  }
}

/**
 * Start a reindex job. Returns the new job id.
 */
export function startReindexJob(input: ReindexJobInput): number {
  const db = getDbInstance();
  const info = db
    .prepare(
      `INSERT INTO memory_reindex_jobs
         (api_key_id, trigger, embedding_model, embedding_dim, status)
       VALUES (?, ?, ?, ?, 'running')`
    )
    .run(
      input.apiKeyId ?? null,
      input.trigger,
      input.embeddingModel ?? null,
      input.embeddingDim ?? null
    );
  const id = Number(info.lastInsertRowid);
  db.prepare(`UPDATE memory_reindex_jobs SET started_at = datetime('now') WHERE id = ?`).run(id);
  return id;
}

/**
 * Complete a reindex job with the run's totals.
 */
export function finishReindexJob(
  jobId: number,
  result: { processed: number; failed: number; total?: number; error?: string | null }
): void {
  const db = getDbInstance();
  const status: ReindexJobStatus = result.failed > 0 ? "failed" : "done";
  db.prepare(
    `UPDATE memory_reindex_jobs
       SET status = ?, total = ?, processed = ?, failed = ?, error = ?, finished_at = datetime('now')
     WHERE id = ?`
  ).run(
    status,
    result.total ?? result.processed + result.failed,
    result.processed,
    result.failed,
    result.error ?? null,
    jobId
  );
}

/**
 * List the most recent reindex jobs, newest first.
 */
export function listReindexJobs(limit = 50): {
  id: number;
  apiKeyId: string | null;
  trigger: string;
  embeddingModel: string | null;
  embeddingDim: number | null;
  status: string;
  total: number;
  processed: number;
  failed: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}[] {
  const db = getDbInstance();
  return db
    .prepare(
      `SELECT id, api_key_id AS apiKeyId, trigger, embedding_model AS embeddingModel,
              embedding_dim AS embeddingDim, status, total, processed, failed, error,
              started_at AS startedAt, finished_at AS finishedAt, created_at AS createdAt
         FROM memory_reindex_jobs ORDER BY id DESC LIMIT ?`
    )
    .all(limit) as unknown as {
    id: number;
    apiKeyId: string | null;
    trigger: string;
    embeddingModel: string | null;
    embeddingDim: number | null;
    status: string;
    total: number;
    processed: number;
    failed: number;
    error: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    createdAt: string;
  }[];
}
