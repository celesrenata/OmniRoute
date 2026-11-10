/**
 * Deterministic golden DEMO snapshot for the Atomic material bench
 * (OR-ATOM-010, T10.1).
 *
 * Builds a realistic topology snapshot through the REAL production
 * pipeline (`normalizeTopology` + `reconcileSnapshot`) so the bench exercises
 * the exact same descriptor resolution, layout, and visual-encoding paths
 * that the dashboard uses. No `Math.random` — every value is a constant.
 *
 * Provenance conditions exercised (the fixed "anchor" providers):
 *   - bench-primary  → 3 distinct in-flight models → 3 model colors (KNOWN)
 *   - bench-secondary → 1 in-flight model → 1 model color (KNOWN)
 *   - bench-unknown  → no in-flight models → slate/neutral (UNKNOWN)
 *   - bench-stale    → stale reconciliation join → no spin (STALE)
 *   - bench-error    → error state → red link (FAILURE)
 *   - 2 GPU atoms    → proven device attribution from reconciliation
 *
 * T10.6 perf ladder: `buildGoldenSnapshot({ atomCount })` scales the PROVIDER
 * pool (8 / 16 / 32) so the bench can exercise the topology sizes the quality
 * budget targets. The anchors are always present; extra deterministic
 * "bench-perf-N" providers fill the scale. The default (no options) is the
 * original golden scene — byte-identical output to the pre-ladder version.
 */
import { normalizeTopology } from "@/shared/topology/domain/normalizeTopology";
import { reconcileSnapshot } from "@/shared/topology/telemetry/reconcile";
import {
  buildCanonicalResourceId,
  type FleetResourceObservation,
  type FleetTelemetrySnapshot,
  type Observed,
} from "@/shared/topology/telemetry/types";

import type { TopologySceneSnapshot } from "@/shared/topology/domain/types";

/** Fixed epoch-ms for deterministic renders (2024-10-27T00:00:00Z). */
const NOW = 1730000000000;

/** Build a fresh (non-stale) observed fact. */
function obs<T>(value: T, source: Observed<T>["source"]): Observed<T> {
  return {
    value,
    source,
    sampledAt: NOW,
    windowMs: 10_000,
    stale: false,
    basis: "bench: deterministic",
  };
}

/** Build a stale observed fact. */
function obsStale<T>(value: T, source: Observed<T>["source"]): Observed<T> {
  return {
    value,
    source,
    sampledAt: NOW,
    windowMs: 10_000,
    stale: true,
    basis: "bench: stale (age > 3×window)",
  };
}

/**
 * Options for the deterministic golden snapshot (T10.6 perf ladder).
 */
export interface GoldenSnapshotOptions {
  /**
   * DEMO failure cycle (Gate B): `"recovered"` renders the error provider as
   * active (no error), so flipping back to the default `"error"` is a real
   * state transition that books the failure discharge. Omitted -> `"error"`.
   */
  errorPhase?: "error" | "recovered" | "completed";
  /**
   * DEMO idle topology (Gate B): every provider idle, no in-flight requests and
   * no fleet reconciliation (nothing measured -> lower energy state).
   */
  allIdle?: boolean;
  /**
   * Target TOTAL atom count (hub + providers), e.g. 8 / 16 / 32 — the
   * `?atoms=N` perf ladder the quality budget targets. `normalizeTopology`
   * emits only hub + provider nodes (GPU/runtime observations drive
   * reconciliation attribution but never become scene atoms), so the
   * 5 anchor providers (1 hub + 5 = 6 atoms) are the floor: the scale is
   * filled with extra `bench-perf-N` providers to reach `atomCount`.
   * Values ≤ 6 keep the original golden scene. Omitted → the 6-atom golden.
   */
  atomCount?: number;
}

/** Total atoms of the anchor-only golden scene (1 hub + 5 anchor providers). */
const ANCHOR_ATOMS = 6;

/**
 * Build a deterministic fleet-telemetry snapshot. 2 GPUs + 2 runtimes (each
 * attributed to a GPU) + 5 anchor providers + N scaled providers. The GPU /
 * runtime observations are constant — only the provider pool scales.
 */
function buildFleet(options: GoldenSnapshotOptions): FleetTelemetrySnapshot {
  const tpsOr = (golden: number): number =>
    options.uniformTps != null && Number.isFinite(options.uniformTps) ? options.uniformTps : golden;
  const target = options.atomCount ?? ANCHOR_ATOMS;
  const scaledCount = Math.max(0, target - ANCHOR_ATOMS);

  const scaledResources: FleetResourceObservation[] = [];
  for (let i = 1; i <= scaledCount; i += 1) {
    const name = `bench-perf-${i}`;
    // Deterministic per-index telemetry (no Math.random): throughput ramps
    // 20→80 tok/s, jobs cycle 1..4, utilization varies so the visual-
    // encoding lane hues spread across the perf ring.
    const tps = 20 + ((i * 7) % 5) * 8;
    const jobs = (i % 4) + 1;
    const util = 20 + ((i * 13) % 70);
    scaledResources.push({
      resourceId: buildCanonicalResourceId("provider", name),
      kind: "provider",
      providerId: name,
      utilizationPercent: obs(util, "omniroute-live"),
      outputTokensPerSecond: obs(tpsOr(tps), "omniroute-call-log"),
      activeJobs: obs(jobs, "omniroute-live"),
    });
  }

  return {
    schemaVersion: 1,
    capturedAt: NOW,
    resources: [
      // ── GPU A (utilized, producing) ──
      {
        resourceId: buildCanonicalResourceId("gpu", "bench-gpu-a", "bench-host"),
        kind: "gpu",
        hostId: "bench-host",
        deviceUuid: "bench-gpu-a",
        utilizationPercent: obs(78, "omniroute-live"),
        vramUsedBytes: obs(14_000_000_000, "omniroute-live"),
        vramTotalBytes: obs(24_000_000_000, "omniroute-live"),
        temperatureC: obs(62, "omniroute-live"),
        powerWatts: obs(280, "omniroute-live"),
        outputTokensPerSecond: obs(tpsOr(42), "omniroute-live"),
      },
      // ── GPU B (lighter load) ──
      {
        resourceId: buildCanonicalResourceId("gpu", "bench-gpu-b", "bench-host"),
        kind: "gpu",
        hostId: "bench-host",
        deviceUuid: "bench-gpu-b",
        utilizationPercent: obs(35, "omniroute-live"),
        vramUsedBytes: obs(8_000_000_000, "omniroute-live"),
        vramTotalBytes: obs(24_000_000_000, "omniroute-live"),
        temperatureC: obs(48, "omniroute-live"),
        powerWatts: obs(120, "omniroute-live"),
        outputTokensPerSecond: obs(tpsOr(18), "omniroute-live"),
      },
      // ── Runtime A → GPU A (busy, queued) ──
      {
        resourceId: buildCanonicalResourceId("runtime", "bench-rt-a", "bench-host"),
        kind: "runtime",
        hostId: "bench-host",
        runtimeId: "bench-rt-a",
        modelId: "bench/llama-70b",
        deviceUuid: "bench-gpu-a",
        outputTokensPerSecond: obs(tpsOr(42), "runtime"),
        queuedJobs: obs(3, "runtime"),
        activeJobs: obs(4, "runtime"),
      },
      // ── Runtime B → GPU B (light) ──
      {
        resourceId: buildCanonicalResourceId("runtime", "bench-rt-b", "bench-host"),
        kind: "runtime",
        hostId: "bench-host",
        runtimeId: "bench-rt-b",
        modelId: "bench/mixtral-8x7b",
        deviceUuid: "bench-gpu-b",
        outputTokensPerSecond: obs(tpsOr(18), "runtime"),
        queuedJobs: obs(0, "runtime"),
        activeJobs: obs(1, "runtime"),
      },
      // ── Provider: primary (high throughput, active) ──
      {
        resourceId: buildCanonicalResourceId("provider", "bench-primary"),
        kind: "provider",
        providerId: "bench-primary",
        outputTokensPerSecond: obs(tpsOr(60), "omniroute-call-log"),
        activeJobs: obs(5, "omniroute-live"),
        queuedJobs: obs(2, "omniroute-live"),
      },
      // ── Provider: secondary (moderate) ──
      {
        resourceId: buildCanonicalResourceId("provider", "bench-secondary"),
        kind: "provider",
        providerId: "bench-secondary",
        outputTokensPerSecond: obs(tpsOr(12), "omniroute-call-log"),
        activeJobs: obs(1, "omniroute-live"),
      },
      // ── Provider: stale (old sample → grey, no spin) ──
      {
        resourceId: buildCanonicalResourceId("provider", "bench-stale"),
        kind: "provider",
        providerId: "bench-stale",
        outputTokensPerSecond: obsStale(8, "omniroute-call-log"),
      },
      // ── Scaled perf providers (T10.6 ladder; deterministic per index) ──
      ...scaledResources,
    ],
  };
}

/**
 * Build the deterministic golden snapshot. Pure — same options → same output
 * every call (the T10.6 perf ladder is reproducible run-to-run).
 */
export function buildGoldenSnapshot(options: GoldenSnapshotOptions = {}): TopologySceneSnapshot {
  const fleet = buildFleet(options);
  const reconciliation = options.allIdle ? undefined : reconcileSnapshot(fleet);
  // `completed`: the error provider just finished a request (last-used, not failing): the
  // transition into it books the completion discharge; back to `error` books the failure strike.
  const completed = options.errorPhase === "completed";
  const recovered = options.errorPhase === "recovered" || completed;
  const idleAll = !!options.allIdle;

  // Scaled providers: the first 4 get one in-flight model each (KNOWN lane,
  // distinct model → distinct model color); the rest stay idle so the ring
  // shows a realistic mixed KNOWN/UNKNOWN population, not a wall of color.
  const scaledCount = Math.max(0, (options.atomCount ?? ANCHOR_ATOMS) - ANCHOR_ATOMS);
  const scaledProviders = [];
  for (let i = 1; i <= scaledCount; i += 1) {
    scaledProviders.push({
      provider: `bench-perf-${i}`,
      name: `Perf ${i}`,
      status: i <= 4 && !idleAll ? ("active" as const) : ("idle" as const),
    });
  }
  const scaledRequests = scaledProviders
    .filter((p) => p.status === "active")
    .map((p, i) => ({
      provider: p.provider,
      model: `bench/perf-model-${(i % 3) + 1}`,
    }));

  return normalizeTopology({
    providers: [
      { provider: "bench-primary", name: "Primary", status: idleAll ? "idle" : "active" },
      { provider: "bench-secondary", name: "Secondary", status: idleAll ? "idle" : "active" },
      { provider: "bench-unknown", name: "Unknown Model", status: "idle" },
      { provider: "bench-stale", name: "Stale", status: "idle" },
      {
        provider: "bench-error",
        name: "Error",
        status: idleAll ? "idle" : recovered ? "active" : "error",
      },
      ...scaledProviders,
    ],
    activeRequests: idleAll
      ? []
      : [
          // bench-primary: 3 distinct models → 3 model colors
          { provider: "bench-primary", model: "bench/llama-70b" },
          { provider: "bench-primary", model: "bench/mixtral-8x7b" },
          { provider: "bench-primary", model: "bench/claude-sonnet-4" },
          // bench-secondary: 1 model → 1 model color
          { provider: "bench-secondary", model: "bench/llama-70b" },
          // bench-unknown: no active requests → no model colors
          // bench-stale: no active requests → no model colors
          // bench-error: no active requests (error state)
          ...scaledRequests,
        ],
    lastProvider: idleAll ? undefined : completed ? "bench-error" : "bench-primary",
    errorProvider: idleAll || recovered ? undefined : "bench-error",
    lifecycleEvents:
      idleAll || recovered
        ? []
        : [
            {
              phase: "failed",
              requestId: "bench-req-err-1",
              provider: "bench-error",
              model: "bench/llama-70b",
              observedAt: NOW,
            },
          ],
    reconciliation,
    capturedAt: NOW,
  });
}
