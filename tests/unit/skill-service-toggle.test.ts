/**
 * tests/unit/skill-service-toggle.test.ts
 *
 * Tests for the master skill-service on/off switch endpoint
 * (/api/skills/service/toggle, backed by settings.skillsEnabled):
 *   - GET reports the current state (default enabled)
 *   - POST flips the switch on/off (durable in settings)
 *   - POST validates the body
 *   - the endpoint itself is NOT gated: it stays reachable while the
 *     service is off (the operator must not be locked out of re-enabling)
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-skill-svc-toggle-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.VECTOR_STORE_DISABLE_VEC = "true";

const core = await import("../../src/lib/db/core.ts");
const { getDbInstance, resetDbInstance } = core;
const { getSettings } = await import("../../src/lib/db/settings.ts");

const toggleRoute = await import("../../src/app/api/skills/service/toggle/route.ts");

async function resetDb() {
  resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  getDbInstance();
}

before(async () => {
  await resetDb();
});

after(async () => {
  resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("GET reports service enabled by default", async () => {
  await resetDb();
  const res = await toggleRoute.GET(new Request("http://localhost/api/skills/service/toggle"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.enabled, true);
});

test("POST disables the service, GET reflects it, re-enable works", async () => {
  await resetDb();
  const res = await toggleRoute.POST(
    new Request("http://localhost/api/skills/service/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.enabled, false);

  // Durable in settings
  assert.equal((await getSettings()).skillsEnabled, false);

  // GET reflects the off state
  const getRes = await toggleRoute.GET(new Request("http://localhost/api/skills/service/toggle"));
  assert.equal((await getRes.json()).enabled, false);

  // Flip back on
  const res2 = await toggleRoute.POST(
    new Request("http://localhost/api/skills/service/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })
  );
  assert.equal((await res2.json()).enabled, true);
  assert.equal((await getSettings()).skillsEnabled, true);
});

test("POST rejects invalid bodies", async () => {
  await resetDb();
  for (const payload of ["not json", "{}", '{"enabled":"yes"}', '{"nope":1}']) {
    const res = await toggleRoute.POST(
      new Request("http://localhost/api/skills/service/toggle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      })
    );
    assert.equal(res.status, 400, `expected 400 for body: ${payload}`);
    const body = await res.json();
    assert.equal(body.error.code, "VALIDATION_FAILED");
  }
});

test("endpoint stays reachable while the service is off (no lockout)", async () => {
  await resetDb();
  const db = core.getDbInstance();
  const insert = db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', 'skillsEnabled', ?)"
  );
  insert.run(JSON.stringify(false));
  const { invalidateDbCache } = await import("../../src/lib/db/readCache.ts");
  invalidateDbCache("settings");

  // Service is off, yet the toggle endpoint still answers (GET + POST on).
  const getRes = await toggleRoute.GET(new Request("http://localhost/api/skills/service/toggle"));
  assert.equal(getRes.status, 200);
  assert.equal((await getRes.json()).enabled, false);

  const res = await toggleRoute.POST(
    new Request("http://localhost/api/skills/service/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })
  );
  assert.equal(res.status, 200);
  assert.equal((await getSettings()).skillsEnabled, true);
});
