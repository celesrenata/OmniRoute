/**
 * Fleet telemetry — shared metric mapping + counter-rate engine
 * (OR-ATOM-005 / Step 5).
 *
 * This module is the SINGLE source of truth for how the external adapters
 * (prometheus / grafana / influxdb2) map upstream metric samples onto the
 * normalized `FleetResourceObservation` schema. It exists because the three
 * adapters must agree on exactly the same allowlist, units, and identity
 * rules — and because the first drafts of those adapters contained two
 * defects this module fixes:
 *
 *   1. FABRICATED GPU ATTRIBUTION — a vLLM runtime counter was mapped to
 *      `outputTokensPerSecond` on a `kind:"gpu"` row built from
 *      `instance`+`uuid`. Runtime output tokens/sec is a SERVER-level fact;
 *      stock vLLM metrics carry NO per-device label. Pinning it to a GPU
 *      (or splitting it across GPUs) invents device attribution. This module
 *      only ever emits runtime throughput on a `kind:"runtime"` row, and only
 *      when a stable runtime-identity label is actually present.
 *
 *   2. INVENTED METRIC — the first draft used `vllm:gpu_prefix_cache_hits_total`
 *      as the "runtime output tok/s" source. That metric is not in vLLM's
 *      documented metric set, and prefix-cache hits are not tokens/sec. The
 *      allowlist here uses the real, documented counter
 *      `vllm:generation_tokens_total`, converted to a windowed rate.
 *
 * Grounding / honesty: T5.0 found NO reachable backend on this host. DCGM and
 * vLLM label KEYS are therefore operator-configurable ASSUMED defaults — they
 * must be confirmed against the operator's actual exporter before GPU/runtime
 * facts are considered live. See docs/telemetry-matrix (OR-ATOM-005).
 *
 * No network, no env, no DB — pure. Adapters import this and feed it samples
 * they parsed from their respective wire formats.
 */

import type { FleetResourceObservation } from "../types";

export type MetricField =
  | "gpu_util"
  | "gpu_vram_used_bytes"
  | "gpu_vram_total_bytes"
  | "gpu_temperature_c"
  | "gpu_power_w"
  | "runtime_output_tokens_total";

export type ExternalSource = "prometheus" | "influxdb2" | "grafana";

/** A parsed metric sample in the backend-agnostic shape all adapters emit. */
export interface MetricSample {
  /** Allowlisted metric name (PromQL name / Influx measurement+field key). */
  metric: string;
  /** Raw numeric value (may be a string from CSV/flux — coerced downstream). */
  value: number;
  /** Sample epoch ms; the adapter must supply a real time (never capturedAt). */
  sampledAt: number;
  /** Upstream labels/tags, already key-normalized (lowercase, trimmed). */
  labels: Record<string, string>;
}

/** Which schema field + unit + resource kind a metric maps to. */
export interface MetricMappingEntry {
  field: MetricField;
  kind: "gpu" | "runtime";
  unit: "percent" | "nonNegative" | "bytes" | "celsius" | "watts" | "tps";
  /** Monotonic counter (rate-converted) vs. gauge (direct value). */
  counter: boolean;
}

/**
 * Allowlisted metrics. DCGM fields are GAUGES that carry per-device identity.
 * The vLLM counter is SERVER-LEVEL and only becomes attributable when the
 * operator adds a runtime-identity label — it is NEVER split across GPUs.
 */
export const FLEET_METRIC_MAPPING: Record<MetricField, MetricMappingEntry> = {
  gpu_util: { field: "gpu_util", kind: "gpu", unit: "percent", counter: false },
  gpu_vram_used_bytes: { field: "gpu_vram_used_bytes", kind: "gpu", unit: "bytes", counter: false },
  gpu_vram_total_bytes: {
    field: "gpu_vram_total_bytes",
    kind: "gpu",
    unit: "bytes",
    counter: false,
  },
  gpu_temperature_c: { field: "gpu_temperature_c", kind: "gpu", unit: "celsius", counter: false },
  gpu_power_w: { field: "gpu_power_w", kind: "gpu", unit: "watts", counter: false },
  // Real vLLM v1 counter (server-level). NOT vllm:gpu_prefix_cache_hits_total
  // (not in the documented set; prefix-cache hits ≠ tokens/sec).
  runtime_output_tokens_total: {
    field: "runtime_output_tokens_total",
    kind: "runtime",
    unit: "tps",
    counter: true,
  },
};

/**
 * Allowlisted upstream metric NAMES (version-controlled; never user-defined).
 * DCGM export-tool field IDs and the documented vLLM counter. This is the
 * only set of queries/adapters may issue — the SSRF chokepoint.
 */
export const ALLOWLISTED_METRIC_NAMES: ReadonlyMap<MetricField, string> = new Map([
  ["gpu_util", "DCGM_FI_DEV_GPU_UTIL"],
  ["gpu_vram_used_bytes", "DCGM_FI_DEV_FB_USED"],
  ["gpu_vram_total_bytes", "DCGM_FI_DEV_FB_TOTAL"],
  ["gpu_temperature_c", "DCGM_FI_DEV_GPU_TEMP"],
  ["gpu_power_w", "DCGM_FI_DEV_POWER_USAGE"],
  ["runtime_output_tokens_total", "vllm:generation_tokens_total"],
]);

const nameToField = new Map<string, MetricField>();
for (const [field, name] of ALLOWLISTED_METRIC_NAMES) nameToField.set(name, field);

/** Reverse lookup: upstream metric name → mapping entry (or null). */
export function mappingForMetric(name: string): MetricMappingEntry | null {
  const field = nameToField.get(name);
  return field ? FLEET_METRIC_MAPPING[field] : null;
}

/** All allowlisted upstream metric names (for building query sets). */
export function allowlistedMetricNames(): string[] {
  return [...ALLOWLISTED_METRIC_NAMES.values()];
}

/**
 * VRAM unit scale (T5.6b1). The stock dcgm-exporter reports
 * `DCGM_FI_DEV_FB_USED` / `DCGM_FI_DEV_FB_TOTAL` in MiB, while the normalized
 * schema fields (`gpu_vram_*_bytes`) are BYTES. `vramScaleFor("mib")` is the
 * single decision point all three adapters (prometheus / influxdb2 / grafana)
 * route through — a copy-pasted `* 1048576` in any one adapter is a bug.
 * `bytes` (the default) is the historical raw pass-through.
 */
export function vramScaleFor(vramUnit: "bytes" | "mib"): number {
  return vramUnit === "mib" ? 1048_576 : 1;
}

/**
 * Whether an upstream metric name carries a VRAM fact that the
 * `vramUnit` knob scales. ONLY the two DCGM VRAM gauges (and their InfluxDB
 * gpu-bucket column names) scale — utilization, temperature, power, and the
 * vLLM output-token counter are NEVER scaled.
 */
export function isVramMetric(name: string): boolean {
  return (
    name === "DCGM_FI_DEV_FB_USED" ||
    name === "DCGM_FI_DEV_FB_TOTAL" ||
    name === "vram_used_bytes" ||
    name === "vram_total_bytes"
  );
}

export interface FleetMetricLabelKeys {
  /** Label that names the HOST the sample was observed on. */
  host: string;
  /** Label that names the GPU DEVICE (DCGM device serial / UUID). */
  gpuDevice: string;
  /** Label that names the inference RUNTIME (vLLM engine instance). */
  runtimeId: string;
}

/**
 * ASSUMED label defaults. DCGM export conventionally emits `gpu_uuid` +
 * `host`; stock vLLM emits neither per-device nor per-runtime labels (it is
 * server-level). These defaults are operator-configurable and MUST be verified
 * against the real exporter — they are not proof of live data.
 */
export const DEFAULT_FLEET_METRIC_LABEL_KEYS: FleetMetricLabelKeys = {
  host: "host",
  gpuDevice: "gpu_uuid",
  runtimeId: "runtime_id",
};

/** A Prometheus/label NAME must be a valid label key (affects id safety). */
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Resolve + validate label keys from an optional override map. Invalid role
 * names fall back to the assumed default for that role (never throw): a bad
 * override should degrade to "unknown identity", not crash the adapter.
 */
export function resolveFleetMetricLabelKeys(
  override: Record<string, string> | undefined
): FleetMetricLabelKeys {
  const out: FleetMetricLabelKeys = { ...DEFAULT_FLEET_METRIC_LABEL_KEYS };
  if (!override) return out;
  for (const role of ["host", "gpuDevice", "runtimeId"] as const) {
    const v = override[role];
    if (typeof v === "string" && v.trim() !== "" && LABEL_NAME_RE.test(v.trim())) {
      out[role] = v.trim();
    }
  }
  return out;
}

/** True when a label value is usable as an identity fact (no id-breaking chars). */
function isUsableIdentity(v: string | undefined): v is string {
  return (
    typeof v === "string" &&
    v.trim() !== "" &&
    !v.includes(":") &&
    !v.includes(" ") &&
    !v.includes("/")
  );
}

/**
 * Extract a GPU identity (host + device) from a sample's labels using the
 * resolved label keys. Returns null when EITHER is missing — a sample without
 * a stable device UUID is dropped, never fabricated from a PCI index.
 */
export function gpuIdentityFromLabels(
  labels: Record<string, string>,
  keys: FleetMetricLabelKeys
): { hostId: string; deviceUuid: string } | null {
  const hostId = labels[keys.host];
  const deviceUuid = labels[keys.gpuDevice];
  if (!isUsableIdentity(hostId) || !isUsableIdentity(deviceUuid)) return null;
  return { hostId: hostId.trim(), deviceUuid: deviceUuid.trim() };
}

/**
 * Extract a runtime identity. A runtime row REQUIRES both a stable host and a
 * stable runtime id; with either absent the throughput stays unattributed
 * (unknown) rather than being pinned to a device or split across GPUs.
 */
export function runtimeIdentityFromLabels(
  labels: Record<string, string>,
  keys: FleetMetricLabelKeys
): { hostId: string; runtimeId: string } | null {
  const hostId = labels[keys.host];
  const runtimeId = labels[keys.runtimeId];
  if (!isUsableIdentity(hostId) || !isUsableIdentity(runtimeId)) return null;
  return { hostId: hostId.trim(), runtimeId: runtimeId.trim() };
}

/**
 * A counter reading with the prior baseline needed to compute a windowed rate.
 * `previousAtMs`/`currentAtMs` let the caller derive a real `deltaSeconds` —
 * the rate is ALWAYS delta / elapsed, never a fabricated value.
 */
export interface CounterRateReading {
  /** Prior counter value (finite, and <= current value). */
  previousValue: number;
  /** Epoch ms of the prior reading. */
  previousAtMs: number;
  /** Epoch ms of the current reading. */
  currentAtMs: number;
}

/**
 * Per-provider, per-metric-key counter state, enabling windowed rates across
 * repeated snapshots within a process. A counter reset (value < previous) or a
 * first-ever reading yields an UNKNOWN rate (`null`) — never a fabricated zero
 * or a negative. State advances on every reading so the next read has a prior.
 */
export interface CounterRateEngine {
  /**
   * Record `value` at `sampledAt` for `key` and return the prior reading that
   * `counterRate` needs, or `null` when no usable prior reading exists
   * (first read / counter reset / span > maxSpanMs).
   */
  readRate(key: string, value: number, sampledAt: number): CounterRateReading | null;
  /** Drop all state (process restarts / tests / counter-reset). */
  reset(): void;
}

export interface CounterRateEngineOptions {
  /** Ignore a rate whose previous reading is older than this (ms). */
  maxSpanMs?: number;
  /** Injectable clock used only when `sampledAt` is not finite. */
  now?: () => number;
}

export function createCounterRateEngine(opts: CounterRateEngineOptions = {}): CounterRateEngine {
  const maxSpanMs = opts.maxSpanMs ?? 10 * 60 * 1000;
  const nowFn = opts.now ?? (() => Date.now());
  const state = new Map<string, { value: number; at: number }>();

  return {
    readRate(key, value, sampledAt) {
      if (!Number.isFinite(value)) {
        state.delete(key);
        return null;
      }
      const at = Number.isFinite(sampledAt) ? sampledAt : nowFn();
      const prev = state.get(key);
      let reading: CounterRateReading | null = null;
      if (prev && value >= prev.value) {
        const spanMs = at - prev.at;
        if (spanMs > 0 && spanMs <= maxSpanMs) {
          reading = {
            previousValue: prev.value,
            previousAtMs: prev.at,
            currentAtMs: at,
          };
        }
      }
      // Always advance state so the NEXT read has a prior; on reset the
      // (lower) current value becomes the new baseline.
      state.set(key, { value, at });
      return reading;
    },
    reset() {
      state.clear();
    },
  };
}

/**
 * Map a metric to the schema field it writes to + the unit guard to apply.
 * Pure: given the mapping entry, it returns the target schema field name and
 * the unit used by `normalizeSample`. Covers both GPU hardware facts and the
 * runtime throughput fact (the only runtime field this data path emits).
 */
export function observationFieldFor(entry: MetricMappingEntry): {
  field: keyof FleetResourceObservation;
  unit: MetricMappingEntry["unit"];
} {
  const map: Record<MetricField, keyof FleetResourceObservation> = {
    gpu_util: "utilizationPercent",
    gpu_vram_used_bytes: "vramUsedBytes",
    gpu_vram_total_bytes: "vramTotalBytes",
    gpu_temperature_c: "temperatureC",
    gpu_power_w: "powerWatts",
    runtime_output_tokens_total: "outputTokensPerSecond",
  };
  return { field: map[entry.field], unit: entry.unit };
}

/**
 * Whether a sample's sample-time is acceptable (finite, not in the future).
 * Adapters use this to drop future-dated samples before they poison provenance.
 */
export function isAcceptableSampleTime(sampledAt: number, capturedAt: number): boolean {
  return Number.isFinite(sampledAt) && Number.isFinite(capturedAt) && sampledAt <= capturedAt + 1;
}
