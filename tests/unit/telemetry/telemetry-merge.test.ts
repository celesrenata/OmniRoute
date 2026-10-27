/**
 * Merge tests (T005 / M2): join-by-canonical-id ONLY, no phantom devices,
 * latest-sampledAt-wins, stale decay-to-neutral, bounded result sizes,
 * out-of-order (future-sample) rejection.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  filterResourcesByQuery,
  isStale,
  mergeSnapshots,
  neutralizeStale,
} from "../../../src/shared/topology/telemetry/mergeSnapshots";
import { FUTURE_TOLERANCE_MS_DEFAULT } from "../../../src/shared/topology/telemetry/provenance";
import {
  fixtureSnapshot,
  gpuResource,
  observedValue,
  providerResource,
  resetFixtureClock,
  runtimeResource,
} from "./telemetry-fixtures";
import type { FleetResourceObservation } from "../../../src/shared/topology/telemetry/types";

const NOW = 1_700_000_000_000;

function byId(resources: FleetResourceObservation[]): Map<string, FleetResourceObservation> {
  return new Map(resources.map((r) => [r.resourceId, r]));
}

describe("merge: join by canonical ID only", () => {
  it("merges device + runtime + omniroute facts onto their rows by id", () => {
    const device = fixtureSnapshot(
      [
        gpuResource("h1", "gpu-uuid", {
          utilizationPercent: observedValue(72, {
            sampledAt: NOW - 1000,
            windowMs: 5000,
            source: "prometheus",
          }),
          vramUsedBytes: observedValue(20_000_000_000, {
            sampledAt: NOW - 1000,
            windowMs: 5000,
            source: "prometheus",
          }),
        }),
      ],
      NOW
    );
    const runtime = fixtureSnapshot(
      [
        runtimeResource("h1", "rt-1", {
          activeJobs: observedValue(2, { sampledAt: NOW - 500, source: "runtime" }),
        }),
      ],
      NOW
    );
    const omniroute = fixtureSnapshot(
      [providerResource("p", { activeJobs: observedValue(3, { sampledAt: NOW }) })],
      NOW
    );

    const { snapshot } = mergeSnapshots([device, runtime, omniroute], NOW);
    const map = byId(snapshot.resources);

    // Three distinct resources — no row is merged across unproven ids.
    assert.equal(snapshot.resources.length, 3);
    assert.ok(map.has("gpu:h1:gpu-uuid"));
    assert.ok(map.has("runtime:h1:rt-1"));
    assert.ok(map.has("provider:p"));
    // Device metrics never leak onto the runtime row and vice versa.
    assert.equal(map.get("runtime:h1:rt-1")?.utilizationPercent, undefined);
    assert.equal(map.get("gpu:h1:gpu-uuid")?.activeJobs, undefined);
  });

  it("merges two providers of the SAME kind on the same canonical id (latest wins)", () => {
    const a = fixtureSnapshot(
      [
        providerResource("p", {
          queuedJobs: observedValue(1, { sampledAt: NOW - 5000 }),
          activeJobs: observedValue(2, { sampledAt: NOW - 5000 }),
        }),
      ],
      NOW
    );
    const b = fixtureSnapshot(
      [
        providerResource("p", {
          queuedJobs: observedValue(5, { sampledAt: NOW - 1000 }),
          // activeJobs intentionally absent in b — must keep a's value.
        }),
      ],
      NOW
    );
    const { snapshot } = mergeSnapshots([a, b], NOW);
    const p = byId(snapshot.resources).get("provider:p")!;
    assert.equal(snapshot.resources.length, 1);
    assert.equal(p.queuedJobs?.value, 5); // later sample wins
    assert.equal(p.activeJobs?.value, 2); // missing does not clobber
  });

  it("same canonical id with different kind → conflict, rows dropped (no phantom device)", () => {
    const asGpu = fixtureSnapshot(
      [gpuResource("h1", "x", { activeJobs: observedValue(1, { sampledAt: NOW }) })],
      NOW
    );
    const asRuntime = fixtureSnapshot(
      // resourceId collision: runtime:h1:x vs gpu:h1:x do NOT collide, so
      // force the collision by reusing the exact same resourceId string.
      [
        {
          ...runtimeResource("h1", "x"),
          resourceId: "gpu:h1:x",
          activeJobs: observedValue(9, { sampledAt: NOW }),
        },
      ],
      NOW
    );
    const { snapshot, droppedConflicts } = mergeSnapshots([asGpu, asRuntime], NOW);
    assert.equal(droppedConflicts, 1);
    assert.equal(snapshot.resources.length, 0);
  });
});

describe("merge: identity facts fill gaps without overwriting", () => {
  it("keeps the first-seen hostId/deviceUuid/modelId", () => {
    const a = fixtureSnapshot(
      [
        providerResource("p", {
          modelId: "m-1",
          activeJobs: observedValue(1, { sampledAt: NOW - 10 }),
        }),
      ],
      NOW
    );
    const b = fixtureSnapshot(
      [providerResource("p", { modelId: "m-2", activeJobs: observedValue(2, { sampledAt: NOW }) })],
      NOW
    );
    const { snapshot } = mergeSnapshots([a, b], NOW);
    assert.equal(snapshot.resources[0].modelId, "m-1");
    assert.equal(snapshot.resources[0].activeJobs?.value, 2);
  });
});

describe("merge: stale marking + decay-to-neutral", () => {
  it("marks a field stale when age > 3 * windowMs", () => {
    const old = observedValue(42, { sampledAt: NOW - 20_000, windowMs: 5_000 });
    const fresh = observedValue(42, { sampledAt: NOW - 4_000, windowMs: 5_000 });
    assert.equal(isStale(old, NOW), true); // 20s > 3 * 5s
    assert.equal(isStale(fresh, NOW), false); // 4s < 15s
    assert.equal(isStale(observedValue(42, { sampledAt: NOW - 20_000 }), NOW), false); // no window → never stale
  });

  it("merge marks stale fields; neutralizeStale decays value to null keeping provenance", () => {
    const snap = fixtureSnapshot(
      [
        gpuResource("h1", "u", {
          utilizationPercent: observedValue(90, {
            sampledAt: NOW - 30_000,
            windowMs: 5_000,
            source: "prometheus",
            basis: "exporter:dcgm",
          }),
          vramUsedBytes: observedValue(1, { sampledAt: NOW, windowMs: 5_000 }),
        }),
      ],
      NOW
    );
    const { snapshot } = mergeSnapshots([snap], NOW);
    const gpu = byId(snapshot.resources).get("gpu:h1:u")!;
    assert.equal(gpu.utilizationPercent?.stale, true);
    assert.equal(gpu.utilizationPercent?.value, 90); // still carries the value
    assert.equal(gpu.vramUsedBytes?.stale, undefined);

    const neutral = neutralizeStale(snapshot);
    const gpu2 = byId(neutral.resources).get("gpu:h1:u")!;
    assert.equal(gpu2.utilizationPercent?.value, null); // decayed to neutral
    assert.equal(gpu2.utilizationPercent?.stale, true);
    assert.equal(gpu2.utilizationPercent?.source, "prometheus"); // provenance kept
    assert.equal(gpu2.utilizationPercent?.basis, "exporter:dcgm");
    assert.equal(gpu2.vramUsedBytes?.value, 1); // fresh field untouched
    // original snapshot not mutated
    assert.equal(gpu.utilizationPercent?.value, 90);
  });

  it("stale factor is configurable", () => {
    const snap = fixtureSnapshot(
      [
        gpuResource("h1", "u", {
          utilizationPercent: observedValue(90, { sampledAt: NOW - 8_000, windowMs: 5_000 }),
        }),
      ],
      NOW
    );
    const defaultFactor = mergeSnapshots([snap], NOW);
    assert.notEqual(defaultFactor.snapshot.resources[0].utilizationPercent?.stale, true); // 8s < 15s -> not stale
    const strict = mergeSnapshots([snap], NOW, { staleFactor: 1 });
    assert.equal(strict.snapshot.resources[0].utilizationPercent?.stale, true); // 8s > 1 * 5s
  });
});

describe("merge: out-of-order rejection (future samples)", () => {
  it("drops the whole snapshot when any field was sampled after capturedAt", () => {
    const good = fixtureSnapshot(
      [providerResource("p", { activeJobs: observedValue(1, { sampledAt: NOW - 1 }) })],
      NOW - 10
    );
    const future = fixtureSnapshot(
      [providerResource("q", { activeJobs: observedValue(1, { sampledAt: NOW + 500 }) })],
      NOW - 10
    );
    const { snapshot, droppedFuture } = mergeSnapshots([good, future], NOW);
    assert.equal(droppedFuture, 1);
    assert.equal(snapshot.resources.length, 1);
    assert.ok(byId(snapshot.resources).has("provider:p"));
    assert.ok(!byId(snapshot.resources).has("provider:q"));
  });
});

describe("merge: bounded clock-skew tolerance (OR-ATOM-005 T5.6c)", () => {
  it("merges a sample 20ms ahead of capturedAt with the default tolerance (real wire ts kept)", () => {
    const skewed = fixtureSnapshot(
      [
        providerResource("prom", {
          activeJobs: observedValue(3, { sampledAt: NOW + 20, source: "prometheus" }),
        }),
      ],
      NOW
    );
    const { snapshot, droppedFuture } = mergeSnapshots([skewed], NOW, {
      futureToleranceMs: FUTURE_TOLERANCE_MS_DEFAULT,
    });
    assert.equal(droppedFuture, 0);
    const row = byId(snapshot.resources).get("provider:prom");
    assert.ok(row, "the skewed snapshot must be merged");
    // The real wire timestamp is KEPT — never re-stamped with capturedAt.
    assert.equal(row.activeJobs?.sampledAt, NOW + 20);
    assert.equal(row.activeJobs?.value, 3);
    // The merged snapshot keeps the gateway now as capturedAt.
    assert.equal(snapshot.capturedAt, NOW);
  });

  it("still drops a sample 6000ms ahead of capturedAt even with the 5s default tolerance", () => {
    const farFuture = fixtureSnapshot(
      [
        providerResource("prom", {
          activeJobs: observedValue(3, { sampledAt: NOW + 6000, source: "prometheus" }),
        }),
      ],
      NOW
    );
    const { snapshot, droppedFuture } = mergeSnapshots([farFuture], NOW, {
      futureToleranceMs: FUTURE_TOLERANCE_MS_DEFAULT,
    });
    assert.equal(droppedFuture, 1);
    assert.equal(snapshot.resources.length, 0);
  });

  it("stays strict when no tolerance option is passed (backward compatible)", () => {
    const skewed = fixtureSnapshot(
      [
        providerResource("prom", {
          activeJobs: observedValue(3, { sampledAt: NOW + 20, source: "prometheus" }),
        }),
      ],
      NOW
    );
    assert.equal(mergeSnapshots([skewed], NOW).droppedFuture, 1);
  });
});

describe("merge: invalid resources are dropped, valid ones kept", () => {
  it("counts droppedInvalid and keeps the valid rows", () => {
    const snap = fixtureSnapshot(
      [
        providerResource("ok"),
        { resourceId: "gpu:h1:", kind: "gpu", hostId: "h1" } as unknown as FleetResourceObservation,
        providerResource("also-ok", { utilizationPercent: observedValue(150) }),
      ],
      NOW
    );
    const { snapshot, droppedInvalid } = mergeSnapshots([snap], NOW);
    assert.equal(droppedInvalid, 2);
    assert.equal(snapshot.resources.length, 1);
    assert.equal(snapshot.resources[0].resourceId, "provider:ok");
  });
});

describe("merge: bounded result sizes", () => {
  it("caps resources at maxResources and reports truncation (deterministic sort order)", () => {
    resetFixtureClock(NOW);
    const rows = Array.from({ length: 10 }, (_, i) =>
      providerResource(`p${String(i).padStart(2, "0")}`)
    );
    const { snapshot, truncated } = mergeSnapshots([fixtureSnapshot(rows, NOW)], NOW, {
      maxResources: 3,
    });
    assert.equal(truncated, true);
    assert.equal(snapshot.resources.length, 3);
    // Sorted by resourceId → p00, p01, p02 survive.
    assert.deepEqual(
      snapshot.resources.map((r) => r.resourceId),
      ["provider:p00", "provider:p01", "provider:p02"]
    );
  });
});

describe("filterResourcesByQuery", () => {
  const rows = [
    providerResource("p"),
    gpuResource("h1", "u"),
    gpuResource("h2", "u"),
    runtimeResource("h1", "rt"),
  ];

  it("hostIds filter keeps only matching hostId rows", () => {
    const out = filterResourcesByQuery(rows, { hostIds: ["h1"] });
    assert.deepEqual(
      out.map((r) => r.resourceId),
      ["gpu:h1:u", "runtime:h1:rt"]
    );
  });

  it("gpuIds filter keeps only matching gpu rows (canonical id match)", () => {
    const out = filterResourcesByQuery(rows, { gpuIds: ["gpu:h2:u"] });
    assert.deepEqual(
      out.map((r) => r.resourceId),
      ["gpu:h2:u"]
    );
  });

  it("no filters → all rows", () => {
    assert.equal(filterResourcesByQuery(rows, {}).length, rows.length);
  });
});
