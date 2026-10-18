/**
 * tests/unit/memory-v2-gates-db.test.ts
 *
 * DB-backed regression tests for the M1 (materialization gate) and M3 (no-recency
 * fallback) gates, plus a sanity check that the M2 (accept gate) drops
 * zero-signal candidates on the FTS path.
 *
 * Runs in its own isolated DATA_DIR. Each test resets the DB between cases.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-memory-v2-gates-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.VECTOR_STORE_DISABLE_VEC = "true";

const core = await import("../../src/lib/db/core.ts");
const { createMemory } = await import("../../src/lib/memory/store.ts");
const { retrieveMemories } = await import("../../src/lib/memory/retrieval.ts");
import { MemoryType } from "../../src/lib/memory/types.ts";

async function cleanup() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

after(async () => {
  await cleanup();
});

test("M1: materialization gate — expired memory is dropped when the flag is ON", async () => {
  try {
    await cleanup();
    const valid = await createMemory({
      apiKeyId: "key-A",
      type: MemoryType.FACTUAL,
      key: "editor",
      content: "I prefer dark mode",
      metadata: {},
      sessionId: "sess",
    });
    const expired = await createMemory({
      apiKeyId: "key-A",
      type: MemoryType.FACTUAL,
      key: "expired",
      content: "this should be expired",
      metadata: {},
      sessionId: "sess",
    });
    const db = core.getDbInstance();
    db.prepare("UPDATE memories SET expires_at = datetime('now', '-1 day') WHERE id = ?").run(
      expired.id
    );

    process.env.MEMORY_V2_MATERIALIZATION_GATE = "true";
    try {
      const memories = await retrieveMemories("key-A", { retrievalStrategy: "hybrid" });
      const ids = memories.map((m) => m.id);
      assert.ok(ids.includes(valid.id), "valid memory returned");
      assert.ok(!ids.includes(expired.id), "expired memory must be dropped by the gate");
    } finally {
      delete process.env.MEMORY_V2_MATERIALIZATION_GATE;
    }
  } finally {
    await cleanup();
  }
});

test("M1: materialization gate — another key's memory is dropped when the flag is ON", async () => {
  try {
    await cleanup();
    const mine = await createMemory({
      apiKeyId: "key-A",
      type: MemoryType.FACTUAL,
      key: "editor",
      content: "I prefer dark mode",
      metadata: {},
      sessionId: "sess",
    });
    const others = await createMemory({
      apiKeyId: "key-B",
      type: MemoryType.FACTUAL,
      key: "editor",
      content: "I prefer dark mode",
      metadata: {},
      sessionId: "sess",
    });

    process.env.MEMORY_V2_MATERIALIZATION_GATE = "true";
    try {
      const memories = await retrieveMemories("key-A", { retrievalStrategy: "hybrid" });
      const ids = memories.map((m) => m.id);
      assert.ok(ids.includes(mine.id), "own memory returned");
      assert.ok(!ids.includes(others.id), "another key's memory must be dropped");
    } finally {
      delete process.env.MEMORY_V2_MATERIALIZATION_GATE;
    }
  } finally {
    await cleanup();
  }
});

test("M3: recency-fallback suppressed by MEMORY_V2_NO_RECENCY_FALLBACK (strategy=hybrid, no query)", async () => {
  try {
    await cleanup();
    for (let i = 0; i < 3; i++) {
      await createMemory({
        apiKeyId: "key-A",
        type: MemoryType.FACTUAL,
        key: `k${i}`,
        content: `content ${i}`,
        metadata: {},
        sessionId: "sess",
      });
    }

    delete process.env.MEMORY_V2_NO_RECENCY_FALLBACK;
    const legacy = await retrieveMemories("key-A", { retrievalStrategy: "hybrid" });
    assert.ok(legacy.length > 0, "legacy returns recency-based memories");

    process.env.MEMORY_V2_NO_RECENCY_FALLBACK = "true";
    try {
      const gated = await retrieveMemories("key-A", { retrievalStrategy: "hybrid" });
      assert.equal(gated.length, 0, "gate must suppress recency fallback");
    } finally {
      delete process.env.MEMORY_V2_NO_RECENCY_FALLBACK;
    }
  } finally {
    await cleanup();
  }
});

test("M2: accept gate — FTS/hybrid drops candidates with no meaningful signal", async () => {
  try {
    await cleanup();
    await createMemory({
      apiKeyId: "key-A",
      type: MemoryType.FACTUAL,
      key: "modern",
      content: "I use a modern framework for my app",
      metadata: {},
      sessionId: "sess",
    });

    process.env.MEMORY_V2_ACCEPT_GATE = "true";
    try {
      const memories = await retrieveMemories("key-A", {
        retrievalStrategy: "hybrid",
        query: "mod",
      });
      assert.equal(memories.length, 0, "accept gate must reject fragment-only matches");
    } finally {
      delete process.env.MEMORY_V2_ACCEPT_GATE;
    }
  } finally {
    await cleanup();
  }
});

test("M2: accept gate — a real term hit still passes", async () => {
  try {
    await cleanup();
    await createMemory({
      apiKeyId: "key-A",
      type: MemoryType.FACTUAL,
      key: "dark",
      content: "I prefer dark mode in the editor",
      metadata: {},
      sessionId: "sess",
    });

    process.env.MEMORY_V2_ACCEPT_GATE = "true";
    try {
      const memories = await retrieveMemories("key-A", {
        retrievalStrategy: "hybrid",
        query: "dark",
      });
      assert.ok(memories.length >= 1, "real term must pass the gate");
    } finally {
      delete process.env.MEMORY_V2_ACCEPT_GATE;
    }
  } finally {
    await cleanup();
  }
});
