/**
 * Fleet telemetry — atom motion-signal mapping (OR-ATOM-009 / W1).
 *
 * Pure module: no DOM, no React, no DB, no network. It maps a
 * `ReconciliationResult` (see ./reconcile.ts) into per-node "motion signals"
 * that the atomic-topology renderer can drive rotation / queue motion from,
 * WITHOUT ever inventing a metric.
 *
 * Data semantics (hard rules, from the reconcile.ts invariants):
 * - A fresh explicit value (even 0) maps through as-is (reconcile.ts:25-26).
 * - A stale Observed (stale === true) maps to null, source "stale" — a
 *   last-known-neutral value, never a fake zero and never a spinning guess
 *   (stale is read from the pre-computed flag, reconcile.ts:96-104).
 * - A field-missing Observed maps to null, source "unavailable".
 * - A fresh Observed whose value is null ("observed as absent", types.ts:70-73)
 *   maps to null, source "unavailable" — there is no live data to assert.
 * - Live numeric data present → source "live".
 *
 * Throughput is NEVER redistributed: a GPU atom's tokensPerSecond comes ONLY
 * from the GPU node's own outputTokensPerSecond (per-device provenance; the
 * GPU field is only ever populated from the device's own fact,
 * reconcile.ts:139-140). A runtime's TPS is never split or averaged across its
 * attributedGpuIds (the split rule is the invariant at reconcile.ts:22-24).
 * When only the runtime has TPS, the GPU signal's tokensPerSecond stays null and
 * gpuHasProvenThroughput is false.
 */

import type { Observed } from "./types";
import type { ReconciliationResult } from "./reconcile";

export type AtomKind = "gpu" | "runtime" | "provider";
export type SignalSource = "live" | "demo" | "unavailable" | "stale";

export interface AtomMotionSignal {
  resourceId: string;
  kind: AtomKind;
  /**
   * Measured decode speed (tok/s) or null when unknown/missing/stale — rotation
   * speed is a downstream function of this (applied at the rendering layer).
   */
  tokensPerSecond: number | null;
  /** Real attributable queued-job count or null. */
  queuedJobs: number | null;
  activeJobs: number | null;
  /**
   * Verified model IDs bound to THIS atom (never guessed; [] = none proven).
   * The full list is kept here; the 3-entry display cap is applied downstream.
   */
  modelIds: string[];
  /**
   * True only when the GPU atom has proven per-device throughput attribution —
   * i.e. the GPU node's own outputTokensPerSecond Observed is a fresh, non-null
   * number (a per-device measurement, never a runtime split).
   */
  gpuHasProvenThroughput: boolean;
  source: SignalSource;
  sampledAt: number | null;
  basis?: string;
}

export interface ReconciliationSignals {
  perAtom: Map<string, AtomMotionSignal>;
  /** Proven edges only — copied 1:1 from reconciliation.edges, never synthesized. */
  edges: {
    sourceId: string;
    targetId: string;
    relation: "provider_runtime" | "runtime_device" | "runtime_model";
    basis: string;
    sampledAt: number;
  }[];
  providerCentricFallback: boolean;
  capturedAt: number;
}

/**
 * Map one observed numeric fact to its signal value. Missing / stale /
 * null-observed all yield null; only a fresh, non-null number passes through.
 */
function mapObservedValue(obs: Observed<number> | undefined): number | null {
  if (obs === undefined) return null;
  if (obs.stale === true) return null;
  if (typeof obs.value !== "number") return null;
  return obs.value;
}

/**
 * The signal's headline freshness, anchored on the throughput fact
 * (rotation speed is a downstream function of it). "demo" is never produced
 * here — it is stamped exclusively by mergeDemoSignals.
 */
function sourceFor(obs: Observed<number> | undefined): SignalSource {
  if (obs === undefined) return "unavailable";
  if (obs.stale === true) return "stale";
  if (obs.value === null) return "unavailable";
  return "live";
}

/**
 * Build the motion signals for every atom in a reconciliation.
 * `buildAtomSignals(null)` → empty perAtom, empty edges, providerCentricFallback
 * false, capturedAt 0.
 */
export function buildAtomSignals(
  reconciliation: ReconciliationResult | null | undefined
): ReconciliationSignals {
  const perAtom = new Map<string, AtomMotionSignal>();

  if (reconciliation === null || reconciliation === undefined) {
    return { perAtom, edges: [], providerCentricFallback: false, capturedAt: 0 };
  }

  // Pre-index verified modelId → GPU via attributedGpuIds (model→GPU provenance
  // ONLY; never from labels, never from provider atoms).
  const modelByGpu = new Map<string, string[]>();
  for (const runtime of reconciliation.runtimeNodes) {
    if (runtime.modelId === undefined || runtime.modelId === "") continue;
    for (const gpuId of runtime.attributedGpuIds) {
      const list = modelByGpu.get(gpuId);
      if (list === undefined) {
        modelByGpu.set(gpuId, [runtime.modelId]);
      } else if (!list.includes(runtime.modelId)) {
        list.push(runtime.modelId);
      }
    }
  }

  for (const gpu of reconciliation.gpuNodes) {
    const tps = gpu.outputTokensPerSecond;
    perAtom.set(gpu.resourceId, {
      resourceId: gpu.resourceId,
      kind: "gpu",
      tokensPerSecond: mapObservedValue(tps),
      // ReconciledGpuNode carries no queue facts — queue/active stay null.
      queuedJobs: null,
      activeJobs: null,
      modelIds: modelByGpu.get(gpu.resourceId) ?? [],
      gpuHasProvenThroughput: mapObservedValue(tps) !== null,
      source: sourceFor(tps),
      sampledAt: tps?.sampledAt ?? null,
      basis: tps?.basis,
    });
  }

  for (const runtime of reconciliation.runtimeNodes) {
    const tps = runtime.outputTokensPerSecond;
    perAtom.set(runtime.resourceId, {
      resourceId: runtime.resourceId,
      kind: "runtime",
      tokensPerSecond: mapObservedValue(tps),
      queuedJobs: mapObservedValue(runtime.queuedJobs),
      activeJobs: mapObservedValue(runtime.activeJobs),
      modelIds: runtime.modelId ? [runtime.modelId] : [],
      // Runtime atoms never claim GPU per-device provenance.
      gpuHasProvenThroughput: false,
      source: sourceFor(tps),
      sampledAt: tps?.sampledAt ?? null,
      basis: tps?.basis,
    });
  }

  for (const provider of reconciliation.providerNodes) {
    const tps = provider.outputTokensPerSecond;
    perAtom.set(provider.resourceId, {
      resourceId: provider.resourceId,
      kind: "provider",
      tokensPerSecond: mapObservedValue(tps),
      queuedJobs: mapObservedValue(provider.queuedJobs),
      activeJobs: mapObservedValue(provider.activeJobs),
      // Model identity is never taken from provider atoms.
      modelIds: [],
      gpuHasProvenThroughput: false,
      source: sourceFor(tps),
      sampledAt: tps?.sampledAt ?? null,
      basis: tps?.basis,
    });
  }

  const edges = reconciliation.edges.map((e) => ({
    sourceId: e.source,
    targetId: e.target,
    relation: e.relation,
    basis: e.basis,
    sampledAt: e.sampledAt,
  }));

  return {
    perAtom,
    edges,
    providerCentricFallback: reconciliation.providerCentricFallback,
    capturedAt: reconciliation.capturedAt,
  };
}

/**
 * Blend live and demo signals. Returns `demo` when it carries at least one atom
 * (the demo harness feeds the same ReconciliationResult shape), else `live`.
 * When demo wins, each atom's source is stamped "demo" (on fresh signal objects,
 * so the inputs are not mutated) so the renderer can badge demo-fed motion as
 * distinct from live telemetry.
 */
export function mergeDemoSignals(
  live: ReconciliationSignals,
  demo: ReconciliationSignals
): ReconciliationSignals {
  if (demo.perAtom.size === 0) return live;

  const perAtom = new Map<string, AtomMotionSignal>();
  demo.perAtom.forEach((signal, key) => {
    perAtom.set(key, { ...signal, source: "demo" });
  });
  return {
    perAtom,
    edges: demo.edges,
    providerCentricFallback: demo.providerCentricFallback,
    capturedAt: demo.capturedAt,
  };
}
