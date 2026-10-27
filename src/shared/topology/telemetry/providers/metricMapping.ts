/**
 * Fleet telemetry — shared metric mapping + counter-rate engine
 * (OR-ATOM-005 / Step 5).
 *
 * This module is the SINGLE source of truth for how the external adapters
 * (prometheus / grafana / influxdb2) map upstream metric samples onto the
 * normalized `FleetResourceObservation` schema. It exists because the three
 * adapters must agree on exactly the same allowlist, units, and identity
 * rules — and because the first drafts of those adapters contained several
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
 *      documented set, and prefix-cache hits are not tokens/sec. The
 *      allowlist here uses the real, documented counter
 *      `vllm:generation_tokens_total`, converted to a windowed rate.
 *
 *   3. NO TPS COUNTER ENGINE IN PRODUCTION — the adapters accepted an optional
 *      `counterEngine` that production never passed, so the vLLM counter
 *      always yielded `outputTokensPerSecond.value = null`. `createCounterRateEngine`
 *      below is the bounded, persistent, reset-aware engine; the gateway now
 *      instantiates ONE per registered adapter. CUMULATIVE counts are never
 *      returned as tok/s — only a windowed delta over the observed interval.
 *
 *   4. MISSING vLLM SCHEDULER GAUGES — `vllm:num_requests_waiting` /
 *      `vllm:num_requests_running` (the inference scheduler's waiting/running
 *      request counts) are mapped to `queuedJobs` / `activeJobs` on a
 *      `kind:"runtime"` row ONLY, and ONLY when the source actually exposes
 *      them (version-aware — the exact vLLM V1 metric names). OmniRoute's own
 *      rate-limiter queue is a DIFFERENT thing (native-only, `providers/omniroute.ts`)
 *      and is NEVER conflated with the inference scheduler.
 *
 *   5. DCGM LABEL REALITY — the stock dcgm-exporter exposes the GPU serial as
 *      `UUID` (sometimes `uuid`) and the host as `hostname`; the Apple macmon
 *      relabels use `hostname` + `uuid`. Adapters lowercase label keys, so the
 *      case-folding aliases in `DEFAULT_FLEET_METRIC_LABEL_ALIASES` + the
 *      `OMNIROUTE_FLEET_METRICS_LABEL_*` env overrides make identity robust.
 *      A hostname is NEVER guessed from `instance` or a PCI index.
 *
 *   6. APPLE MACMON — `macmon_gpu_scaled_ratio` (0..1), `macmon_gpu_temp_celsius`,
 *      `macmon_gpu_power_watts` map onto the gpu row. macmon exposes NO
 *      discrete GPU memory (Apple uses shared system RAM), so a macmon GPU row
 *      carries NO vram fields — absent, never a fabricated zero.
 *
 * Grounding / honesty: T5.0 found NO reachable backend on this host. DCGM,
 * vLLM, and macmon label KEYS are therefore operator-configurable ASSUMED
 * defaults — they must be confirmed against the operator's actual exporter
 * before GPU/runtime facts are considered live. See
 * docs/specs/atomic-topology-telemetry-matrix.md (OR-ATOM-005).
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
  | "runtime_output_tokens_total"
  | "runtime_scheduler_waiting"
  | "runtime_scheduler_running";

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
 * operator adds a runtime-identity label — it is NEVER split across GPUs. The
 * vLLM scheduler gauges are RUNTIME-level (waiting/running request counts) and
 * map to queuedJobs/activeJobs on a runtime row.
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
  // vLLM inference-scheduler gauges (V1). The RUNTIME's waiting/running request
  // counts — a scheduler fact, NOT OmniRoute's own rate-limiter queue. They map
  // to queuedJobs / activeJobs on a kind:"runtime" row only when a stable
  // runtime identity is present, and only when the source actually exposes them
  // (version-aware: the exact vLLM V1 names).
  runtime_scheduler_waiting: {
    field: "runtime_scheduler_waiting",
    kind: "runtime",
    unit: "nonNegative",
    counter: false,
  },
  runtime_scheduler_running: {
    field: "runtime_scheduler_running",
    kind: "runtime",
    unit: "nonNegative",
    counter: false,
  },
};

/**
 * Allowlisted upstream metric NAMES (version-controlled; never user-defined).
 * DCGM export-tool field IDs, the documented vLLM counter + scheduler gauges,
 * and the Apple macmon GPU gauges. This is the ONLY set of queries/adapters may
 * issue — the SSRF chokepoint. `allowlistedMetricNames()` returns the names;
 * `mappingForMetric()` reverse-looks-up a name to its mapping.
 *
 * KEYED BY NAME, NOT BY FIELD: DCGM and macmon both feed the same normalized
 * fields (gpu_util / gpu_temperature_c / gpu_power_w). A field-keyed Map
 * silently dropped the DCGM names (the macmon entries overwrote them), so the
 * three DCGM gauges were never queried and came back null in production. An
 * upstream name maps to exactly one field, so the name is the unique key.
 */
const ALLOWLISTED_METRIC_NAME_ENTRIES: readonly [string, MetricField][] = [
  ["DCGM_FI_DEV_GPU_UTIL", "gpu_util"],
  ["DCGM_FI_DEV_FB_USED", "gpu_vram_used_bytes"],
  ["DCGM_FI_DEV_FB_TOTAL", "gpu_vram_total_bytes"],
  ["DCGM_FI_DEV_GPU_TEMP", "gpu_temperature_c"],
  ["DCGM_FI_DEV_POWER_USAGE", "gpu_power_w"],
  ["vllm:generation_tokens_total", "runtime_output_tokens_total"],
  ["vllm:num_requests_waiting", "runtime_scheduler_waiting"],
  ["vllm:num_requests_running", "runtime_scheduler_running"],
  // Apple SMC (macmon) GPU gauges. macmon exposes NO discrete GPU memory —
  // Apple GPUs use shared system RAM — so a macmon GPU row carries no vram
  // fields by design (absent, never a fabricated zero).
  ["macmon_gpu_scaled_ratio", "gpu_util"],
  ["macmon_gpu_temp_celsius", "gpu_temperature_c"],
  ["macmon_gpu_power_watts", "gpu_power_w"],
];

// Defense-in-depth: a duplicate upstream name in the table above used to fail
// SILENTLY — the old field-keyed Map kept only the last entry, the losing
// metric was never queried, and its gauge came back null. Fail loud at module
// load instead.
{
  const names = ALLOWLISTED_METRIC_NAME_ENTRIES.map(([name]) => name);
  if (new Set(names).size !== names.length) {
    throw new Error("metricMapping: duplicate upstream metric name in allowlist");
  }
}

export const ALLOWLISTED_METRIC_NAMES: ReadonlyMap<string, MetricField> = new Map(
  ALLOWLISTED_METRIC_NAME_ENTRIES
);

/** Reverse lookup: upstream metric name → mapping entry (or null). */
export function mappingForMetric(name: string): MetricMappingEntry | null {
  const field = ALLOWLISTED_METRIC_NAMES.get(name);
  return field ? FLEET_METRIC_MAPPING[field] : null;
}

/** All allowlisted upstream metric NAMES (for building query sets). */
export function allowlistedMetricNames(): string[] {
  return [...ALLOWLISTED_METRIC_NAMES.keys()];
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
 * macmon's `macmon_gpu_scaled_ratio` is a 0..1 utilization fraction. It is
 * scaled to the 0..100 `percent` field; an out-of-range value is dropped as
 * unknown (null) rather than clamped, so a bad sample cannot fabricate a gauge.
 */
export function ratioScaleFor(raw: number): number | null {
  if (!Number.isFinite(raw) || raw < 0 || raw > 1) return null;
  return raw * 100;
}

/**
 * The single value-scaling decision point all three adapters route through.
 * DCGM VRAM gauges (MiB on the stock exporter) are scaled to bytes only when
 * `vramUnit="mib"`; the macmon scaled ratio (0..1) is scaled to 0..100
 * (out-of-range → null, never clamped). Everything else passes through
 * unchanged, so the counter and non-VRAM gauges are never rescaled.
 */
export function scaleFieldValue(
  raw: number,
  vramUnit: "bytes" | "mib",
  metricName: string
): number | null {
  if (isVramMetric(metricName)) return raw * vramScaleFor(vramUnit);
  if (metricName === "macmon_gpu_scaled_ratio") return ratioScaleFor(raw);
  return raw;
}

/**
 * Whether an upstream metric name carries a VRAM fact that the
 * `vramUnit` knob scales. ONLY the two DCGM VRAM gauges (and their InfluxDB
 * gpu-bucket column names) scale — utilization, temperature, power, the macmon
 * ratio (scaled by `ratioScaleFor`, not `vramScaleFor`), and the vLLM counter
 * are NEVER VRAM-scaled.
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
 * server-level); macmon emits `uuid` + `hostname`. These defaults are
 * operator-configurable and MUST be verified against the real exporter — they
 * are not proof of live data.
 */
export const DEFAULT_FLEET_METRIC_LABEL_KEYS: FleetMetricLabelKeys = {
  host: "host",
  gpuDevice: "gpu_uuid",
  runtimeId: "runtime_id",
};

/**
 * Case-insensitive label aliases accepted in ADDITION to the resolved primary
 * key for each role. The stock dcgm-exporter exposes the GPU serial as `UUID`
 * (sometimes `uuid`) and the host as `hostname` (when enabled); the cluster-side
 * relabels used by the Apple macmon exporter use `hostname` + `uuid`. Adapters
 * lowercase label keys before this lookup, so `UUID`/`uuid` and
 * `hostname`/`host` all resolve. This NEVER guesses a hostname from `instance`
 * or a PCI index — those are only accepted as ALIASES when the operator's
 * exporter genuinely tags the sample with them.
 */
export const DEFAULT_FLEET_METRIC_LABEL_ALIASES: Readonly<
  Record<keyof FleetMetricLabelKeys, readonly string[]>
> = {
  host: ["host", "hostname", "node"],
  gpuDevice: ["gpu_uuid", "uuid", "gpu_serial", "serial"],
  runtimeId: ["runtime_id", "vllm_instance"],
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

/**
 * Read an identity label by role: the resolved primary key first, then any
 * case-insensitive alias. Label maps are already lowercased by the adapters, so
 * `UUID`/`uuid` and `hostname`/`host` all resolve. Returns undefined when no
 * alias carries the label — callers drop the sample as unidentifiable (never
 * fabricate).
 */
export function identityLabel(
  labels: Record<string, string>,
  keys: FleetMetricLabelKeys,
  role: keyof FleetMetricLabelKeys
): string | undefined {
  const byRole: Record<keyof FleetMetricLabelKeys, string> = {
    host: keys.host,
    gpuDevice: keys.gpuDevice,
    runtimeId: keys.runtimeId,
  };
  const candidates = [byRole[role], ...DEFAULT_FLEET_METRIC_LABEL_ALIASES[role]];
  for (const c of candidates) {
    const v = labels[c.toLowerCase()];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

/**
 * True when a label value is usable as an identity fact. The structural
 * separators `:` and `/` are forbidden (they break the canonical id shape),
 * but a SPACE is legal — a macmon GPU's device id is the chip display name
 * (e.g. "Apple M5 Max"), which is a real, operator-confirmed device identity.
 */
function isUsableIdentity(v: string | undefined): v is string {
  return typeof v === "string" && v.trim() !== "" && !v.includes(":") && !v.includes("/");
}

/**
 * Extract a GPU identity (host + device) from a sample's labels using the
 * resolved label keys + case-insensitive aliases. Returns null when EITHER is
 * missing — a sample without a stable device UUID is dropped, never fabricated
 * from a PCI index.
 */
export function gpuIdentityFromLabels(
  labels: Record<string, string>,
  keys: FleetMetricLabelKeys
): { hostId: string; deviceUuid: string } | null {
  const hostId = identityLabel(labels, keys, "host");
  const deviceUuid = identityLabel(labels, keys, "gpuDevice");
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
  const hostId = identityLabel(labels, keys, "host");
  const runtimeId = identityLabel(labels, keys, "runtimeId");
  if (!isUsableIdentity(hostId) || !isUsableIdentity(runtimeId)) return null;
  return { hostId: hostId.trim(), runtimeId: runtimeId.trim() };
}

/**
 * A counter reading with the prior baseline needed to compute a windowed rate.
 * `previousAtMs`/`currentAtMs` let the caller derive a real `deltaSeconds` —
 * the rate is ALWAYS delta / elapsed, never a fabricated value. A counter
 * reset (current < previous) yields NO reading — the rate for that interval
 * is unknown, and the reset value becomes the baseline for the next one.
 */
export interface CounterRateReading {
  /** Prior counter value (finite). */
  previousValue: number;
  /** Epoch ms of the prior reading. */
  previousAtMs: number;
  /** Epoch ms of the current reading. */
  currentAtMs: number;
}

/**
 * Per-provider, per-series counter state, enabling windowed rates across
 * repeated snapshots within a process. A counter reset (value < previous) or
 * a first-ever reading yields an UNKNOWN rate (`null`) — never a fabricated
 * zero or a negative. Bounded: at most `maxSeries` series are tracked,
 * LRU-evicted when exceeded, so a high-cardinality backend cannot grow the
 * engine without bound.
 */
export interface CounterRateEngine {
  /**
   * Record `value` at `sampledAt` for `key` and return the prior reading that
   * `counterRate` needs, or `null` when no usable prior reading exists
   * (first read / counter reset / span > maxSpanMs / zero-elapsed).
   */
  readRate(key: string, value: number, sampledAt: number): CounterRateReading | null;
  /** Drop all state (process restarts / tests / counter-reset). */
  reset(): void;
}

export interface CounterRateEngineOptions {
  /** Ignore a rate whose previous reading is older than this (ms). */
  maxSpanMs?: number;
  /** Max number of series tracked; LRU-evicts when exceeded. */
  maxSeries?: number;
  /** Injectable clock used only when `sampledAt` is not finite. */
  now?: () => number;
}

/** Bounded per-series counter state (high-cardinality guard). */
export const COUNTER_ENGINE_MAX_SERIES_DEFAULT = 4096;

/**
 * Build the bounded, persistent, reset-aware counter-rate engine. ONE instance
 * per registered adapter — it survives across snapshots so successive samples
 * form a real window. The map key is the full label-set string (see
 * `counterSeriesKey`): a series with changing labels is a NEW series (re-warm),
 * and the map is LRU-bounded so cardinality cannot grow it without limit.
 */
export function createCounterRateEngine(opts: CounterRateEngineOptions = {}): CounterRateEngine {
  const maxSpanMs = opts.maxSpanMs ?? 10 * 60 * 1000;
  const maxSeries = opts.maxSeries ?? COUNTER_ENGINE_MAX_SERIES_DEFAULT;
  const nowFn = opts.now ?? (() => Date.now());
  // A Map preserves insertion order; the tail is the most-recently-used (LRU).
  const state = new Map<string, { value: number; at: number }>();

  return {
    readRate(key, value, sampledAt) {
      if (!Number.isFinite(value)) {
        state.delete(key);
        return null;
      }
      const at = Number.isFinite(sampledAt) ? sampledAt : nowFn();
      const prev = state.get(key);
      // Touch: re-insert to mark this series most-recently-used (LRU tail).
      if (prev) state.delete(key);
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
        // spanMs <= 0 (clock skew) or > maxSpanMs (stale gap) → no usable prior;
        // the fresh baseline below still gives the NEXT read something to diff.
      }
      // A counter reset (value < prev) yields NO reading this interval —
      // unknown, never a negative — but the reset value becomes the baseline.
      state.set(key, { value, at });
      // LRU eviction: drop the least-recently-used (front) until within budget.
      while (state.size > maxSeries) {
        const oldest = state.keys().next().value;
        if (oldest === undefined) break;
        state.delete(oldest);
      }
      return reading;
    },
    reset() {
      state.clear();
    },
  };
}

/**
 * Stable counter-engine key from the metric name + the FULL label set (sorted
 * `k=v` pairs). Including the metric name avoids cross-metric collisions when
 * one engine serves many metrics; the full label set means a series whose
 * labels change is a NEW series (re-warm), never a bogus diff across a series
 * boundary.
 */
export function counterSeriesKey(metric: string, labels: Record<string, string>): string {
  const pairs = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`);
  return `${metric}|${pairs.join(",")}`;
}

/**
 * Map a metric to the schema field it writes to + the unit guard to apply.
 * Pure: given the mapping entry, it returns the target schema field name and
 * the unit used by `normalizeSample`. Covers GPU hardware facts, the runtime
 * throughput fact, and the runtime inference-scheduler waiting/running counts.
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
    runtime_scheduler_waiting: "queuedJobs",
    runtime_scheduler_running: "activeJobs",
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
