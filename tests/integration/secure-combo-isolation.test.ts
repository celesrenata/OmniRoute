import test from "node:test";
import assert from "node:assert/strict";
import { createChatPipelineHarness } from "./_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("secure-combo-isolation");
const { invalidateMemorySettingsCache } = await import("../../src/lib/memory/settings.ts");
const { isComboTreeSecure } = await import("../../src/lib/combos/secure.ts");
const {
  BaseExecutor,
  buildOpenAIResponse,
  buildRequest,
  combosDb,
  handleChat,
  memoryStore,
  resetStorage,
  seedApiKey,
  seedConnection,
  semanticCacheModule,
  settingsDb,
  waitFor,
} = harness;

function dropFts5Artifacts() {
  try {
    harness.core
      .getDbInstance()
      .exec(
        "DROP TRIGGER IF EXISTS memory_fts_ai;DROP TRIGGER IF EXISTS memory_fts_ad;" +
          "DROP TRIGGER IF EXISTS memory_fts_au;DROP TABLE IF EXISTS memory_fts;"
      );
  } catch {
    /* DB not initialized yet */
  }
}

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await resetStorage();
  invalidateMemorySettingsCache();
  dropFts5Artifacts();
});
test.afterEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = harness.originalRetryDelayMs;
  await resetStorage();
  invalidateMemorySettingsCache();
});
test.after(async () => {
  await harness.cleanup();
});

type ApiKey = { id: string; key: string };
const LEAF = "vllm/granite-4.2-8b";
const LOCAL_URL = "http://10.1.1.12:2701/v1";
const seedLocal = (key: string) =>
  seedConnection("vllm", { apiKey: key, providerSpecificData: { baseUrl: LOCAL_URL } });

async function enableEverythingThatInjects() {
  await settingsDb.updateSettings({
    memoryEnabled: true,
    memoryMaxTokens: 400,
    memoryRetentionDays: 30,
    memoryStrategy: "recent",
    skillsEnabled: true,
    customSystemPromptEnabled: true,
    customSystemPrompt: "OPERATOR-CONTEXT-SENTINEL",
    semanticCacheEnabled: true,
  });
  invalidateMemorySettingsCache();
}

async function makeCombo(name: string, config: Record<string, unknown>, models: unknown[]) {
  await combosDb.createCombo({ name, strategy: "priority", config, models });
}

function capture() {
  const upstream: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_url: unknown, init: { body?: unknown } = {}) => {
    upstream.push(init.body ? JSON.parse(String(init.body)) : {});
    return buildOpenAIResponse("I prefer zebra-canary-7731 formatting.");
  };
  return upstream;
}

async function send(model: string, apiKey: ApiKey, content: string, headers = {}) {
  return handleChat(
    buildRequest({
      authKey: apiKey.key,
      headers,
      body: { model, stream: false, messages: [{ role: "user", content }] },
    })
  );
}

async function seedMemory(apiKey: ApiKey) {
  await memoryStore.createMemory({
    apiKeyId: apiKey.id,
    sessionId: "s",
    type: "factual",
    key: "preference:concise",
    content: "User prefers concise answers.",
    metadata: {},
    expiresAt: null,
  });
}

async function allMemories(apiKey: ApiKey) {
  dropFts5Artifacts();
  const result = await memoryStore.listMemories({ apiKeyId: apiKey.id });
  return Array.isArray(result) ? result : (result.data ?? []);
}

test("control: a non-secure combo still gets memory and the custom system prompt injected", async () => {
  await seedLocal("sk-openai-ctl");
  const apiKey = await seedApiKey();
  await enableEverythingThatInjects();
  await seedMemory(apiKey);
  await makeCombo("plain", {}, [LEAF]);
  const upstream = capture();

  const res = await send("plain", apiKey, "Say ok");
  assert.equal(res.status, 200);
  assert.equal(upstream.length, 1);
  const serialized = JSON.stringify(upstream[0]);
  assert.match(serialized, /OPERATOR-CONTEXT-SENTINEL|concise answers/);
});

test("secure combo: upstream receives only the client's message, no tools, no injected context", async () => {
  await seedLocal("sk-openai-sec");
  const apiKey = await seedApiKey();
  await enableEverythingThatInjects();
  await seedMemory(apiKey);
  await makeCombo("locked", { secure: true }, [LEAF]);
  const upstream = capture();

  const res = await send("locked", apiKey, "Say ok");
  assert.equal(res.status, 200);
  assert.equal(upstream.length, 1);
  const body = upstream[0];
  assert.deepEqual(body.messages, [{ role: "user", content: "Say ok" }]);
  assert.equal("tools" in body, false, "no tools may reach the upstream");
  assert.doesNotMatch(JSON.stringify(body), /OPERATOR-CONTEXT-SENTINEL|concise answers/);
});

test("secure combo persists nothing: canary is stored via a plain combo but not via a secure one", async () => {
  await seedLocal("sk-openai-canary");
  const apiKey = await seedApiKey();
  await enableEverythingThatInjects();
  await makeCombo("plain", {}, [LEAF]);
  await makeCombo("locked", { secure: true }, [LEAF]);
  capture();

  // Control proves the test can detect a write.
  await send("plain", apiKey, "I prefer zebra-canary-7731 formatting.");
  const stored = await waitFor(async () => {
    const list = await allMemories(apiKey);
    return list.some((m: { content: string }) => /zebra-canary-7731/.test(m.content)) ? list : null;
  }, 5000);
  assert.ok(stored, "control: canary should be persisted by a non-secure combo");

  const before = (await allMemories(apiKey)).length;
  semanticCacheModule.clearCache();
  await send("locked", apiKey, "I prefer another-canary-9912 formatting.");
  await new Promise((r) => setTimeout(r, 400));
  const after = await allMemories(apiKey);
  assert.equal(after.length, before, "secure combo must not add memories");
  assert.ok(!after.some((m: { content: string }) => /another-canary-9912/.test(m.content)));
});

test("secure outer combo makes the whole nested tree secure, including a non-secure inner combo", async () => {
  await seedLocal("sk-openai-nest");
  const apiKey = await seedApiKey();
  await enableEverythingThatInjects();
  await seedMemory(apiKey);
  await makeCombo("inner-plain", {}, [LEAF]);
  await makeCombo("outer-secure", { secure: true }, [
    { kind: "combo-ref", comboName: "inner-plain" },
  ]);
  const upstream = capture();

  const res = await send("outer-secure", apiKey, "Say ok");
  assert.equal(res.status, 200);
  assert.deepEqual(upstream[0].messages, [{ role: "user", content: "Say ok" }]);
  assert.equal("tools" in upstream[0], false);
});

test("a non-secure outer combo that references a secure inner combo is treated as secure", async () => {
  await seedLocal("sk-openai-nest2");
  const apiKey = await seedApiKey();
  await enableEverythingThatInjects();
  await seedMemory(apiKey);
  await makeCombo("inner-secure", { secure: true }, [LEAF]);
  await makeCombo("outer-plain", {}, [{ kind: "combo-ref", comboName: "inner-secure" }]);
  const upstream = capture();

  const res = await send("outer-plain", apiKey, "Say ok");
  assert.equal(res.status, 200);
  assert.deepEqual(upstream[0].messages, [{ role: "user", content: "Say ok" }]);
});

test("x-omniroute-secure header tightens a plain combo and cannot loosen a secure one", async () => {
  await seedLocal("sk-openai-hdr");
  const apiKey = await seedApiKey();
  await enableEverythingThatInjects();
  await seedMemory(apiKey);
  await makeCombo("plain", {}, [LEAF]);
  await makeCombo("locked", { secure: true }, [LEAF]);
  const upstream = capture();

  await send("plain", apiKey, "Say ok", { "x-omniroute-secure": "true" });
  assert.deepEqual(upstream[0].messages, [{ role: "user", content: "Say ok" }]);

  semanticCacheModule.clearCache();
  await send("locked", apiKey, "Say ok again", {
    "x-omniroute-secure": "false",
    "x-omniroute-no-memory": "false",
  });
  assert.deepEqual(upstream[1].messages, [{ role: "user", content: "Say ok again" }]);
});

test("isComboTreeSecure handles cycles and missing refs", () => {
  const a = { name: "a", config: {}, models: [{ kind: "combo-ref", comboName: "b" }] };
  const b = { name: "b", config: {}, models: [{ kind: "combo-ref", comboName: "a" }] };
  assert.equal(isComboTreeSecure(a, [a, b]), false);
  assert.equal(
    isComboTreeSecure(a, [a, { ...b, models: [{ kind: "combo-ref", comboName: "ghost" }] }]),
    false
  );
  const c = { name: "c", config: { secure: true }, models: [] };
  assert.equal(
    isComboTreeSecure({ ...a, models: [{ kind: "combo-ref", comboName: "c" }] }, [c]),
    true
  );
});

test("secure combo fails closed at dispatch when the target is a cloud provider", async () => {
  await seedConnection("openai", { apiKey: "sk-openai-cloud" });
  const apiKey = await seedApiKey();
  await enableEverythingThatInjects();
  // Inserted straight into the DB (bypassing the route check) to prove the runtime guard.
  await makeCombo("locked-cloud", { secure: true }, ["openai/gpt-4o-mini"]);
  const upstream = capture();

  const res = await send("locked-cloud", apiKey, "Say ok");
  assert.notEqual(res.status, 200);
  assert.equal(upstream.length, 0, "no request may reach a cloud upstream");
  const providersDb = await import("../../src/lib/db/providers.ts");
  const conns = await providersDb.getProviderConnections({ provider: "openai" });
  assert.ok(
    conns.every((c: { rateLimitedUntil?: unknown }) => !c.rateLimitedUntil),
    "a policy refusal must not put the connection into cooldown"
  );
});

test("findSecureCloudViolations flags cloud and unknown providers, accepts private base URLs", async () => {
  const { findSecureCloudViolations } = await import("../../src/lib/combos/secureLeaves.ts");
  const combos = [
    { name: "ok", config: { secure: true }, models: [{ kind: "model", model: "vllm/x" }] },
    { name: "bad", config: { secure: true }, models: [{ kind: "model", model: "openai/gpt-4o" }] },
    {
      name: "outer",
      config: { secure: true },
      models: [{ kind: "combo-ref", comboName: "inner" }],
    },
    { name: "inner", config: {}, models: [{ kind: "model", model: "openai/gpt-4o" }] },
    { name: "plain", config: {}, models: [{ kind: "model", model: "openai/gpt-4o" }] },
  ];
  const conns = async (provider: string) =>
    provider === "vllm" ? [{ id: "c1", providerSpecificData: { baseUrl: LOCAL_URL } }] : [];
  const v = await findSecureCloudViolations(combos, conns);
  assert.deepEqual(v.map((x) => x.combo).sort(), ["bad", "outer"]);
  const publicUrl = async () => [
    { id: "c", providerSpecificData: { baseUrl: "https://api.example.com/v1" } },
  ];
  const v2 = await findSecureCloudViolations([combos[0]], publicUrl);
  assert.equal(v2[0]?.reason, "non_local_base_url");
});

test("nested execute mode: inner combo system_message is suppressed under a secure parent", async () => {
  await seedLocal("sk-vllm-nested-exec");
  const apiKey = await seedApiKey();
  await enableEverythingThatInjects();
  await combosDb.createCombo({
    name: "inner-sys",
    strategy: "priority",
    config: {},
    models: [LEAF],
    system_message: "INNER-COMBO-SYSTEM-SENTINEL",
  });
  await makeCombo("outer-exec", { secure: true, nestedComboMode: "execute" }, [
    { kind: "combo-ref", comboName: "inner-sys" },
  ]);
  const upstream = capture();

  const res = await send("outer-exec", apiKey, "Say ok");
  assert.equal(res.status, 200);
  assert.doesNotMatch(JSON.stringify(upstream[0]), /INNER-COMBO-SYSTEM-SENTINEL/);
});

test("POST /api/combos refuses a secure combo that targets a cloud provider, accepts a local one", async () => {
  await seedLocal("sk-vllm-route");
  await seedConnection("openai", { apiKey: "sk-openai-route" });
  const { POST } = await import("../../src/app/api/combos/route.ts");
  const post = (body: unknown) =>
    POST(
      new Request("http://localhost/api/combos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    );

  const cloud = await post({
    name: "route-cloud",
    strategy: "priority",
    config: { secure: true },
    models: ["openai/gpt-4o-mini"],
  });
  assert.equal(cloud.status, 400);
  assert.match(JSON.stringify(await cloud.json()), /Secure combos may only route to local/);

  const relay = await post({
    name: "route-relay",
    strategy: "context-relay",
    config: { secure: true },
    models: [LEAF],
  });
  assert.equal(relay.status, 400);

  const local = await post({
    name: "route-local",
    strategy: "priority",
    config: { secure: true },
    models: [LEAF],
  });
  assert.equal(local.status, 201);
});
