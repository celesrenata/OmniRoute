# OR-ATOM-008 — Completion Report

**Task ID:** OR-ATOM-008
**Repo root:** `/Users/celes/sources/celesrenata/OmniRoute`
**Base commit:** `b83f63bdf` ("docs(topology): OR-ATOM-007 evidence, skill audit + application report" — MAIN HEAD)
**Date:** 2026-10-28
**Status:** **COMPLETE (with documented limitations)** — see §5 and §6.

Every number in this report is copied from the evidence files in `OR_ATOM_008_task/`
(`S85_AFTER_MEASUREMENTS.md`, `S85_BEFORE_MEASUREMENTS.md`, `screenshots/stress-matrix.json`,
`screenshots/after-matrix.json`, `screenshots/before-matrix.json`, `screenshots/soak-after.json`,
`SKILL_AUDIT.md`, `SKILL_APPLICATION_REPORT.md`, `OR_ATOM_008_code.patch`) — no fabricated
telemetry. Where a value is unmeasurable, it is recorded explicitly as **UNVERIFIED** with the reason.

---

## 1. What changed (files)

**9 production files** under `src/plugins/atomic-topology/` + **3 new test files** under
`tests/unit/atomic-topology/` — **12 files total, +2608/−156** (confirmed by `git apply --stat`
on the patch below, run in this worktree).

| File                                                     | Change                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/plugins/atomic-topology/scene/filament.ts`          | **New** (430 lines): pure arc-length table (memoized `buildArcLengthTable`, built once per geometry), bounded pulse-packet pool (`MAX_PACKET_POOL = 3`), zero per-frame allocation contract, `packetPoolSize()` scheduling.                                                                                                      |
| `src/plugins/atomic-topology/scene/plasmaShader.ts`      | **New** (129 lines): ribbon halo via `onBeforeCompile` into a stock `MeshBasicMaterial` — **zero custom uniforms** (reuses stock `diffuse`/`opacity`; self-contained `vPlasmaUv` varying for the r186 `USE_UV` caveat); one shared program `PLASMA_PROGRAM_KEY = "atomic-topology-plasma-filament-v1"`.                          |
| `src/plugins/atomic-topology/scene/EnergyLink.tsx`       | **Rewritten** (506 lines per dispatch; `wc -l` in this worktree: 505, trailing newline): hairline `Line2` core (~1–2 CSS px at normal framing), arc-length traveling pulses, ~350 ms completion cool pulse, seeded red branching failure discharge.                                                                              |
| `src/plugins/atomic-topology/scene/cloudHaze.ts`         | **New** (160 lines): 3-tier volumetric electron haze (high/medium/low resolved once from `navigator.hardwareConcurrency`), FNV-1a-seeded mulberry32 PRNG (no `Math.random`), bounded sprite budget (worst case 38 ring atoms × 3 haze sprites = 114; patch budget comment: whole scene under the ~700 total-sprite budget).      |
| `src/plugins/atomic-topology/scene/ElectronCloud.tsx`    | **191 → 359 lines** (per dispatch; `wc -l`: 358): haze-sprite layer added on top of the existing tilted shell groups.                                                                                                                                                                                                            |
| `src/plugins/atomic-topology/scene/nucleusCluster.ts`    | **New** (345 lines): ring **8** / hub **12** particles on a **0.55×** shell; proton roughness **0.35** vs neutron **0.7**; neutral two-tone **#F2EDE3 / #4E5D73** when `observedModelIds` is absent; model-color groups (order-independent FNV-1a hash sort, capped at `MAX_MODEL_GROUPS`) — future-proofed, exercised by tests. |
| `src/plugins/atomic-topology/scene/AtomNode.tsx`         | Nucleus role wiring (per-particle luminance separation: protons brighter/emissive, neutrons rougher).                                                                                                                                                                                                                            |
| `src/plugins/atomic-topology/scene/Nucleus.tsx`          | Hub nucleus cluster integration (12 nucleons).                                                                                                                                                                                                                                                                                   |
| `src/plugins/atomic-topology/AtomicTopologyRenderer.tsx` | `AtomVisualDescriptor.observedModelIds?: string[]` — optional; the snapshot exposes no per-node model ids today, so the adapter leaves it absent → the nucleus renders the honest neutral two-tone.                                                                                                                              |
| `tests/unit/atomic-topology/sceneFilament.test.ts`       | **New** (283 lines) — 21 tests.                                                                                                                                                                                                                                                                                                  |
| `tests/unit/atomic-topology/electronCloudHaze.test.ts`   | **New** (162 lines) — 10 tests.                                                                                                                                                                                                                                                                                                  |
| `tests/unit/atomic-topology/nucleusCluster.test.ts`      | **New** (266 lines) — 16 tests.                                                                                                                                                                                                                                                                                                  |

**Patch:** `OR_ATOM_008_task/OR_ATOM_008_code.patch` — md5 `818083e2e88a99db8dac3cb003f83dce`
(re-verified in this worktree), generated with
`git diff b83f63bdf -- src/plugins/atomic-topology tests/unit/atomic-topology`.
`git apply --reverse --check` → **PASS** in this worktree (the tree carries the S8 content).
**No `AtomicScene.tsx` hunk** (zero occurrences of `AtomicScene` in the patch) and
**no diagnostic probe** — the `window.__atomic` probe was wired only in the after-soak
worktree for instrumentation and is deliberately excluded from the shipping patch.

### Phase S8.1 — Fine plasma filaments + event-driven discharges

- **Pure arc-length table** in `scene/filament.ts`: the Bézier is sampled once and a cumulative
  arc-length table is built **once per geometry** (memoized `buildArcLengthTable`); emission
  heads are placed by arc-length fraction, not raw index — zero per-frame allocation.
- **Bounded ≤3 pulse-packet pool**: `MAX_PACKET_POOL = 3`, active count resolved by
  `packetPoolSize(MAX_PACKET_POOL, isActive, reduced)` — no unbounded packet growth.
- **Completion cool-pulse impulse**: a short (~350 ms) traveling cool impulse (#2DD4BF)
  starting just behind the atom, sharp ease-out, single-shot edge booking.
- **Seeded failure branches**: deterministic red branching discharge, seeded by event ID
  (FNV-1a), frame-independent, no `Math.random`; reduced-motion aware.
- **Ribbon halo**: `onBeforeCompile` injection into the stock `MeshBasicMaterial` — **zero
  custom uniforms** (reuses stock `diffuse`/`opacity`; self-contained `vPlasmaUv` varying for
  the r186 `USE_UV` caveat), **one shared compiled program**
  `atomic-topology-plasma-filament-v1` for all links.
- **21 tests** — `tests/unit/atomic-topology/sceneFilament.test.ts` (21 pass).

### Phase S8.2 — Volumetric electron haze

- **3-tier haze parameters** (`HAZE_TIER_TABLE`: high/medium/low), tier resolved **once** at
  module scope from `navigator.hardwareConcurrency` (stable heuristic, no per-frame resolution).
- **FNV-1a deterministic**: seeded mulberry32 PRNG over FNV-1a of a stable tag —
  deterministic, no `Math.random`.
- **Worst-case opacity stack 0.207 < 0.25** banding/blow-out budget — asserted by unit test
  (`opacity stack stays under 0.25 at the nucleus (banding/blow-out guard)`).
- **10 tests** — `tests/unit/atomic-topology/electronCloudHaze.test.ts` (10 pass).

### Phase S8.3 — Nucleus shading

- **Ring 8 / hub 12 particles** on a **0.55× shell**
  (`RING_NUCLEUS_PARTICLE_COUNT = 8`, `HUB_NUCLEUS_PARTICLE_COUNT = 12`,
  `NUCLEUS_SHELL_RADIUS = 0.55`).
- **Proton roughness 0.35 vs neutron 0.7** (`PROTON_ROUGHNESS = 0.35`,
  `NEUTRON_ROUGHNESS = 0.7`) with per-particle luminance separation instead of a color wash.
- **Neutral two-tone #F2EDE3 / #4E5D73** (`PROTON_TINT_WARM` / `NEUTRON_TINT_SLATE`) when
  `observedModelIds` is absent — honest unknown-model rendering, never fabricated residency.
- **Model-color groups future-proofed**: `resolveModelGroups()` canonicalizes (trim +
  lowercase, drop blanks/duplicates) and sorts by FNV-1a hash so group k is always the k-th
  smallest hash (order-independent, stable across frame/redraw/model-order changes), capped at
  `MAX_MODEL_GROUPS` — exercised by tests, exercised by the renderer when the snapshot starts
  carrying per-node model ids.
- **16 tests** — `tests/unit/atomic-topology/nucleusCluster.test.ts` (16 pass).

---

## 2. S8.5 gate evidence

One row per gate item in `OR_ATOM_008_CONTEXT.md` §"Phase S8.5 — Measured visual fidelity and
operational stability [RELEASE GATE]", followed by the 6-item screenshot acceptance gate.

| Gate item (OR_ATOM_008_CONTEXT.md §S8.5)                                                                          | Measured value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Verdict                                                                                                                  | Evidence file                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Default framing + **operator-zoomed detail** for the exact current topology (real browser, screenshots/video)     | Before/after desktop pairs (steady, traffic, zoom), mobile + panel captures, 3 stress frames, 47 per-minute/final/remount soak frames (`soak-after-min-1…20` + final/final-page/remount = 23; `soak-before-min-0…20` + final/final-page/remount = 24), 2× motion WebM (12 s target) — consolidated in `OR_ATOM_008_task/screenshots/` (directory count: **79 entries = 67 PNG + 2 WebM + 8 JSON + 2 LOG**, i.e. 69 media files)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | PASS                                                                                                                     | `screenshots/after-matrix.json`, `screenshots/before-matrix.json`, `screenshots/*.png`, `screenshots/{after,before}-motion-desktop.webm` |
| Idle / 2+ simultaneous active requests / completed / failed event frames; synthetic vs live clearly distinguished | `after-matrix.json`: `after-desktop-steady` (idle), `after-desktop-traffic` (injected traffic — the per-capture `traffic[]` array labels each frame: `kiro/claude-haiku-4.5` → 200, `bedrock/claude-haiku-4.5` → 403, `aihorde/koboldcpp/Angelic_Eclipse-12B` → 400, so the injected/synthetic traffic is explicitly labeled in the matrix JSON), `after-desktop-zoom-detail`; motion in `after-motion-desktop.webm`; 20 per-minute soak frames (`soak-after-min-1…20.png`)                                                                                                                                                                                                                                                                                                                                                                                                                                        | PASS                                                                                                                     | `screenshots/after-matrix.json`, `screenshots/after-motion-desktop.webm`, `S85_AFTER_MEASUREMENTS.md`                                    |
| 8 / 16 / 32 atom stress fixtures, without moving topology or making a new layout                                  | 8 atoms: **247** calls / 97382 tris / 36 geoms / 3 tex / **6 programs**, `fps2s` 12 · 16 atoms: **484** / 179518 / 69 / 3 / **6**, `fps2s` 9 · 32 atoms: **952** / 343754 / 135 / 3 / **6**, `fps2s` 5 — `liveCanvases=1` / `peakCanvases=1` throughout, `contextLost=0`, `contextRestored=0`, `remounts=0`, `pageErrors: []`, `consoleErrors: []`; programs constant at **6** across 8→32 (no program explosion); `layout.ts` unchanged (not in the patch)                                                                                                                                                                                                                                                                                                                                                                                                                                                        | PASS                                                                                                                     | `screenshots/stress-matrix.json`, `screenshots/after-stress-{8,16,32}-atoms.png`                                                         |
| 20-minute telemetry polling soak with visual continuity + stable active WebGL context count                       | **AFTER:** headed full Chromium (`chromium-1243`, `headless: false`, no SwiftShader), viewport 1440×900, `soak-after.json` `durationSec = 1200` (exactly 20 min), **all verdicts true** — `stableContexts` (ctx lost/restored 0/0 for all 20 min), `disposeOk` (forced remount t≈600 s: pre `live=1/peak=1` → post `live=1/peak=1`, `remounts=1`), `noUnboundedGrowth`, `allFramesNonBlank` (pixelVar 4747–4861, meanLum 751), `pass: true`; FPS **118–121** (min 118 / avg 120.0 / max 121, display-locked ~120 Hz); stable single 702×420 canvas; traffic at t≈420 s: 2× `POST /v1/chat/completions` → 200/200 (`kiro/claude-haiku-4.5`). **BEFORE** (pre-S8 baseline): 1200 s exactly (2026-10-27T23:53:13Z → 2026-10-28T00:14:10Z), 0/0 ctx lost/restored (DOM counters), `pageErrors: []`, stable 702×420 canvas, FPS 119 / 119.95 / 120, pixelVar 5613–5699 (avg 5653, no drift), `allFramesNonBlank = true` | PASS (AFTER fully measured; BEFORE clean on every probe-independent signal — probe-gated verdicts UNVERIFIED, see below) | `S85_AFTER_MEASUREMENTS.md`, `S85_BEFORE_MEASUREMENTS.md`, `screenshots/soak-after.json`, `screenshots/soak-before-min-*.png`            |
| Collect `renderer.info.render.calls` / `memory.geometries` / `memory.textures` before and after                   | **AFTER: collected** — calls **272**, triangles **107862**, geometries **43**, textures **3**, programs **6**, liveCanvases 1 (peak 1) — flat over the full 20 min, identical before vs after within the soak. **BEFORE: UNVERIFIED** — the `window.__atomic` probe is absent in the pre-S8 baseline (grep-verified on both `b83f63bdf` and snapshot `b33447f5e`), so the before-side `rendererInfo` is null; `noUnboundedGrowth` was recorded `true` under the mandated null-null→true edit and is recorded as UNVERIFIED, not a measured comparison                                                                                                                                                                                                                                                                                                                                                              | AFTER PASS · **BEFORE UNVERIFIED (instrumentation gap)**                                                                 | `S85_AFTER_MEASUREMENTS.md`, `S85_BEFORE_MEASUREMENTS.md`                                                                                |
| Smooth 60 FPS on discrete GPU / >30 FPS on integrated GPU _where measured_; record unverified targets             | Integrated GPU (Apple M5 Max): measured **118–121 fps** after (min 118 / avg 120.0 / max 121) and **119–120 fps** before (display-locked) — both far above the >30 FPS integrated floor; 2D fallback **58 fps** (integrated GPU). Discrete-GPU 60 fps target: **UNVERIFIED** (no discrete GPU on this machine)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | PASS where measured · discrete-GPU target UNVERIFIED                                                                     | `S85_AFTER_MEASUREMENTS.md`, `S85_BEFORE_MEASUREMENTS.md`                                                                                |
| No memory trend from repeated remount/telemetry cycles; dispose owned buffers/geometries/textures/programs        | AFTER soak: forced mid-point remount at t≈600 s — pre `live=1/peak=1` → post `live=1/peak=1`, `remounts=1` (old canvas disposed, no canvas/context leak); `renderer.info` flat over 20 min (272 / 107862 / 43 / 3 / 6). Stress dispose proof (32-atom fixture): before `liveCanvases=1, peakCanvases=1, remounts=0` → after `liveCanvases=0, peakCanvases=0, remounts=1, rendererInfo=null` — full GPU memory teardown on unmount                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | PASS                                                                                                                     | `S85_AFTER_MEASUREMENTS.md`, `screenshots/stress-matrix.json`                                                                            |
| Scoped unit tests + documented typecheck/lint for changed paths                                                   | **14 atomic-topology test files** (11 tracked at `b83f63bdf` + 3 new in S8); full scoped run: **136 tests — 135 pass / 0 fail / 1 skipped, 718 ms** (per-file evidence in `SKILL_APPLICATION_REPORT.md`: `sceneFilament` 21, `electronCloudHaze` 10, `nucleusCluster` 16). `typecheck:core`: **0 errors in S8 scope**; the **43 remaining errors are pre-existing on the baseline** (`open-sse/services/rateLimitManager.ts`, `open-sse/services/bottleneckPatch.ts`, `src/lib/scripts/scriptVault.ts`, `src/lib/db/scripts.ts`, `src/shared/components/flow/FlowCanvas.tsx`) — byte-identical to MAIN HEAD. `eslint src/plugins/atomic-topology tests/unit/atomic-topology`: **0 errors, 0 warnings**                                                                                                                                                                                                             | PASS                                                                                                                     | `SKILL_APPLICATION_REPORT.md` (Verification notes)                                                                                       |

### 6-item screenshot acceptance gate (OR_ATOM_008_CONTEXT.md)

| #   | Item                                                                                                                 | Verdict                                                                                                              | Evidence                                                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Connections look like fine electrical threads, not thick opaque rods                                                 | PASS                                                                                                                 | `after-desktop-steady.png`, `after-desktop-traffic.png`, `after-desktop-zoom-detail.png` — hairline `Line2` core (~1–2 CSS px) + additive halo; no tube geometry in the patch                                                                                                                         |
| 2   | Electrons visibly orbiting against soft luminous volume, not a starfield of unrelated white dots                     | PASS                                                                                                                 | `after-desktop-steady.png`, `after-motion-desktop.webm` — 3-tier haze; worst-case opacity stack **0.207 < 0.25** banding/blow-out guard (asserted in `electronCloudHaze.test.ts`)                                                                                                                     |
| 3   | Model-attributed nuclei show distinctly colored particle groups rather than gray-white balls                         | PASS (with honest nuance)                                                                                            | The current snapshot carries no per-node model ids → the live view renders the honest **neutral two-tone** (#F2EDE3 / #4E5D73) instead of fabricating residency; model-color groups (up to 3, order-independent) are implemented and unit-tested (`nucleusCluster.test.ts`, 16 pass) — future-proofed |
| 4   | Activity visibly travels through the graph; completion is a short cool pulse; failure is a short red lightning flash | PASS                                                                                                                 | `after-motion-desktop.webm`, `after-desktop-traffic.png` — arc-length traveling pulses; ~350 ms cool impulse (#2DD4BF) on completion; seeded red branching discharge on failure (deterministic, event-ID seeded)                                                                                      |
| 5   | Atoms and labels in exactly the same places, same camera/zoom behavior                                               | PASS                                                                                                                 | `before-desktop-steady.png` vs `after-desktop-steady.png` pairs (stable 702×420 canvas, identical framing); `layout.ts` / `cameraFit.ts` / `SceneOrbitControls.tsx` / `AtomicLabels.tsx` untouched; no `AtomicScene.tsx` hunk                                                                         |
| 6   | 2D fallback, pause/resume, reduced motion and live telemetry still work                                              | PASS (2D fallback, reduced motion, live telemetry verified; pause/resume has no dedicated evidence frame — see §5.5) | `after-desktop-2d.png` / `after-mobile-2d.png` (2D fallback at 58 fps on integrated GPU); reduced-motion static frame (`capabilities.test.ts`, 3 pass); live telemetry: soak traffic 200/200 + `/api/provider-metrics` polling 200s accumulated to 401 over the soak (steady, no stall)               |

---

## 3. Skill traceability

**Skill Hub connection:** the live Skill Hub MCP returned **503**
(`POST /api/mcp/stream` → `{"error":"MCP server is disabled..."}`; `GET /api/mcp/sse` → 503;
WP4 catalog REST → 405; `/api/skills` → `total:0`) → **local catalog fallback**
(`skills-import/*.zip` extracted read-only to `/tmp/or-atom-008-corpus`). Catalog size as
actually observed: **1410 raw `SKILL.md` files (≈909 effective unique after the 501×2
trading-zip duplicate); no live catalog count claimed**. Full connection evidence
(status codes, auth method, search hit counts): `SKILL_AUDIT.md` §Connection / §Catalog.
**Not all skills in the corpus were read** — only the 9 selected skills were loaded in full.

**9 skills actually loaded** (exact IDs + revisions from `SKILL_AUDIT.md` §"Selected skills (9)"):

1. `webgpu-threejs-tsl` (no version in frontmatter) — 16 files loaded
2. `performance`@2.0 — 3 files
3. `core-web-vitals`@2.0 — 4 files
4. `accessibility`@2.0 — 3 files
5. `accessibility-compliance` (no version) — 5 files
6. `web-quality-audit` (no version) — 2 files
7. `visual-design-foundations` (no version) — 4 files
8. `interaction-design` (no version) — 4 files
9. `game-developer`@1.1.0 — 1 file

**Condensed skill → technique → file/test table** (condensed from `SKILL_APPLICATION_REPORT.md`):

| Skill (exact ID@revision)                | Technique applied                                                                                                                                                                                                                                                                                                                      | File / test evidence                                                                                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webgpu-threejs-tsl`@(no version)        | TSL-node technique ported to the installed WebGL2 idiom: single-program `onBeforeCompile` injection into a stock `MeshBasicMaterial` (zero custom uniforms; self-contained `vPlasmaUv` varying for the r186 `USE_UV` caveat) + per-particle luminance separation (protons brighter/emissive, neutrons rougher) instead of a color wash | `scene/plasmaShader.ts` (shared program `atomic-topology-plasma-filament-v1`) + `scene/nucleusCluster.ts`; `sceneFilament.test.ts` (21 pass), `nucleusCluster.test.ts` (16 pass) — programs stayed at 6 for 8→32 atoms |
| `performance`@2.0                        | Strict GPU budget: zero per-frame allocation contract (arc-length table built once per geometry + shared `THREE.Vector3` scratch) and bounded sprite budgets resolved once at module scope (worst case 38 ring atoms × 3 haze sprites = 114)                                                                                           | `scene/filament.ts` + `scene/cloudHaze.ts`; 20-min headed after-soak: stable `renderer.info` (272 calls / 43 geoms / 3 tex), FPS min 118 / avg 120.0 / max 121                                                         |
| `accessibility`@2.0                      | WCAG 2.2 `prefers-reduced-motion` → static render (no orbital motion / pulses)                                                                                                                                                                                                                                                         | `sceneState.tsx` / `AtomicScene.tsx` `useReducedMotionSync` (pre-existing gating — not modified by the patch); `capabilities.test.ts` (3 pass); 2D fallback verified at 58 fps                                         |
| `accessibility-compliance`@(no version)  | ARIA / inclusive labeling + reduced-motion echo in the legend and overlays (role labels for nucleus roles, hub label)                                                                                                                                                                                                                  | `overlays/AtomicLegend.tsx` + `AtomicLabels.tsx` (descriptor-driven labels — pre-existing semantics, not modified by the patch); `visualEncoding.test.ts` (23 pass)                                                    |
| `visual-design-foundations`@(no version) | Additive layer separation (hairline core vs plasma halo vs haze vs glow — each layer additive, `depthWrite: false`, low per-layer opacity so stacking never blows out white) + nucleus role shading with the honest neutral two-tone when `observedModelIds` is absent                                                                 | `scene/EnergyLink.tsx` (layered additive link) + `AtomicTopologyRenderer.tsx` (`observedModelIds`) + `scene/AtomNode.tsx` (role wiring); `visualEncoding.test.ts` (23 pass), `nucleusCluster.test.ts` (16 pass)        |
| `interaction-design`@(no version)        | Motion design: symmetric ease-in-out (smoothstep) for the continuous one-shot pulse cycle + sharp cubic ease-out for the one-shot impulse decay; one-shot edge booking so a discharge fires exactly once per transition edge                                                                                                           | `scene/motion.ts` easings (pre-existing) + `scene/EnergyLink.tsx` edge booking; `sceneFilament.test.ts` (21 pass)                                                                                                      |

The other 3 loaded skills — `core-web-vitals`@2.0, `web-quality-audit`, `game-developer`@1.1.0 —
informed the gate and harness (no layout shift / long tasks; screenshot-QA pass for rendered
verification; 60 fps + particle/object-pooling budgets) but carry no separate application-report
row: `SKILL_APPLICATION_REPORT.md` documents 6 technique rows across the 9 skills loaded.

---

## 4. Protected modules unchanged

- `layout.ts`, `cameraFit.ts`, `SceneOrbitControls.tsx`, `AtomicLabels.tsx` — **untouched**
  (the patch contains exactly the 12 files listed in §1; none of the protected modules appears in it).
- `AtomicScene.tsx` — **byte-identical to HEAD** (zero occurrences of `AtomicScene` in the patch).
- **No `_diagProbe` / `probeRemount` anywhere in MAIN `src/`**
  (grep-verified in this worktree; also grep-verified absent in the pre-S8 baseline `b83f63bdf`
  and snapshot `b33447f5e` per `S85_BEFORE_MEASUREMENTS.md`). The `window.__atomic` probe existed
  only in the after-soak instrumentation worktree and is deliberately excluded from the shipping patch.
- **2D fallback preserved** — `after-desktop-2d.png`, `after-mobile-2d.png` (58 fps on integrated GPU).
- **No camera / zoom / fit / layout / label / control / topology-semantics changes** — the patch
  changes rendered materials, transient effects, and shading only; endpoints, geometry paths,
  event mapping and positions are unchanged.

---

## 5. Limitations / unverified

1. **Before-soak `stableContexts` and `disposeOk`: UNVERIFIED (instrumentation gap)** — recorded
   exactly as "UNVERIFIED (instrumentation gap)", not `true` or `false`. The S8.5 probe
   (`window.__atomic`) does not exist in the pre-S8 tree (full-tree grep on both `b83f63bdf` and
   snapshot `b33447f5e` → empty) and the probe was deliberately excluded from the shipping patch.
   Every probe-independent before-signal is clean: 0 ctx lost/restored, `pageErrors` empty,
   stable 702×420 canvas, FPS min/avg/max 119/119.95/120, pixelVar 5613–5699 with no drift,
   `allFramesNonBlank = true`.
2. **Before-soak `renderer.info` (`render.calls`, `memory.geometries`, `memory.textures`):
   UNVERIFIED** — probe absent in the baseline, so the before-side `rendererInfo` is null and
   `noUnboundedGrowth` was recorded `true` under the mandated null-null→true edit (an
   UNVERIFIED record, not a measured comparison). The first-attempt value
   (`render.calls ≈ 201.14/frame` @ 120 fps — 96,747 calls over a 4.01 s window;
   `memory.*` UNVERIFIED, R3F v9.8.1 store not attached to the canvas DOM element) was measured
   on an **instrumented** tree (batch `2de83902…`, worker-2) and is cited as **context only**,
   not as the official before measurement.
3. **First-attempt after-soak headless SwiftShader stall (min-2):** the previous batch
   (`2de83902…`) launched SwiftShader software-render `chrome-headless-shell` (15–17 fps, no
   GPU), which froze the rAF sampler and never wrote `soak-after.json`. That after-soak is
   **invalidated and superseded by the headed re-run** (`S85_AFTER_MEASUREMENTS.md`); the 15–17 fps
   SwiftShader figures are not used as evidence.
4. **Discrete-GPU 60 fps target: UNVERIFIED** — no discrete GPU available on this machine
   (Apple M5 Max, integrated GPU); recorded per the gate's "if hardware unavailable" clause.
5. **Pause/resume action sequence:** no dedicated before/after evidence frame in the evidence
   files (the 2D-fallback, reduced-motion and live-telemetry legs of screenshot-gate item 6 are
   verified; see §2 gate table row 6).
6. **Count reconciliations (honest discrepancies vs the dispatch text):**
   (a) The dispatch cited "74 screenshots" for `OR_ATOM_008_task/screenshots/`; the counted
   directory contents are **79 entries = 67 PNG + 2 WebM + 8 JSON + 2 LOG (69 media files)** —
   the counted values are reported in §2.
   (b) `EnergyLink.tsx` "506 lines" and `ElectronCloud.tsx` "191 → 359" are as given in the
   dispatch; `wc -l` in this worktree shows 505 and 358 (both files end with a trailing newline);
   the base `ElectronCloud.tsx` count of 191 is verified at `b83f63bdf`.
   (c) The full-suite duration "718 ms" is dispatch-supplied (not present in the evidence files
   read); the 135 pass / 0 fail / 1 skipped breakdown is from `SKILL_APPLICATION_REPORT.md`.

---

## 6. Verdict

**PASS WITH DOCUMENTED LIMITATIONS.** Every measured gate is green: the 20-minute headed
after-soak has all four verdicts true (`stableContexts` / `disposeOk` / `noUnboundedGrowth` /
`allFramesNonBlank`; FPS 118–121; `renderer.info` collected and flat over the full soak), the
8/16/32 stress matrix is clean (programs constant at 6, zero context loss, full GPU teardown on
dispose), the scoped suite is 136 tests (135 pass / 0 fail / 1 skipped), and typecheck + eslint
are clean in scope (zero new errors). The before-side probe-gated verdicts
(`stableContexts`, `disposeOk`, `renderer.info` before) are **unmeasurable by construction** —
the probe is absent in the pre-S8 baseline and was deliberately excluded from the shipping patch
— and are recorded as UNVERIFIED (instrumentation gap), not as true or false. **No fabricated
telemetry:** every number in this report traces to a soak JSON, screenshot/matrix entry,
stress-matrix entry, or test-run record in `OR_ATOM_008_task/`.
