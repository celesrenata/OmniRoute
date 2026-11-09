/**
 * Opt-in GPU / atom detail view: pure state + view-model (OR-ATOM Step 11).
 *
 * The detail view reuses the SAME renderer, descriptors and focus state as the
 * default view; it only (a) remembers which atom the viewer chose to inspect,
 * (b) lets the camera fly closer to it (see `detailFlight.ts`) and (c) shows a
 * DOM overlay built from {@link buildDetailModel}. Nothing here touches the
 * default camera, layout, labels or telemetry semantics.
 *
 * Honesty rules (operator directives 7, 30; plan D1):
 * - Every value is copied from the descriptor (real telemetry). A `null`
 *   device measurement is "no data", never `0`.
 * - Job panels (Active / Queued / Failed) exist ONLY when a real value backs
 *   them: `activeJobs` / `queuedJobs` from the device facts, `Failed` from
 *   real `request-failed` events still in the lifecycle pool. No value, no
 *   panel; nothing is ever synthesised.
 * - Model -> nucleon mapping uses the descriptor's observed model ids only and
 *   the deterministic nucleus allocator the scene itself uses.
 *
 * Pure + three-free + React-free: importable from node tests.
 */
import type { AtomVisualDescriptor } from "../AtomicTopologyRenderer";
import type { AtomicEvent } from "../eventPool";
import { activityLine } from "../overlays/activityVocabulary";
import { LANE_HUES } from "../visualEncoding";
import { fnv1a } from "./cloudShells";
import { buildNucleusCluster } from "./nucleusCluster";
import { RT_RING_OUTER_COUNT, RT_HUB_OUTER_COUNT } from "./nucleonPack";

/** The viewer's detail selection. `atomId === null` means the default view. */
export interface DetailState {
  /** The inspected atom, or `null` when the detail view is closed. */
  atomId: string | null;
  /** The focus the viewer had before opening, restored on exit. */
  returnFocusId: string | null;
}

export const DETAIL_CLOSED: DetailState = Object.freeze({ atomId: null, returnFocusId: null });

/** Only failures newer than this are shown in the Failed panel (matches the pool max age). */
export const DETAIL_FAILURE_WINDOW_MS = 60_000;

/**
 * Open the detail view for `atomId`. Opt-in only: an unknown id, or a state
 * that is already showing that atom, leaves the state unchanged. The prior
 * focus is remembered once (re-opening another atom keeps the ORIGINAL focus).
 */
export function openDetail(
  state: DetailState,
  atomId: string,
  descriptors: readonly Pick<AtomVisualDescriptor, "id">[],
  currentFocusId: string | null
): DetailState {
  if (typeof atomId !== "string" || !descriptors.some((d) => d.id === atomId)) return state;
  if (state.atomId === atomId) return state;
  return {
    atomId,
    returnFocusId: state.atomId === null ? currentFocusId : state.returnFocusId,
  };
}

/** Result of leaving the detail view. */
export interface DetailExit {
  state: DetailState;
  /** The focus to restore (`null` = no focus; the caller re-frames the whole scene). */
  restoreFocusId: string | null;
  /** True when the caller must bump the camera reset token (no prior focus to return to). */
  resetView: boolean;
}

/** Leave the detail view and report how to restore the previous framing. */
export function closeDetail(state: DetailState): DetailExit {
  if (state.atomId === null) {
    return { state: DETAIL_CLOSED, restoreFocusId: null, resetView: false };
  }
  return {
    state: DETAIL_CLOSED,
    restoreFocusId: state.returnFocusId,
    resetView: state.returnFocusId === null,
  };
}

/** The descriptor being inspected, or `null` (closed, or the atom left the snapshot). */
export function resolveDetailDescriptor<T extends Pick<AtomVisualDescriptor, "id">>(
  state: DetailState,
  descriptors: readonly T[]
): T | null {
  if (state.atomId === null) return null;
  return descriptors.find((d) => d.id === state.atomId) ?? null;
}

export interface DetailModelRow {
  model: string;
  color: string;
  /** Nucleons (of the atom's nucleus) coloured for this model. */
  nucleons: number;
  /** Where the id was observed. */
  basis: string;
}

export interface DetailFactRow {
  label: string;
  value: string;
}

export interface DetailJobPanel {
  key: "active" | "queued" | "failed";
  label: string;
  value: number;
  /** Provenance of the number (never empty). */
  basis: string;
}

export interface DetailModel {
  atomId: string;
  title: string;
  kind: AtomVisualDescriptor["kind"];
  /** Nucleon mapping, one row per observed model (empty => neutral nucleus). */
  models: DetailModelRow[];
  /** Nucleons not attributed to any observed model (neutral two-tone). */
  neutralNucleons: number;
  /** True when no model was observed: the nucleus is the honest neutral two-tone. */
  neutralNucleus: boolean;
  totalNucleons: number;
  /** Orbital / lane legend for this atom. */
  orbital: DetailFactRow[];
  laneHue: string;
  /** Measured device facts ("no data" when null). Empty for non-device atoms. */
  deviceFacts: DetailFactRow[];
  /** Real job panels only. */
  jobs: DetailJobPanel[];
  /** The honest activity statement (tier wording, never "live" for decorative vitality). */
  activity: string;
  /** One-line provenance for the whole panel. */
  provenance: string;
}

export interface DetailContext {
  /** Snapshot capture time (epoch ms): the deterministic clock for "Nm ago". */
  now: number;
  /** Live lifecycle events (the host pool). Failures are counted from here only. */
  events?: readonly AtomicEvent[];
}

const noData = "no data";

function fmt(v: number | null | undefined, f: (n: number) => string): string {
  return v == null || !Number.isFinite(v) ? noData : f(v);
}

function modelBasis(d: AtomVisualDescriptor, id: string): string {
  const s = d.observedModelSources;
  if (!s) return "fleet residency (proven runtime)";
  if (s.inFlight.includes(id)) return "live in-flight";
  if (s.callLog.includes(id)) {
    const min = s.callLogWindowMs ? Math.round(s.callLogWindowMs / 60_000) : null;
    return min ? `call-log, last ${min} min` : "call-log";
  }
  return "fleet residency (proven runtime)";
}

/** Count nucleons per model group using the scene's own deterministic allocator. */
export function countNucleonsByModel(
  atomId: string,
  hub: boolean,
  modelIds: readonly string[]
): { perGroup: number[]; neutral: number; total: number; groups: string[] } {
  const outerCount = hub ? RT_HUB_OUTER_COUNT : RT_RING_OUTER_COUNT;
  const seed = fnv1a(atomId);
  const outer = buildNucleusCluster({
    seed,
    particleCount: outerCount,
    observedModelIds: modelIds,
  });
  const inner = buildNucleusCluster({
    seed: (seed ^ 0x9e3779b9) >>> 0,
    particleCount: Math.round(outerCount * 0.4),
    observedModelIds: modelIds,
  });
  const groups = outer.modelGroups;
  const perGroup = groups.map(() => 0);
  let neutral = 0;
  let total = 0;
  for (const p of [...outer.particles, ...inner.particles]) {
    total += 1;
    if (p.modelGroupIndex >= 0 && p.modelGroupIndex < perGroup.length) {
      perGroup[p.modelGroupIndex] += 1;
    } else {
      neutral += 1;
    }
  }
  return { perGroup, neutral, total, groups };
}

/** Build the detail overlay's view-model from a descriptor (pure, deterministic). */
export function buildDetailModel(d: AtomVisualDescriptor, ctx: DetailContext): DetailModel {
  const ids = d.observedModelIds ?? [];
  const counts = countNucleonsByModel(d.id, d.kind === "hub", ids);
  // modelGroups are canonicalised; match colours by index to the descriptor's
  // own colour list when the canonical id appears in it, else keep order.
  const models: DetailModelRow[] = counts.groups.map((id, i) => ({
    model: id,
    color: d.modelColors[ids.indexOf(id)] ?? d.modelColors[i] ?? d.color,
    nucleons: counts.perGroup[i] ?? 0,
    basis: modelBasis(d, id),
  }));

  const orbital: DetailFactRow[] = [
    { label: "Lane", value: d.lane },
    {
      label: "Spin",
      value:
        d.spin.mode === "measured"
          ? `${d.spin.value.toFixed(2)} rad/s (measured output tok/s)`
          : d.spin.mode === "measured-zero"
            ? "0 rad/s (measured, observed quiet)"
            : "TPS unavailable (no telemetry)",
    },
    {
      label: "Queue vibration",
      value:
        d.vibration.mode === "measured"
          ? `measured (amplitude ${d.vibration.amplitude.toFixed(1)})`
          : d.vibration.mode === "zero"
            ? "empty queue (measured)"
            : "unavailable (no queue telemetry)",
    },
    { label: "In flight", value: d.activeRequests == null ? "no data" : String(d.activeRequests) },
  ];

  const f = d.deviceFacts;
  const deviceFacts: DetailFactRow[] = [];
  const jobs: DetailJobPanel[] = [];
  if (f) {
    if (f.kind === "gpu") {
      deviceFacts.push(
        { label: "GPU util", value: fmt(f.utilizationPercent, (n) => `${n.toFixed(1)}%`) },
        {
          label: "VRAM",
          value:
            f.vramUsedBytes != null && f.vramTotalBytes != null
              ? `${(f.vramUsedBytes / 1e9).toFixed(2)} / ${(f.vramTotalBytes / 1e9).toFixed(2)} GB`
              : noData,
        },
        { label: "Temp", value: fmt(f.temperatureC, (n) => `${n.toFixed(1)} °C`) },
        { label: "Power", value: fmt(f.powerWatts, (n) => `${n.toFixed(1)} W`) }
      );
      if (f.hostedRuntimeIds && f.hostedRuntimeIds.length > 0) {
        deviceFacts.push({
          label: "Hosted runtimes",
          value: `${f.hostedRuntimeIds.join(", ")} (proven runtime_device)`,
        });
      }
    } else {
      deviceFacts.push({ label: "Model", value: f.modelId ?? noData });
    }
    const basis = "fleet telemetry sample";
    if (f.activeJobs != null && Number.isFinite(f.activeJobs)) {
      jobs.push({ key: "active", label: "Active jobs", value: f.activeJobs, basis });
    }
    if (f.queuedJobs != null && Number.isFinite(f.queuedJobs)) {
      jobs.push({ key: "queued", label: "Queued jobs", value: f.queuedJobs, basis });
    }
  }
  // Failed: real request-failed events for this provider still inside the window.
  if (d.providerId && ctx.events) {
    let failed = 0;
    for (const e of ctx.events) {
      if (e.kind === "request-failed" && e.providerId === d.providerId) {
        const age = ctx.now - e.at;
        if (age >= 0 && age <= DETAIL_FAILURE_WINDOW_MS) failed += 1;
      }
    }
    if (failed > 0) {
      jobs.push({
        key: "failed",
        label: "Failed (last 60 s)",
        value: failed,
        basis: "lifecycle failure events",
      });
    }
  }

  return {
    atomId: d.id,
    title: d.label,
    kind: d.kind,
    models,
    neutralNucleons: counts.neutral,
    neutralNucleus: models.length === 0,
    totalNucleons: counts.total,
    orbital,
    laneHue: d.laneHue || LANE_HUES.unknown,
    deviceFacts,
    jobs,
    activity: activityLine(d.visualState.state, d.energyTier, d.lastActivityAt, ctx.now),
    provenance:
      "Values are measured telemetry; decorative idle light is not activity. " +
      "Panels appear only when a real value exists.",
  };
}
