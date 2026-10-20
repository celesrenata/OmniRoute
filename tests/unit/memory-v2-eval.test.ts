/**
 * tests/unit/memory-v2-eval.test.ts
 *
 * WP5 — drives the memory eval harness on a seeded two-key dataset and asserts
 * the four acceptance properties: recall, precision, grounding, cross-account
 * isolation. DB-backed; isolated DATA_DIR (same harness shape as the other
 * memory-v2 tests).
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-memory-eval-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.VECTOR_STORE_DISABLE_VEC = "true";

const core = await import("../../src/lib/db/core.ts");
const { runMemoryEval } = await import("../../src/lib/evals/memoryEval.ts");

async function cleanup() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

after(async () => {
  await cleanup();
});

test("WP5: harness reports high recall + precision, full grounding, zero cross-account leaks", async () => {
  await cleanup();

  // Two keys, three relevant memories for key-A, one unrelated for key-B.
  const report = await runMemoryEval(
    [
      { apiKeyId: "key-A", key: "editor", content: "I use vim as my editor" },
      { apiKeyId: "key-A", key: "language", content: "I prefer Rust for systems work" },
      { apiKeyId: "key-A", key: "timezone", content: "I live in the São Paulo timezone" },
      // key-B's memory — must NEVER surface on a key-A retrieval.
      { apiKeyId: "key-B", key: "editor", content: "I use emacs as my editor" },
    ],
    [
      { apiKeyId: "key-A", query: "editor", expectedKeys: ["editor"] },
      { apiKeyId: "key-A", query: "Rust language", expectedKeys: ["language"] },
      { apiKeyId: "key-A", query: "timezone", expectedKeys: ["timezone"] },
      // Negative: a query with no matching memory — precision should not
      // collapse, and key-A must not leak key-B's rows.
      { apiKeyId: "key-A", query: "completely unrelated zzzzzz", expectedKeys: [] },
    ],
    { minPrecision: 0.7, minRecall: 0.8 }
  );

  // Grounding: every returned row was owned + unexpired.
  assert.equal(report.groundingRate, 1.0, `grounding failed: ${JSON.stringify(report.queries)}`);

  // Cross-account isolation: zero leaks.
  assert.equal(
    report.crossAccountLeaks,
    0,
    `cross-account leak: ${JSON.stringify(report.queries)}`
  );
  for (const q of report.queries) {
    assert.deepEqual(q.crossAccountLeaks, []);
  }

  // Aggregate gates.
  assert.ok(report.recall >= 0.8, `recall ${report.recall} < 0.8`);
  assert.ok(report.precision >= 0.7, `precision ${report.precision} < 0.7`);
  assert.ok(report.pass, "harness pass=true");
});

test("WP5: cross-account retrieval — key-B sees its own memory, not key-A's", async () => {
  await cleanup();

  const report = await runMemoryEval(
    [
      { apiKeyId: "key-A", key: "editor", content: "I use vim as my editor" },
      { apiKeyId: "key-B", key: "editor", content: "I use emacs as my editor" },
    ],
    [{ apiKeyId: "key-B", query: "editor", expectedKeys: ["editor"] }],
    { minPrecision: 1.0, minRecall: 1.0 }
  );

  // key-B's retrieval returns exactly its own "editor" memory.
  const q = report.queries[0];
  assert.deepEqual(q.returned, ["editor"], `key-B saw: ${q.returned}`);
  assert.equal(q.crossAccountLeaks.length, 0, "no key-A leak into key-B");
  assert.equal(report.groundingRate, 1.0);
  assert.ok(report.pass, "cross-account case passes");
});
