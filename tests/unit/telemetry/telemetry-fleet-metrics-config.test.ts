/**
 * Unit tests for the fleet-metrics external-source config (OR-ATOM-005 / T5.6b1).
 *
 * The T5.6b1 knob: `OMNIROUTE_FLEET_METRICS_VRAM_UNIT=bytes|mib`. The
 * production dcgm-exporter (k3s, RTX 4070 Ti SUPER) reports
 * `DCGM_FI_DEV_FB_USED` / `DCGM_FI_DEV_FB_TOTAL` in MiB (458 + 15567 MiB on a
 * 16 GB card), while the normalized schema fields are BYTES. The default
 * stays "bytes" (raw pass-through) so all existing byte-valued fixtures keep
 * passing unchanged.
 *
 * Error semantics mirror `source`: a garbage value fails the schema, so the
 * external source is disabled (the native adapter still serves) — never a
 * silently wrong scale.
 *
 * Deterministic + hermetic: pure schema/env parsing, no network, no DB.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FLEET_METRICS_ENV,
  fleetMetricsConfigSchema,
  readFleetMetricsConfig,
} from "../../../src/shared/topology/telemetry/fleetMetricsConfig";
import {
  isVramMetric,
  vramScaleFor,
} from "../../../src/shared/topology/telemetry/providers/metricMapping";

describe("fleetMetricsConfig: OMNIROUTE_FLEET_METRICS_VRAM_UNIT (T5.6b1)", () => {
  const baseEnv = {
    [FLEET_METRICS_ENV.source]: "prometheus",
    [FLEET_METRICS_ENV.url]: "http://127.0.0.1:9090",
  };

  it("the env var name is exactly OMNIROUTE_FLEET_METRICS_VRAM_UNIT", () => {
    assert.equal(FLEET_METRICS_ENV.vramUnit, "OMNIROUTE_FLEET_METRICS_VRAM_UNIT");
  });

  it("defaults to 'bytes' when the env var is unset (schema + env reader)", () => {
    const parsed = fleetMetricsConfigSchema.parse({ url: "http://127.0.0.1:9090" });
    assert.equal(parsed.vramUnit, "bytes");

    const resolved = readFleetMetricsConfig({ ...baseEnv } as NodeJS.ProcessEnv);
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.kind, "prometheus");
    assert.equal(resolved.config?.vramUnit, "bytes");
  });

  it("parses OMNIROUTE_FLEET_METRICS_VRAM_UNIT=mib", () => {
    const resolved = readFleetMetricsConfig({
      ...baseEnv,
      [FLEET_METRICS_ENV.vramUnit]: "mib",
    } as NodeJS.ProcessEnv);
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.kind, "prometheus");
    assert.equal(resolved.config?.vramUnit, "mib");
  });

  it("rejects a garbage value the same way a bad source does (source disabled)", () => {
    const resolved = readFleetMetricsConfig({
      ...baseEnv,
      [FLEET_METRICS_ENV.vramUnit]: "gib",
    } as NodeJS.ProcessEnv);
    assert.deepEqual(resolved, { enabled: false, kind: null, config: null });
  });
});

describe("metricMapping: shared VRAM scale helper (single decision point)", () => {
  it("vramScaleFor: bytes → 1, mib → 1048576", () => {
    assert.equal(vramScaleFor("bytes"), 1);
    assert.equal(vramScaleFor("mib"), 1048_576);
  });

  it("isVramMetric: only the two VRAM gauges scale (never util/temp/power/counter)", () => {
    assert.equal(isVramMetric("DCGM_FI_DEV_FB_USED"), true);
    assert.equal(isVramMetric("DCGM_FI_DEV_FB_TOTAL"), true);
    // InfluxDB gpu-bucket column names carry the same VRAM facts.
    assert.equal(isVramMetric("vram_used_bytes"), true);
    assert.equal(isVramMetric("vram_total_bytes"), true);
    assert.equal(isVramMetric("DCGM_FI_DEV_GPU_UTIL"), false);
    assert.equal(isVramMetric("DCGM_FI_DEV_GPU_TEMP"), false);
    assert.equal(isVramMetric("DCGM_FI_DEV_POWER_USAGE"), false);
    assert.equal(isVramMetric("vllm:generation_tokens_total"), false);
  });
});
