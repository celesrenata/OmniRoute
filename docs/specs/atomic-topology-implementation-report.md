---
title: Atomic Topology Implementation Report (OR-ATOM-001 v2)
---

# Atomic Topology Implementation Report (OR-ATOM-001 v2)

Status: M1, M2 (authenticated server-side Fleet Telemetry Gateway), M3
(Phase A + Phase B), M4 (single gated-WebSocket lifecycle stream + lane data +
orbit controls + bounded event pool/effects), and M6 hardening (quality
ladder, reduced motion, document-hidden pause, WebGL context-loss guard,
camera fit/focus, disposal) implemented. M5 GPU atoms are **explicitly
unavailable, not pending** — no real external GPU/runtime telemetry source
exists in the repository (§3, §4.5). M6 instancing/LOD/benchmarking remain
deferred (§4.3).
Spec: `prompt.md` (OR-ATOM-001 v2). Companion artifact:
`docs/specs/atomic-topology-telemetry-matrix.md` (M0 audit).
User guide: `docs/specs/atomic-topology-user-guide.md`.

This report records what the repository actually ships, how it is wired, what is
evidenced by tests, and — deliberately — what is **not** done yet and why. No
capability is claimed without a test or code reference.

## 1. What was delivered

### 1.1 Renderer extension point (spec §4 / M1)

- `src/shared/topology/renderer/registry.ts` — pure-TS registry
  (`registerTopologyRenderer`, `getTopologyRenderer`,
  `read/writeTopologyRendererPreference`, SSR-safe).
- `src/shared/topology/renderer/types.ts` — `TopologyRendererPlugin` contract
  (`id/name/version/supported()/mount()` returning a
  `TopologyRendererInstance` with `update/resize/setPaused/focusNode/dispose`).
- `src/shared/topology/renderer/BuiltinReactFlowRenderer.tsx` — the existing 2D
  ReactFlow implementation behind the plugin contract; self-registers under
  `reactflow-2d`, which is also the default + fallback
  (`DEFAULT_TOPOLOGY_RENDERER_ID`).
- `src/app/(dashboard)/home/ProviderTopology.tsx` — renderer **host**. It owns
  the data (normalizes props into a renderer-neutral `TopologySceneSnapshot`
  via `src/shared/topology/domain/normalizeTopology.ts`) and owns no rendering.
  It resolves the preferred renderer from localStorage, mounts it, pushes
  snapshots, and falls back to 2D with a non-blocking notice when a renderer
  throws on `mount`/`update` (AC3/AC4).
- A **2D/3D toggle** overlay in the host lets the user switch to the Atomic
  renderer and persists the preference (`writeTopologyRendererPreference`).
  2D remains the default view; the Atomic renderer is strictly opt-in.
- `src/app/(dashboard)/home/ProviderTopology2D.tsx` — the previous inline
  implementation, now wrapped by the built-in plugin. `FlowCanvas.tsx` and
  `edgeStyles.ts` were **not** modified (spec §1 invariant).

### 1.2 Atomic plugin (M3 Phase A + Phase B)

`src/plugins/atomic-topology/` — the entry (`index.ts`) is pure (no `three` /
`@react-three/fiber` at top level); the WebGL2 scene sits behind a client-only
dynamic import, so server and jsdom contexts load the plugin cheaply.

- `manifest.ts` — id `atomic`, capability `webgl2`, version 1.
- `capabilities.ts` — SSR-safe WebGL2 detection (`supported()`).
- `visualEncoding.ts` — deterministic metric → color/motion rules
  (`LANE_HUES`, `modelColor`, `spinRadiansPerSecond`, `queueVibration`,
  `UNKNOWN_MODEL_COLOR`).
- `layout.ts` — deterministic hub/ring placement.
- `eventPool.ts` — bounded request-lifecycle event pool:
  `createAtomicEventPool` (capacity 512, high watermark, 60 s max age,
  exact-dedupe) plus `mapLifecycleToAtomicEvents`, the pure bridge from the
  snapshot's bounded `lifecycle` stream (fed by the single gated dashboard
  WebSocket — see §4.4) into transient discharge effects the scene reads per
  frame without per-frame React state.
- `AtomicTopologyRenderer.tsx` — Phase B: the single client-only scene
  surface. `mountAtomicTopologyRenderer` gates on WebGL2 (typed
  `AtomicWebGLUnsupportedError` when absent, so the host falls back to 2D)
  and loads the R3F scene through a client-only dynamic `import()`, so
  `three`/`@react-three/fiber` never enter the static module graph; the pure
  `resolveAtomDescriptors` / `resolveLinkDescriptors` data→visual bridge and
  `createAtomicTopologyInstance` drive the scene imperatively via
  `update/resize/setPaused/focusNode/dispose` (idempotent no-ops after
  dispose).
- `cameraFit.ts` — deterministic camera fit/focus math (pure
  `computeCameraFit` / `computeCameraFocus` / `isUsableCameraFit`); the scene
  consumes it in `CameraRig` (fit on mount, slide-on-focus — rotation stays
  with the orbit controls).
- `quality.ts` — pure quality-fallback ladder (`high`/`medium`/`low`/`none` +
  `QUALITY_BUDGETS`) resolved from a coarse, bounded probe
  (`resolveSceneQuality`); the scene scales antialias/DPR/segment budgets from
  it.
- `scene/AtomicScene.tsx` + scene primitives (`scene/AtomNode.tsx`,
  `scene/ElectronCloud.tsx`, `scene/EnergyLink.tsx`, `scene/Nucleus.tsx`,
  `scene/SceneOrbitControls.tsx`, `scene/ContextGuard.tsx`,
  `scene/sceneContext.ts`) — the client-side R3F composition: lighting, hub
  nucleus, provider atoms, energy links, orbit/zoom/pan, document-hidden
  pause, WebGL context-loss guard, and the per-frame scene context (pool,
  focus, reduced motion, quality, snapshot time).
- `overlays/` — DOM overlay layer (`AtomicLegend`, `AtomicControls`,
  `AtomicLabels`, `AtomicTooltip`, and `AtomicTelemetryStatus` — the
  available/stale/unavailable feed-freshness badge, driven by the snapshot's
  `capturedAt` + a fixed freshness window).

### 1.3 Telemetry: authenticated server-side Fleet Telemetry Gateway (M2 / T005)

- `src/shared/topology/telemetry/` — server-side gateway: `gateway.ts`
  (bounded snapshot query, cache TTL, abort semantics), `gatewayServer.ts`
  (one process-wide `FleetTelemetryGateway` whose **only** registered backend
  is the OmniRoute-native adapter `providers/omniroute.ts`, imported
  dynamically so the SQLite/rate-limit layer never enters the route's static
  graph), `provenance.ts` (`Observed<T>` tags `source`/`sampledAt`; **absent
  values are `null`, never `0`**), `httpQuery.ts` (strict query-schema
  validation — window bounds, strict keys), `mergeSnapshots.ts`, and
  `types.ts`. Tested under `tests/unit/telemetry/`.
- `src/app/api/telemetry/fleet/route.ts` — `GET /api/telemetry/fleet`:
  management-authenticated (`requireManagementAuth` before any data access),
  force-dynamic, one bounded snapshot per call — no browser fan-out, no
  per-atom queries, no external backend. Errors route through
  `buildErrorBody` (hard rule #12).
- **Hard limit — no external GPU/runtime source in the repository.** The M0
  audit (companion matrix) found zero GPU/device-metric producers
  (no `vram`/`gpu_util`/`temperature`/`power_draw`/`nvidia-smi`/NVML source,
  no Prometheus/InfluxDB/Grafana client, no exporter/agent). The gateway
  therefore keeps every GPU/runtime device fact `null` with documented
  unavailable provenance (`unavailable:no-gpu-exporter-in-repo`): GPU atoms
  and GPU metrics are unavailable by construction — not gated on
  configuration, and never fabricated (§3, §4.5).
- No dashboard consumer is wired to the endpoint in this checkout (verified
  by source search: only the route, the matrix, and the tests reference
  `/api/telemetry/fleet`), so the scene renders from core-owned snapshot
  data. The gateway is the shipped, tested read-side surface.

### 1.4 Tests shipped

- `tests/unit/atomic-topology/` — capabilities, camera fit, visual encoding,
  layout, event pool, plugin contract, and quality-ladder suites; the Phase B
  lifecycle/descriptor bridge (relocated from
  `tests/integration/atomic-topology/`, which had no test collector — see
  §4.1); `sceneOrbitControls.test.ts` (orbit-control presence + wiring); and
  `live-request-lifecycle-hook.test.tsx` (the gated-WebSocket lifecycle
  stream).
- `tests/unit/telemetry/` — gateway, native provider, provenance, snapshot
  merge, query mapping, and the management-authenticated fleet route.
- `tests/unit/topology/` — built-in 2D renderer, registry + preference, and
  host-adjacent suites; `lane.test.ts` and the lane blocks in
  `normalizeTopology.test.ts` (lane data); `lifecycle-normalization.test.ts`
  (bounded lifecycle stream).
- 5 pre-existing topology suites were updated to match the host refactor.

Verification of these suites is recorded by the implementation work; this
documentation pass adds no new measurements. The last dated measurement in
this report — 2026-10-12 (M4-closure): **184** topology+atomic+telemetry
node:test cases (183 pass, 1 skip, 0 fail — 109 in
`tests/unit/topology` + `tests/unit/atomic-topology`, 75 in `telemetry`);
**12** vitest host/2D cases (12 pass);
`scripts/check/check-test-discovery.mjs` PASS (orphaned tests eliminated) —
predates some of the suites listed above.

## 2. Architecture / separation of responsibilities (spec §4.6)

| Responsibility                                                          | Owner                                       |
| ----------------------------------------------------------------------- | ------------------------------------------- |
| Provider/device/model identity, edges, health/traffic, navigation, auth | `normalizeTopology.ts` (core)               |
| Telemetry sources, auth, query, normalization, freshness, cache         | `src/shared/topology/telemetry/`            |
| Renderer-neutral immutable scene data                                   | `TopologySceneSnapshot` (`domain/types.ts`) |
| Deterministic metric → color/motion                                     | `visualEncoding.ts`                         |
| GPU drawing, interpolation, camera, picking, effects                    | `AtomicTopologyRenderer.tsx` + `scene/`     |
| Labels, tooltips, accessible controls                                   | `overlays/`                                 |

## 3. Invariants held

- **No synthetic GPU/device facts.** No core module emits `kind: "gpu"`
  nodes — the type is forward-compatible only — and **no real external
  GPU/runtime telemetry source exists in the repository** (M0 audit; the
  gateway keeps GPU/runtime facts `null` with
  `unavailable:no-gpu-exporter-in-repo` provenance). GPU atoms and GPU
  metrics are therefore explicitly unavailable, not implemented. Remote
  providers stay provider nodes.
- **Absent ≠ zero.** Provenance carries `null` for unobserved values; the
  visual layer decays to neutral (idle/unknown) rather than inventing data.
- **2D intact.** The default renderer is byte-for-byte the pre-plugin 2D
  implementation wrapped in the plugin contract; `FlowCanvas`/`edgeStyles`
  unmodified.
- **Fallback never crashes the panel.** Mount/update throws dispose the
  renderer and fall back to 2D with a non-blocking notice.
- **SSR-safe plugin entry.** No top-level `three`/R3F imports; verified by the
  import graph and by the plugin loading in node (capability `false`).

## 4. Known deferrals and rationale (honest)

### 4.1 Test-hygiene fixes applied in this repair

1. **Orphaned integration test** — the Phase B lifecycle/descriptor suite
   originally sat under `tests/integration/atomic-topology/`, a path no test
   collector covers, so it never ran and the repo's own discovery gate
   (`check-test-discovery.mjs`) flagged it as orphaned. It was **relocated**
   to `tests/unit/atomic-topology/atomicSceneBridge.test.ts` (a collected
   path) and the now-empty `tests/integration/atomic-topology/` directory
   removed. The discovery gate now passes with no new orphans.
2. **Stale Phase A assertion** — `tests/unit/atomic-topology/plugin.test.ts`
   still expected `AtomicMountNotImplementedError`
   (`ATOMIC_MOUNT_NOT_IMPLEMENTED_PHASE_A`) after Phase B landed. Updated to
   expect the real Phase B typed error `AtomicWebGLUnsupportedError`
   (`ATOMIC_WEBGL_UNSUPPORTED`).
3. **0-byte placeholder** — the empty
   `tests/unit/atomic-topology/atomicSceneBridge.test.ts` was replaced by the
   relocated real test.

### 4.2 Lane hue: now plumbed (M4-closure)

The spec's visual-encoding rule is "electron-cloud hue = request/job lane".
This M4 data task is **closed**. In M1 the snapshot carried no per-node lane,
so the adapter set `lane: "unknown"` for every node rather than inventing one
(fabricating a lane would violate the no-synthetic-facts invariant, §3). The
lane is now derived from **actual in-flight traffic**, still with no
fabrication:

- `src/shared/topology/domain/lane.ts` — conservative keyword classifier.
  `deriveLaneFromModel` maps an in-flight model id to a `TopologyLane`
  (`embedding`/`rerank`/`vision`/`image`/`audio`) via distinctive family
  tokens, or `null` when nothing matches; `deriveLaneForProvider` collapses a
  provider's in-flight ids to a single observation (or `null`). `chat`,
  `prefill`, and `decode` are deliberately **absent** from `TOPOLOGY_LANES` —
  "every model that is not clearly a specialist is a chat model" is exactly
  the fabrication the invariant forbids. The hub never gets a lane.
- `normalizeTopology` populates `node.lane?: Observed<TopologyLane>` from the
  in-flight request set: no traffic → the field is _absent_; all ids classify
  to one family → that lane (source `live-event`); ids span more than one
  family → the one honest `unknown`, with a per-model `(model, lane)` basis.
- The adapter reads `node.lane` (via `asJobLane`, a compile-time
  `TopologyLane ⊆ JobLane` subsumption) instead of hard-coding `"unknown"`;
  the existing `LANE_HUES` mapping activates unchanged. Absent observation
  still renders the neutral `unknown` hue — a coloring default, never an
  observed lane fact.

### 4.3 Instancing / LOD / benchmarking deferred — M6 release milestone

Part of the M6 hardening has landed: the quality-fallback ladder
(`quality.ts` → `QUALITY_BUDGETS` scaling antialias/DPR/segment budgets), the
document-hidden RAF pause (`AtomicScene.tsx`), and the per-frame pooled
effects (event pool discharges read in `useFrame`). Atom meshes are still
drawn individually, not via `InstancedMesh`: the spec's §12 instancing, LOD,
and benchmarking items remain the M6 [RELEASE] milestone. Deferring keeps the
scene simple and correct; the current atom counts (provider scale, typically
<100) are well within direct-draw budget. A profile-guided instancing pass
is an M6 task, not an M1/M3 correctness item.

### 4.4 Scene: orbit controls + event-pool motion landed (M4/M6)

`scene/AtomicScene.tsx` mounts `scene/SceneOrbitControls.tsx` inside the
`<Canvas>`: the user can **orbit, zoom, and pan** around the hub
(`three`'s `OrbitControls`, damped, distance-clamped to the scene's frustum).
The component is SSR-safe — it renders `null` (no R3F primitive) and only
constructs the imperative controls in `useEffect`, guarded on
`gl.domElement`, so it is a no-op during server render and in jsdom. It
deliberately avoids `@react-three/drei` to keep the 3D dependency surface to
`three` + `@react-three/fiber` (both already in the scene graph) and to own
the damping + dispose lifecycle explicitly.

**Single gated WebSocket lifecycle stream.** Live request transitions arrive
on the _same_ gated dashboard live-WebSocket that feeds the 2D panel —
`useLiveRequests` derives a bounded, exact-deduped `LiveRequestLifecycleEvent`
stream (cap 256, key `phase:requestId:observedAt`),
`HomeProviderTopologySection` folds it into the host (no second socket), and
`normalizeTopology.ts` bounds/dedupes it into the snapshot's `lifecycle`
field (`MAX_LIFECYCLE_EVENTS = 256`; absent input → no field, never a fake
empty feed). The Atomic adapter maps that bounded stream into the event pool
on every `update` (`mapLifecycleToAtomicEvents` → `pool.ingest`), and the
scene primitives read transient discharges per frame (`EnergyLink` flare,
atom discharge) — animated in normal mode, a one-shot settle under reduced
motion. No streaming ticks are lifecycle events; anything else is dropped,
never guessed.

Still deferred (M6): instancing / LOD / benchmarking (§4.3). M5 ("fleet GPU
atoms + measured motion") is **not pending configuration** — it is excluded
by the repository's hard limit: no real external GPU/runtime telemetry source
exists, so GPU atoms and GPU metrics remain explicitly unavailable (§3,
§4.5).

### 4.5 Telemetry: M2 endpoint shipped; no external source exists (hard limit)

The Fleet Telemetry Gateway (§1.3) is implemented, tested, and served
(`GET /api/telemetry/fleet`, management-authenticated). What is **not**
shipped — and cannot be shipped from this repository — is any external
telemetry source: the M0 audit found no Prometheus/InfluxDB/Grafana client,
no exporter/agent process, and no GPU/device-metric producer anywhere in
`src/` / `open-sse/`. Consequences:

- GPU/runtime device facts in gateway snapshots are `null` with
  `unavailable:no-gpu-exporter-in-repo` provenance — **never fabricated,
  never `0`**. GPU atoms and GPU metrics stay explicitly unavailable (§3);
  M5 is a hard boundary of the repository, not an unconfigured dependency.
- The topology panel has no consumer wiring it to the endpoint in this
  checkout; the scene renders from core-owned snapshot data (identity,
  health, traffic, and the gated-WebSocket lifecycle stream). If an operator
  later adds an external datasource, the read-side surface to consume is this
  gateway — no browser fan-out, no per-atom queries.

## 5. Gate & test evidence

Verification of the current suites is recorded by the implementation work;
this documentation pass adds no new measurements. The last dated run
(2026-10-12, M4-closure) recorded:

- `check-test-discovery.mjs` — PASS (6671 files, 32 collectors, no new orphans).
- Topology + Atomic suites (incl. M4-closure) — 109 tests: 108 pass, 1 skip
  (guarded DOM smoke), 0 fail. New M4-closure coverage: `lane.test.ts`
  (classifier + anti-fabrication invariants, 12), `normalizeTopology.test.ts`
  lane blocks (5), `atomicSceneBridge.test.ts` lane→descriptor bridge (3),
  `sceneOrbitControls.test.ts` orbit-control presence + wiring (3).
- Telemetry suites — 75 tests: 75 pass, 0 fail.
- Combined scope — 184 tests: 183 pass, 1 skip (guarded DOM smoke), 0 fail.
- Host/2D vitest suites — 12/12 pass.
- ESLint on the touched surface — clean.
- Typecheck — no errors in plugin/host/topology files (remaining `tsc` errors
  are pre-existing baseline noise in `open-sse/` + `FlowCanvas` CSS import; one
  pre-existing WIP debt in `tests/unit/topology-provider-nodes-arc.test.ts`
  line 84 — a stale `TopologyEntry` literal missing an `id` — predates that
  run and is unrelated to lane/orbit work).

That run predates some suites now on disk (camera fit, quality, lifecycle
hook, fleet route); the current scope is the suites listed in §1.4.

- Last recorded live-render observation (2026-10-12): app boots; `/home`
  shows the Provider Topology card in 2D (default), the 2D/3D toggle is
  present, console has no plugin-related errors. Lane hues + orbitable
  camera in the live 3D view are confirmed by the deterministic descriptor
  tests (`atomicSceneBridge`, `sceneOrbitControls`) and the classifier unit
  tests; a manual WebGL2 screenshot pass was pending (headless CI has no GPU
  context).

## 6. File map

```
src/shared/topology/
  domain/{types,normalizeTopology,lane}.ts  core data + snapshot + lane + lifecycle
  renderer/{registry,types,BuiltinReactFlowRenderer}
  telemetry/{gateway,gatewayServer,httpQuery,mergeSnapshots,provenance,
             types,providers/omniroute}     server-side, tested
src/app/api/telemetry/fleet/route.ts        management-authenticated fleet snapshot (M2)
src/app/(dashboard)/
  dashboard/HomeProviderTopologySection.tsx  feeds the gated-WS lifecycle stream
  home/ProviderTopology.tsx                  host (owns data, 2D/3D toggle)
  home/ProviderTopology2D.tsx                built-in 2D implementation
src/plugins/atomic-topology/
  index.ts manifest.ts capabilities.ts quality.ts cameraFit.ts
  visualEncoding.ts layout.ts eventPool.ts
  AtomicTopologyRenderer.tsx
  scene/{AtomicScene,AtomNode,ElectronCloud,EnergyLink,Nucleus,
         SceneOrbitControls,ContextGuard,sceneContext}
  overlays/{AtomicLegend,AtomicControls,AtomicLabels,AtomicTooltip,
            AtomicTelemetryStatus}
tests/unit/{atomic-topology,telemetry,topology}/   incl. lane, lifecycle, orbit,
                                                   quality, and camera-fit suites
docs/specs/atomic-topology-*.md                  this report, matrix, user guide
```
