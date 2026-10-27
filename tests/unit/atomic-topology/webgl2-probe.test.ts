/**
 * Atomic topology — cached, context-releasing WebGL2 probe (P0 regression fix).
 *
 * The probe must allocate a real WebGL2 context **at most once per page load**
 * and release it immediately (`WEBGL_lose_context`), so it never counts
 * against the browser's ~16 active-WebGL-context limit. Every call after the
 * first returns the cached boolean.
 *
 * Pure/lean: fakes `document` + canvas, no R3F rendering.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  webgl2Available,
  __resetWebgl2CacheForTests,
} from "@/plugins/atomic-topology/capabilities";

interface FakeCtx {
  loseContextCalls: number;
  ctx: { getExtension?: (name: string) => { loseContext(): void } | null };
}

/** Install a fake `document` whose canvas reports WebGL2 support (or not). */
function installFakeDocument(opts: {
  supported?: boolean;
  getContextThrows?: boolean;
  onGetContext?: () => void;
}) {
  const calls = { getContext: 0, loseContext: 0 };
  const fakeDoc = {
    createElement(kind: string) {
      assert.equal(kind, "canvas");
      return {
        getContext(_type: string) {
          calls.getContext += 1;
          opts.onGetContext?.();
          if (opts.getContextThrows) throw new Error("boom: canvas.getContext");
          if (!opts.supported) return null;
          const lose = {
            loseContext() {
              calls.loseContext += 1;
            },
          };
          return { getExtension: (_name: string) => lose } as FakeCtx["ctx"];
        },
      };
    },
  };
  (globalThis as Record<string, unknown>)["document"] = fakeDoc;
  return calls;
}

/** Remove the fake `document` (restore node/SSR conditions). */
function removeDocument() {
  delete (globalThis as Record<string, unknown>)["document"];
}

test("webgl2Available: allocates exactly one context across 100 calls, releases it", () => {
  __resetWebgl2CacheForTests();
  const calls = installFakeDocument({ supported: true });

  const results: boolean[] = [];
  for (let i = 0; i < 100; i += 1) results.push(webgl2Available());

  // All 100 calls return the same (true) cached boolean.
  for (const result of results) assert.equal(result, true);
  // The underlying getContext is invoked EXACTLY once…
  assert.equal(calls.getContext, 1);
  // …and the context is released exactly once (success path).
  assert.equal(calls.loseContext, 1);

  __resetWebgl2CacheForTests();
  removeDocument();
});

test("webgl2Available: no document (SSR) returns false without throwing", () => {
  __resetWebgl2CacheForTests();
  removeDocument();
  assert.equal(typeof document, "undefined");

  assert.equal(webgl2Available(), false);
  // Cached: a second call is still false, no throw.
  assert.equal(webgl2Available(), false);

  __resetWebgl2CacheForTests();
});

test("webgl2Available: throwing probe is unavailable (permissive), never crashes", () => {
  __resetWebgl2CacheForTests();
  const calls = installFakeDocument({ supported: true, getContextThrows: true });

  assert.doesNotThrow(() => webgl2Available());
  assert.equal(webgl2Available(), false);
  assert.equal(calls.getContext, 1); // probed once, then cached

  __resetWebgl2CacheForTests();
  removeDocument();
});
