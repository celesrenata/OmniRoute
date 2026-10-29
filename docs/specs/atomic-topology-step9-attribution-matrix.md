---
title: Atomic Topology Step 9 Attribution Matrix (OR-ATOM-009 / S9.1 + W2)
---

# Atomic Topology Step 9 — Proven Attribution Matrix

Status: W2 (proven GPU runtime attribution adapter) complete. Records exactly
what each device atom may attribute, which reconciliation edge proves each
association, and which joins are unproven (→ `null` / `"unknown"`, never
fabricated). Every claim below is verified against this worktree; live
verification is **pending** (§6).

## 1. Provenance rule (invariant)

Every visual attribution on a GPU/runtime atom must trace to one of:

1. the atom's **own** reconciled `Observed` facts, or
2. a **canonical edge** in `ReconciliationResult.edges`
   (`src/shared/topology/telemetry/reconcile.ts:33-44`), or
3. the atom's own `modelId`/`attributedGpuIds` (set by the reconciler only
   from proven samples, `src/shared/topology/telemetry/reconcile.ts:205-230`).

Display names, PCI indices, host-name joins, and any unproven correlation are
never used. Absent edge ⇒ unattached ⇒ `null` / `"unknown"` (honest missing
datum, not `0` and not a guess).

## 2. Edge inventory — what `reconcileSnapshot` actually emits

| Edge                                                                         | Emitted when                                                                                      | Source evidence                                                                                                       |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `runtime_device` (source `runtime:<host>:<id>` → target `gpu:<host>:<uuid>`) | runtime has an explicit `attributedGpuIds` entry                                                  | `src/shared/topology/telemetry/reconcile.ts:205-217`                                                                  |
| `runtime_model` (→ `model:<id>`)                                             | runtime has an observed `modelId`                                                                 | `src/shared/topology/telemetry/reconcile.ts:220-230`                                                                  |
| `provider_runtime` (source `provider:<key>` → target `runtime:<host>:<id>`)  | **only** an explicit upstream source correlates them — `reconcileSnapshot` never infers this join | `src/shared/topology/telemetry/reconcile.ts:235-237` ("Absent here means unattached — we never join by display name") |

Consequence: with today's single in-repo adapter
(`src/shared/topology/telemetry/providers/omniroute.ts` — reads
`provider_connections` rows + circuit breaker states, no provider→runtime
correlation), **live `provider_runtime` edges are currently absent**. Runtimes
therefore render provider-unattached until an upstream source provides the
correlation. The adapter consumes the edge if present and fabricates nothing
if absent. The dev demo harness
(`src/plugins/atomic-topology/dev/demoHarness.ts`) likewise emits only
`runtime_device` + `runtime_model` edges (verified by grep — no
`provider_runtime` tuples).

## 3. Attribution matrix — device atoms (W2)

Adapter: `resolveAtomDescriptors` device-band loop in
`src/plugins/atomic-topology/AtomicTopologyRenderer.tsx:409-549`.
Edge indexes are built ONLY from `reconciliation.edges` (no name joins):
`runtimesByGpu` from `runtime_device` edges, `providersByRuntime` from
`provider_runtime` edges (`src/plugins/atomic-topology/AtomicTopologyRenderer.tsx:409-426`).

### GPU atom (`kind: "gpu"`)

| Field                                                               | Attribution                                                                                                                                             | Proven by                                                              | Fallback (never fabricated)                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `observedModelIds` / `modelColors`                                  | union of `modelId` over runtimes proven on this GPU (non-stale only), canonicalized (trim+lowercase), deduped, capped at 3 (matches `MAX_MODEL_GROUPS`) | `runtime_device` edge + reconciler's proven runtime `modelId`          | empty array → neutral nucleus                                           |
| `lane` / `laneHue`                                                  | `deriveLaneForProvider(observedModelIds)` — single recognizable lane → that lane; mixed → observed `unknown`; none → coloring `unknown`                 | observed model ids only (`src/shared/topology/domain/lane.ts:112-147`) | `"unknown"` (coloring default, not a lane fact)                         |
| `spin`                                                              | own measured TPS if present+fresh; else the TPS of the runtime when **exactly one** runtime is proven on the GPU; else nothing                          | own `Observed` / `runtime_device` edge                                 | `mode: "unavailable"` — **multi-runtime GPUs never split an aggregate** |
| `vibration` (queue)                                                 | `queuedJobs` of the single proven on-GPU runtime (non-stale)                                                                                            | `runtime_device` edge                                                  | `mode: "unavailable"` — never an averaged/split queue                   |
| `deviceFacts.queuedJobs` / `activeJobs`                             | same single-runtime attribution, stale-gated                                                                                                            | `runtime_device` edge                                                  | `null` (multi-runtime or stale runtime → `null`)                        |
| `deviceFacts.modelId`                                               | first observed model id (`observedModelIds[0]`)                                                                                                         | `runtime_device` edge + runtime `modelId`                              | `null`                                                                  |
| `deviceFacts.utilizationPercent / vram / temperatureC / powerWatts` | the GPU's **own** measured facts                                                                                                                        | own `Observed` fields                                                  | `null` when absent/stale                                                |
| `providerId`                                                        | **never set** — a GPU's provider link is transitive through its runtime and is never drawn directly                                                     | —                                                                      | `undefined`                                                             |
| stale handling                                                      | any decayed value on the GPU or its attributed runtime ⇒ `unavailable` / `null`                                                                         | `Observed.stale` / node `stale`                                        | —                                                                       |

### Runtime atom (`kind: "runtime"`)

| Field                              | Attribution                                            | Proven by                         | Fallback                              |
| ---------------------------------- | ------------------------------------------------------ | --------------------------------- | ------------------------------------- |
| `observedModelIds` / `modelColors` | its own reconciled `modelId`                           | runtime `modelId` (proven sample) | empty                                 |
| `lane` / `laneHue`                 | `deriveLaneForProvider([own modelId])`                 | own model id                      | `"unknown"`                           |
| `spin` / `vibration`               | own TPS / own queue                                    | own `Observed`                    | `unavailable`                         |
| `deviceFacts.*`                    | own facts; `modelId` = own `modelId` (null when stale) | own `Observed`                    | `null`                                |
| `providerId`                       | **first proven** `provider_runtime` edge source        | `provider_runtime` edge           | `undefined` when no edge (unattached) |

## 4. Test evidence (deterministic fixtures — no live source)

File: `tests/unit/atomic-topology/telemetryBinding.test.ts` (15 tests, all
pass; run: `node --import tsx/esm --test
tests/unit/atomic-topology/telemetryBinding.test.ts`).

W2 pins added this session:

| Test                                                                                | Proves                                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `W2: classifiable on-GPU model -> gpu + runtime carry the lane and the model color` | `text-embedding-3-small` residency ⇒ both atoms `lane: "embedding"`, `laneHue "#A78BFA"`, shared single model color                                                          |
| `W2: multi-runtime gpu -> no even split (proven model union, own facts only)`       | two runtimes proven on one GPU ⇒ `observedModelIds` = sorted union of both models; `deviceFacts.queuedJobs/activeJobs = null`; `spin`/`vibration` = `unavailable` (no split) |
| `W2: unproven joins -> no attribution (absent edges are never invented)`            | all edges stripped ⇒ GPU models `[]`, queue/active/model `null`, `lane "unknown"`, runtime `providerId undefined`; runtime keeps its **own** facts (own ≠ attribution)       |
| `W2: stale runtime -> its attribution to the gpu is never shown`                    | stale runtime ⇒ nothing attributed to the (fresh) GPU; GPU keeps its own spin; stale runtime itself reads `unavailable`                                                      |

The pre-existing pin `device atoms appended in the outer band with proven
facts` was updated from the T5.4 expectations (`queuedJobs/activeJobs/modelId:
null`) to the W2 single-runtime attribution (`3 / 2 / "llama-3-70b"`), and
gained the W2 proven-linkage assertions (`runtime.providerId === "openai"`,
`gpu.providerId === undefined`, GPU `observedModelIds`).

## 5. Motion parity (Step 8 — unchanged)

W2 is descriptor-driven only: no scene changes. Pause, reduced-motion and
WebGL context-loss freezes operate on the same contiguous per-atom motion
state as Step 8 (`src/plugins/atomic-topology/scene/AtomNode.tsx`,
`src/plugins/atomic-topology/scene/nucleusMotion.ts`); the adapter stays pure
(no `three`, no DOM, no clock — `resolveAtomDescriptors` is testable without
WebGL).

## 6. Live verification status — PENDING

- No reachable live fleet-telemetry source was available in this environment;
  **live verification is explicitly pending** (do not treat this document as
  live evidence).
- Deterministic coverage: the 4 W2 fixture tests above plus the 9 dev-only
  demo scenarios in `src/plugins/atomic-topology/dev/demoHarness.ts`
  (`idle`, `unknown-stale`, `tps-20`, `tps-80`, `queued-jobs`,
  `mixed-lanes`, `completion`, `failed-request`, `multi-runtime-gpu`) which
  drive the real `reconcileSnapshot` pipeline. W3's browser-truth captures
  exist under `OR_ATOM_009/screenshots/` (pre-Step-9 archive + per-scenario
  captures) but post-W2 re-capture is not yet done.
- When a live telemetry source becomes reachable: re-run the browser
  verification against the real fleet endpoint and record live TPS/queue
  values + frame/memory benchmarks per the OR-ATOM-009 required completion
  report (item 5).

## 7. Known gaps (carried forward, by design)

1. **Unproven `provider_runtime` edges** — no in-repo source currently
   correlates provider key → runtime host; runtimes therefore stay
   provider-unattached in live mode. The adapter is ready for the edge the
   moment an upstream source emits it.
2. **Per-device TPS attribution** — only _single_-runtime GPUs inherit a
   runtime's TPS/queue; multi-runtime GPUs show `unavailable` (an even split
   would fabricate values). A per-device upstream measurement would replace
   the fallback.
3. `runtime_model` edges exist on the reconciler result but are not
   consumed by the adapter — the runtime `modelId` field is the same proven
   sample, so the edge would be redundant there; it remains available for
   future link-level rendering (`resolveLinkDescriptors` does not render
   provenance edges — out of W2 scope).
