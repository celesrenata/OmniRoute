// Regression tests: same-prefix rerank provider_nodes must spread across all
// matching nodes instead of pinning to the first registered one.
//
// The /v1/rerank route used localProviders.find(p => p.id === prefix) to pick
// a provider_node, so several nodes sharing one model prefix (one per GPU
// host, e.g. arcforge on 4 boxes) funneled every request through the first
// registered node while the rest sat idle — the pinned GPU saturated under a
// batch until the client timed out ("provider is down") although every
// service was alive. #arcforge-embeddings.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the DB to a temp dir BEFORE importing any module that opens it.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-rerank-spread-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { invalidateDbCache } = await import("../../src/lib/db/readCache.ts");
const { createProviderNode, createProviderConnection } =
  await import("../../src/lib/db/providers.ts");
const { POST } = await import("../../src/app/api/v1/rerank/route.ts");
const { RERANK_REMOTE_NODES_FLAG } =
  await import("../../src/app/api/v1/_shared/rerankProviderNodes.ts");

test.describe("#arcforge-embeddings: rerank same-prefix node spread", () => {
  const originalFetch = globalThis.fetch;
  const hosts = ["10.30.0.1", "10.30.0.2", "10.30.0.3", "10.30.0.4"];
  const now = new Date().toISOString();

  test.before(async () => {
    // Remote (LAN) nodes are only eligible with the opt-in flag on.
    process.env[RERANK_REMOTE_NODES_FLAG] = "true";
    for (const [i, host] of hosts.entries()) {
      const id = `openai-compatible-rerank-arcforge-${i + 1}`;
      await createProviderNode({
        id,
        name: `ArcForge Rerank ${i + 1}`,
        type: "openai",
        prefix: "arcforge",
        baseUrl: `http://${host}:8101/v1`,
        apiType: "rerank",
        createdAt: now,
        updatedAt: now,
      });
      await createProviderConnection({
        id: `conn-arcforge-rerank-${i + 1}`,
        provider: id,
        authType: "apikey",
        name: `arcforge-rerank-${i + 1}`,
        apiKey: `arcforge-token-${i + 1}`,
        createdAt: now,
        updatedAt: now,
      });
    }
    invalidateDbCache("nodes");
    invalidateDbCache("connections");
  });

  test.afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test.after(async () => {
    delete process.env[RERANK_REMOTE_NODES_FLAG];
    core.resetDbInstance();
    try {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // ignore
    }
  });

  test("requests spread across all same-prefix rerank nodes", async () => {
    const seenHosts = new Set<string>();
    globalThis.fetch = async (url: string | URL | Request, _init?: RequestInit) => {
      seenHosts.add(new URL(String(url)).host);
      // OpenAI/Cohere-shaped rerank success.
      return new Response(
        JSON.stringify({
          results: [{ index: 0, relevance_score: 0.9 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    for (let i = 0; i < 24; i++) {
      const res = await POST(
        new Request("http://localhost/v1/rerank", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "arcforge/bge-reranker-v2-m3",
            query: "what is a cat",
            documents: ["a cat is a small animal", "the stock market fell"],
            top_n: 1,
          }),
        }),
        {}
      );
      assert.equal(res.status, 200, `request ${i} should resolve a node and succeed`);
    }

    assert.ok(
      seenHosts.size >= 2,
      `expected traffic spread across >=2 nodes, but only hit: ${[...seenHosts].join(", ")}`
    );
    for (const host of seenHosts) {
      assert.ok(
        hosts.some((h) => host === `${h}:8101`),
        `unexpected upstream host ${host} (expected one of the 4 arcforge rerank nodes)`
      );
    }
  });

  test("a single rerank node still resolves (no regression for 1-node setups)", async () => {
    const soloId = "openai-compatible-rerank-solo-1";
    await createProviderNode({
      id: soloId,
      name: "Solo Rerank",
      type: "openai",
      prefix: "solorerank",
      baseUrl: "http://10.30.9.9:8101/v1",
      apiType: "rerank",
      createdAt: now,
      updatedAt: now,
    });
    await createProviderConnection({
      id: "conn-solo-rerank-1",
      provider: soloId,
      authType: "apikey",
      name: "solo-rerank",
      apiKey: "solo-token",
      createdAt: now,
      updatedAt: now,
    });
    invalidateDbCache("nodes");
    invalidateDbCache("connections");

    let hit = 0;
    globalThis.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
      hit++;
      return new Response(
        JSON.stringify({
          results: [{ index: 0, relevance_score: 0.5 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    for (let i = 0; i < 6; i++) {
      const res = await POST(
        new Request("http://localhost/v1/rerank", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "solorerank/bge-reranker-v2-m3",
            query: "q",
            documents: ["a", "b"],
            top_n: 1,
          }),
        }),
        {}
      );
      assert.equal(res.status, 200);
    }
    assert.equal(hit, 6, "a lone node must still receive every request");
  });
});
