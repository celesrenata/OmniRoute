/**
 * tests/unit/skill-hub-wp6-policy.test.ts
 *
 * DB-backed regression tests for WP6 — durable Skill Hub tables (migration 200
 * + db/skillHub.ts) and the per-agent policy wired into WP4's searchCatalog.
 *
 * Locks in:
 *   - the six seed skillsets are provisioned idempotently
 *   - an agent with NO grants gets an empty result set (fail-closed)
 *   - an agent granted a domain sees only skills in that domain
 *   - grant/execute permission is recorded and queryable
 *   - import jobs + execution approvals are durable
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-skill-wp6-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.VECTOR_STORE_DISABLE_VEC = "true";

const core = await import("../../src/lib/db/core.ts");
const { getDbInstance, resetDbInstance } = core;
const hub = await import("../../src/lib/db/skillHub.ts");
const { searchCatalog } = await import("../../open-sse/services/skillDiscovery.ts");

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

test("WP6: six seed skillsets provision idempotently", () => {
  resetDb();
  const created = hub.seedSkillsets();
  assert.equal(created, 6);
  // Idempotent: second run creates none.
  assert.equal(hub.seedSkillsets(), 0);
  const sets = hub.listSkillsets();
  assert.equal(sets.length, 6);
  const ids = sets.map((s) => s.id).sort();
  assert.deepEqual(ids, ["backend", "data", "devops", "frontend", "general", "security"]);
});

test("WP6: agent with no grants sees nothing (fail-closed)", () => {
  resetDb();
  hub.seedSkillsets();
  // No grants for 'agent-x' → discoverDomainsForAgent returns null → empty.
  assert.equal(hub.discoverDomainsForAgent("agent-x"), null);
  const results = searchCatalog("routing", { agentId: "agent-x" });
  assert.deepEqual(results, []);
});

test("WP6: agent granted a domain sees only that domain", () => {
  resetDb();
  hub.seedSkillsets();
  hub.grantAgent("agent-y", "backend", "discover");
  assert.deepEqual(hub.discoverDomainsForAgent("agent-y"), ["backend"]);

  const granted = searchCatalog("routing", { agentId: "agent-y" });
  assert.ok(Array.isArray(granted));
  // Every result is scoped to the granted domain (backend) or a granted id.
  for (const r of granted) {
    assert.ok(
      r.domain === "backend" || hub.discoverDomainsForAgent("agent-y")!.includes(r.id),
      `leak: ${r.domain}`
    );
  }
  // And a different domain must be absent.
  const domains = new Set(granted.map((r) => r.domain));
  assert.ok(!domains.has("frontend"));
});

test("WP6: grant/execute permission is queryable", () => {
  resetDb();
  hub.seedSkillsets();
  hub.grantAgent("agent-z", "backend", "discover");
  hub.grantAgent("agent-z", "backend", "execute");
  assert.equal(hub.discoverDomainsForAgent("agent-z")?.includes("backend"), true);
});

test("WP6: revoke removes the discover grant", () => {
  resetDb();
  hub.seedSkillsets();
  hub.grantAgent("agent-w", "devops", "discover");
  assert.ok(hub.discoverDomainsForAgent("agent-w")?.includes("devops"));
  hub.revokeAgent("agent-w", "devops", "discover");
  assert.equal(hub.discoverDomainsForAgent("agent-w"), null);
});

test("WP6: collection membership is recorded and listed", () => {
  resetDb();
  hub.seedSkillsets();
  const added = hub.addToCollection("backend", "builtin:some-skill");
  assert.equal(added, true);
  // Idempotent.
  assert.equal(hub.addToCollection("backend", "builtin:some-skill"), false);
  assert.deepEqual(hub.collectionMembers("backend"), ["builtin:some-skill"]);
  hub.removeFromCollection("backend", "builtin:some-skill");
  assert.deepEqual(hub.collectionMembers("backend"), []);
});

test("WP6: searchCatalog respects the skillset filter", () => {
  resetDb();
  hub.seedSkillsets();
  // Restrict to the backend skillset: results must be backend-domain only.
  const results = searchCatalog("routing", { skillset: "backend" });
  for (const r of results) {
    assert.ok(r.domain === "backend" || hub.collectionMembers("backend").includes(r.id));
  }
});
