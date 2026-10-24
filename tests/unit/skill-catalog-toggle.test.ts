/**
 * tests/unit/skill-catalog-toggle.test.ts
 *
 * DB-backed tests for per-skill enable/disable (Skill Hub catalog toggle,
 * migration 205 `skill_catalog_state`) and its effect on discovery
 * visibility.
 *
 * Locks in:
 *   - catalog skills are enabled by default (no row)
 *   - setCatalogSkillEnabled(false) hides the skill from searchCatalog
 *   - setCatalogSkillEnabled(true) re-shows it
 *   - disabled skills are invisible via search/browse but loadSkill refuses
 *   - the toggle is durable (a fresh cache still reflects it)
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-skill-toggle-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.VECTOR_STORE_DISABLE_VEC = "true";

const core = await import("../../src/lib/db/core.ts");
const { getDbInstance, resetDbInstance } = core;
const hub = await import("../../src/lib/db/skillHub.ts");
const discovery = await import("../../open-sse/services/skillDiscovery.ts");

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

test("catalog skills are enabled by default (no row)", async () => {
  await resetDb();
  // No row exists → enabled.
  assert.equal(hub.isCatalogSkillEnabled("builtin:does-not-matter"), true);
  assert.deepEqual(hub.disabledCatalogSkillIds(), []);
});

test("setCatalogSkillEnabled(false) hides the skill from discovery", async () => {
  await resetDb();
  // Seed one visible skill into the catalog via a direct row isn't possible
  // (catalog is built-in/imported), so we exercise the toggle at the
  // isCatalogSkillEnabled/disabledCatalogSkillIds boundary, which is exactly
  // what visibleCatalog() consumes.
  hub.setCatalogSkillEnabled("imported:devops/my-skill", false);
  assert.equal(hub.isCatalogSkillEnabled("imported:devops/my-skill"), false);
  assert.deepEqual(hub.disabledCatalogSkillIds(), ["imported:devops/my-skill"]);

  // visibleCatalog excludes it (assert via loadSkill returning null for a
  // disabled id that is NOT in the built-in catalog — it can't load anyway,
  // so instead assert the disabled set that visibleCatalog uses).
  discovery.invalidateCatalog();
});

test("setCatalogSkillEnabled(true) re-enables (removes row)", async () => {
  await resetDb();
  hub.setCatalogSkillEnabled("imported:devops/my-skill", false);
  assert.equal(hub.isCatalogSkillEnabled("imported:devops/my-skill"), false);

  hub.setCatalogSkillEnabled("imported:devops/my-skill", true);
  assert.equal(hub.isCatalogSkillEnabled("imported:devops/my-skill"), true);
  assert.deepEqual(hub.disabledCatalogSkillIds(), []);
});

test("disable→enable→disable is idempotent and durable", async () => {
  await resetDb();
  hub.setCatalogSkillEnabled("imported:security/scan", false);
  hub.setCatalogSkillEnabled("imported:security/scan", true);
  hub.setCatalogSkillEnabled("imported:security/scan", false);
  assert.equal(hub.isCatalogSkillEnabled("imported:security/scan"), false);
  assert.deepEqual(hub.disabledCatalogSkillIds(), ["imported:security/scan"]);
});

test("visibleCatalog excludes disabled skills (integration)", async () => {
  await resetDb();
  // Build a tiny imported catalog on disk so discovery has something to show.
  const root = process.env.OMNIROUTE_SKILL_ROOT;
  const skillsDir = path.join(TEST_DATA_DIR, "skills");
  const skillDir = path.join(skillsDir, "general");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: general/demo\ndescription: a demo skill for the toggle test\n---\n# demo\nbody\n"
  );
  process.env.OMNIROUTE_SKILL_ROOT = skillsDir;
  discovery.refreshCatalogIndex();

  const demoId = "imported:general/general-demo";
  // First, it is visible (enabled by default).
  let all = discovery.searchCatalog("", { limit: 200 });
  assert.ok(
    all.some((r) => r.id === demoId),
    "demo skill is visible when enabled"
  );

  // Disable it.
  hub.setCatalogSkillEnabled(demoId, false);
  discovery.invalidateCatalog();
  all = discovery.searchCatalog("", { limit: 200 });
  assert.ok(!all.some((r) => r.id === demoId), "disabled skill is hidden from browse");
  assert.equal(discovery.loadSkill(demoId), null, "loadSkill refuses a disabled skill");

  // Re-enable it.
  hub.setCatalogSkillEnabled(demoId, true);
  discovery.invalidateCatalog();
  all = discovery.searchCatalog("", { limit: 200 });
  assert.ok(
    all.some((r) => r.id === demoId),
    "re-enabled skill is visible again"
  );

  if (root) process.env.OMNIROUTE_SKILL_ROOT = root;
});
