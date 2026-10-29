# OR-ATOM-009 / W1 — Telemetry Signal Contract

Worker W1 deliverable: a **pure** (no DOM / React / DB / network) mapping from a
`ReconciliationResult` to per-atom "motion signals". This document is the binding
interface contract the other workers and the integrator build against.

**Module:** `src/shared/topology/telemetry/atomSignals.ts`
**Tests:** `tests/unit/atomic-topology/atomSignals.test.ts`

## 1. Interface (verbatim)

The contract is implemented **exactly** as below. Sibling workers and the
integrator import these names/types from the module path above.

```ts
export type AtomKind = "gpu" | "runtime" | "provider";
export type SignalSource = "live" | "demo" | "unavailable" | "stale";

export interface AtomMotionSignal {
  resourceId: string;
  kind: AtomKind;
  /** Measured decode speed (tok/s) or null when unknown/missing/stale —
   * rotation speed is a downstream function of this. */
  tokensPerSecond: number | null;
  /** Real attributable queued-job count or null. */
  queuedJobs: number | null;
  activeJobs: number | null;
  /** Verified model IDs bound to THIS atom (never guessed; [] = none proven). */
  modelIds: string[];
  /** True only when the GPU atom has proven per-device throughput attribution
   * (Observed basis says so). */
  gpuHasProvenThroughput: boolean;
  source: SignalSource;
  sampledAt: number | null;
  basis?: string;
}

export interface ReconciliationSignals {
  perAtom: Map<string, AtomMotionSignal>;
  /** Proven edges only — never synthesized. */
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

export function buildAtomSignals(
  reconciliation: ReconciliationResult | null | undefined
): ReconciliationSignals;
export function mergeDemoSignals(
  live: ReconciliationSignals,
  demo: ReconciliationSignals
): ReconciliationSignals;
```

## 2. Source of truth for the input shape

Every field W1 reads comes from the reconciliation types (already-frozen
contracts, not W1's to change):

- `Observed<T>` — `src/shared/topology/telemetry/types.ts:69-84`.
  - `value: T | null` — `null` means "observed as absent/unknown", which is
    distinct from the field being absent (`missing`). A literal `0` is a real
    measurement and is kept (`types.ts:70-73`).
  - `stale?: boolean` — the pre-computed staleness flag (`types.ts:80`).
  - `basis?: string` — how the value was produced (`types.ts:81-83`).
- `ReconciliationResult` — `reconcile.ts:85-94`: `capturedAt` (`:87`),
  `gpuNodes` (`:88`), `runtimeNodes` (`:89`), `providerNodes` (`:90`), `edges`
  (`:91`), `providerCentricFallback` (`:93`).
- `ReconciledGpuNode.outputTokensPerSecond` — `reconcile.ts:56`.
- `ReconciledRuntimeNode`: `modelId` (`:65`), `outputTokensPerSecond` (`:66`),
  `queuedJobs` (`:67`), `activeJobs` (`:68`), `attributedGpuIds` (`:70`).
- `ReconciledProviderNode`: `outputTokensPerSecond` (`:78`), `queuedJobs`
  (`:79`), `activeJobs` (`:80`).
- `ReconciliationEdge`: `source` (`:35`), `target` (`:37`), `relation` (`:39`),
  `basis` (`:41`), `sampledAt` (`:43`).

## 3. Semantic rules (HARD — with reconcile.ts / types.ts citations)

**Freshness mapping (per field).** The four states are driven by the
`Observed` shape and its pre-computed flags:

| Observed state                     | maps to value | `source`        | citation                            |
| ---------------------------------- | ------------- | --------------- | ----------------------------------- |
| fresh, non-null number (even `0`)  | the number    | `"live"`        | `reconcile.ts:25-26`; `types.ts:72` |
| `stale === true`                   | `null`        | `"stale"`       | `reconcile.ts:96-104`               |
| field absent (`undefined`)         | `null`        | `"unavailable"` | `reconcile.ts:25-26`                |
| `value === null` (observed absent) | `null`        | `"unavailable"` | `types.ts:70-73`                    |

- A stale value is **last-known-neutral** — never a fake zero, never a
  "spinning guess" (`reconcile.ts:25-26`). Staleness is read from the
  pre-computed `stale` flag; W1 never re-derives age
  (`isStaleObserved`, `reconcile.ts:102-104`).
- `sampledAt` / `basis` on the signal are taken from the **throughput**
  Observed (rotation speed is a downstream function of TPS). When that field
  is absent, `sampledAt` is `null` and `basis` is `undefined`.

**Throughput is never redistributed.**

- A GPU atom's `tokensPerSecond` comes **only** from the GPU node's own
  `outputTokensPerSecond` (a per-device fact — the reconciler copies it
  straight from the device sample, `reconcile.ts:139-140`).
- A runtime's TPS is **never** split / averaged / redistributed across its
  `attributedGpuIds`. This is the reconcile invariant at `reconcile.ts:22-24`
  ("a runtime's TPS goes to a GPU ONLY when the runtime metric carries
  per-device attribution; NEVER an even split across GPUs").
- Consequence: when only the runtime has TPS and the GPU does not, the GPU
  signal's `tokensPerSecond` stays `null` and `gpuHasProvenThroughput` is
  `false`. When both have their own values, each keeps its own — never the
  average (covered by the "NO TPS splitting" tests).
- `gpuHasProvenThroughput` is `true` **iff** the GPU's own
  `outputTokensPerSecond` is a fresh, non-null number.

**`modelIds` — verified attribution only.**

- Runtime atom: its own `modelId` (verified, from the sample —
  `reconcile.ts:164`) as a single-entry list, else `[]`.
- GPU atom: the `modelId`(s) of runtime nodes whose `attributedGpuIds` include
  that GPU. Attribution is the per-device provenance established at
  `reconcile.ts:169-178` (deviceUuid fact → `buildCanonicalResourceId`,
  `types.ts:143`). Never model names parsed from labels, never from provider
  atoms. Deduped; full list kept.
- Provider atom: always `[]` — provider atoms are never conflated with
  models/devices (`reconcile.ts:74`, header invariant `reconcile.ts:16-17`).
- **Display cap:** the 3-entry cap is applied **downstream** (rendering
  layer), NOT here — the signal carries the full list.

**Edges + passthrough.**

- `edges` is copied **1:1** from `reconciliation.edges` (proven only — the
  reconciler only emits edges it can prove, header invariant
  `reconcile.ts:18-21`). Field mapping: `source`→`sourceId`, `target`→
  `targetId`, `relation`/`basis`/`sampledAt` preserved verbatim.
- `providerCentricFallback` and `capturedAt` pass through from the
  reconciliation (`reconcile.ts:87`, `:93`).
- `buildAtomSignals(null)` / `buildAtomSignals(undefined)` → empty `perAtom`,
  empty `edges`, `providerCentricFallback: false`, `capturedAt: 0`.

**`mergeDemoSignals(live, demo)`.**

- Returns `demo` when `demo.perAtom.size > 0`, else `live` (the demo harness
  feeds the same `ReconciliationResult` shape, so it is converted to
  `ReconciliationSignals` before the merge).
- When demo wins, every atom's `source` is stamped `"demo"` (on fresh signal
  objects — inputs are never mutated) so the renderer can badge demo-fed
  motion as distinct from live telemetry.

## 4. What the renderer consumes today (context for the integrator)

The frozen renderer currently binds only two telemetry-derived motion values —
`spinRadiansPerSecond` and `queueVibration` — sourced from the reconciliation's
provider/runtime/device joins:

- `src/plugins/atomic-topology/AtomicTopologyRenderer.tsx:291` — reads
  `snapshot.fleetTelemetry` (the `ReconciliationResult`).
- `:346-347` — provider-atom spin + queue vibration from the measured provider
  join.
- `:397-403` — device (GPU) atom spin + queue vibration, with stale nodes
  forced to the neutral (unavailable) form.

The integrator (a later worker) is expected to route these through
`buildAtomSignals` / `mergeDemoSignals` and read `tokensPerSecond`,
`queuedJobs`, `activeJobs`, `modelIds`, `gpuHasProvenThroughput`, `source` and
`basis` from the signals. W1 does **not** touch the renderer.

## 5. Files FROZEN for W1 (do NOT modify)

W1's scope is exactly the three files it creates. The following are **frozen**
for W1 and are wired by the integrator later:

- `src/plugins/atomic-topology/AtomicTopologyRenderer.tsx`
- `src/plugins/atomic-topology/scene/*`
  (`AtomicScene.tsx`, `AtomNode.tsx`, `cloudHaze.ts`, `cloudShells.ts`,
  `ContextGuard.tsx`, `discharge.ts`, `ElectronCloud.tsx`, `EnergyLink.tsx`,
  `filament.ts`, `geometry.ts`, `motion.ts`, `Nucleus.tsx`,
  `nucleusCluster.ts`, `oneShot.ts`, `plasmaShader.ts`, `sceneContext.ts`,
  `SceneOrbitControls.tsx`, `sceneResources.ts`, `sceneState.tsx`)
- `src/plugins/atomic-topology/overlays/*`
  (`AtomicControls.tsx`, `AtomicLabels.tsx`, `AtomicLegend.tsx`,
  `AtomicTelemetryStatus.tsx`, `AtomicTooltip.tsx`)

Plus the whole HARD FREEZE in `OR_ATOM_009/CONTEXT.md:15-17`: camera /
orbit / zoom / pan, framing, `layout.ts`, `cameraFit.ts`,
`SceneOrbitControls.tsx`, node positions, name labels, collision / projection,
UI controls, existing Step 8 filaments / clouds / glows, and the 2D ReactFlow
fallback. No invented metrics, no new metrics stack, no redesign.
