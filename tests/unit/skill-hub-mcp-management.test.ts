/**
 * Skill Hub management over MCP: omr_skill_install / omr_skill_remove /
 * omr_skill_set_enabled (shared implementation in src/lib/skills/skillAdmin.ts).
 *
 * Skills are written as imported SKILL.md skills under OMNIROUTE_SKILL_ROOT, which is
 * exactly what the discovery catalog (omr_skill_search/get/list) reads. No handler
 * code is ever stored, so nothing installed this way is executable.
 */
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-skillhub-mcp-data-"));
const TEST_SKILL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omr-skillhub-mcp-root-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OMNIROUTE_SKILL_ROOT = TEST_SKILL_ROOT;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.VECTOR_STORE_DISABLE_VEC = "true";

const core = await import("../../src/lib/db/core.ts");
const discovery = await import("../../open-sse/services/skillDiscovery.ts");
const { skillDiscoveryTools } =
  await import("../../open-sse/mcp-server/tools/skillDiscoveryTools.ts");
const { evaluateToolScopes } = await import("../../open-sse/mcp-server/scopeEnforcement.ts");
const { SkillAdminError } = await import("../../src/lib/skills/skillAdmin.ts");

const SKILL_BODY = "# Granite helper\n\nUse this skill when you need zebra-quartz widgets.\n";

function clearRoot() {
  for (const entry of fs.readdirSync(TEST_SKILL_ROOT)) {
    fs.rmSync(path.join(TEST_SKILL_ROOT, entry), { recursive: true, force: true });
  }
}

beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  clearRoot();
  discovery.invalidateCatalog();
});

after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(TEST_SKILL_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function install(overrides: Record<string, unknown> = {}) {
  return (await skillDiscoveryTools.omr_skill_install.handler(
    skillDiscoveryTools.omr_skill_install.inputSchema.parse({
      name: "Zebra Helper",
      description: "Helps with zebra-quartz widgets",
      content: SKILL_BODY,
      domain: "devops",
      tags: ["zebra"],
      ...overrides,
    })
  )) as { success: boolean; id: string; snapshotId: string | null };
}

test("new tools require the write:skills scope and deny callers without it", () => {
  for (const name of ["omr_skill_install", "omr_skill_remove", "omr_skill_set_enabled"] as const) {
    const tool = skillDiscoveryTools[name];
    assert.deepEqual(tool.scopes, ["write:skills"]);
    assert.equal(evaluateToolScopes(name, ["read:catalog"], true, tool.scopes).allowed, false);
    assert.equal(evaluateToolScopes(name, ["write:skills"], true, tool.scopes).allowed, true);
  }
});

test("install -> omr_skill_search finds it -> omr_skill_get returns markdown", async () => {
  const result = await install();
  assert.equal(result.success, true);
  assert.equal(result.id, "imported:devops/zebra-helper");
  assert.ok(fs.existsSync(path.join(TEST_SKILL_ROOT, "devops", "zebra-helper", "SKILL.md")));

  const search = (await skillDiscoveryTools.omr_skill_search.handler(
    skillDiscoveryTools.omr_skill_search.inputSchema.parse({ query: "zebra-quartz widgets" })
  )) as { count: number; results: Array<{ id: string; executable: boolean }> };
  const hit = search.results.find((r) => r.id === result.id);
  assert.ok(hit, "installed skill must be discoverable");
  assert.equal(hit.executable, false);

  const got = (await skillDiscoveryTools.omr_skill_get.handler(
    skillDiscoveryTools.omr_skill_get.inputSchema.parse({ id: result.id })
  )) as { found: boolean; markdown: string };
  assert.equal(got.found, true);
  assert.ok(got.markdown.includes("zebra-quartz widgets"));
});

test("install refuses to overwrite unless overwrite=true", async () => {
  await install();
  await assert.rejects(
    () => install(),
    (err: unknown) => err instanceof SkillAdminError && err.code === "CONFLICT"
  );
  const again = await install({ content: "# v2\n\nreplaced body zebra-quartz\n", overwrite: true });
  assert.equal(again.success, true);
  const md = fs.readFileSync(
    path.join(TEST_SKILL_ROOT, "devops", "zebra-helper", "SKILL.md"),
    "utf8"
  );
  assert.ok(md.includes("replaced body"));
});

test("install quarantines content with a hard-block secret pattern and writes nothing", async () => {
  await assert.rejects(
    () => install({ content: `# Bad\n\ntoken ghp_${"a".repeat(40)}\n` }),
    (err: unknown) => err instanceof SkillAdminError && err.code === "QUARANTINED"
  );
  assert.equal(fs.existsSync(path.join(TEST_SKILL_ROOT, "devops", "zebra-helper")), false);
});

test("install validates input (Zod): empty name, oversize content, bad domain", () => {
  const schema = skillDiscoveryTools.omr_skill_install.inputSchema;
  assert.equal(schema.safeParse({ name: "", description: "d", content: "x" }).success, false);
  assert.equal(
    schema.safeParse({ name: "n", description: "d", content: "x".repeat(200_001) }).success,
    false
  );
  assert.equal(
    schema.safeParse({ name: "n", description: "d", content: "x", domain: "../etc" }).success,
    false
  );
  // Executable handler code is not part of the MCP surface.
  assert.equal(
    schema.safeParse({ name: "n", description: "d", content: "x", handlerCode: "eval_code" })
      .success &&
      "handlerCode" in
        schema.parse({ name: "n", description: "d", content: "x", handlerCode: "eval_code" }),
    false
  );
});

test("set_enabled hides and re-shows a skill in discovery", async () => {
  const { id } = await install();
  const off = (await skillDiscoveryTools.omr_skill_set_enabled.handler(
    skillDiscoveryTools.omr_skill_set_enabled.inputSchema.parse({ id, enabled: false })
  )) as { success: boolean; enabled: boolean };
  assert.deepEqual([off.success, off.enabled], [true, false]);
  assert.equal(
    discovery.searchCatalog("zebra-quartz widgets").some((r) => r.id === id),
    false
  );

  await skillDiscoveryTools.omr_skill_set_enabled.handler(
    skillDiscoveryTools.omr_skill_set_enabled.inputSchema.parse({ id, enabled: true })
  );
  assert.equal(
    discovery.searchCatalog("zebra-quartz widgets").some((r) => r.id === id),
    true
  );
});

test("set_enabled on an unknown id is NOT_FOUND", async () => {
  await assert.rejects(
    () =>
      skillDiscoveryTools.omr_skill_set_enabled.handler(
        skillDiscoveryTools.omr_skill_set_enabled.inputSchema.parse({
          id: "imported:nope/missing",
          enabled: false,
        })
      ),
    (err: unknown) => err instanceof SkillAdminError && err.code === "NOT_FOUND"
  );
});

test("remove deletes the skill directory and the skill disappears", async () => {
  const { id } = await install();
  const removed = (await skillDiscoveryTools.omr_skill_remove.handler(
    skillDiscoveryTools.omr_skill_remove.inputSchema.parse({ id })
  )) as { success: boolean };
  assert.equal(removed.success, true);
  assert.equal(fs.existsSync(path.join(TEST_SKILL_ROOT, "devops", "zebra-helper")), false);
  assert.equal(
    discovery.searchCatalog("zebra-quartz widgets").some((r) => r.id === id),
    false
  );
});

test("remove only touches imported skills and never leaves the skill root", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "omr-skillhub-outside-"));
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
  try {
    for (const id of [
      "builtin:omni-inference",
      "imported:../../x",
      "imported:devops/missing",
      "",
    ]) {
      await assert.rejects(
        () => skillDiscoveryTools.omr_skill_remove.handler({ id } as { id: string }),
        (err: unknown) => err instanceof SkillAdminError,
        `id=${JSON.stringify(id)} must be rejected`
      );
    }
    assert.ok(fs.existsSync(path.join(outside, "keep.txt")));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("SkillAdminError messages never carry stack frames or absolute paths", async () => {
  await install();
  try {
    await install();
    assert.fail("expected conflict");
  } catch (err) {
    assert.ok(err instanceof SkillAdminError);
    assert.ok(!err.message.includes("at /"));
    assert.ok(!err.message.includes(TEST_SKILL_ROOT));
  }
});
