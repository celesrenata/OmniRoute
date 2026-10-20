/**
 * WP4 (Skill Hub) — SkillDiscoveryService + omr_catalog_* tools regression tests.
 *
 * Locks in the invariants that WP6 (policy/skillsets) builds on:
 *   - search returns ranked, bounded, explainable results
 *   - empty query returns no results
 *   - load returns bounded content or null for unknown ids
 *   - the four MCP tool schemas validate their inputs correctly
 */
import test from "node:test";
import assert from "node:assert/strict";

const discovery = await import("../../open-sse/services/skillDiscovery.ts");
const {
  searchCatalog,
  loadSkill,
  getCatalogSkill,
  listDomains,
  refreshCatalogIndex,
  resolveContainedResource,
} = discovery;

const {
  catalogTools,
  CatalogSearchSchema,
  CatalogLoadSchema,
  CatalogResourceSchema,
  CatalogExecuteSchema,
} = await import("../../open-sse/mcp-server/tools/catalogTools.ts");

test("WP4 — searchCatalog returns explainable ranked results for a real query", () => {
  refreshCatalogIndex();
  const results = searchCatalog("providers", { limit: 10 });
  // The built-in catalog has several provider-related skills.
  assert.ok(results.length >= 1, `expected at least 1 result, got ${results.length}`);
  const top = results[0];
  for (const key of [
    "id",
    "name",
    "description",
    "domain",
    "revision",
    "tags",
    "source",
    "score",
    "reason",
  ]) {
    assert.ok(key in top, `result missing key ${key}`);
  }
  // Score is monotonic non-increasing.
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i].score <= results[i - 1].score, "results must be sorted by score desc");
  }
  // Reason components are present and within [0,1].
  for (const key of ["nameMatch", "descriptionMatch", "tagMatch", "domainAffinity"]) {
    assert.ok(top.reason[key] >= 0 && top.reason[key] <= 1, `reason.${key} out of range`);
  }
});

test("WP4 — searchCatalog respects the limit", () => {
  refreshCatalogIndex();
  const results = searchCatalog("skill", { limit: 3 });
  assert.ok(results.length <= 3, `limit=3 violated: ${results.length}`);
});

test("WP4 — empty/whitespace query browses the full catalog (no lexical ranking)", () => {
  refreshCatalogIndex();
  const browse = searchCatalog("   ");
  assert.ok(browse.length > 0, "browse-all should surface the catalog, not an empty list");
  assert.ok(browse.length <= 200, "browse cap (200) violated");
  // Browse results carry no relevance breakdown.
  for (const r of browse) {
    assert.equal(r.score, 0);
    assert.equal(r.reason, null);
  }
  // Stable name order.
  const names = browse.map((r) => r.name);
  assert.deepEqual(
    names,
    [...names].sort((a, b) => a.localeCompare(b))
  );
});

test("WP4 — searchCatalog caps limit at 20", () => {
  refreshCatalogIndex();
  const results = searchCatalog("a", { limit: 9999 });
  assert.ok(results.length <= 20, `limit capped at 20 violated: ${results.length}`);
});

test("WP4 — loadSkill returns bounded content for a known builtin id", () => {
  refreshCatalogIndex();
  const results = searchCatalog("providers", { limit: 5 });
  assert.ok(results.length >= 1);
  const id = results[0].id;
  const loaded = loadSkill(id);
  assert.ok(loaded, "loadSkill should find the skill");
  assert.ok(loaded!.content.length <= 50_000, "content must be bounded to 50KB");
  assert.equal(loaded!.skill.id, id);
});

test("WP4 — loadSkill returns null for an unknown id", () => {
  refreshCatalogIndex();
  assert.equal(loadSkill("no-such-skill-id"), null);
});

test("WP4 — getCatalogSkill returns null for unknown id", () => {
  refreshCatalogIndex();
  assert.equal(getCatalogSkill("does-not-exist"), null);
});

test("WP4 — listDomains returns non-empty domain list with counts", () => {
  refreshCatalogIndex();
  const domains = listDomains();
  assert.ok(Array.isArray(domains));
  assert.ok(domains.length >= 1);
  for (const d of domains) {
    assert.ok(typeof d.domain === "string" && d.domain.length > 0);
    assert.ok(d.count >= 1);
  }
});

// ─── MCP tool schemas ────────────────────────────────────────────────────────

test("WP4 — four omr_catalog_* tools are registered with correct scopes", () => {
  assert.deepEqual(catalogTools.omr_catalog_search.scopes, ["read:catalog"]);
  assert.deepEqual(catalogTools.omr_catalog_load.scopes, ["read:catalog"]);
  assert.deepEqual(catalogTools.omr_catalog_resource.scopes, ["read:catalog"]);
  assert.deepEqual(catalogTools.omr_catalog_execute.scopes, ["execute:skills"]);
});

test("WP4 — CatalogSearchSchema rejects empty query", () => {
  const result = CatalogSearchSchema.safeParse({ query: "" });
  assert.equal(result.success, false);
});

test("WP4 — CatalogSearchSchema accepts valid input with all options", () => {
  const result = CatalogSearchSchema.safeParse({
    query: "routing",
    project: "acme",
    language: "ts",
    capabilities: ["http"],
    limit: 5,
    skillset: "devops",
  });
  assert.equal(result.success, true);
});

test("WP4 — CatalogSearchSchema caps limit at 20", () => {
  const result = CatalogSearchSchema.safeParse({ query: "x", limit: 21 });
  assert.equal(result.success, false);
});

test("WP4 — CatalogLoadSchema requires id", () => {
  assert.equal(CatalogLoadSchema.safeParse({}).success, false);
  assert.equal(CatalogLoadSchema.safeParse({ id: "builtin:omni-providers" }).success, true);
});

test("WP4 — CatalogResourceSchema requires id and path", () => {
  assert.equal(CatalogResourceSchema.safeParse({ id: "x" }).success, false);
  assert.equal(CatalogResourceSchema.safeParse({ id: "x", path: "refs/doc.md" }).success, true);
});

test("WP4 — CatalogExecuteSchema requires id, input is a record", () => {
  assert.equal(CatalogExecuteSchema.safeParse({}).success, false);
  const ok = CatalogExecuteSchema.safeParse({ id: "builtin:omni-providers", input: { a: 1 } });
  assert.equal(ok.success, true);
});

// ─── Handler behavior (imported skills are non-executable) ───────────────────

test("WP4 — omr_catalog_execute returns non-executable for imported instruction-only skills", async () => {
  const result = await catalogTools.omr_catalog_execute.handler({
    id: "imported:general/not-registered",
  });
  assert.equal(result.executed, false);
});

test("WP4 — omr_catalog_load returns found:false for unknown id", async () => {
  const result = await catalogTools.omr_catalog_load.handler({ id: "nope" });
  assert.equal(result.found, false);
});

test("WP4 — omr_catalog_search handler returns results array", async () => {
  const result = await catalogTools.omr_catalog_search.handler({ query: "providers" });
  assert.ok(Array.isArray(result.results));
  assert.ok(typeof result.count === "number");
});

// ─── Path containment (shared by MCP tool + REST route) ─────────────────────

test("WP4 — resolveContainedResource denies traversal outside the skill dir", () => {
  const skillMd = "/root/skills/demo/SKILL.md";
  // Escape via ../
  assert.equal(resolveContainedResource(skillMd, "../secrets.txt"), null);
  assert.equal(resolveContainedResource(skillMd, "../../etc/passwd"), null);
});

test("WP4 — resolveContainedResource allows paths inside the skill dir", () => {
  const skillMd = "/root/skills/demo/SKILL.md";
  const ok = resolveContainedResource(skillMd, "references/guide.md");
  assert.ok(ok);
  assert.ok(ok!.endsWith("references/guide.md"));
});

test("WP4 — omr_catalog_resource returns found:false for skills without a file tree", async () => {
  const result = await catalogTools.omr_catalog_resource.handler({
    id: "builtin:omni-providers",
    path: "refs/doc.md",
  });
  assert.equal(result.found, false);
});
