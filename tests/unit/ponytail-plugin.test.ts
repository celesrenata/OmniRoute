// Ponytail plugin unit test — loads examples/plugins/ponytail/index.mjs directly
// (no plugin manager, no child process): verifies mode filtering of the embedded
// SKILL.md body, the JSONL band ledger row shape, and the fire-and-forget webhook.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const plugin = await import("../../examples/plugins/ponytail/index.mjs");

const baseCtx = {
  requestId: "req_1",
  usage: { prompt_tokens: 10, completion_tokens: 5 },
  timing: { latencyMs: 123, ttft: 12 },
  model: "test-model",
  provider: "test-provider",
  status: 200,
};

function tempLedgerDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-ponytail-test-"));
}

test("ponytail plugin: mode off returns undefined (no body change)", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(plugin.onRequest({ body, config: { mode: "off" } }), undefined);
});

test("ponytail plugin: mode off via inject=false returns undefined", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(plugin.onRequest({ body, config: { inject: false } }), undefined);
});

test("ponytail plugin: missing config defaults to full and prepends a system message", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };
  const r = plugin.onRequest({ body });
  assert.ok(r && Array.isArray(r.body.messages) && r.body.messages.length === 2);
  assert.equal(r.body.messages[0].role, "system");
  const content = r.body.messages[0].content;
  assert.ok(content.includes("# Ponytail"));
  // full keeps the full table row, drops the other two level rows
  assert.ok(content.includes("| **full** |"));
  assert.ok(!content.includes("| **lite** |"));
  assert.ok(!content.includes("| **ultra** |"));
  assert.equal(r.body.messages[1].content, "hi");
});

test("ponytail plugin: existing system message is extended, not replaced", () => {
  const body = {
    messages: [
      { role: "system", content: "existing rules" },
      { role: "user", content: "hi" },
    ],
  };
  const r = plugin.onRequest({ body, config: { mode: "lite" } });
  assert.equal(r.body.messages.length, 2);
  assert.equal(r.body.messages[0].role, "system");
  assert.ok(r.body.messages[0].content.includes("existing rules"));
  assert.ok(r.body.messages[0].content.includes("# Ponytail"));
});

test("ponytail plugin: mode lite filters to the lite row only", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };
  const r = plugin.onRequest({ body, config: { mode: "lite" } });
  const content = r.body.messages[0].content;
  assert.ok(content.includes("| **lite** |"));
  assert.ok(!content.includes("| **full** |"));
  assert.ok(!content.includes("| **ultra** |"));
});

test("ponytail plugin: mode ultra filters to the ultra row only", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };
  const r = plugin.onRequest({ body, config: { mode: "ultra" } });
  const content = r.body.messages[0].content;
  assert.ok(content.includes("| **ultra** |"));
  assert.ok(!content.includes("| **lite** |"));
  assert.ok(!content.includes("| **full** |"));
});

test("ponytail plugin: unknown mode falls back to full", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };
  const r = plugin.onRequest({ body, config: { mode: "bogus" } });
  const content = r.body.messages[0].content;
  assert.ok(content.includes("| **full** |"));
});

test("ponytail plugin: onStreamComplete appends a JSONL row with the expected fields", async () => {
  const dir = tempLedgerDir();
  try {
    await plugin.onStreamComplete({ ...baseCtx, config: { ledgerDir: dir } });
    const ledgerPath = path.join(dir, "band.jsonl");
    assert.ok(fs.existsSync(ledgerPath));
    const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.model, "test-model");
    assert.equal(row.provider, "test-provider");
    assert.equal(row.status, 200);
    assert.equal(row.requestId, "req_1");
    assert.deepEqual(row.usage, { prompt_tokens: 10, completion_tokens: 5 });
    assert.equal(row.ttftMs, 12);
    assert.equal(row.latencyMs, 123);
    assert.ok(typeof row.ts === "string" && row.ts.length > 0);
    assert.equal("cost" in row, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ponytail plugin: onStreamComplete ledger=false writes nothing", async () => {
  const dir = tempLedgerDir();
  try {
    await plugin.onStreamComplete({ ...baseCtx, config: { ledger: false, ledgerDir: dir } });
    assert.ok(!fs.existsSync(path.join(dir, "band.jsonl")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ponytail plugin: onStreamComplete ledgerDir omitted falls back to tmpdir default", async () => {
  // Default = join(tmpdir(), "omniroute", "ponytail") — the parent MCP tool must
  // compute the same path to read the ledger.
  const dir = path.join(os.tmpdir(), "omniroute", "ponytail");
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    await plugin.onStreamComplete({ ...baseCtx, config: {} });
    const row = JSON.parse(
      fs.readFileSync(path.join(dir, "band.jsonl"), "utf8").trim().split("\n").pop()
    );
    assert.equal(row.model, "test-model");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ponytail plugin: onStreamComplete posts the row to webhookUrl with Bearer token", async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({
        auth: req.headers["authorization"],
        ct: req.headers["content-type"],
        row: JSON.parse(body),
      });
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const { port } = server.address();
  const dir = tempLedgerDir();
  try {
    await plugin.onStreamComplete({
      ...baseCtx,
      config: {
        ledgerDir: dir,
        webhookUrl: `http://127.0.0.1:${port}/band`,
        webhookToken: "tok_abc",
      },
    });
    // Webhook is fire-and-forget — give it one tick to land.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received.length, 1);
    assert.equal(received[0].auth, "Bearer tok_abc");
    assert.equal(received[0].ct, "application/json");
    assert.equal(received[0].row.model, "test-model");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ponytail plugin: webhook failure never throws", async () => {
  const dir = tempLedgerDir();
  try {
    // Port 1 is essentially never listening — connection refused must be swallowed.
    // onStreamComplete is sync (returns void), so wrap it in an async thunk.
    await assert.doesNotReject(async () => {
      plugin.onStreamComplete({
        ...baseCtx,
        config: { ledgerDir: dir, webhookUrl: "http://127.0.0.1:1/never" },
      });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
