/**
 * OR-ATOM-009 — provenance diagnostics atom-row mapping (S9.5).
 *
 * Pins `buildDiagnosticsAtoms()`: the pure mapping from
 * `ReconciliationSignals` (built by `buildAtomSignals` / `mergeDemoSignals`)
 * to the per-atom provenance rows the dev diagnostics panel renders. The
 * mapping is the *only* place that turns a motion signal into a display row,
 * so it must never invent a value:
 *
 *   - `value` is the measured TPS itself (`null` stays `null` — never `0`);
 *   - `source` passes through verbatim (live / demo / stale / unavailable);
 *   - `ageSec` is derived from `sampledAt` and `nowMs` (both epoch-ms),
 *     clamped at 0 (a future `sampledAt` — clock skew — must not render a
 *     negative age); `null` when `sampledAt` is absent;
 *   - `basis` passes through ("" when absent — the panel prints nothing);
 *   - rows follow the signal map's insertion order (the reconciliation's).
 *
 * No React, no DOM, no `three` — pure TS, run under the Node native runner.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDiagnosticsAtoms,
  type AtomicDiagnosticsAtom,
} from "@/plugins/atomic-topology/overlays/AtomicTelemetryDiagnostics";
import {
  buildAtomSignals,
  mergeDemoSignals,
  type ReconciliationSignals,
} from "@/shared/topology/telemetry/atomSignals";
import type { ReconciliationResult } from "@/shared/topology/telemetry/reconcile";

/** Build a minimal reconciliation fixture with one proven GPU + runtime pair. */
function fixtureReconciliation(nowMs: number): ReconciliationResult {
  return {
    schemaVersion: 1,
    capturedAt: nowMs,
    gpuNodes: [
      {
        resourceId: "gpu:host-1:uuid-a",
        hostId: "host-1",
        deviceUuid: "uuid-a",
        outputTokensPerSecond: {
          value: 80,
          source: "omniroute-live",
          sampledAt: nowMs - 1000,
          stale: false,
        },
        stale: false,
      },
    ],
    runtimeNodes: [
      {
        resourceId: "runtime:host-1:rt-a",
        hostId: "host-1",
        runtimeId: "rt-a",
        modelId: "demo/model-a",
        attributedGpuIds: ["gpu:host-1:uuid-a"],
        outputTokensPerSecond: {
          value: 80,
          source: "omniroute-live",
          sampledAt: nowMs - 1000,
          stale: false,
        },
        queuedJobs: {
          value: 3,
          source: "omniroute-live",
          sampledAt: nowMs - 1000,
          stale: false,
        },
        stale: false,
      },
    ],
    providerNodes: [
      {
        resourceId: "provider:openai",
        providerId: "openai",
        outputTokensPerSecond: {
          value: 80,
          source: "omniroute-live",
          sampledAt: nowMs - 1000,
          stale: false,
        },
        stale: false,
      },
    ],
    edges: [
      {
        source: "provider:openai",
        target: "runtime:host-1:rt-a",
        relation: "provider_runtime",
        basis: "live: request attribution",
        sampledAt: nowMs - 1000,
      },
      {
        source: "runtime:host-1:rt-a",
        target: "gpu:host-1:uuid-a",
        relation: "runtime_device",
        basis: "live: attributedGpuIds",
        sampledAt: nowMs - 1000,
      },
    ],
    providerCentricFallback: false,
  };
}

/** Build signals directly (no reconciliation) to pin the mapping contract. */
function fixtureSignals(overrides?: Partial<ReconciliationSignals>): ReconciliationSignals {
  const base: ReconciliationSignals = {
    perAtom: new Map([
      [
        "gpu:host-1:uuid-a",
        {
          resourceId: "gpu:host-1:uuid-a",
          kind: "gpu",
          tokensPerSecond: 80,
          queuedJobs: null,
          activeJobs: null,
          modelIds: [],
          gpuHasProvenThroughput: true,
          source: "live",
          sampledAt: 1_000_000,
          basis: "live: per-device measurement",
        },
      ],
      [
        "runtime:host-1:rt-a",
        {
          resourceId: "runtime:host-1:rt-a",
          kind: "runtime",
          tokensPerSecond: null,
          queuedJobs: 3,
          activeJobs: 1,
          modelIds: ["demo/model-a"],
          gpuHasProvenThroughput: false,
          source: "stale",
          sampledAt: null,
        },
      ],
    ]),
    edges: [],
    providerCentricFallback: false,
    capturedAt: 1_000_000,
  };
  return { ...base, ...overrides };
}

test("buildDiagnosticsAtoms: maps TPS verbatim — null stays null (never fabricated 0)", () => {
  const rows = buildDiagnosticsAtoms(fixtureSignals());
  assert.equal(rows.length, 2);

  const gpu = rows.find((r) => r.resourceId === "gpu:host-1:uuid-a");
  const runtime = rows.find((r) => r.resourceId === "runtime:host-1:rt-a");
  assert.ok(gpu && runtime);

  assert.equal(gpu.value, 80);
  assert.equal(runtime.value, null);
  assert.notEqual(runtime.value, 0);
});

test("buildDiagnosticsAtoms: source passes through verbatim (live/stale)", () => {
  const rows = buildDiagnosticsAtoms(fixtureSignals());
  const byId = new Map(rows.map((r) => [r.resourceId, r]));

  assert.equal(byId.get("gpu:host-1:uuid-a")?.source, "live");
  assert.equal(byId.get("runtime:host-1:rt-a")?.source, "stale");
});

test("buildDiagnosticsAtoms: ageSec = (nowMs - sampledAt)/1000, clamped at 0, null when absent", () => {
  const rows = buildDiagnosticsAtoms(fixtureSignals(), 1_000_500);
  const byId = new Map(rows.map((r) => [r.resourceId, r]));

  assert.equal(byId.get("gpu:host-1:uuid-a")?.ageSec, 0.5);
  assert.equal(byId.get("runtime:host-1:rt-a")?.ageSec, null);

  // A future sampledAt (clock skew) must not render a negative age.
  const clamped = buildDiagnosticsAtoms(fixtureSignals(), 999_000);
  const clampedById = new Map(clamped.map((r) => [r.resourceId, r]));
  assert.equal(clampedById.get("gpu:host-1:uuid-a")?.ageSec, 0);
});

test("buildDiagnosticsAtoms: basis passes through, '' when absent", () => {
  const rows = buildDiagnosticsAtoms(fixtureSignals());
  const byId = new Map(rows.map((r) => [r.resourceId, r]));

  assert.equal(byId.get("gpu:host-1:uuid-a")?.basis, "live: per-device measurement");
  assert.equal(byId.get("runtime:host-1:rt-a")?.basis, "");
});

test("buildDiagnosticsAtoms: null signals → no rows", () => {
  assert.deepEqual(buildDiagnosticsAtoms(null), []);
  assert.deepEqual(buildDiagnosticsAtoms(undefined), []);
});

test("buildDiagnosticsAtoms: empty perAtom → no rows", () => {
  const rows = buildDiagnosticsAtoms(fixtureSignals({ perAtom: new Map() }));
  assert.deepEqual(rows, []);
});

test("buildDiagnosticsAtoms: end-to-end — buildAtomSignals + mergeDemoSignals marks 'demo'", () => {
  const now = 2_000_000;
  const reconciliation = fixtureReconciliation(now);
  const live = buildAtomSignals(reconciliation);

  const liveRows = buildDiagnosticsAtoms(live, now);
  const gpuLive = liveRows.find((r) => r.resourceId === "gpu:host-1:uuid-a");
  assert.ok(gpuLive);
  assert.equal(gpuLive.value, 80);
  assert.equal(gpuLive.source, "live");
  assert.equal(gpuLive.ageSec, 1); // sampledAt = now - 1000 → 1 s old

  // In demo mode the host re-marks the (identical) live feed as "demo" — the
  // demo body IS what the wrapped fetch served, so nothing is fabricated.
  const demoRows = buildDiagnosticsAtoms(mergeDemoSignals(live, live), now);
  const gpuDemo = demoRows.find((r) => r.resourceId === "gpu:host-1:uuid-a");
  assert.ok(gpuDemo);
  assert.equal(gpuDemo.value, 80); // same measured value
  assert.equal(gpuDemo.source, "demo");
});

test("buildDiagnosticsAtoms: returns plain row objects (stable row contract)", () => {
  const rows = buildDiagnosticsAtoms(fixtureSignals());
  for (const row of rows) {
    const keys = Object.keys(row).sort();
    assert.deepEqual(keys, ["ageSec", "basis", "resourceId", "source", "value"]);
    const typed: AtomicDiagnosticsAtom = row;
    assert.equal(typeof typed.resourceId, "string");
  }
});
