/**
 * Skill write tools (write:skills) must check scopes UNCONDITIONALLY, even when
 * OMNIROUTE_MCP_ENFORCE_SCOPES is off. Other tools keep their flag-gated behavior.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-skillhub-scope-data-"));
const TEST_SKILL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omr-skillhub-scope-root-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OMNIROUTE_SKILL_ROOT = TEST_SKILL_ROOT;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.VECTOR_STORE_DISABLE_VEC = "true";
delete process.env.OMNIROUTE_MCP_ENFORCE_SCOPES;
delete process.env.OMNIROUTE_API_KEY;
delete process.env.ROUTER_API_KEY;

const { createMcpServer } = await import("../../open-sse/mcp-server/server.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { isMcpScopeEnforcementEnabled } = await import("../../src/shared/utils/featureFlags.ts");

after(() => {
  resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(TEST_SKILL_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

type ToolResult = { content?: Array<{ type: string; text: string }>; isError?: boolean };
type RegisteredTool = { handler: (args: unknown, extra?: unknown) => Promise<ToolResult> };

function tool(server: unknown, name: string) {
  const registry = (server as { _registeredTools?: Record<string, RegisteredTool> })
    ._registeredTools;
  assert.ok(registry?.[name], `${name} must be registered`);
  return registry[name].handler;
}

const server = createMcpServer();
const extraWith = (scopes: string[]) => ({ authInfo: { clientId: "key-1", scopes } });

const { skillTools } = await import("../../open-sse/mcp-server/tools/skillTools.ts");
const { skillDiscoveryTools } =
  await import("../../open-sse/mcp-server/tools/skillDiscoveryTools.ts");
const { githubSkillTools } = await import("../../open-sse/mcp-server/tools/githubSkillTools.ts");

// Derive every tool that declares write:skills so none can be missed.
const ALL_TOOLS = { ...skillTools, ...skillDiscoveryTools, ...githubSkillTools } as Record<
  string,
  { scopes?: readonly string[] }
>;
const WRITE_TOOLS = Object.entries(ALL_TOOLS)
  .filter(([, t]) => t.scopes?.includes("write:skills"))
  .map(([name]) => name);

const ARGS: Record<string, Record<string, unknown>> = {
  omr_skill_install: { name: "Scope Probe", description: "probe", content: "# Probe\n\nbody\n" },
  omr_skill_remove: { id: "imported:general/scope-probe" },
  omr_skill_set_enabled: { id: "imported:general/scope-probe", enabled: true },
  omniroute_skills_enable: { skillId: "nope", enabled: true },
  omniroute_github_skills_install: {},
};
const CALLS: Array<[string, Record<string, unknown>]> = WRITE_TOOLS.map((n) => [n, ARGS[n] ?? {}]);

test("every known write:skills tool is covered", () => {
  for (const n of [
    "omr_skill_install",
    "omr_skill_remove",
    "omr_skill_set_enabled",
    "omr_catalog_refresh",
    "omniroute_skills_enable",
    "omniroute_github_skills_install",
  ]) {
    assert.ok(WRITE_TOOLS.includes(n), `${n} should be a write:skills tool`);
  }
});

test("precondition: scope enforcement flag is off", () => {
  assert.equal(isMcpScopeEnforcementEnabled(), false);
});

for (const [name, args] of CALLS) {
  test(`${name}: read-only key is denied with the flag off`, async () => {
    const result = await tool(server, name)(args, extraWith(["read:catalog"]));
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? "", /Insufficient MCP scopes/);
  });

  test(`${name}: key with no scopes is denied with the flag off`, async () => {
    const result = await tool(server, name)(args, { authInfo: { clientId: "k", scopes: [] } });
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? "", /Insufficient MCP scopes/);
  });

  for (const scope of ["write:skills", "manage", "admin"]) {
    test(`${name}: ${scope} key passes the scope check with the flag off`, async () => {
      const result = await tool(server, name)(args, extraWith([scope]));
      assert.doesNotMatch(result.content?.[0]?.text ?? "", /Insufficient MCP scopes/);
    });
  }
}

test("read tools stay flag-gated: read-only-unrelated key still allowed with flag off", async () => {
  const result = await tool(server, "omr_skill_list")({}, extraWith(["read:usage"]));
  assert.doesNotMatch(result.content?.[0]?.text ?? "", /Insufficient MCP scopes/);
});
