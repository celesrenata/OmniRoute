/**
 * tests/unit/skill-snapshots.test.ts
 *
 * DB-backed tests for the durable Skill Hub catalog snapshots
 * (migration 205 + db/skillSnapshots.ts).
 *
 * Locks in:
 *   - snapshots are immutable records (create → list → latest → delete)
 *   - metadata is decoded (and fault-tolerant on corrupt payloads)
 *   - retention_until = created_at + 30 days
 *   - purgeExpired() removes only expired snapshots
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-skill-snap-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.VECTOR_STORE_DISABLE_VEC = "true";

const core = await import("../../src/lib/db/core.ts");
const { getDbInstance, resetDbInstance } = core;
const snapshots = await import("../../src/lib/db/skillSnapshots.ts");

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

test("createSnapshot → listSnapshots → latestSnapshot round-trip", async () => {
  await resetDb();
  const id = snapshots.createSnapshot(
    {
      total: 10,
      builtinCount: 5,
      importedCount: 5,
      domains: ["devops", "security"],
      origin: "manual",
    },
    "2026-10-24T12:00:00.000Z"
  );

  const latest = snapshots.latestSnapshot();
  assert.ok(latest, "latestSnapshot returns the created row");
  assert.equal(latest.id, id);
  assert.equal(latest.metadata.total, 10);
  assert.equal(latest.metadata.builtinCount, 5);
  assert.equal(latest.metadata.importedCount, 5);
  assert.deepEqual(latest.metadata.domains, ["devops", "security"]);
  assert.equal(latest.metadata.origin, "manual");

  // Retention: created 2026-10-24 → expires 2026-11-23 (+30 days)
  assert.equal(latest.retentionUntil, "2026-11-23 12:00:00");

  const list = snapshots.listSnapshots();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
});

test("snapshots are ordered newest-first; multiple rows preserved", async () => {
  await resetDb();
  const older = snapshots.createSnapshot(
    { total: 1, builtinCount: 1, importedCount: 0, domains: [], origin: "a" },
    "2026-10-24T10:00:00.000Z"
  );
  const newer = snapshots.createSnapshot(
    { total: 2, builtinCount: 1, importedCount: 1, domains: ["devops"], origin: "b" },
    "2026-10-24T11:00:00.000Z"
  );

  const list = snapshots.listSnapshots();
  assert.equal(list.length, 2);
  assert.deepEqual(
    list.map((s) => s.id),
    [newer, older]
  );
  assert.equal(snapshots.latestSnapshot()?.id, newer);
});

test("deleteSnapshot removes by id; false on unknown id", async () => {
  await resetDb();
  const id = snapshots.createSnapshot(
    { total: 0, builtinCount: 0, importedCount: 0, domains: [], origin: "x" },
    "2026-10-24T09:00:00.000Z"
  );
  assert.equal(snapshots.deleteSnapshot(id), true);
  assert.equal(snapshots.latestSnapshot(), null);
  assert.equal(snapshots.deleteSnapshot(id), false, "already deleted → false");
});

test("snapshotFromCatalog derives metadata from the catalog array", async () => {
  await resetDb();
  const catalog = [
    { id: "builtin:omni-inference", source: "builtin", domain: "general" },
    { id: "imported:devops/x", source: "imported", domain: "devops" },
    { id: "imported:devops/y", source: "imported", domain: "devops" },
    { id: "imported:security/z", source: "imported", domain: "security" },
  ];
  const id = snapshots.snapshotFromCatalog(catalog, "skill-added", "2026-10-24T08:00:00.000Z");
  const row = snapshots.listSnapshots().find((s) => s.id === id);
  assert.ok(row);
  assert.equal(row.metadata.total, 4);
  assert.equal(row.metadata.builtinCount, 1);
  assert.equal(row.metadata.importedCount, 3);
  assert.deepEqual(row.metadata.domains, ["devops", "general", "security"]);
  assert.equal(row.metadata.origin, "skill-added");
});

test("purgeExpired removes only expired snapshots (30-day window)", async () => {
  await resetDb();
  // Expired: created 40 days before 2026-10-24 → retention past
  snapshots.createSnapshot(
    { total: 1, builtinCount: 1, importedCount: 0, domains: [], origin: "old" },
    "2026-09-04T00:00:00.000Z"
  );
  // Fresh: created 5 days before → still within 30 days
  snapshots.createSnapshot(
    { total: 2, builtinCount: 2, importedCount: 0, domains: [], origin: "fresh" },
    "2026-10-19T00:00:00.000Z"
  );

  const purged = snapshots.purgeExpired(new Date("2026-10-24T00:00:00.000Z"));
  assert.equal(purged, 1);
  const list = snapshots.listSnapshots();
  assert.equal(list.length, 1);
  assert.equal(list[0].metadata.origin, "fresh");

  // Purging again removes nothing
  assert.equal(snapshots.purgeExpired(new Date("2026-10-24T00:00:00.000Z")), 0);
});

test("corrupt metadata degrades to zeroed shape, does not throw", async () => {
  await resetDb();
  const db = getDbInstance();
  db.prepare(
    `INSERT INTO skill_snapshots (id, created_at, type, metadata, retention_until)
     VALUES ('corrupt-1', '2026-10-24 10:00:00', 'full', 'not-json', '2026-11-23 10:00:00')`
  ).run();
  const row = snapshots.latestSnapshot();
  assert.ok(row);
  assert.equal(row.id, "corrupt-1");
  assert.equal(row.metadata.total, 0);
  assert.deepEqual(row.metadata.domains, []);
});
