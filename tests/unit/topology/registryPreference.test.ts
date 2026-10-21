/**
 * Renderer-registry contract regression tests (OR-ATOM-001 v2, T004 / M1) —
 * registration / lookup / default / unknown-id fallback and the SSR-safe
 * renderer-preference storage helpers.
 *
 * Pure TS / node:test. No React, no DOM, and deliberately NO import of the
 * built-in renderer module (its `.css` import cannot load under node:test);
 * self-registration of the built-in is asserted in the vitest UI tests.
 *
 * Independent of the suite in `registry.test.ts`: re-pins the same contracts
 * from the host's angle — unknown preference ids must always resolve to the
 * default plugin (never `undefined`, never a foreign plugin), and the storage
 * helpers must be SSR-safe no-ops / safe fallbacks.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TOPOLOGY_RENDERER_ID,
  TOPOLOGY_RENDERER_PREF_KEY,
  getDefaultTopologyRenderer,
  getTopologyRenderer,
  listTopologyRenderers,
  readTopologyRendererPreference,
  registerTopologyRenderer,
  resetTopologyRendererRegistry,
  resolveTopologyRenderer,
  unregisterTopologyRenderer,
  writeTopologyRendererPreference,
} from "@/shared/topology/renderer/registry";
import type {
  TopologyRendererInstance,
  TopologyRendererPlugin,
} from "@/shared/topology/renderer/types";
import type { TopologySceneSnapshot } from "@/shared/topology/domain/types";

function stub(id: string, supported = () => true): TopologyRendererPlugin {
  return {
    id,
    name: `stub-${id}`,
    version: 1,
    supported,
    mount: (_container, _snapshot, _options): TopologyRendererInstance => ({
      update: (_snapshot: TopologySceneSnapshot) => undefined,
      resize: (_w: number, _h: number) => undefined,
      setPaused: (_paused: boolean) => undefined,
      focusNode: (_nodeId: string) => undefined,
      dispose: () => undefined,
    }),
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  const writes: string[] = [];
  let flagGet = false;
  let flagSet = false;
  const storage = {
    getItem(key: string): string | null {
      if (flagGet) throw new Error("storage disabled");
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key: string, value: string): void {
      if (flagSet) throw new Error("quota exceeded");
      map.set(key, value);
      writes.push(key);
    },
  } as Storage;
  return {
    storage,
    writes,
    throwOnGet: () => (flagGet = true),
    throwOnSet: () => (flagSet = true),
  };
}

test("registry: constants pin the built-in default id and storage key", () => {
  assert.equal(DEFAULT_TOPOLOGY_RENDERER_ID, "reactflow-2d");
  assert.equal(TOPOLOGY_RENDERER_PREF_KEY, "omniroute.topology.renderer");
});

test("registry: fresh registry has no renderers and safe lookups", () => {
  resetTopologyRendererRegistry();
  assert.equal(getTopologyRenderer("anything"), null, "unknown id -> null (host falls back)");
  assert.equal(getDefaultTopologyRenderer(), null, "default absent -> null, never throws");
  assert.deepEqual(listTopologyRenderers(), []);
  assert.equal(resolveTopologyRenderer("missing"), null, "no default registered -> null");
});

test("registry: register + get returns the exact plugin instance", () => {
  resetTopologyRendererRegistry();
  const plugin = stub("renderer-a");
  registerTopologyRenderer(plugin);
  assert.equal(getTopologyRenderer("renderer-a"), plugin);
  assert.equal(listTopologyRenderers().length, 1);
  assert.equal(listTopologyRenderers()[0], plugin);
});

test("registry: re-registering the same id replaces with the new instance", () => {
  resetTopologyRendererRegistry();
  const first = stub("renderer-b");
  const second = stub("renderer-b");
  registerTopologyRenderer(first);
  registerTopologyRenderer(second);
  assert.equal(getTopologyRenderer("renderer-b"), second, "latest registration wins");
  assert.equal(listTopologyRenderers().length, 1, "replacement does not duplicate");
});

test("registry: list preserves registration order across ids", () => {
  resetTopologyRendererRegistry();
  const a = stub("order-a");
  const b = stub("order-b");
  const c = stub("order-c");
  registerTopologyRenderer(a);
  registerTopologyRenderer(b);
  registerTopologyRenderer(c);
  assert.deepEqual(listTopologyRenderers(), [a, b, c]);
});

test("registry: unregister removes only the named renderer", () => {
  resetTopologyRendererRegistry();
  const a = stub("gone-a");
  const b = stub("stays-b");
  registerTopologyRenderer(a);
  registerTopologyRenderer(b);
  unregisterTopologyRenderer("gone-a");
  assert.equal(getTopologyRenderer("gone-a"), null);
  assert.equal(getTopologyRenderer("stays-b"), b);
  unregisterTopologyRenderer("never-registered");
  assert.equal(getTopologyRenderer("stays-b"), b, "unregister is idempotent; others untouched");
});

test("default lookup returns the built-in slot, independent of other plugins", () => {
  resetTopologyRendererRegistry();
  const builtin = stub(DEFAULT_TOPOLOGY_RENDERER_ID);
  registerTopologyRenderer(builtin);
  registerTopologyRenderer(stub("extra"));
  assert.equal(getDefaultTopologyRenderer(), builtin);
});

test("resolveTopologyRenderer: registered preference resolves to that plugin", () => {
  resetTopologyRendererRegistry();
  const builtin = stub(DEFAULT_TOPOLOGY_RENDERER_ID);
  const preferred = stub("preferred-3d");
  registerTopologyRenderer(builtin);
  registerTopologyRenderer(preferred);
  assert.equal(resolveTopologyRenderer("preferred-3d"), preferred);
});

test("resolveTopologyRenderer: unknown preference falls back to the default plugin", () => {
  resetTopologyRendererRegistry();
  const builtin = stub(DEFAULT_TOPOLOGY_RENDERER_ID);
  registerTopologyRenderer(builtin);
  assert.equal(resolveTopologyRenderer("never-registered-id"), builtin, "unknown id -> default");
  assert.equal(resolveTopologyRenderer(""), builtin, "empty preference -> default");
});

test("resolveTopologyRenderer: explicit default id resolves to the default plugin", () => {
  resetTopologyRendererRegistry();
  const builtin = stub(DEFAULT_TOPOLOGY_RENDERER_ID);
  registerTopologyRenderer(builtin);
  registerTopologyRenderer(stub("other"));
  assert.equal(resolveTopologyRenderer(DEFAULT_TOPOLOGY_RENDERER_ID), builtin);
});

test("resolveTopologyRenderer: unregistered default -> null, never a foreign plugin", () => {
  resetTopologyRendererRegistry();
  registerTopologyRenderer(stub("other"));
  assert.equal(resolveTopologyRenderer(DEFAULT_TOPOLOGY_RENDERER_ID), null);
});

test("readTopologyRendererPreference: null/undefined storage -> default (SSR)", () => {
  assert.equal(readTopologyRendererPreference(null), DEFAULT_TOPOLOGY_RENDERER_ID);
  assert.equal(readTopologyRendererPreference(undefined), DEFAULT_TOPOLOGY_RENDERER_ID);
});

test("readTopologyRendererPreference: no persisted value -> default", () => {
  const { storage } = memoryStorage();
  assert.equal(readTopologyRendererPreference(storage), DEFAULT_TOPOLOGY_RENDERER_ID);
});

test("readTopologyRendererPreference: persisted id round-trips", () => {
  const { storage } = memoryStorage({ [TOPOLOGY_RENDERER_PREF_KEY]: "atomic-3d" });
  assert.equal(readTopologyRendererPreference(storage), "atomic-3d");
});

test("readTopologyRendererPreference: empty string -> default (never an empty renderer id)", () => {
  const { storage } = memoryStorage({ [TOPOLOGY_RENDERER_PREF_KEY]: "" });
  assert.equal(readTopologyRendererPreference(storage), DEFAULT_TOPOLOGY_RENDERER_ID);
});

test("readTopologyRendererPreference: corrupt / throwing storage falls back to default", () => {
  const { storage, throwOnGet } = memoryStorage();
  assert.equal(readTopologyRendererPreference(storage), DEFAULT_TOPOLOGY_RENDERER_ID);
  throwOnGet();
  assert.equal(
    readTopologyRendererPreference(storage),
    DEFAULT_TOPOLOGY_RENDERER_ID,
    "throwing getItem must never propagate"
  );
});

test("writeTopologyRendererPreference: null/undefined storage is a no-op (SSR)", () => {
  writeTopologyRendererPreference(null, "atomic-3d");
  writeTopologyRendererPreference(undefined, "atomic-3d");
});

test("writeTopologyRendererPreference: persists under the canonical key", () => {
  const { storage, writes } = memoryStorage();
  writeTopologyRendererPreference(storage, "atomic-3d");
  assert.deepEqual(writes, [TOPOLOGY_RENDERER_PREF_KEY]);
  assert.equal(storage.getItem(TOPOLOGY_RENDERER_PREF_KEY), "atomic-3d");
});

test("writeTopologyRendererPreference: throwing storage (quota/private mode) is swallowed", () => {
  const { storage, throwOnSet } = memoryStorage();
  throwOnSet();
  assert.doesNotThrow(() => writeTopologyRendererPreference(storage, "atomic-3d"));
  assert.equal(storage.getItem(TOPOLOGY_RENDERER_PREF_KEY), null, "failed write leaves no state");
});

test("preference storage + registry resolve into one coherent fallback chain", () => {
  resetTopologyRendererRegistry();
  const builtin = stub(DEFAULT_TOPOLOGY_RENDERER_ID);
  const preferred = stub("atomic-3d");
  registerTopologyRenderer(builtin);
  registerTopologyRenderer(preferred);

  const { storage } = memoryStorage({ [TOPOLOGY_RENDERER_PREF_KEY]: "atomic-3d" });
  assert.equal(resolveTopologyRenderer(readTopologyRendererPreference(storage)), preferred);

  resetTopologyRendererRegistry();
  registerTopologyRenderer(builtin);
  assert.equal(resolveTopologyRenderer(readTopologyRendererPreference(storage)), builtin);
});
