/**
 * Atomic topology — manifest metadata + Phase A plugin registration contract
 * (OR-ATOM-001 v2, T006a / M3 Phase A).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  atomicManifest,
  buildAtomicTopologyPlugin,
  registerAtomicTopologyRenderer,
  AtomicWebGLUnsupportedError,
  placeholderAtomicInstance,
  LANE_HUES,
  computeAtomicLayout,
  ATOMIC_EVENT_POOL_CAPACITY,
  ATOMIC_EVENT_HIGH_WATERMARK,
  ATOMIC_EVENT_MAX_AGE_MS,
} from "@/plugins/atomic-topology";
import {
  getTopologyRenderer,
  listTopologyRenderers,
  resetTopologyRendererRegistry,
  unregisterTopologyRenderer,
} from "@/shared/topology/renderer/registry";
import type { TopologySceneSnapshot } from "@/shared/topology/domain/types";

const emptySnapshot: TopologySceneSnapshot = {
  schemaVersion: 1,
  capturedAt: 1700000000000,
  links: [],
  nodes: [{ id: "hub", kind: "hub", label: "Router", health: "healthy", traffic: "idle" }],
};

test("manifest metadata pins id/name/version/capability", () => {
  assert.deepEqual(atomicManifest, {
    id: "atomic",
    name: "Atomic",
    version: 1,
    capability: "webgl2",
  });
});

test("plugin: supported() is false in node/jsdom (no WebGL2)", () => {
  const plugin = buildAtomicTopologyPlugin();
  assert.equal(plugin.id, "atomic");
  assert.equal(plugin.name, "Atomic");
  assert.equal(plugin.version, 1);
  const supported = plugin.supported();
  assert.equal(supported, false, "no browser context → not supported → host falls back");
  assert.ok(
    typeof supported === "boolean",
    "Phase A detection is synchronous (returns boolean, not a Promise)"
  );
});

test("plugin: mount() throws the Phase B typed error when WebGL2 is unavailable", () => {
  const plugin = buildAtomicTopologyPlugin();
  const container = { tagName: "DIV" } as unknown as HTMLElement;
  assert.throws(
    () => plugin.mount(container, emptySnapshot, {}),
    (err: unknown) => {
      assert.ok(
        err instanceof AtomicWebGLUnsupportedError,
        `expected the Phase B typed error, got ${String(err)}`
      );
      assert.equal((err as AtomicWebGLUnsupportedError).code, "ATOMIC_WEBGL_UNSUPPORTED");
      return true;
    }
  );
});

test("registerAtomicTopologyRenderer: registers under id 'atomic' and is idempotent", () => {
  resetTopologyRendererRegistry();
  try {
    const first = registerAtomicTopologyRenderer();
    assert.equal(first.id, "atomic");
    assert.equal(getTopologyRenderer("atomic"), first);
    assert.ok(listTopologyRenderers().some((r) => r.id === "atomic"));

    const second = registerAtomicTopologyRenderer();
    assert.equal(getTopologyRenderer("atomic"), second);
    assert.equal(
      listTopologyRenderers().filter((r) => r.id === "atomic").length,
      1,
      "re-registration replaces, never duplicates"
    );
  } finally {
    unregisterTopologyRenderer("atomic");
  }
});

test("placeholder instance satisfies the contract shape (no-op lifecycle)", () => {
  assert.doesNotThrow(() => placeholderAtomicInstance.update(emptySnapshot));
  assert.doesNotThrow(() => placeholderAtomicInstance.resize(800, 600));
  assert.doesNotThrow(() => placeholderAtomicInstance.setPaused(true));
  assert.doesNotThrow(() => placeholderAtomicInstance.focusNode("provider:openai"));
  assert.doesNotThrow(() => placeholderAtomicInstance.dispose());
});

test("index re-exports the pure API surface used by host/tests; eventPool constants are bounded", () => {
  assert.equal(typeof LANE_HUES.chat, "string");
  assert.equal(typeof computeAtomicLayout, "function");
  assert.equal(ATOMIC_EVENT_POOL_CAPACITY, 512);
  assert.equal(ATOMIC_EVENT_HIGH_WATERMARK, 448, "high watermark is 87.5% of capacity");
  assert.equal(ATOMIC_EVENT_MAX_AGE_MS, 60_000);
  assert.ok(
    ATOMIC_EVENT_HIGH_WATERMARK < ATOMIC_EVENT_POOL_CAPACITY,
    "high watermark must be below capacity"
  );
});
