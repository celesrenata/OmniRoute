/**
 * Atomic topology — Phase B lifecycle adapter + pure descriptor bridge
 * (OR-ATOM-001 v2, T006b / M3 Phase B).
 *
 * Covers the *new* surface from `src/plugins/atomic-topology/AtomicTopologyRenderer.tsx`:
 *   - `resolveAtomDescriptors` / `resolveLinkDescriptors` (pure data→visual
 *     bridge, no WebGL) — exact positions, colors, lanes, spin/vibration/state.
 *   - `mountAtomicTopologyRenderer` throwing the typed
 *     `AtomicWebGLUnsupportedError` when WebGL2 is unavailable (node / SSR).
 *   - The plugin's `supported()` / `mount()` contract now backed by the real
 *     Phase B mount (replacing the Phase A placeholder).
 *   - A minimal, guarded DOM smoke test of `createAtomicTopologyInstance`
 *     (create/update/resize/setPaused/focusNode/dispose) — run only when a DOM
 *     is present so it never fails the headless node run.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  mountAtomicTopologyRenderer,
  createAtomicTopologyInstance,
  resolveAtomDescriptors,
  resolveLinkDescriptors,
  AtomicWebGLUnsupportedError,
  buildAtomicTopologyPlugin,
  modelColor,
  LANE_HUES,
  UNKNOWN_MODEL_COLOR,
} from "@/plugins/atomic-topology";
import type { TopologySceneNode, TopologySceneSnapshot } from "@/shared/topology/domain/types";
import type { TopologyLane } from "@/shared/topology/domain/lane";

/** A snapshot with the hub + one busy provider (exercises a ring + a link). */
function makeSnapshot(): TopologySceneSnapshot {
  return {
    schemaVersion: 1,
    capturedAt: 1700000000000,
    links: [
      {
        id: "route:openai",
        source: "hub",
        target: "provider:openai",
        kind: "route",
        health: "healthy",
        traffic: "active",
      },
    ],
    nodes: [
      { id: "hub", kind: "hub", label: "Router", health: "healthy", traffic: "idle" },
      {
        id: "provider:openai",
        kind: "provider",
        label: "OpenAI",
        providerId: "openai",
        health: "healthy",
        traffic: "active",
        activeRequests: { value: 5, source: "derived", sampledAt: 1700000000000 },
      },
    ],
  };
}

test("resolveAtomDescriptors: hub at origin, provider on a ring, exact encodings", () => {
  const snapshot = makeSnapshot();
  const descriptors = resolveAtomDescriptors(snapshot);

  assert.equal(descriptors.length, 2, "one descriptor per node");

  const hub = descriptors.find((d) => d.id === "hub");
  assert.ok(hub, "hub descriptor present");
  assert.deepEqual(hub!.position, { x: 0, y: 0, z: 0 }, "hub is the nucleus at the origin");
  assert.equal(hub!.ringIndex, -1, "hub is not on a ring");
  assert.equal(hub!.color, UNKNOWN_MODEL_COLOR, "hub has the neutral unknown color");
  assert.equal(hub!.lane, "unknown", "M1 has no per-node lane");
  assert.equal(hub!.laneHue, LANE_HUES.unknown, "hub lane hue = unknown hue");
  assert.equal(hub!.visualState.state, "healthy");
  assert.deepEqual(hub!.spin, { value: 0.1, mode: "unavailable" });
  assert.deepEqual(hub!.vibration, { amplitude: 0, frequencyHz: 0, mode: "unavailable" });
  assert.equal(hub!.activeRequests, null, "absent activeRequests -> null (never 0)");

  const provider = descriptors.find((d) => d.id === "provider:openai");
  assert.ok(provider, "provider descriptor present");
  assert.equal(provider!.providerId, "openai");
  assert.equal(provider!.ringIndex, 0, "first provider sits on the inner ring (index 0)");
  assert.equal(provider!.color, modelColor("openai"));
  assert.equal(provider!.color, modelColor("OPENAI"), "modelColor is case-insensitive");
  assert.ok(Number.isFinite(provider!.position.x), "x finite");
  assert.ok(Number.isFinite(provider!.position.y), "y finite");
  assert.ok(Number.isFinite(provider!.position.z), "z finite");
  assert.ok(
    provider!.position.x !== 0 || provider!.position.y !== 0,
    "provider is placed off the origin"
  );
  assert.equal(provider!.spin.mode, "measured");
  assert.equal(provider!.activeRequests, 5);
  // healthy health + active traffic -> "active" (the animated energy-flow state).
  assert.equal(provider!.visualState.state, "active");
  assert.deepEqual(provider!.visualState.style, { width: 2.5, opacity: 1, animated: true });
});

test("resolveAtomDescriptors: deterministic — same snapshot -> same descriptors", () => {
  const a = resolveAtomDescriptors(makeSnapshot());
  const b = resolveAtomDescriptors(makeSnapshot());
  assert.deepEqual(a, b, "pure: identical input -> identical output (no clock/random)");
});

test("resolveAtomDescriptors: radiusScale option scales positions deterministically", () => {
  const base = resolveAtomDescriptors(makeSnapshot());
  const scaled = resolveAtomDescriptors(makeSnapshot(), { radiusScale: 2 });
  const baseProvider = base.find((d) => d.id === "provider:openai")!;
  const scaledProvider = scaled.find((d) => d.id === "provider:openai")!;
  assert.ok(
    Math.abs(scaledProvider.position.x - baseProvider.position.x * 2) < 1e-9,
    "x scales x2"
  );
  assert.ok(
    Math.abs(scaledProvider.position.y - baseProvider.position.y * 2) < 1e-9,
    "y scales x2"
  );
  assert.ok(
    Math.abs(scaledProvider.position.z - baseProvider.position.z * 2) < 1e-9,
    "z scales x2"
  );
});

test("resolveLinkDescriptors: canonical ids, lane hue, and resolved visual state", () => {
  const snapshot = makeSnapshot();
  const links = resolveLinkDescriptors(snapshot);
  assert.equal(links.length, 1, "one descriptor per link");
  const link = links[0];
  assert.equal(link.id, "route:openai");
  assert.equal(link.source, "hub");
  assert.equal(link.target, "provider:openai");
  assert.equal(link.lane, "unknown", "M1 links have no lane");
  assert.equal(link.laneHue, LANE_HUES.unknown);
  // healthy health + active traffic -> "active" (animated energy flow).
  assert.equal(link.visualState.state, "active");
  assert.deepEqual(link.visualState.style, { width: 2.5, opacity: 1, animated: true });
});

test("mountAtomicTopologyRenderer: throws AtomicWebGLUnsupportedError without WebGL2 (node)", () => {
  const container = { tagName: "DIV" } as unknown as HTMLElement;
  assert.throws(
    () => mountAtomicTopologyRenderer(container, makeSnapshot(), {}),
    (err: unknown) => {
      assert.ok(err instanceof AtomicWebGLUnsupportedError, "typed error");
      assert.equal((err as AtomicWebGLUnsupportedError).code, "ATOMIC_WEBGL_UNSUPPORTED");
      return true;
    }
  );
});

test("plugin: supported() is false and mount() throws the Phase B typed error in node", () => {
  const plugin = buildAtomicTopologyPlugin();
  assert.equal(plugin.id, "atomic");
  assert.equal(plugin.supported(), false, "no WebGL2 in node -> host falls back");

  const container = { tagName: "DIV" } as unknown as HTMLElement;
  assert.throws(
    () => plugin.mount(container, makeSnapshot(), {}),
    (err: unknown) => {
      assert.ok(err instanceof AtomicWebGLUnsupportedError, "Phase B typed error");
      assert.equal((err as AtomicWebGLUnsupportedError).code, "ATOMIC_WEBGL_UNSUPPORTED");
      return true;
    }
  );
});

test(
  "createAtomicTopologyInstance: guarded DOM smoke (idempotent lifecycle)",
  { skip: typeof document === "undefined" ? "no DOM in this environment" : false },
  () => {
    const container = document.createElement("div");
    (container as unknown as { clientWidth: number }).clientWidth = 800;
    (container as unknown as { clientHeight: number }).clientHeight = 600;
    document.body.appendChild(container);

    const instance = createAtomicTopologyInstance(container, makeSnapshot(), {
      emptyStateLabel: "nothing to show",
    });

    const host = container.querySelector(".atomic-topology-host");
    assert.ok(host, "a scene host element was mounted into the container");

    assert.doesNotThrow(() => instance.update(makeSnapshot()));
    assert.doesNotThrow(() => instance.resize(1024, 768));
    assert.doesNotThrow(() => instance.setPaused(true));
    assert.doesNotThrow(() => instance.focusNode("provider:openai"));
    assert.doesNotThrow(() => instance.focusNode("provider:openai"));
    assert.doesNotThrow(() => instance.setPaused(false));

    instance.dispose();
    assert.equal(container.querySelector(".atomic-topology-host"), null, "host removed on dispose");
    assert.doesNotThrow(() => instance.dispose());
    assert.doesNotThrow(() => instance.update(makeSnapshot()));

    document.body.removeChild(container);
  }
);

// ──────────────────────────────────────────────────────────────────────────────
// M4-closure: lane → descriptor bridge. The domain now carries a real
// `node.lane?: Observed<TopologyLane>`; the adapter must surface it on the
// provider descriptor (not hard-code "unknown" for providers), while the hub
// stays lane-less.
// ──────────────────────────────────────────────────────────────────────────────
function snapshotWithLane(laneValue: string | undefined): TopologySceneSnapshot {
  const node: TopologySceneNode = {
    id: "provider:openai",
    kind: "provider",
    label: "OpenAI",
    providerId: "openai",
    health: "healthy",
    traffic: "active",
    activeRequests: { value: 5, source: "derived", sampledAt: 1700000000000 },
  };
  if (laneValue !== undefined) {
    node.lane = {
      value: laneValue as TopologyLane,
      source: "live-event",
      sampledAt: 1700000000000,
    };
  }
  return {
    schemaVersion: 1,
    capturedAt: 1700000000000,
    links: [
      {
        id: "route:openai",
        source: "hub",
        target: "provider:openai",
        kind: "route",
        health: "healthy",
        traffic: "active",
      },
    ],
    nodes: [{ id: "hub", kind: "hub", label: "Router", health: "healthy", traffic: "idle" }, node],
  };
}

test("resolveAtomDescriptors: provider lane observation flows to the descriptor (lane + laneHue)", () => {
  const descriptors = resolveAtomDescriptors(snapshotWithLane("audio"));
  const provider = descriptors.find((d) => d.kind === "provider")!;
  const hub = descriptors.find((d) => d.kind === "hub")!;

  assert.equal(provider.lane, "audio", "provider lane should be the observed lane, not unknown");
  assert.equal(provider.laneHue, LANE_HUES.audio, "provider laneHue should match the audio hue");

  // The hub remains lane-less — it is not a provider.
  assert.equal(hub.lane, "unknown");
  assert.equal(hub.laneHue, LANE_HUES.unknown);
});

test("resolveAtomDescriptors: provider with NO lane observation falls back to unknown (no fabrication)", () => {
  const descriptors = resolveAtomDescriptors(snapshotWithLane(undefined));
  const provider = descriptors.find((d) => d.kind === "provider")!;
  assert.equal(
    provider.lane,
    "unknown",
    "absent lane observation ⇒ neutral unknown (a coloring default)"
  );
  assert.equal(provider.laneHue, LANE_HUES.unknown);
});

test("resolveAtomDescriptors: mixed-lane provider (observed `unknown`) renders the unknown hue", () => {
  const descriptors = resolveAtomDescriptors(snapshotWithLane("unknown"));
  const provider = descriptors.find((d) => d.kind === "provider")!;
  assert.equal(provider.lane, "unknown");
  assert.equal(provider.laneHue, LANE_HUES.unknown);
});
