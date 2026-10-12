/**
 * Renderer-registry tests (OR-ATOM-001 v2, T004 / M1).
 *
 * Pure TS / node:test — no React, no DOM, and deliberately NO import of the
 * built-in renderer module here: importing it would pull the React/xyflow
 * chain (including a `.css` import) into the node:test runtime, which cannot
 * load it. The built-in module's self-registration side effect is asserted in
 * the vitest UI tests (`builtinRenderer.test.tsx`, `ProviderTopology2D...`)
 * where the CSS import is handled by Vite.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TOPOLOGY_RENDERER_ID,
  TOPOLOGY_RENDERER_PREF_KEY,
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

/** Minimal no-op renderer implementing the plugin contract. */
function stubPlugin(id: string): TopologyRendererPlugin {
  return {
    id,
    name: `stub:${id}`,
    version: 1,
    supported: () => true,
    mount: (
      _container: HTMLElement,
      _snapshot?: TopologySceneSnapshot,
      _options?: unknown
    ): TopologyRendererInstance => ({
      update: () => undefined,
      resize: () => undefined,
      setPaused: () => undefined,
      focusNode: () => undefined,
      dispose: () => undefined,
    }),
  };
}

/** In-memory `Storage` double (node:test has no `localStorage`). */
function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (_index: number) => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

// Isolate the module-global registry per suite so this file never leaks state
// into (or depends on) other test files in the same worker.
test.before(() => {
  resetTopologyRendererRegistry();
});

test("registry constants are stable (no accidental rename / id drift)", () => {
  assert.equal(DEFAULT_TOPOLOGY_RENDERER_ID, "reactflow-2d");
  assert.equal(TOPOLOGY_RENDERER_PREF_KEY, "omniroute.topology.renderer");
});

test("register + get + list lifecycle for a new plugin", () => {
  const plugin = stubPlugin("test-stub");
  registerTopologyRenderer(plugin);
  assert.equal(getTopologyRenderer("test-stub"), plugin);
  assert.ok(
    listTopologyRenderers()
      .map((r) => r.id)
      .includes("test-stub")
  );
  unregisterTopologyRenderer("test-stub");
  assert.equal(getTopologyRenderer("test-stub"), null);
  assert.ok(!listTopologyRenderers().some((r) => r.id === "test-stub"));
});

test("re-registering the same plugin object is idempotent (single entry)", () => {
  const plugin = stubPlugin("test-dup");
  registerTopologyRenderer(plugin);
  registerTopologyRenderer(plugin);
  assert.equal(listTopologyRenderers().filter((r) => r.id === "test-dup").length, 1);
  unregisterTopologyRenderer("test-dup");
});

test("getTopologyRenderer returns null for unknown / empty ids (host falls back)", () => {
  assert.equal(getTopologyRenderer("does-not-exist"), null);
  assert.equal(getTopologyRenderer(""), null);
});

test("readTopologyRendererPreference: no storage -> default (SSR-safe, AC4)", () => {
  assert.equal(readTopologyRendererPreference(null), DEFAULT_TOPOLOGY_RENDERER_ID);
  assert.equal(readTopologyRendererPreference(undefined), DEFAULT_TOPOLOGY_RENDERER_ID);
});

test("readTopologyRendererPreference: missing / empty / throwing storage -> default, never throws", () => {
  const storage = memoryStorage();
  assert.equal(readTopologyRendererPreference(storage), DEFAULT_TOPOLOGY_RENDERER_ID);

  writeTopologyRendererPreference(storage, "");
  assert.equal(readTopologyRendererPreference(storage), DEFAULT_TOPOLOGY_RENDERER_ID);

  const broken: Storage = {
    getItem: () => {
      throw new Error("SecurityError: access denied");
    },
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    get length() {
      return 0;
    },
  };
  assert.equal(readTopologyRendererPreference(broken), DEFAULT_TOPOLOGY_RENDERER_ID);
});

test("writeTopologyRendererPreference persists; read round-trips the value", () => {
  const storage = memoryStorage();
  writeTopologyRendererPreference(storage, "custom-renderer");
  assert.equal(readTopologyRendererPreference(storage), "custom-renderer");
});

test("writeTopologyRendererPreference never throws (quota / private-mode safe)", () => {
  const readonly: Storage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    get length() {
      return 0;
    },
  };
  assert.doesNotThrow(() => writeTopologyRendererPreference(readonly, "whatever"));
  assert.doesNotThrow(() => writeTopologyRendererPreference(null, "whatever"));
  assert.doesNotThrow(() => writeTopologyRendererPreference(undefined, "whatever"));
});

// --- resolveTopologyRenderer: requires a default to be registered (AC3) -------

test("with a registered default: unknown / empty / default ids all resolve to it (AC3)", () => {
  const def = stubPlugin(DEFAULT_TOPOLOGY_RENDERER_ID);
  resetTopologyRendererRegistry();
  registerTopologyRenderer(def);

  assert.equal(resolveTopologyRenderer("does-not-exist"), def);
  assert.equal(resolveTopologyRenderer(""), def);
  assert.equal(resolveTopologyRenderer(DEFAULT_TOPOLOGY_RENDERER_ID), def);
});

test("with a registered default: a registered non-default wins when preferred", () => {
  const def = stubPlugin(DEFAULT_TOPOLOGY_RENDERER_ID);
  const pref = stubPlugin("test-pref");
  resetTopologyRendererRegistry();
  registerTopologyRenderer(def);
  registerTopologyRenderer(pref);

  assert.equal(resolveTopologyRenderer("test-pref"), pref);
  assert.equal(resolveTopologyRenderer(DEFAULT_TOPOLOGY_RENDERER_ID), def);
});

test("with an empty registry: resolveTopologyRenderer returns null (host must not assume)", () => {
  resetTopologyRendererRegistry();
  assert.equal(resolveTopologyRenderer("anything"), null);
  assert.equal(resolveTopologyRenderer(DEFAULT_TOPOLOGY_RENDERER_ID), null);
});
