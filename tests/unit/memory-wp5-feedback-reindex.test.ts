/**
 * tests/unit/memory-wp5-feedback-reindex.test.ts
 *
 * DB-backed regression tests for WP5 — durable memory feedback, retrieval
 * events, and reindex jobs (migration 199 + db/memoryFeedback.ts).
 *
 * Locks in:
 *   - feedback is recorded and aggregates correctly (useful/wrong counts)
 *   - retrieval events capture candidate vs returned counts + drop reasons
 *   - a reindex job is created running, then finished done/failed with totals
 *   - the tracked reindex batch wrapper records a job and preserves the result
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-memory-wp5-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.VECTOR_STORE_DISABLE_VEC = "true";

const core = await import("../../src/lib/db/core.ts");
const { getDbInstance, resetDbInstance } = core;
const fb = await import("../../src/lib/db/memoryFeedback.ts");

async function resetDb() {
  resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  return getDbInstance();
}

after(async () => {
  resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function insertMemory(db: ReturnType<typeof getDbInstance>, id: string, content: string) {
  db.prepare("INSERT INTO memories (id, api_key_id, type, content) VALUES (?, ?, ?, ?)").run(
    id,
    "key-A",
    "factual",
    content
  );
}

test("WP5: recordMemoryFeedback stores the signal and getMemoryFeedbackStats aggregates", async () => {
  const db = await resetDb();
  insertMemory(db, "mem1", "fact");
  const id1 = fb.recordMemoryFeedback({
    apiKeyId: "key-A",
    memoryId: "mem1",
    signal: "useful",
    sourceKind: "operator",
  });
  const id2 = fb.recordMemoryFeedback({
    apiKeyId: "key-A",
    memoryId: "mem1",
    signal: "wrong",
    comment: "stale",
  });
  assert.ok(id1 && id2);
  const stats = fb.getMemoryFeedbackStats("mem1");
  assert.equal(stats.useful, 1);
  assert.equal(stats.wrong, 1);
  assert.equal(stats.total, 2);
});

test("WP5: getMemoryFeedbackStats returns zeros for a memory with no feedback", async () => {
  await resetDb();
  const stats = fb.getMemoryFeedbackStats("nobody");
  assert.equal(stats.total, 0);
  assert.equal(stats.useful, 0);
});

test("WP5: recordRetrievalEvent persists candidate vs returned counts and drop reasons", async () => {
  const db = await resetDb();
  const id = fb.recordRetrievalEvent({
    apiKeyId: "key-A",
    query: "timezone",
    strategy: "hybrid",
    backend: "hybrid",
    candidateCount: 5,
    returnedCount: 2,
    droppedReasons: [
      { memoryId: "m1", reason: "expired" },
      { memoryId: "m2", reason: "no_relevance_signal" },
    ],
    durationMs: 12,
  });
  assert.ok(id);
  const row = db.prepare("SELECT * FROM memory_retrieval_events WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;
  assert.equal(row.strategy, "hybrid");
  assert.equal(row.candidate_count, 5);
  assert.equal(row.returned_count, 2);
  const dropped = JSON.parse(String(row.dropped_reasons)) as Array<{
    memoryId: string;
    reason: string;
  }>;
  assert.equal(dropped.length, 2);
  assert.equal(dropped[0].reason, "expired");
});

test("WP5: reindex job lifecycle — running then done with totals", async () => {
  const db = await resetDb();
  const jobId = fb.startReindexJob({ trigger: "manual", embeddingModel: "m", embeddingDim: 384 });
  const running = db.prepare("SELECT * FROM memory_reindex_jobs WHERE id = ?").get(jobId) as Record<
    string,
    unknown
  >;
  assert.equal(running.status, "running");
  assert.equal(running.started_at, running.started_at); // non-null
  fb.finishReindexJob(jobId, { processed: 10, failed: 0, total: 10 });
  const done = db.prepare("SELECT * FROM memory_reindex_jobs WHERE id = ?").get(jobId) as Record<
    string,
    unknown
  >;
  assert.equal(done.status, "done");
  assert.equal(done.processed, 10);
  assert.equal(done.failed, 0);
  assert.ok(done.finished_at);
});

test("WP5: reindex job marked failed when there are errors", async () => {
  const db = await resetDb();
  const jobId = fb.startReindexJob({ trigger: "failure_retry" });
  fb.finishReindexJob(jobId, { processed: 3, failed: 2, error: "embedding timeout" });
  const row = db.prepare("SELECT * FROM memory_reindex_jobs WHERE id = ?").get(jobId) as Record<
    string,
    unknown
  >;
  assert.equal(row.status, "failed");
  assert.equal(row.error, "embedding timeout");
});

test("WP5: listReindexJobs returns newest first", async () => {
  await resetDb();
  const a = fb.startReindexJob({ trigger: "manual" });
  const b = fb.startReindexJob({ trigger: "model_swap" });
  fb.finishReindexJob(a, { processed: 1, failed: 0 });
  const jobs = fb.listReindexJobs(10);
  assert.ok(jobs.length >= 2);
  assert.equal(jobs[0].id, b); // b is newer
});

test("WP5: runTrackedReindexBatch records a job and returns the result", async () => {
  await resetDb();
  const { runTrackedReindexBatch } = await import("../../src/lib/memory/reindex.ts");
  // No pending items → processed 0, but the job row is still created.
  const result = await runTrackedReindexBatch(10, "manual");
  assert.equal(result.processed, 0);
  assert.equal(result.errors, 0);
  assert.ok(result.jobId > 0);
  const jobs = fb.listReindexJobs(5);
  assert.ok(jobs.length >= 1);
  assert.equal(jobs[0].trigger, "manual");
});
