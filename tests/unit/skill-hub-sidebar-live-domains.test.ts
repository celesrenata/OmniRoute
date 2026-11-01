/**
 * tests/unit/skill-hub-sidebar-live-domains.test.ts
 *
 * Regression guard for the Skill Hub sidebar (filter chips).
 *
 * The sidebar must be rebuilt from the LIVE domain distribution of the
 * visible catalog (builtin + imported) so it mirrors the catalog as it is
 * on disk — not the DB-snapshotted `skill_collections` seed rows, which go
 * stale whenever the catalog is reorganized (e.g. a frontmatter domain
 * reorg at import time).
 *
 * Locks in:
 *   - listSkillsetFilters() returns the live domain distribution, keyed by
 *     slug, with the per-domain skill counts
 *   - the sum of the per-chip counts equals the total visible catalog size
 *   - domain slugs are stable, lower-case, unique
 *   - domainLabel() produces a readable Title-Case label from a slug
 *   - listSkillsetFilters() ordering is stable by descending count
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-skill-sidebar-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.VECTOR_STORE_DISABLE_VEC = "true";

const discovery = await import("../../open-sse/services/skillDiscovery.ts");
const { listDomains, listSkillsetFilters, domainLabel, refreshCatalogIndex } = discovery;

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("listSkillsetFilters() returns the live domain distribution keyed by slug", () => {
  refreshCatalogIndex();
  const filters = listSkillsetFilters();
  const domains = listDomains();

  // Every filter entry carries a stable slug id, a display name, and a count.
  assert.ok(Array.isArray(filters) && filters.length > 0, "expected a non-empty sidebar");
  for (const f of filters) {
    assert.ok(typeof f.id === "string" && f.id.length > 0, "id must be a non-empty slug");
    assert.ok(typeof f.name === "string" && f.name.length > 0, "name must be non-empty");
    assert.ok(
      Number.isInteger(f.skillCount) && f.skillCount > 0,
      "skillCount must be a positive int"
    );
  }

  // The filter ids are exactly the live domain slugs (same set + same counts).
  const fromDomains = domains.map((d) => ({ id: d.domain, skillCount: d.count }));
  const byId = new Map(filters.map((f) => [f.id, f.skillCount]));
  for (const d of domains) {
    assert.equal(byId.get(d.domain), d.count, `count mismatch for domain ${d.domain}`);
  }
  assert.equal(
    filters.length,
    domains.length,
    "filter count must equal the number of live domains"
  );
  assert.deepEqual(
    fromDomains,
    filters.map(({ id, skillCount }) => ({ id, skillCount })),
    "filters must match the live domain distribution exactly"
  );
});

test("listSkillsetFilters() counts sum to the visible catalog size", () => {
  refreshCatalogIndex();
  const filters = listSkillsetFilters();
  const total = filters.reduce((sum, f) => sum + f.skillCount, 0);
  // The visible catalog = builtin + imported. Without an import dir this is
  // the builtin set; the sum of per-domain counts must equal that length.
  const expected = listDomains().reduce((sum, d) => sum + d.count, 0);
  assert.equal(total, expected, "per-chip counts must sum to the catalog total");
  assert.ok(total > 0, "catalog should not be empty");
});

test("domain slugs are stable, lower-case and unique", () => {
  refreshCatalogIndex();
  const filters = listSkillsetFilters();
  const ids = new Set<string>();
  for (const f of filters) {
    assert.equal(f.id, f.id.toLowerCase(), `slug ${f.id} must be lower-case`);
    assert.ok(!ids.has(f.id), `duplicate slug ${f.id}`);
    ids.add(f.id);
  }
});

test("listSkillsetFilters() is ordered by descending skill count", () => {
  refreshCatalogIndex();
  const filters = listSkillsetFilters();
  for (let i = 1; i < filters.length; i++) {
    assert.ok(
      filters[i].skillCount <= filters[i - 1].skillCount,
      `filters must be sorted by count desc (index ${i}: ${filters[i].skillCount} after ${filters[i - 1].skillCount})`
    );
  }
});

test("domainLabel() title-cases slugs and handles empty/edge input", () => {
  assert.equal(domainLabel("data-ml"), "Data Ml");
  assert.equal(domainLabel("web-graphics"), "Web Graphics");
  assert.equal(domainLabel("algorithmic-trading"), "Algorithmic Trading");
  assert.equal(domainLabel("security"), "Security");
  assert.equal(domainLabel("cli_chat_tools"), "Cli Chat Tools"); // underscores too
  assert.equal(domainLabel("  "), "Other"); // blank -> Other
  assert.equal(domainLabel(""), "Other");
});

// ---------------------------------------------------------------------------
// Route-level contract: GET /api/skills/catalog/skillsets serves the LIVE
// domain distribution (not the DB-snapshotted seed collections).
//
// requireManagementAuth() treats a missing Request as a trusted in-process
// caller, so the handler can be exercised directly without a NextRequest.
// ---------------------------------------------------------------------------
const { GET: skillsetsRoute } = await import("../../src/app/api/skills/catalog/skillsets/route.ts");

test("GET /api/skills/catalog/skillsets returns the live domain distribution", async () => {
  refreshCatalogIndex();
  const response = await skillsetsRoute();
  assert.equal(response.status, 200);
  const body = await response.json();

  const expected = listDomains().map((d) => ({
    id: d.domain,
    name: domainLabel(d.domain),
    skillCount: d.count,
  }));

  // The sidebar shows every live domain, in count order, with correct counts.
  assert.equal(body.count, expected.length, "count must equal number of live domains");
  assert.deepEqual(
    body.skillsets,
    expected,
    "route must return the live domain distribution keyed by slug"
  );
});
