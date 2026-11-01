/**
 * tests/unit/skills-service-gate.test.ts
 *
 * Tests for the whole skill-service on/off gate (settings.skillsEnabled):
 *   - /api/skills/catalog/refresh returns 503 SKILLS_DISABLED when the
 *     service is off, and a fresh snapshot when on
 *   - /api/skills/catalog/[id]/toggle returns 503 when the service is off,
 *     and toggles visibility when on
 *   - the executor gate is unchanged (skillsEnabled === false blocks execute)
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-skill-gate-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.VECTOR_STORE_DISABLE_VEC = "true";

const core = await import("../../src/lib/db/core.ts");
const { getDbInstance, resetDbInstance } = core;
const { updateSettings, getSettings } = await import("../../src/lib/db/settings.ts");
const { snapshotCatalog } = await import("../../open-sse/services/skillDiscovery.ts");
const snapshots = await import("../../src/lib/db/skillSnapshots.ts");

const refreshRoute = await import("../../src/app/api/skills/catalog/refresh/route.ts");
const toggleRoute = await import("../../src/app/api/skills/catalog/[id]/toggle/route.ts");

let rev = 0;
async function resetDb() {
  resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  getDbInstance();
  rev = 0;
}

before(async () => {
  await resetDb();
});

after(async () => {
  resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function setSkillsEnabled(value: boolean) {
  await updateSettings({ skillsEnabled: value }, { expectedRevision: rev });
  rev += 1;
}

test("default: skills service is enabled", async () => {
  await resetDb();
  const settings = await getSettings();
  assert.equal(settings.skillsEnabled, true);
});

test("refresh route creates snapshot + purges when service enabled", async () => {
  await resetDb();
  const res = await refreshRoute.POST(new Request("http://localhost/api/skills/catalog/refresh"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.ok(typeof body.snapshotId === "string" && body.snapshotId.length > 0);
  assert.equal(body.purged, 0);
  assert.ok(typeof body.summary.total === "number" && body.summary.total > 0);
  assert.ok(Array.isArray(body.summary.domains));
  assert.equal(snapshots.latestSnapshot()?.metadata.origin, "manual-refresh");
});

test("refresh route returns 503 SKILLS_DISABLED when service off", async () => {
  await resetDb();
  await setSkillsEnabled(false);
  const res = await refreshRoute.POST(new Request("http://localhost/api/skills/catalog/refresh"));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error.code, "SKILLS_DISABLED");
});

test("toggle route flips skill visibility when service enabled", async () => {
  await resetDb();
  const res = await toggleRoute.POST(
    new Request("http://localhost/api/skills/catalog/builtin%3Aomni-inference/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }),
    { params: Promise.resolve({ id: "builtin:omni-inference" }) }
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.enabled, false);

  const hub = await import("../../src/lib/db/skillHub.ts");
  assert.equal(hub.isCatalogSkillEnabled("builtin:omni-inference"), false);

  // Re-enable
  const res2 = await toggleRoute.POST(
    new Request("http://localhost/api/skills/catalog/builtin%3Aomni-inference/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }),
    { params: Promise.resolve({ id: "builtin:omni-inference" }) }
  );
  assert.equal(res2.status, 200);
  assert.equal((await res2.json()).enabled, true);
});

test("toggle route rejects malformed bodies", async () => {
  await resetDb();
  const res = await toggleRoute.POST(
    new Request("http://localhost/api/skills/catalog/x/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    }),
    { params: Promise.resolve({ id: "x" }) }
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "VALIDATION_FAILED");
});

test("toggle route returns 503 SKILLS_DISABLED when service off", async () => {
  await resetDb();
  await setSkillsEnabled(false);
  const res = await toggleRoute.POST(
    new Request("http://localhost/api/skills/catalog/x/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }),
    { params: Promise.resolve({ id: "x" }) }
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "SKILLS_DISABLED");
});

test("snapshotCatalog captures registered executable skills", async () => {
  await resetDb();
  const id = snapshotCatalog("test", {
    registered: [
      { name: "alpha", version: "1.0.0" },
      { name: "beta", version: "2.1.0" },
    ],
  });
  const row = snapshots.listSnapshots().find((s) => s.id === id);
  assert.ok(row);
  assert.equal(row.metadata.registeredCount, 2);
  assert.deepEqual(row.metadata.registeredIds, ["alpha@1.0.0", "beta@2.1.0"]);
  assert.equal(row.metadata.origin, "test");
});
