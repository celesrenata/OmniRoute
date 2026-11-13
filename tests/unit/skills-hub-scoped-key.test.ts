/**
 * Least-privilege Skill Hub management key.
 *
 * Secondary management key = scopes [mcp:connect, read:catalog, write:skills]:
 *   - read:catalog  -> GET/POST /api/skills/catalog (search/load/resource ONLY)
 *   - write:skills  -> POST|DELETE /api/skills/hub, POST /api/skills/catalog/refresh,
 *                      POST /api/skills/catalog/[id]/toggle
 *   - mcp:connect   -> /api/mcp/* transport
 * Everything else under /api/** (and catalog `execute`, /api/skills/install,
 * /api/skills/[id], /api/keys, /api/skills/collect/) still needs manage/admin.
 */
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-skills-scoped-data-"));
const TEST_SKILL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omr-skills-scoped-root-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OMNIROUTE_SKILL_ROOT = TEST_SKILL_ROOT;
process.env.API_KEY_SECRET = "test-secret";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.VECTOR_STORE_DISABLE_VEC = "true";
process.env.JWT_SECRET = "test-jwt-secret-for-skills-scoped-key";
process.env.INITIAL_PASSWORD = "initial-pass";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const discovery = await import("../../open-sse/services/skillDiscovery.ts");
const { managementPolicy } = await import("../../src/server/authz/policies/management.ts");
const scopes = await import("../../src/shared/constants/managementScopes.ts");
const hubRoute = await import("../../src/app/api/skills/hub/route.ts");
const catalogRoute = await import("../../src/app/api/skills/catalog/route.ts");
const refreshRoute = await import("../../src/app/api/skills/catalog/refresh/route.ts");
const toggleRoute = await import("../../src/app/api/skills/catalog/[id]/toggle/route.ts");

beforeEach(async () => {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  for (const e of fs.readdirSync(TEST_SKILL_ROOT)) {
    fs.rmSync(path.join(TEST_SKILL_ROOT, e), { recursive: true, force: true });
  }
  discovery.invalidateCatalog();
  await settingsDb.updateSettings({ requireLogin: true });
});

after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(TEST_SKILL_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function ctx(key: string | null, method: string, pathname: string) {
  const headers = new Headers(key ? { authorization: `Bearer ${key}` } : {});
  return {
    request: {
      method,
      headers,
      url: `http://localhost${pathname}`,
      nextUrl: { pathname },
    },
    classification: {
      routeClass: "MANAGEMENT" as const,
      reason: "management_api" as const,
      normalizedPath: pathname,
    },
    requestId: "req_skills_scoped",
  };
}

function req(key: string | null, method: string, url: string, body?: unknown) {
  return new Request(`http://localhost${url}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function mkKey(name: string, keyScopes: string[]) {
  return (await apiKeysDb.createApiKey(name, `machine-${name}`, keyScopes)).key;
}

const SKILL = {
  name: "Scoped Skill",
  description: "installed by a scoped key",
  content: "# Scoped\n\nbody for scoped key test\n",
  domain: "devops",
};

test("hasSkillsHubScope: read/write levels, manage and admin pass, others do not", () => {
  const { hasSkillsHubScope } = scopes;
  assert.equal(hasSkillsHubScope(["read:catalog"], "read"), true);
  assert.equal(hasSkillsHubScope(["read:catalog"], "write"), false);
  assert.equal(hasSkillsHubScope(["write:skills"], "write"), true);
  assert.equal(hasSkillsHubScope(["write:skills"], "read"), false);
  assert.equal(hasSkillsHubScope(["manage"], "write"), true);
  assert.equal(hasSkillsHubScope(["admin"], "read"), true);
  assert.equal(hasSkillsHubScope(["chat"], "read"), false);
  assert.equal(hasSkillsHubScope([], "write"), false);
  // Must stay out of the general management scope set.
  assert.equal(scopes.MANAGEMENT_API_KEY_SCOPES.has("read:catalog"), false);
  assert.equal(scopes.MANAGEMENT_API_KEY_SCOPES.has("write:skills"), false);
});

test("resolveSkillsHubRouteLevel allowlists exactly the hub routes", () => {
  const lvl = scopes.resolveSkillsHubRouteLevel;
  assert.equal(lvl("GET", "/api/skills/catalog"), "read");
  assert.equal(lvl("POST", "/api/skills/catalog"), "read");
  assert.equal(lvl("POST", "/api/skills/hub"), "write");
  assert.equal(lvl("DELETE", "/api/skills/hub"), "write");
  assert.equal(lvl("POST", "/api/skills/catalog/refresh"), "write");
  assert.equal(lvl("POST", "/api/skills/catalog/imported%3Adevops%2Fx/toggle"), "write");
  for (const [m, p] of [
    ["POST", "/api/skills/install"],
    ["POST", "/api/skills/executions"],
    ["PUT", "/api/skills/abc"],
    ["DELETE", "/api/skills/abc"],
    ["GET", "/api/skills"],
    ["GET", "/api/skills/collect/detect"],
    ["POST", "/api/skills/marketplace/install"],
    ["GET", "/api/skills/catalog/skillsets"],
    ["GET", "/api/skills/hub"],
    ["PUT", "/api/skills/hub"],
    ["GET", "/api/keys"],
  ] as const) {
    assert.equal(lvl(m, p), null, `${m} ${p} must not be carved out`);
  }
});

test("policy: read:catalog key may search/load, not write, not other routes", async () => {
  const key = await mkKey("reader", ["read:catalog"]);
  assert.equal(
    (await managementPolicy.evaluate(ctx(key, "GET", "/api/skills/catalog"))).allow,
    true
  );
  assert.equal(
    (await managementPolicy.evaluate(ctx(key, "POST", "/api/skills/catalog"))).allow,
    true
  );
  for (const [m, p] of [
    ["POST", "/api/skills/hub"],
    ["POST", "/api/skills/catalog/refresh"],
    ["POST", "/api/skills/install"],
    ["GET", "/api/keys"],
    ["GET", "/api/skills"],
  ] as const) {
    const out = await managementPolicy.evaluate(ctx(key, m, p));
    assert.equal(out.allow, false, `${m} ${p} must be denied for read:catalog`);
  }
});

test("policy: write:skills key may mutate hub routes, not read other management routes", async () => {
  const key = await mkKey("writer", ["write:skills"]);
  for (const [m, p] of [
    ["POST", "/api/skills/hub"],
    ["DELETE", "/api/skills/hub"],
    ["POST", "/api/skills/catalog/refresh"],
    ["POST", "/api/skills/catalog/imported%3Adevops%2Fx/toggle"],
  ] as const) {
    assert.equal((await managementPolicy.evaluate(ctx(key, m, p))).allow, true, `${m} ${p}`);
  }
  for (const [m, p] of [
    ["GET", "/api/keys"],
    ["GET", "/api/settings"],
    ["POST", "/api/skills/install"],
    ["PUT", "/api/skills/some-id"],
  ] as const) {
    assert.equal((await managementPolicy.evaluate(ctx(key, m, p))).allow, false, `${m} ${p}`);
  }
});

test("policy: manage still works, no key is 401, chat-only key is denied", async () => {
  const manage = await mkKey("mgr", ["manage"]);
  assert.equal(
    (await managementPolicy.evaluate(ctx(manage, "POST", "/api/skills/hub"))).allow,
    true
  );
  const none = await managementPolicy.evaluate(ctx(null, "GET", "/api/skills/catalog"));
  assert.equal(none.allow, false);
  if (!none.allow) assert.equal(none.status, 401);
  const chat = await mkKey("chatter", ["chat"]);
  assert.equal(
    (await managementPolicy.evaluate(ctx(chat, "GET", "/api/skills/catalog"))).allow,
    false
  );
});

test("secondary key [mcp:connect, read:catalog, write:skills] works end to end over REST", async () => {
  const key = await mkKey("secondary", ["mcp:connect", "read:catalog", "write:skills"]);

  const created = await hubRoute.POST(req(key, "POST", "/api/skills/hub", SKILL));
  assert.equal(created.status, 200);
  const createdBody = (await created.json()) as { id: string };
  assert.equal(createdBody.id, "imported:devops/scoped-skill");

  const search = await catalogRoute.GET(req(key, "GET", "/api/skills/catalog?query=scoped"));
  assert.equal(search.status, 200);
  assert.ok(
    ((await search.json()) as { results: Array<{ id: string }> }).results.some(
      (r) => r.id === createdBody.id
    )
  );

  const load = await catalogRoute.POST(
    req(key, "POST", "/api/skills/catalog", { action: "load", id: createdBody.id })
  );
  assert.equal(load.status, 200);

  const toggled = await toggleRoute.POST(
    req(key, "POST", "/api/skills/catalog/x/toggle", { enabled: false }),
    { params: Promise.resolve({ id: encodeURIComponent(createdBody.id) }) }
  );
  assert.equal(toggled.status, 200);

  const refreshed = await refreshRoute.POST(
    req(key, "POST", "/api/skills/catalog/refresh") as never
  );
  assert.equal(refreshed.status, 200);

  const removed = await hubRoute.DELETE(
    req(key, "DELETE", `/api/skills/hub?id=${encodeURIComponent(createdBody.id)}`)
  );
  assert.equal(removed.status, 200);
  assert.equal(fs.existsSync(path.join(TEST_SKILL_ROOT, "devops", "scoped-skill")), false);
});

test("routes: read:catalog-only key is 403 on write routes and on catalog execute", async () => {
  const key = await mkKey("reader-only", ["read:catalog"]);
  assert.equal((await hubRoute.POST(req(key, "POST", "/api/skills/hub", SKILL))).status, 403);
  assert.equal(
    (await hubRoute.DELETE(req(key, "DELETE", "/api/skills/hub?id=imported%3Adevops%2Fx"))).status,
    403
  );
  assert.equal(
    (await refreshRoute.POST(req(key, "POST", "/api/skills/catalog/refresh") as never)).status,
    403
  );
  const exec = await catalogRoute.POST(
    req(key, "POST", "/api/skills/catalog", { action: "execute", id: "builtin:omni-inference" })
  );
  assert.equal(exec.status, 403);
  const load = await catalogRoute.POST(
    req(key, "POST", "/api/skills/catalog", { action: "load", id: "builtin:omni-inference" })
  );
  assert.notEqual(load.status, 403);
});

test("routes: write:skills-only key cannot search; inference-only key is rejected; none is 401", async () => {
  const writer = await mkKey("writer-only", ["write:skills"]);
  assert.equal(
    (await catalogRoute.GET(req(writer, "GET", "/api/skills/catalog?query=x"))).status,
    403
  );
  const chat = await mkKey("chat-only", ["chat"]);
  assert.equal((await hubRoute.POST(req(chat, "POST", "/api/skills/hub", SKILL))).status, 403);
  assert.equal((await hubRoute.POST(req(null, "POST", "/api/skills/hub", SKILL))).status, 401);
});

test("routes: manage key still passes; invalid body yields 400 with no stack in the error", async () => {
  const manage = await mkKey("mgr2", ["manage"]);
  assert.equal((await hubRoute.POST(req(manage, "POST", "/api/skills/hub", SKILL))).status, 200);
  const dup = await hubRoute.POST(req(manage, "POST", "/api/skills/hub", SKILL));
  assert.equal(dup.status, 409);
  assert.ok(!JSON.stringify(await dup.json()).includes("at /"));
  const bad = await hubRoute.POST(req(manage, "POST", "/api/skills/hub", { name: "" }));
  assert.equal(bad.status, 400);
  assert.ok(!JSON.stringify(await bad.json()).includes("at /"));
});
