---
title: Atomic Topology Implementation Report (OR-ATOM-001 v2)
---

# Atomic Topology Implementation Report (OR-ATOM-001 v2)

Status: M1 + M3 (Phase A + Phase B) + M4-closure (lane data + orbit controls) implemented; M2 live-source wiring / M5 GPU atoms / M6 instancing+perf still gated (see §5).
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
- `eventPool.ts` — bounded visual event-pool contract (capacity, high watermark,
  max age) — pure, testable.
- `AtomicTopologyRenderer.tsx` — Phase B: `mountAtomicTopologyRenderer` (typed
  `AtomicWebGLUnsupportedError` when WebGL2 is absent), the pure
  `resolveAtomDescriptors` / `resolveLinkDescriptors` data→visual bridge, and
  `createAtomicTopologyInstance` (imperative instance driving the scene via
  `update/resize/setPaused/focusNode/dispose`).
- `scene/AtomicScene.tsx` + overlays (`AtomicLegend`, `AtomicControls`,
  `AtomicLabels`, `AtomicTooltip`) — the client-side scene and DOM overlay
  layer.

### 1.3 Telemetry gateway + provenance (§9)

- `src/shared/topology/telemetry/` — server-side gateway: source adapters,
  `provenance.ts` (`Observed<T>` tags `source`/`sampledAt`; **absent values are
  `null`, never `0`**), query-schema validation (window bounds, strict keys),
  and normalization. Tested under `tests/unit/telemetry/`.
- **Not yet consumed by the app**: no runtime telemetry source is configured in
  this environment, so the scene renders from core-owned data only (M2 gate,
  see §5). This is by design: the spec forbids presenting synthetic
  telemetry-derived facts.

### 1.4 Tests shipped

- `tests/unit/atomic-topology/` — manifest, capabilities, visual encoding,
  layout, event pool, plugin contract, and the Phase B lifecycle/descriptor
  bridge (relocated from `tests/integration/atomic-topology/`, which had no
  test collector — see §4.1); plus `sceneOrbitControls.test.ts` (orbit-control
  presence + wiring, M4-closure).
- `tests/unit/telemetry/` — gateway, provenance, query schema.
- `tests/unit/topology/` — built-in 2D renderer + host-adjacent suites; plus
  `lane.test.ts` and the lane blocks in `normalizeTopology.test.ts`
  (M4-closure lane data).
- 5 pre-existing topology suites were updated to match the host refactor.

Latest measured run (2026-10-12, M4-closure): **184** topology+atomic+telemetry
node:test cases (183 pass, 1 skip, 0 fail — 109 in
`tests/unit/topology` + `tests/unit/atomic-topology`, 75 in `telemetry`);
**12** vitest host/2D cases (12 pass).
`scripts/check/check-test-discovery.mjs`: PASS (orphaned tests eliminated).

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

- **No synthetic GPU/device facts.** M1/M3 never emits `kind: "gpu"` nodes;
  the type is forward-compatible only. Remote providers stay provider nodes.
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

### 4.3 Instancing / LOD / effect caps deferred — M6 release milestone

Atom meshes are drawn individually, not via `InstancedMesh`. The spec's §12
performance items (instancing, LOD, effect caps, hidden-tab RAF pause,
quality profiles, benchmarking) are explicitly the M6 [RELEASE] milestone.
Deferring keeps the scene simple and correct; the current atom counts
(provider scale, typically <100) are well within direct-draw budget. A
profile-guided instancing pass is an M6 task, not an M1/M3 correctness item.

### 4.4 Scene: orbit controls landed; motion still M4/M5 targets

`scene/AtomicScene.tsx` now mounts `scene/SceneOrbitControls.tsx` inside the
`<Canvas>`: the user can **orbit, zoom, and pan** around the hub
(`three`'s `OrbitControls`, damped, distance-clamped to the scene's frustum).
The component is SSR-safe — it renders `null` (no R3F primitive) and only
constructs the imperative controls in `useEffect`, guarded on
`gl.domElement`, so it is a no-op during server render and in jsdom. It
deliberately avoids `@react-three/drei` to keep the 3D dependency surface to
`three` + `@react-three/fiber` (both already in the scene graph) and to own
the damping + dispose lifecycle explicitly.

Still deferred (M4/M5 visual targets per the spec's milestone plan):
per-model nucleus particles and event-pool-driven motion. The event pool
(§1.2) is a tested pure contract, but live feed events do not populate it
yet, and M5 ("fleet GPU atoms + measured motion") is conditional on real
telemetry data (§4.5).

### 4.5 Telemetry consumer not wired — M2 gate

The gateway (§1.3) is implemented and tested but has **no app consumer** and
no configured source (Grafana/Prometheus/Influx) in this environment. Wiring
a live source, the 1–2 Hz fleet-snapshot query cadence, and stale-decay is
the M2 milestone and is gated on the operator configuring a read-only
datasource (spec §9.9). Until then the panel is correct by showing only
core-owned facts.

## 5. Gate & test evidence (2026-10-12)

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
  line 84 — a stale `TopologyEntry` literal missing an `id` — predates this
  change and is unrelated to lane/orbit work).
- Live render — app boots; `/home` shows the Provider Topology card in 2D
  (default), the 2D/3D toggle is present, console has no plugin-related errors.
  Lane hues + orbitable camera in the live 3D view are confirmed by the
  deterministic descriptor tests (`atomicSceneBridge`, `sceneOrbitControls`)
  and the classifier unit tests; a manual WebGL2 screenshot pass is pending
  (headless CI has no GPU context).

## 6. File map

```
src/shared/topology/
  domain/{types,normalizeTopology,lane}.ts core data + snapshot + lane classifier
  renderer/{registry,types,BuiltinReactFlowRenderer}
  telemetry/{gateway,provenance,...}       server-side, tested
src/plugins/atomic-topology/
  index.ts manifest.ts capabilities.ts
  visualEncoding.ts layout.ts eventPool.ts
  AtomicTopologyRenderer.tsx
  scene/{AtomicScene,SceneOrbitControls}.tsx
  overlays/{AtomicLegend,AtomicControls,AtomicLabels,AtomicTooltip}
src/app/(dashboard)/home/
  ProviderTopology.tsx                     host (owns data, 2D/3D toggle)
  ProviderTopology2D.tsx                  built-in 2D implementation
tests/unit/{atomic-topology,telemetry,topology}/   incl. lane + orbit-control suites
docs/specs/atomic-topology-*.md           this report, matrix, user guide
```
