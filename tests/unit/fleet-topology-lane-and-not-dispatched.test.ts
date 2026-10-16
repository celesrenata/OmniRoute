// Requirement 17.3/17.4 and 17.7:
//  - The Capability_Lane name the client sends (OpenAI `user` field, here) is
//    recorded on every call-log row, including not-dispatched rejection rows,
//    and WINS over the internally-derived conversationId.
//  - Fail-closed / lane-exhausted paths write a not-dispatched row with a
//    non-2xx status so the Fleet_Observer sees the attempt.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-fleet-nodispatch-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const rejection = await import("../../src/sse/handlers/quotaParkedSkipUsage.ts");

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ─── Pure attribution: Capability_Lane recording (Req 17.3/17.4) ────────────

test("1. lane name from OpenAI user field is recorded as session_tag", () => {
  const attr = rejection.chatRejectionAttribution({
    body: { model: "auto/code", user: "code-lane" },
    runtimeOptions: { conversationId: "conv-derived-123" },
  });
  // Explicit lane name wins over the derived conversationId.
  assert.equal(attr.sessionTag, "code-lane");
});

test("2. lane name is recorded exactly as sent (trimmed only)", () => {
  const attr = rejection.chatRejectionAttribution({
    body: { model: "auto/code", user: "  Research_Lane_v2  " },
    runtimeOptions: { conversationId: "conv-x" },
  });
  assert.equal(attr.sessionTag, "Research_Lane_v2");
});

test("3. no lane name → conversationId still applies (backward compatible)", () => {
  const attr = rejection.chatRejectionAttribution({
    body: { model: "auto/code" },
    runtimeOptions: { conversationId: "conv-derived-123" },
  });
  assert.equal(attr.sessionTag, "conv-derived-123");
});

test("4. empty/whitespace user is not a lane name", () => {
  const attr = rejection.chatRejectionAttribution({
    body: { model: "auto/code", user: "   " },
    runtimeOptions: { conversationId: "conv-y" },
  });
  assert.equal(attr.sessionTag, "conv-y");
});

test("5. non-string user is ignored", () => {
  const attr = rejection.chatRejectionAttribution({
    body: { model: "auto/code", user: 42 as unknown as string },
    runtimeOptions: { conversationId: "conv-z" },
  });
  assert.equal(attr.sessionTag, "conv-z");
});

// ─── Not-dispatched rows on the fail-closed path (Req 17.7) ─────────────────

test("6. not-dispatched helper is a no-op for combo targets (no duplicate row)", async () => {
  // Combos write exactly one row for the whole request via the combo-exhausted
  // path; a per-target not-dispatched write would duplicate it. The helper
  // returns before importing the writer when isCombo is set.
  await assert.doesNotReject(() =>
    rejection.recordNoEligibleConnections(503, "vllm", "code-t1", {
      body: { model: "code-t1" },
      isCombo: true,
    })
  );
});

test("7. fail-closed path writes a non-2xx not-dispatched row with the lane name", async () => {
  const apiKeyName = "fleet-nodispatch-key";
  await rejection.recordNoEligibleConnections(503, "vllm", "code-t1", {
    body: { model: "code-t1", user: "code-lane" },
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    runtimeOptions: { conversationId: "conv-abc", correlationId: "corr-fleet-1" },
    apiKeyInfo: { id: "key-fleet", name: apiKeyName },
    isCombo: false,
  });

  // saveCallLog is fire-and-forget inside recordRejectedRequestUsage — poll.
  let row: Record<string, unknown> | undefined;
  for (let i = 0; i < 60 && !row; i++) {
    const logs = await callLogs.getCallLogs({});
    const list = ((logs as { logs?: unknown[] }).logs ?? logs) as Array<Record<string, unknown>>;
    row = (list ?? []).find((l) => l.apiKeyName === apiKeyName || l.api_key_name === apiKeyName);
    if (!row) await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(row, "expected a not-dispatched call_logs row for the fail-closed request");
  const status = Number(row.status);
  assert.equal(status, 503);
  assert.ok(status < 200 || status >= 300, "status is non-2xx (Req 17.7)");
  assert.equal(
    row.sessionTag ?? row.session_tag,
    "code-lane",
    "Capability_Lane recorded (Req 17.3)"
  );
  assert.equal(row.model, "code-t1");
  assert.equal(row.provider, "vllm");
});
