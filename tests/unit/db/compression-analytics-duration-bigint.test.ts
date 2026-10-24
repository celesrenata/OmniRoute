/**
 * TDD: compression_analytics `duration_ms` must be bound as an integer (or null).
 *
 * Root cause (production, feat/postgres-adapter): the caveman engine reports
 * duration with sub-millisecond precision (`Math.round(durationMs * 100) / 100` →
 * e.g. 2.25) and it was bound straight into the `duration_ms` column, which is
 * `INTEGER`/`bigint`. SQLite's type affinity silently coerced the float, so the
 * bug only surfaced on PostgreSQL: `invalid input syntax for type bigint: "2.25"`.
 *
 * We reproduce the PG failure at the binding boundary by injecting a
 * parameter-capturing DB handle (via setDbInstance) and asserting the value bound
 * to duration_ms is a finite integer. A real-SQLite read-back would NOT catch
 * this (affinity coerces), so the assertion is on the bound param — the exact
 * invariant the PG adapter cannot accept.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { SqliteAdapter, PreparedStatement } from "../../../src/lib/db/adapters/types";

const { setDbInstance, getExistingDbInstance } = await import("../../../src/lib/db/singleton.ts");

const { insertCompressionAnalyticsRow, insertCompressionEngineBreakdown } =
  await import("../../../src/lib/db/compressionAnalytics.ts");

// ─── parameter-capturing fake DB ─────────────────────────────────────────────

// Every .run() records its bound parameters so the test can inspect what would
// be sent to the engine, independent of SQLite's permissive affinity.
const capturedRuns: unknown[][] = [];

function makeCapturingDb(): SqliteAdapter {
  const makeStmt = (_sql: string): PreparedStatement => ({
    run: (...params: unknown[]) => {
      capturedRuns.push(params);
      return { changes: 1, lastInsertRowid: 1 };
    },
    get: () => undefined,
    all: () => [], // empty → column-ensure treats all as "missing", ALTERs are no-ops
  });
  return {
    driver: "better-sqlite3",
    open: true,
    name: "capturing-fake",
    prepare: (sql: string) => makeStmt(sql),
    exec: () => undefined,
    pragma: () => undefined,
    transaction: <T>(fn: (...args: unknown[]) => T) => fn,
    immediate: (fn: () => void) => fn(),
    backup: async () => undefined,
    checkpoint: () => undefined,
    close: () => undefined,
    raw: null,
  };
}

const FAKE_DURATION = 2.25; // matches the production error "2.25"

test.beforeEach(() => {
  capturedRuns.length = 0;
  setDbInstance(makeCapturingDb());
});

test.after(() => {
  setDbInstance(null);
});

test("insertCompressionAnalyticsRow binds an integer (not 2.25) to duration_ms", () => {
  const before = getExistingDbInstance();
  insertCompressionAnalyticsRow({
    timestamp: new Date().toISOString(),
    mode: "caveman",
    engine: "caveman",
    original_tokens: 100,
    compressed_tokens: 60,
    tokens_saved: 40,
    duration_ms: FAKE_DURATION,
  });

  assert.ok(before, "fake DB handle should be installed");
  const insertRun = capturedRuns.find((p) => p.length === 27);
  assert.ok(insertRun, "expected the 27-column compression_analytics INSERT to run");

  // Column order of the INSERT (see compressionAnalytics.ts): duration_ms is
  // the 10th column → index 9.
  const boundDuration = insertRun[9];
  assert.ok(
    boundDuration === null ||
      (typeof boundDuration === "number" && Number.isInteger(boundDuration)),
    `duration_ms must be bound as an integer or null for the bigint column, got ${JSON.stringify(
      boundDuration
    )}`
  );
  assert.ok(
    !capturedRuns.some((p) => p.includes(FAKE_DURATION)),
    "the raw 2.25 float must not reach any bound parameter"
  );
});

test("insertCompressionEngineBreakdown binds an integer (not 2.25) to duration_ms", () => {
  insertCompressionEngineBreakdown([
    {
      timestamp: new Date().toISOString(),
      request_id: "req-breakdown",
      engine: "rtk",
      original_tokens: 500,
      compressed_tokens: 300,
      tokens_saved: 200,
      duration_ms: FAKE_DURATION,
    },
  ]);

  const breakdownRun = capturedRuns.find((p) => p.length === 7);
  assert.ok(breakdownRun, "expected the 7-column engine-breakdown INSERT to run");

  // Column order: (timestamp, request_id, engine, original_tokens,
  // compressed_tokens, tokens_saved, duration_ms) → duration_ms is index 6.
  const boundDuration = breakdownRun[6];
  assert.ok(
    boundDuration === null ||
      (typeof boundDuration === "number" && Number.isInteger(boundDuration)),
    `engine-breakdown duration_ms must be bound as an integer or null, got ${JSON.stringify(
      boundDuration
    )}`
  );
});
