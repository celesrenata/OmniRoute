/**
 * Fleet telemetry — HTTP query mapping unit tests (T005 / M2, OR-ATOM-001 v2).
 *
 * `mapFleetTelemetryQuery` is the 400-vs-200 boundary for GET /api/telemetry/fleet.
 * Pure: no DB, no Next, no network.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  FLEET_TELEMETRY_DEFAULT_WINDOW_MS,
  mapFleetTelemetryQuery,
} from "../../../src/shared/topology/telemetry/httpQuery";
import {
  MAX_QUERY_WINDOW_MS,
  MIN_QUERY_WINDOW_MS,
} from "../../../src/shared/topology/telemetry/provenance";

function map(url: string) {
  return mapFleetTelemetryQuery(new URL(url, "http://localhost").searchParams);
}

test("defaults: empty query yields the default window, no id filters", () => {
  const out = map("/api/telemetry/fleet");
  assert.equal("error" in out, false);
  assert.deepEqual(out, {
    query: { windowMs: FLEET_TELEMETRY_DEFAULT_WINDOW_MS },
  });
  assert.equal(FLEET_TELEMETRY_DEFAULT_WINDOW_MS, 300_000);
});

test("windowMs is honored and bounded", () => {
  assert.deepEqual(map("/api/telemetry/fleet?windowMs=60000"), {
    query: { windowMs: 60_000 },
  });
  assert.deepEqual(map(`/api/telemetry/fleet?windowMs=${MIN_QUERY_WINDOW_MS}`), {
    query: { windowMs: MIN_QUERY_WINDOW_MS },
  });
  assert.deepEqual(map(`/api/telemetry/fleet?windowMs=${MAX_QUERY_WINDOW_MS}`), {
    query: { windowMs: MAX_QUERY_WINDOW_MS },
  });
  assert.match((map("/api/telemetry/fleet?windowMs=0") as { error: string }).error, /windowMs/);
  assert.match(
    (map(`/api/telemetry/fleet?windowMs=${MAX_QUERY_WINDOW_MS + 1}`) as { error: string }).error,
    /within/
  );
});

test("windowMs rejects non-numeric / negative / fractional / padded values", () => {
  for (const bad of ["abc", "-5", "1.5", " 100", "100 ", "1e3", "NaN", "Infinity"]) {
    const out = map(`/api/telemetry/fleet?windowMs=${encodeURIComponent(bad)}`);
    assert.equal("error" in out, true, `windowMs=${bad} should be rejected`);
  }
  const emptyOut = map("/api/telemetry/fleet?windowMs=");
  assert.equal("error" in emptyOut, true, "empty windowMs value is rejected");
});

test("windowMs repeats: first value wins (URLSearchParams.get semantics)", () => {
  assert.deepEqual(map("/api/telemetry/fleet?windowMs=5000&windowMs=60000"), {
    query: { windowMs: 5_000 },
  });
});

test("id list params map to providerIds/hostIds/gpuIds with comma + repeat support", () => {
  const out = map(
    "/api/telemetry/fleet?providers=openai,anthropic&providers=glm&hosts=host-a&gpus=gpu:host-a:UUID-1"
  );
  assert.equal("error" in out, false);
  assert.deepEqual(out.query, {
    providerIds: ["openai", "anthropic", "glm"],
    hostIds: ["host-a"],
    gpuIds: ["gpu:host-a:UUID-1"],
    windowMs: FLEET_TELEMETRY_DEFAULT_WINDOW_MS,
  });
});

test("id tokens reject empty, padded, and trailing-comma values", () => {
  for (const [name, value] of [
    ["providers", "openai, ,glm"],
    ["hosts", " host-a"],
    ["gpus", "gpu:host-a:UUID-1,"],
  ]) {
    const out = map(`/api/telemetry/fleet?${name}=${encodeURIComponent(value)}`);
    assert.equal("error" in out, true, `${name}=${value} should be rejected`);
  }
});

test("over-long id lists are rejected, not truncated", () => {
  const many = Array.from({ length: 65 }, (_, i) => `p${i}`).join(",");
  const out = map(`/api/telemetry/fleet?providers=${encodeURIComponent(many)}`);
  assert.equal("error" in out, true, "65 provider ids exceed the 64 cap");

  const ok64 = Array.from({ length: 64 }, (_, i) => `p${i}`).join(",");
  assert.equal("error" in map(`/api/telemetry/fleet?providers=${encodeURIComponent(ok64)}`), false);

  const manyGpu = Array.from({ length: 257 }, (_, i) => `gpu:h${i}:u${i}`).join(",");
  assert.equal("error" in map(`/api/telemetry/fleet?gpus=${encodeURIComponent(manyGpu)}`), true);
  const ok256 = Array.from({ length: 256 }, (_, i) => `gpu:h${i}:u${i}`).join(",");
  assert.equal("error" in map(`/api/telemetry/fleet?gpus=${encodeURIComponent(ok256)}`), false);
});

test("unknown query params are ignored (only windowMs/providers/hosts/gpus map)", () => {
  const out = map("/api/telemetry/fleet?windowMs=60000&foo=bar&sort=desc");
  assert.equal("error" in out, false);
  assert.deepEqual(out.query, { windowMs: 60_000 });
});
