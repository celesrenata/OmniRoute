/**
 * OR-ATOM-009 — proven route-link diagnostics row mapping (S9.5).
 *
 * Pins `buildDiagnosticsRouteLinks()`: the pure mapping from a
 * `TopologySceneSnapshot` to the per-route-link provenance rows the dev
 * diagnostics panel renders. The rows carry the snapshot's OWN provenance —
 * a link is proven when its target provider atom is present, and the basis
 * is `call-log route` (strengthened to `call-log route + fleet-metrics` when a
 * fleet-telemetry provider sample corroborates it; unproven otherwise).
 *
 * Honesty contract (OR-ATOM-009 / S9.5):
 *   - `proven` + `basis` pass through from `computeProvenRouteLinks` verbatim;
 *   - `ageSec` derives from the snapshot's `capturedAt` vs an injectable
 *     `nowMs` (both epoch-ms), clamped at 0 (a future `capturedAt` — clock
 *     skew — must not render a negative age); `null` when `capturedAt` is
 *     absent;
 *   - rows follow the snapshot's `links` order (no reordering, no invented
 *     links).
 *
 * No React, no DOM, no `three` — pure TS, run under the Node native runner.
 * This is the regression guard for the react-hooks/purity fix: the age is
 * computed HERE (testable, injectable clock), never in the render body.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDiagnosticsRouteLinks } from "@/plugins/atomic-topology/overlays/AtomicTelemetryDiagnostics";
import {
  PROVEN_BASIS_CALL_LOG,
  PROVEN_BASIS_FLEET,
  UNPROVEN_BASIS_NO_TARGET,
} from "@/plugins/atomic-topology/scene/provenPulse";
import type { TopologySceneSnapshot } from "@/shared/topology/domain/types";

const T = 1_700_000_000_000;

function routeSnapshot(extra?: Partial<TopologySceneSnapshot>): TopologySceneSnapshot {
  return {
    schemaVersion: 1,
    capturedAt: T,
    links: [
      {
        id: "route:openai",
        source: "hub",
        target: "provider:openai",
        kind: "route",
        health: "healthy",
        traffic: "active",
      },
      {
        id: "route:anthropic",
        source: "hub",
        target: "provider:anthropic",
        kind: "route",
        health: "healthy",
        traffic: "idle",
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
      },
      // NOTE: no `provider:anthropic` node → route:anthropic is unproven.
    ],
    ...extra,
  };
}

test("buildDiagnosticsRouteLinks: proven + basis pass through (call-log when no fleet sample)", () => {
  const rows = buildDiagnosticsRouteLinks(routeSnapshot(), T);
  const byId = new Map(rows.map((r) => [r.id, r]));

  assert.equal(rows.length, 2);
  // Provider atom present → proven, call-log basis.
  assert.equal(byId.get("route:openai")?.proven, true);
  assert.equal(byId.get("route:openai")?.basis, PROVEN_BASIS_CALL_LOG);
  // Target provider atom absent → unproven, never a guess.
  assert.equal(byId.get("route:anthropic")?.proven, false);
  assert.equal(byId.get("route:anthropic")?.basis, UNPROVEN_BASIS_NO_TARGET);
});

test("buildDiagnosticsRouteLinks: a fleet-telemetry provider sample strengthens the basis only", () => {
  const snapshot = routeSnapshot({
    fleetTelemetry: {
      schemaVersion: 1,
      capturedAt: T + 1000,
      gpuNodes: [],
      runtimeNodes: [],
      providerNodes: [
        {
          resourceId: "provider:openai",
          providerId: "openai",
          outputTokensPerSecond: { value: 12, source: "runtime", sampledAt: T },
          queuedJobs: { value: 0, source: "runtime", sampledAt: T },
          stale: false,
        },
      ],
      edges: [],
      providerCentricFallback: false,
    },
  });

  const rows = buildDiagnosticsRouteLinks(snapshot, T + 1000);
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Same proven status, but the corroborated link's basis is strengthened.
  assert.equal(byId.get("route:openai")?.proven, true);
  assert.equal(byId.get("route:openai")?.basis, PROVEN_BASIS_FLEET);
  // The uncorroborated unproven link is unaffected by the fleet sample.
  assert.equal(byId.get("route:anthropic")?.proven, false);
  assert.equal(byId.get("route:anthropic")?.basis, UNPROVEN_BASIS_NO_TARGET);
});

test("buildDiagnosticsRouteLinks: ageSec = (nowMs - capturedAt)/1000, clamped at 0", () => {
  // 500ms old snapshot → 0.5 s.
  const rows = buildDiagnosticsRouteLinks(routeSnapshot(), T + 500);
  assert.equal(rows[0].ageSec, 0.5);
  assert.equal(rows[1].ageSec, 0.5);

  // A future capturedAt (clock skew) must not render a negative age.
  const clamped = buildDiagnosticsRouteLinks(routeSnapshot(), T - 500);
  assert.equal(clamped[0].ageSec, 0);
  assert.equal(clamped[1].ageSec, 0);
});

test("buildDiagnosticsRouteLinks: ageSec is null when capturedAt is absent", () => {
  const snapshot = routeSnapshot({ capturedAt: Number.NaN });
  const rows = buildDiagnosticsRouteLinks(snapshot, T + 5000);
  for (const row of rows) assert.equal(row.ageSec, null);
});

test("buildDiagnosticsRouteLinks: rows follow the snapshot's links order, stable key contract", () => {
  const rows = buildDiagnosticsRouteLinks(routeSnapshot(), T);

  // Order preserved verbatim (no reordering, no invented links).
  assert.deepEqual(
    rows.map((r) => r.id),
    ["route:openai", "route:anthropic"]
  );

  // Exactly the four documented keys, in a stable shape.
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ["ageSec", "basis", "id", "proven"]);
  }
});

test("buildDiagnosticsRouteLinks: empty snapshot → no rows", () => {
  assert.deepEqual(buildDiagnosticsRouteLinks(routeSnapshot({ links: [], nodes: [] }), T), []);
});
