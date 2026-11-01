import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the DB to a temp dir BEFORE importing any module that opens it.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-embed-spread-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const { createProviderNode } = await import("../../src/lib/db/providers/nodes.ts");
const { createEmbeddingResponse } = await import("../../src/lib/embeddings/service.ts");
const { pickRandomMatchingNode } = await import("../../src/shared/utils/pickRandomMatchingNode.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * #arcforge-embeddings — several `provider_nodes` can advertise the SAME model
 * prefix (one node per GPU host, e.g. `arcforge` on 4 boxes). The old resolver
 * used `.find()`, pinning EVERY request to the first registered node while the
 * rest sat idle: a whole index batch saturated one GPU until the client timed
 * out and reported "the provider is down" even though the service was alive.
 * Requests must now be spread across every matching node.
 */
test("#arcforge-embeddings: requests spread across multiple same-prefix embedding nodes", async () => {
  const hosts = ["10.20.0.1", "10.20.0.2", "10.20.0.3", "10.20.0.4"];
  for (const [i, host] of hosts.entries()) {
    await createProviderNode({
      type: "openai-compatible-embeddings",
      name: `ArcForge Embeddings ${i + 1}`,
      prefix: "arcforge",
      apiType: "embeddings",
      baseUrl: `http://${host}:11434/v1`,
    });
  }

  const originalFetch = globalThis.fetch;
  const seenHosts = new Set<string>();
  globalThis.fetch = async (url: RequestInfo | URL, _options: RequestInit = {}) => {
    // The upstream URL is `<node baseUrl>/embeddings` — capture host:port so we
    // can prove which physical node each request actually hit.
    seenHosts.add(new URL(String(url)).host);
    return new Response(
      JSON.stringify({
        data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    for (let i = 0; i < 24; i++) {
      const res = await createEmbeddingResponse({
        model: "arcforge/nomic-embed-text",
        input: "hello world",
      });
      assert.equal(res.status, 200, `request ${i} should resolve and succeed`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Every request went to a real arcforge node (port 11434), and MORE THAN ONE
  // distinct node was used. Under the old `.find()` this set would be exactly
  // {"10.20.0.1:11434"} regardless of how many requests were sent.
  assert.ok(
    seenHosts.size >= 2,
    `expected traffic spread across >=2 nodes, but only hit: ${[...seenHosts].join(", ")}`
  );
  for (const host of seenHosts) {
    assert.ok(
      hosts.some((h) => host === `${h}:11434`),
      `unexpected upstream host ${host} (expected one of the 4 arcforge nodes)`
    );
  }
});

test("#arcforge-embeddings: a single node still resolves (no regression for 1-node setups)", async () => {
  await createProviderNode({
    type: "openai-compatible-embeddings",
    name: "ArcForge Embeddings Solo",
    prefix: "soloarcforge",
    apiType: "embeddings",
    baseUrl: "http://10.20.9.9:11434/v1",
  });

  const originalFetch = globalThis.fetch;
  let hit = 0;
  globalThis.fetch = async (_url: RequestInfo | URL, _options: RequestInit = {}) => {
    hit++;
    return new Response(
      JSON.stringify({
        data: [{ object: "embedding", embedding: [0.3], index: 0 }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    for (let i = 0; i < 6; i++) {
      const res = await createEmbeddingResponse({
        model: "soloarcforge/nomic-embed-text",
        input: "solo",
      });
      assert.equal(res.status, 200);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(hit, 6, "a lone node must still receive every request");
});

// Deterministic unit tests for the selector itself (no DB / no network).
test("pickRandomMatchingNode: returns null on empty input", () => {
  assert.equal(
    pickRandomMatchingNode([], (x: string) => x === "a"),
    null
  );
});

test("pickRandomMatchingNode: returns null when nothing matches", () => {
  assert.equal(
    pickRandomMatchingNode(["a", "b"], (x: string) => x === "zzz"),
    null
  );
});

test("pickRandomMatchingNode: only ever returns matching items, and spreads across all of them", () => {
  const items = ["n1", "n2", "n3", "n4"];
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const pick = pickRandomMatchingNode(items, (x) => x === "n2" || x === "n3");
    assert.ok(pick === "n2" || pick === "n3", `never returns a non-matching item (got ${pick})`);
    if (pick) seen.add(pick);
  }
  assert.equal(seen.size, 2, "repeated picks must cover every matching item");
});
