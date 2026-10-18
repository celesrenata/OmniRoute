/**
 * tests/unit/memory-v2-provenance.test.ts
 *
 * WP2 — memory provenance (source / confidence / recorded_at) + audit log
 * regression tests. DB-backed; runs in its own isolated DATA_DIR and resets the
 * DB between cases (same harness shape as memory-v2-gates-db.test.ts).
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-memory-wp2-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.VECTOR_STORE_DISABLE_VEC = "true";

const core = await import("../../src/lib/db/core.ts");
const { createMemory, getMemory } = await import("../../src/lib/memory/store.ts");
const { recordMemoryAudit, listMemoryAudit, purgeMemoryAuditOlderThan } =
  await import("../../src/lib/db/memoryAudit.ts");

async function cleanup() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

after(async () => {
  await cleanup();
});

test("WP2: createMemory INSERT stamps source, confidence, recorded_at", async () => {
  await cleanup();
  const mem = await createMemory({
    apiKeyId: "key-WP2",
    sessionId: "sess-1",
    type: "factual",
    key: "wp2-source-test",
    content: "I prefer dark mode",
    metadata: { category: "preference" },
    source: "user-message",
    confidence: "high",
    expiresAt: null,
  });

  assert.equal(mem.source, "user-message");
  assert.equal(mem.confidence, "high");
  assert.ok(mem.recordedAt, "recordedAt should be set on insert");
  assert.ok(Math.abs(mem.recordedAt!.getTime() - Date.now()) < 5000, "recordedAt ≈ now");

  const fetched = await getMemory(mem.id);
  assert.ok(fetched, "getMemory returns the row");
  assert.equal(fetched!.source, "user-message");
  assert.equal(fetched!.confidence, "high");
  assert.ok(fetched!.recordedAt, "recordedAt round-trips");
});

test("WP2: createMemory upsert preserves recorded_at, merges source/confidence", async () => {
  await cleanup();
  const original = await createMemory({
    apiKeyId: "key-WP2",
    sessionId: "sess-1",
    type: "factual",
    key: "wp2-upsert-key",
    content: "original fact",
    metadata: {},
    source: "user-message",
    confidence: "low",
    expiresAt: null,
  });

  // Small delay so the upsert's updated_at is strictly after recorded_at.
  await new Promise((r) => setTimeout(r, 50));

  const updated = await createMemory({
    apiKeyId: "key-WP2",
    sessionId: "sess-1",
    type: "factual",
    key: "wp2-upsert-key",
    content: "updated fact",
    metadata: { category: "decision" },
    source: "assistant-response",
    confidence: "medium",
    expiresAt: null,
  });

  assert.equal(updated.id, original.id, "upsert reuses the same id");
  assert.equal(updated.content, "updated fact");
  assert.equal(updated.source, "assistant-response", "source updated from new extraction");
  assert.equal(updated.confidence, "medium", "confidence updated");
  assert.ok(
    updated.recordedAt!.getTime() <= original.recordedAt!.getTime() + 1000,
    "recorded_at preserved from the original insert"
  );
});

test("WP2: createMemory without source leaves it null (back-compat)", async () => {
  await cleanup();
  const mem = await createMemory({
    apiKeyId: "key-WP2",
    sessionId: "sess-1",
    type: "semantic",
    key: "wp2-no-source",
    content: "a fact without provenance",
    metadata: {},
    expiresAt: null,
  });

  assert.equal(mem.source, null);
  assert.equal(mem.confidence, null);
  assert.ok(mem.recordedAt, "recorded_at defaults to insert time");
});

test("WP2: recordMemoryAudit + listMemoryAudit round-trip", async () => {
  await cleanup();
  recordMemoryAudit({
    apiKeyId: "key-audit",
    action: "accept",
    memoryId: "mem-123",
    query: "test query",
    outcome: "dropped",
    reason: "no_signal",
  });
  recordMemoryAudit({
    apiKeyId: "key-audit",
    action: "materialize",
    memoryId: "mem-456",
    outcome: "dropped",
    reason: "stale_index",
  });

  const entries = listMemoryAudit("key-audit", undefined, 10);
  assert.equal(entries.length, 2, "exactly 2 audit entries");

  // Newest first
  assert.equal(entries[0].action, "materialize");
  assert.equal(entries[0].memoryId, "mem-456");
  assert.equal(entries[0].outcome, "dropped");
  assert.equal(entries[0].reason, "stale_index");

  assert.equal(entries[1].action, "accept");
  assert.equal(entries[1].query, "test query");
  assert.equal(entries[1].reason, "no_signal");
});

test("WP2: listMemoryAudit filters by action", async () => {
  await cleanup();
  recordMemoryAudit({
    apiKeyId: "key-audit-2",
    action: "extract",
    outcome: "created",
    memoryId: "m1",
  });
  recordMemoryAudit({ apiKeyId: "key-audit-2", action: "accept", outcome: "dropped" });

  const extractOnly = listMemoryAudit("key-audit-2", "extract", 10);
  assert.equal(extractOnly.length, 1, "only the extract row is returned");
  assert.equal(extractOnly[0].action, "extract");
  assert.equal(extractOnly[0].memoryId, "m1");
});

test("WP2: purgeMemoryAuditOlderThan removes old rows", async () => {
  await cleanup();
  recordMemoryAudit({ apiKeyId: "key-audit-3", action: "accept", outcome: "dropped" });

  // "2099-01-01" is in the future — every row created before then is removed.
  const removed = purgeMemoryAuditOlderThan("2099-01-01");
  assert.ok(removed >= 1, "at least one row removed");

  assert.equal(listMemoryAudit("key-audit-3", undefined, 10).length, 0, "all audit rows purged");
});

test("WP2: memories table has provenance columns + memory_audit table (migration 197)", async () => {
  await cleanup();
  const db = core.getDbInstance();

  const info = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  const colNames = info.map((c) => c.name);
  assert.ok(colNames.includes("source"), "memories.source exists");
  assert.ok(colNames.includes("confidence"), "memories.confidence exists");
  assert.ok(colNames.includes("recorded_at"), "memories.recorded_at exists");

  const auditTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_audit'")
    .get();
  assert.ok(auditTable, "memory_audit table exists");
});
