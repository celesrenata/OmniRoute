/**
 * skill-discovery-root-override.test.ts — regression guard for the
 * `OMNIROUTE_SKILL_ROOT` override.
 *
 * `loadImportedSkills` used to hardcode `~/.opencode/skills`. In the K8s
 * deployment that path is on the ephemeral container overlay (HOME=/home/node),
 * so imported skills there silently vanish on pod restart. This lets a
 * deployment point the discovery reader at a durable volume (e.g.
 * `/app/data/skills` on the data PVC) via `OMNIROUTE_SKILL_ROOT`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ORIGINAL_SKILL_ROOT = process.env.OMNIROUTE_SKILL_ROOT;
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omr-skill-root-"));

// Lay out one imported skill under {root}/{domain}/{slug}/SKILL.md.
const skillDir = path.join(TEST_ROOT, "trading", "demo-alpha");
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(
  path.join(skillDir, "SKILL.md"),
  [
    "---",
    "name: Demo Alpha",
    "description: A test trading signal skill",
    "domain: trading",
    "version: 1.2.3",
    "---",
    "# Demo Alpha",
    "Body content.",
  ].join("\n")
);

process.env.OMNIROUTE_SKILL_ROOT = TEST_ROOT;

// Import AFTER setting the env var so the module-level constant (if any) sees it.
const { searchCatalog, loadSkill, refreshCatalogIndex } =
  await import("../../open-sse/services/skillDiscovery.ts");

test.after(() => {
  refreshCatalogIndex();
  if (ORIGINAL_SKILL_ROOT === undefined) delete process.env.OMNIROUTE_SKILL_ROOT;
  else process.env.OMNIROUTE_SKILL_ROOT = ORIGINAL_SKILL_ROOT;
  fs.rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("imported skills under OMNIROUTE_SKILL_ROOT are discovered by search", () => {
  refreshCatalogIndex();
  const results = searchCatalog("trading signal");
  const hit = results.find((r) => r.id === "imported:trading/demo-alpha");
  assert.ok(
    hit,
    `expected imported:trading/demo-alpha in results, got: ${JSON.stringify(results.map((r) => r.id))}`
  );
  assert.equal(hit.source, "imported");
  assert.equal(hit.executable, false);
  assert.equal(hit.revision, "1.2.3");
});

test("imported skills under OMNIROUTE_SKILL_ROOT are loadable", () => {
  refreshCatalogIndex();
  const loaded = loadSkill("imported:trading/demo-alpha");
  assert.ok(loaded, "imported:trading/demo-alpha should be loadable from the override root");
  assert.equal(loaded.skill.domain, "trading");
  assert.ok(loaded.content.includes("Body content."));
});

test("empty root (unset) falls back to default and does not crash", () => {
  if (ORIGINAL_SKILL_ROOT === undefined) delete process.env.OMNIROUTE_SKILL_ROOT;
  else process.env.OMNIROUTE_SKILL_ROOT = ORIGINAL_SKILL_ROOT;
  refreshCatalogIndex();
  // Default root (~/.opencode/skills) is likely empty in CI — must not throw.
  const results = searchCatalog("trading signal");
  assert.ok(Array.isArray(results));
});
