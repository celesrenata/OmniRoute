import test from "node:test";
import assert from "node:assert/strict";

import { buildCallLogListRows } from "../../src/app/api/usage/call-logs/route.ts";

// Regression (Hard Rule #18): a finished request used to be listed twice. The persisted row is
// keyed by a fresh UUID (not the pending id), so the id-based de-dupe could not match the
// in-memory completed entry. The two share the request's correlationId.

const now = 5_000_000;
const completed = (over: Record<string, unknown> = {}) => ({
  id: "pending-1",
  model: "m",
  provider: "p",
  connectionId: "c",
  startedAt: now - 2_000,
  completedAt: now - 1_000,
  durationMs: 1_000,
  status: 200,
  correlationId: "corr-1",
  ...over,
});
const persisted = (over: Record<string, unknown> = {}) => ({
  id: "row-uuid-1",
  timestamp: new Date(now - 1_000).toISOString(),
  status: 200,
  correlationId: "corr-1",
  ...over,
});

test("completed in-memory entry is dropped when its persisted row shares the correlationId", () => {
  const rows = buildCallLogListRows({
    logs: [persisted()],
    connections: [],
    pendingDetails: [],
    completedDetails: [completed()],
    now,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "row-uuid-1");
});

test("completed entries with a different or missing correlationId are kept", () => {
  const rows = buildCallLogListRows({
    logs: [persisted()],
    connections: [],
    pendingDetails: [],
    completedDetails: [
      completed({ id: "other", correlationId: "corr-2" }),
      completed({ id: "none", correlationId: null }),
    ],
    now,
  });
  assert.equal(rows.length, 3);
});

test("a persisted row with no correlationId never swallows an in-memory entry", () => {
  const rows = buildCallLogListRows({
    logs: [persisted({ correlationId: null })],
    connections: [],
    pendingDetails: [],
    completedDetails: [completed({ correlationId: null })],
    now,
  });
  assert.equal(rows.length, 2);
});

test("an in-flight entry is still listed next to a persisted earlier attempt", () => {
  const rows = buildCallLogListRows({
    logs: [persisted()],
    connections: [],
    pendingDetails: [{ id: "pending-1", model: "m", provider: "p", startedAt: now - 500 }],
    completedDetails: [],
    now,
  });
  assert.equal(rows.length, 2);
});
