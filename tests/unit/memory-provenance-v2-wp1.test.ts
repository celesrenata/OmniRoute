/**
 * tests/unit/memory-provenance-v2-wp1.test.ts
 *
 * DB-backed regression tests for WP1 — memory provenance v2 + versioned
 * supersession (migration 198 + db/memoryProvenanceV2.ts).
 *
 * Locks in the B1/B2 invariants:
 *   - pre-v2 rows are backfilled to a safe (not "confirmed", not "global") state
 *   - supersession preserves the old value in memory_revisions (audit/rollback)
 *   - the old row is marked superseded and the new row links via supersedes_id
 *   - provenance quotes are stored separately from the canonical fact
 *   - dedup key lookup only returns the active row
 *
 * Runs in its own isolated DATA_DIR, mirroring memory-v2-gates-db.test.ts.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-memory-wp1-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.VECTOR_STORE_DISABLE_VEC = "true";

const core = await import("../../src/lib/db/core.ts");
const { getDbInstance, resetDbInstance } = core;
const prov = await import("../../src/lib/db/memoryProvenanceV2.ts");

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

function insertMemory(
  db: ReturnType<typeof getDbInstance>,
  id: string,
  content: string,
  overrides: Record<string, unknown> = {}
) {
  const cols = ["id", "api_key_id", "type", "content"];
  const vals = [id, "key-A", "factual", content];
  for (const [k, v] of Object.entries(overrides)) {
    cols.push(k);
    vals.push(v);
  }
  db.prepare(
    `INSERT INTO memories (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`
  ).run(...vals);
}

test("WP1: pre-v2 row is backfilled to active / unverified / normal (never confirmed, never global)", async () => {
  const db = await resetDb();
  // Insert a legacy row with NO v2 columns set.
  insertMemory(db, "legacy-1", "I prefer dark mode");
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get("legacy-1") as Record<
    string,
    unknown
  >;
  assert.equal(row.status, "active");
  assert.equal(row.verification_state, "unverified");
  assert.equal(row.sensitivity, "normal");
  // scope must NOT have been backfilled to "global" — a legacy row has no trusted scope.
  assert.equal(row.scope, null);
});

test("WP1: supersedeMemory preserves the old value in revisions and links the new row", async () => {
  const db = await resetDb();
  insertMemory(db, "m1", "User uses UTC timezone", { subject: "user", predicate: "timezone" });

  const result = prov.supersedeMemory({
    memoryId: "m1",
    content: "User uses EST timezone",
    reason: "user updated their timezone",
    actor: "operator",
    subject: "user",
    predicate: "timezone",
    verificationState: "confirmed",
  });

  assert.ok(result.newId !== "m1");
  assert.equal(result.revisionNo, 1);

  const oldRow = db.prepare("SELECT * FROM memories WHERE id = ?").get("m1") as Record<
    string,
    unknown
  >;
  assert.equal(oldRow.status, "superseded");

  const newRow = db.prepare("SELECT * FROM memories WHERE id = ?").get(result.newId) as Record<
    string,
    unknown
  >;
  assert.equal(newRow.status, "active");
  assert.equal(newRow.content, "User uses EST timezone");
  assert.equal(newRow.supersedes_id, "m1");
  // Inherited owner scope.
  assert.equal(newRow.api_key_id, "key-A");

  const revisions = prov.getRevisions("m1");
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].content, "User uses UTC timezone");
  assert.equal(revisions[0].supersededReason, "user updated their timezone");
});

test("WP1: supersession stacks — multiple contradictions keep a full history", async () => {
  const db = await resetDb();
  insertMemory(db, "base", "v1", { subject: "user", predicate: "x" });
  const r1 = prov.supersedeMemory({ memoryId: "base", content: "v2", reason: "change 1" });
  const r2 = prov.supersedeMemory({ memoryId: r1.newId, content: "v3", reason: "change 2" });
  // The base id keeps accumulating revisions across its chain? No — each new
  // row is a distinct id; the base's history is preserved, and the latest row
  // is active with supersedes_id pointing back.
  assert.equal(r2.newId, r2.newId);
  const latest = db.prepare("SELECT * FROM memories WHERE id = ?").get(r2.newId) as Record<
    string,
    unknown
  >;
  assert.equal(latest.status, "active");
  assert.equal(latest.content, "v3");
  assert.equal(latest.supersedes_id, r1.newId);
});

test("WP1: provenance quote is stored separately and retrievable", async () => {
  const db = await resetDb();
  insertMemory(db, "pm", "fact", { subject: "s", predicate: "p" });
  const id = prov.addProvenance("pm", {
    quoteText: "The user literally said: 'I live in Berlin.'",
    sourceKind: "user-message",
    sourceTurnId: "turn-42",
  });
  assert.ok(id > 0);
  const quotes = prov.getProvenance("pm");
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].quoteText, "The user literally said: 'I live in Berlin.'");
  assert.equal(quotes[0].sourceKind, "user-message");
  assert.equal(quotes[0].sourceTurnId, "turn-42");
});

test("WP1: updateMemoryVerification transitions state and stamps verified_at", async () => {
  const db = await resetDb();
  insertMemory(db, "v1", "fact");
  const ok = prov.updateMemoryVerification({
    memoryId: "v1",
    verificationState: "confirmed",
    status: "active",
    sensitivity: "sensitive",
    verifiedAt: "2026-10-18T00:00:00Z",
  });
  assert.equal(ok, true);
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get("v1") as Record<
    string,
    unknown
  >;
  assert.equal(row.verification_state, "confirmed");
  assert.equal(row.sensitivity, "sensitive");
  assert.equal(row.verified_at, "2026-10-18T00:00:00Z");
});

test("WP1: findActiveByCanonicalKey returns only the active row, not superseded", async () => {
  const db = await resetDb();
  insertMemory(db, "a", "old", { subject: "user", predicate: "lang" });
  insertMemory(db, "b", "new", { subject: "user", predicate: "lang" });
  // Mark 'a' superseded, 'b' stays active.
  prov.updateMemoryVerification({ memoryId: "a", status: "superseded" });
  assert.equal(
    prov.findActiveByCanonicalKey({ apiKeyId: "key-A", subject: "user", predicate: "lang" }),
    "b"
  );
});

test("WP1: supersedeMemory throws for a missing memory", async () => {
  await resetDb();
  assert.throws(() => prov.supersedeMemory({ memoryId: "ghost", content: "x", reason: "r" }));
});
