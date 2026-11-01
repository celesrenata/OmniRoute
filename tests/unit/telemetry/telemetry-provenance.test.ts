/**
 * Provenance + schema-validation tests (T005 / M2).
 *
 * AC3/AC4: every observed field carries source+sampledAt; invalid telemetry
 * (NaN / Infinity / negative / missing provenance / credential-shaped basis /
 * grafana-proxy violations) is rejected by Zod and dropped. 0 is distinct
 * from missing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FUTURE_TOLERANCE_MS_DEFAULT,
  GRAFANA_PROXY_BASIS_PREFIX,
  isFutureSampled,
  isValidResource,
  MAX_SNAPSHOT_RESOURCES,
  MAX_QUERY_WINDOW_MS,
  MIN_QUERY_WINDOW_MS,
  parseProviderSnapshot,
  parseQuery,
} from "../../../src/shared/topology/telemetry/provenance";
import {
  fixtureSnapshot,
  gpuResource,
  observedValue,
  providerResource,
  runtimeResource,
} from "./telemetry-fixtures";
import type {
  FleetResourceObservation,
  FleetTelemetrySnapshot,
} from "../../../src/shared/topology/telemetry/types";

describe("provenance: observed field contract", () => {
  it("accepts a valid field with source + sampledAt", () => {
    const o = observedValue(7, { source: "omniroute-live", sampledAt: 1_700_000_000_000 });
    assert.equal(o.value, 7);
    assert.equal(o.source, "omniroute-live");
    assert.equal(o.sampledAt, 1_700_000_000_000);
  });

  it("accepts a value of 0 (a real measurement) — 0 is distinct from missing", () => {
    const withZero = providerResource("p", { queuedJobs: observedValue(0) });
    const without = providerResource("p");
    assert.equal(withZero.queuedJobs?.value, 0);
    assert.equal(without.queuedJobs, undefined);
    assert.ok(isValidResource(withZero));
    assert.ok(isValidResource(without));
  });
});

type FieldSetter = (field: keyof FleetResourceObservation) => unknown;

const INVALID_FIELD_CASES: Array<[string, FieldSetter]> = [
  [
    "NaN value",
    () => {
      const o = observedValue(5);
      o.value = Number.NaN;
      return o;
    },
  ],
  [
    "Infinity value",
    () => {
      const o = observedValue(5);
      o.value = Number.POSITIVE_INFINITY;
      return o;
    },
  ],
  [
    "-Infinity value",
    () => {
      const o = observedValue(5);
      o.value = Number.NEGATIVE_INFINITY;
      return o;
    },
  ],
  [
    "missing sampledAt",
    () => {
      const o = observedValue(5) as unknown as Record<string, unknown>;
      delete o.sampledAt;
      return o;
    },
  ],
  ["negative windowMs", () => observedValue(5, { windowMs: -5 })],
  ["zero windowMs", () => observedValue(5, { windowMs: 0 })],
  ["grafana source without datasource basis", () => observedValue(5, { source: "grafana" })],
  ["basis with credential token", () => observedValue(5, { basis: "api_key=abc" })],
  ["basis with whitespace", () => observedValue(5, { basis: "a b c" })],
];

describe("provenance: Zod rejection of invalid observed fields", () => {
  for (const [label, make] of INVALID_FIELD_CASES) {
    it(`rejects ${label}`, () => {
      const r: Record<string, unknown> = {
        ...providerResource("p"),
        queuedJobs: make("queuedJobs"),
      };
      assert.ok(!isValidResource(r), `expected "${label}" to be rejected`);
    });
  }
});

describe("provenance: grafana-proxy rule", () => {
  it("accepts source:grafana with basis starting with datasource=", () => {
    const good = gpuResource("h1", "gpu-uuid", {
      utilizationPercent: observedValue(42, {
        source: "grafana",
        basis: "datasource=prometheus:gpu-node-1",
      }),
    });
    assert.ok(isValidResource(good));
    assert.equal(good.utilizationPercent?.basis, "datasource=prometheus:gpu-node-1");
  });

  it("exposes the prefix constant for builders", () => {
    assert.equal(GRAFANA_PROXY_BASIS_PREFIX, "datasource=");
  });
});

describe("provenance: resource schema strictness", () => {
  it("rejects unknown keys on a resource", () => {
    const bad: Record<string, unknown> = {
      ...providerResource("p"),
      unknownField: observedValue(1),
    };
    assert.ok(!isValidResource(bad));
  });

  it("rejects gpu resources without deviceUuid (PCI-index-only is not an identity)", () => {
    const bad: Record<string, unknown> = {
      resourceId: "gpu:h1:PCI-0",
      kind: "gpu",
      hostId: "h1",
    };
    assert.ok(!isValidResource(bad));
  });

  it("rejects utilizationPercent outside [0,100]", () => {
    assert.ok(!isValidResource(providerResource("p", { utilizationPercent: observedValue(120) })));
    assert.ok(!isValidResource(providerResource("p", { utilizationPercent: observedValue(-1) })));
    const at100 = providerResource("p", { utilizationPercent: observedValue(100) });
    assert.ok(isValidResource(at100));
  });

  it("rejects negative queuedJobs / activeJobs", () => {
    assert.ok(!isValidResource(providerResource("p", { queuedJobs: observedValue(-1) })));
    assert.ok(!isValidResource(providerResource("p", { activeJobs: observedValue(-1) })));
  });

  it("rejects negative outputTokensPerSecond", () => {
    assert.ok(
      !isValidResource(
        providerResource("p", {
          outputTokensPerSecond: observedValue(-1, { windowMs: 60_000, basis: "test" }),
        })
      )
    );
  });

  it("accepts runtime resources with hostId + runtimeId", () => {
    assert.ok(isValidResource(runtimeResource("h1", "rt-1")));
  });

  it("accepts a provider resource with a modelId", () => {
    assert.ok(isValidResource(providerResource("p", { modelId: "claude-1" })));
  });
});

describe("provenance: snapshot schema", () => {
  it("accepts a valid snapshot (parseProviderSnapshot ok)", () => {
    const snap = fixtureSnapshot([providerResource("p"), gpuResource("h1", "u")]);
    assert.equal(parseProviderSnapshot(snap).ok, true);
  });

  it("drops a snapshot whose resource fails validation", () => {
    const bad = {
      schemaVersion: 1,
      capturedAt: 1_700_000_000_000,
      resources: [{ resourceId: 123, kind: "gpu" }],
    } as unknown as FleetTelemetrySnapshot;
    assert.equal(parseProviderSnapshot(bad).ok, false);
  });

  it("drops a snapshot with the wrong schemaVersion", () => {
    const bad: Record<string, unknown> = { schemaVersion: 2, capturedAt: 1, resources: [] };
    assert.equal(parseProviderSnapshot(bad).ok, false);
  });
});

describe("provenance: query schema", () => {
  it("windowMs must be within [MIN, MAX]", () => {
    assert.equal(parseQuery({ windowMs: 0 }), null);
    assert.equal(parseQuery({ windowMs: Number.POSITIVE_INFINITY }), null);
    assert.ok(parseQuery({ windowMs: MIN_QUERY_WINDOW_MS }) != null);
    assert.ok(parseQuery({ windowMs: MAX_QUERY_WINDOW_MS }) != null);
  });

  it("rejects unknown keys (strict)", () => {
    assert.equal(parseQuery({ windowMs: 1000, bogus: true }), null);
  });

  it("accepts host/gpu filters", () => {
    const q = parseQuery({ windowMs: 1000, hostIds: ["h1"], gpuIds: ["gpu:h1:u"] });
    assert.ok(q);
    assert.deepEqual(q.hostIds, ["h1"]);
    assert.deepEqual(q.gpuIds, ["gpu:h1:u"]);
  });

  it("rejects NaN windowMs", () => {
    assert.equal(parseQuery({ windowMs: Number.NaN }), null);
  });
});

void MAX_SNAPSHOT_RESOURCES;

describe("provenance: bounded clock-skew tolerance (OR-ATOM-005 T5.6c)", () => {
  it("is strict by default (toleranceMs = 0)", () => {
    assert.equal(isFutureSampled(1000, 1000), false);
    assert.equal(isFutureSampled(1001, 1000), true);
    assert.equal(isFutureSampled(1001, 1000, 0), true);
  });

  it("tolerates small positive skew within toleranceMs", () => {
    // Within the tolerance (and exactly at the boundary) is not future.
    assert.equal(isFutureSampled(1500, 1000, 5000), false);
    assert.equal(isFutureSampled(6000, 1000, 5000), false);
    // Beyond the tolerance is future.
    assert.equal(isFutureSampled(6001, 1000, 5000), true);
    // A past sample is never "future", regardless of tolerance.
    assert.equal(isFutureSampled(999, 1000, 5000), false);
  });

  it("exports a documented default tolerance constant", () => {
    assert.equal(FUTURE_TOLERANCE_MS_DEFAULT, 5000);
  });
});
