/**
 * skill-hub-executable-gap.test.ts — regression guard for the Skill Hub
 * `executable`-claim gap (fresh deploy had no registered skills).
 *
 * The 46 curated built-in agent skills (omni-* and cli-*) are reference/instruction
 * skills with NO registered executor handler, yet the catalog previously marked
 * them `executable: true`. Executing one through the catalog bridge then threw
 * "Skill not found" from the executor and surfaced as a raw 500.
 *
 * This locks in the honest contract:
 *   1. Curated built-ins are reported `executable: false` (search + load).
 *   2. The catalog `execute` bridge returns a clean 404 (not a 500) when the
 *      executor cannot resolve a skill name, and a sanitized 500 for genuine
 *      execution faults.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-skillhub-exec-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_OMNIROUTE_API_KEY = process.env.OMNIROUTE_API_KEY;

process.env.DATA_DIR = TEST_DATA_DIR;
delete process.env.OMNIROUTE_API_KEY;

const { searchCatalog, loadSkill, getCatalogSkill, refreshCatalogIndex } =
  await import("../../open-sse/services/skillDiscovery.ts");
const { skillExecutor } = await import("../../src/lib/skills/executor.ts");
const core = await import("../../src/lib/db/core.ts");
const catalogRoute = await import("../../src/app/api/skills/catalog/route.ts");

function freshCatalog() {
  refreshCatalogIndex();
}

test.beforeEach(() => {
  delete process.env.OMNIROUTE_API_KEY;
  core.resetDbInstance();
  freshCatalog();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_OMNIROUTE_API_KEY === undefined) delete process.env.OMNIROUTE_API_KEY;
  else process.env.OMNIROUTE_API_KEY = ORIGINAL_OMNIROUTE_API_KEY;
});

// ── 1. Curated built-ins report executable:false ────────────────────────────

test("catalog search exposes executable=false on curated built-in agent skills", () => {
  const results = searchCatalog("inference");
  assert.ok(results.length > 0, "expected at least one built-in skill matching 'inference'");
  const builtin = results.find((r) => r.source === "builtin");
  assert.ok(builtin, "expected a builtin source in the search results");
  assert.equal(builtin.executable, false);
});

test("catalog browse-all exposes executable on every curated built-in", () => {
  const results = searchCatalog("");
  const builtins = results.filter((r) => r.source === "builtin");
  assert.ok(builtins.length > 0, "expected built-in skills in browse-all");
  for (const b of builtins) {
    assert.equal(b.executable, false, `builtin ${b.id} must report executable:false`);
  }
});

test("loadSkill reports executable:false for a curated built-in", () => {
  // omni-inference is one of the canonical curated API skills.
  const loaded = loadSkill("builtin:omni-inference");
  assert.ok(loaded, "builtin:omni-inference should be present in the catalog");
  assert.equal(loaded.skill.executable, false);
});

test("executableOnly filter excludes all curated built-ins", () => {
  const results = searchCatalog("", { executableOnly: true });
  assert.equal(
    results.filter((r) => r.source === "builtin").length,
    0,
    "no curated built-in may pass the executableOnly filter on a fresh deploy"
  );
});

// ── 2. execute bridge: clean 404 / sanitized 500, never a raw 500 leak ──────

function makeRequest(action: string, id: string, input: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/skills/catalog", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, id, input }),
  });
}

test("execute on a skill whose name the executor cannot resolve returns 404 (not 500)", async () => {
  const original = skillExecutor.execute.bind(skillExecutor);
  skillExecutor.execute = async (name: string) => {
    throw new Error(`Skill not found: ${name}`);
  };
  try {
    // Force the skill to be executable so the code path reaches the executor
    // (mirrors the historical bug: catalog said true, registry had nothing).
    const skill = getCatalogSkill("builtin:omni-inference");
    assert.ok(skill);
    // The fix sets this false; to exercise the executor 404 path we flip it,
    // then assert the bridge maps the executor miss to a clean 404.
    (skill as { executable: boolean }).executable = true;

    const res = await catalogRoute.POST(makeRequest("execute", "builtin:omni-inference"));
    assert.equal(res.status, 404, `expected 404, got ${res.status}`);

    const body = (await res.json()) as {
      executed?: unknown;
      found?: unknown;
      error?: unknown;
    };
    assert.equal(body.executed, false);
    assert.equal(body.found, false);
    assert.equal(typeof body.error, "string");
    assert.ok(!String(body.error).includes("at "), "404 body must not leak a stack trace");
  } finally {
    skillExecutor.execute = original;
    freshCatalog();
  }
});

test("execute returns a sanitized 500 for a genuine executor fault", async () => {
  const original = skillExecutor.execute.bind(skillExecutor);
  skillExecutor.execute = async () => {
    throw new Error("boom at /home/user/secret/stack-frame");
  };
  try {
    const skill = getCatalogSkill("builtin:omni-inference");
    assert.ok(skill);
    (skill as { executable: boolean }).executable = true;

    const res = await catalogRoute.POST(makeRequest("execute", "builtin:omni-inference"));
    assert.equal(res.status, 500, `expected 500, got ${res.status}`);

    const body = (await res.json()) as { executed?: unknown; error?: unknown };
    assert.equal(body.executed, false);
    const error = String(body.error ?? "");
    assert.ok(
      !error.includes("/home/user/secret"),
      `500 body must sanitize absolute paths, got: ${error}`
    );
  } finally {
    skillExecutor.execute = original;
    freshCatalog();
  }
});
