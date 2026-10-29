/**
 * skill-hub-browse-cap.test.ts — regression guard for the Skill Hub browse cap.
 *
 * The Skill Hub dashboard catalog view calls `searchCatalog("")` (empty query =
 * "browse all") with `limit=1000` (see
 * `src/app/(dashboard)/dashboard/skill-hub/SkillHubPageClient.tsx`). When the
 * operator's import holds more skills than the browse cap, the page silently
 * shows only the first N and the rest are unreachable without per-domain
 * filtering. The cap must be large enough to cover the full catalog: an
 * operator fleet with ~1k imported skills needs the whole browse to be
 * visible, not a 200-item window.
 *
 * This test lays out a synthetic skill root with 250 imported skills and asserts
 * that browse-all surfaces all of them (plus the built-ins) — i.e. the cap is
 * NOT clamping at 200.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ORIGINAL_SKILL_ROOT = process.env.OMNIROUTE_SKILL_ROOT;
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omr-skill-browse-cap-"));
const IMPORTED_COUNT = 250;

// Lay out IMPORTED_COUNT imported skills under {root}/browse/skill-NNN/SKILL.md.
for (let i = 0; i < IMPORTED_COUNT; i++) {
  const skillDir = path.join(TEST_ROOT, "browse", `skill-${String(i).padStart(3, "0")}`);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      `name: browse skill ${i}`,
      'description: "Synthetic skill for the browse cap guard"',
      "domain: browse",
      "version: 1.0.0",
      "---",
      "# Body",
    ].join("\n")
  );
}

process.env.OMNIROUTE_SKILL_ROOT = TEST_ROOT;

// Import AFTER setting the env var so the lazy root resolver sees it.
const { searchCatalog, refreshCatalogIndex } =
  await import("../../open-sse/services/skillDiscovery.ts");

test.after(() => {
  refreshCatalogIndex();
  if (ORIGINAL_SKILL_ROOT === undefined) delete process.env.OMNIROUTE_SKILL_ROOT;
  else process.env.OMNIROUTE_SKILL_ROOT = ORIGINAL_SKILL_ROOT;
  fs.rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("browse-all returns every imported skill when the catalog exceeds 200", () => {
  refreshCatalogIndex();
  const browse = searchCatalog("");
  const imported = browse.filter((r) => r.id.startsWith("imported:"));
  assert.ok(
    imported.length >= IMPORTED_COUNT,
    `browse-all clamped the catalog: got ${imported.length} imported, expected ${IMPORTED_COUNT} (cap must cover the full catalog, not a 200-item window)`
  );
});

test("browse-all respects an explicit limit higher than 200", () => {
  refreshCatalogIndex();
  const browse = searchCatalog("", { limit: 500 });
  const imported = browse.filter((r) => r.id.startsWith("imported:"));
  assert.ok(
    imported.length >= IMPORTED_COUNT,
    `limit=500 clamped the catalog: got ${imported.length} imported, expected ${IMPORTED_COUNT}`
  );
});
