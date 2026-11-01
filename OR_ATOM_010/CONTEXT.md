# OR-ATOM-010 — Cinematic Atomic Renderer: Visual Fidelity, Not More Plumbing

**Priority:** P0 visual milestone  
**Implementation:** OmniRoute / Menagerie  
**Scope:** Existing Atomic Topology renderer's appearance, material/shader pipeline, glow, luminous particles, energy-link aesthetics, and demonstrable visual quality.  
**Status:** Proposed; not implemented by this pack.

## 0. The decision

We are **far short of the original visual concept**, despite substantial technical progress through Steps 1–9.2. Steps 8–9 implemented useful rendering primitives and data flow, but the default scene still reads like a plain network diagram with grey balls, occasional white particles, and dim links. A technically correct particle emitter is not equivalent to the colorful, dimensional plasma/atomic simulation in the concept artwork.

**Step 10 is not a telemetry, routing, camera, layout, or UI-controls task.** The primary goal is an immediately, unmistakably improved **rendered look**. The same existing positions, edges, camera/orbit/zoom behavior, projected labels, controls, topology semantics, and 2D fallback must remain intact.

### Evidence / source baseline

- Main public release: `release/v3.8.52` at `b26a6d8a9e7a` (observed October 29, 2026). Step 9 material/visual effects are present there.
- Step 9.2: `fix/atomic-0092-proven-routing` at `f24d25a8196a` (observed), based on release and ahead by four commits; its `OR_ATOM_009_2/IMPL_REPORT.md` documents a deployed image `3.8.52-oratom0092-e3ada315` and **one live** `provider:vllm → runtime:192.168.133.3:q27` join. It does _not_ document a complete GPU relationship for every runtime. Do not conflate this branch with the public release branch or assert all Step 9.2 commits were deployed.
- Original visual concept images (included under `references/`):
  - `omniroute_neon_gpu_topology_dashboard.png` — **primary look reference** for provider topology.
  - `neon_gpu_topology_dashboard.png` — secondary reference for distinct atom shells, colorful nuclei, and action links.
  - `gpu_galaxy_neon_topology_dashboard.png` — secondary reference for atmosphere and multi-atom coherence.
  - `neon_gpu_atom_dashboard.png` — optional _close-up material target_; do not copy its entire dashboard layout.
- These images are **aspirational art**, not literal live data. Model names, counts, charts, colors, and figures in the artwork are not production observations.

## 1. Hard freeze — user has repeatedly insisted on this

Do NOT alter the following while executing this step:

- Camera position, orbit interaction, zoom limits, user-driven zoom, reset, projection, auto-fit, near/far logic.
- Existing topology layout algorithm, atom coordinates, link routing endpoints, or node spacing.
- Labels, their positions, projection/collision logic, provider navigation, current controls, 2D fallback.
- Data types, current telemetry mapping, request processing, source credentials, fleet metrics API, or production routing.
- Existing working Step 9 nucleus motion, queue vibration, color semantics, or event gating.

A previous screenshot was intentionally zoomed in. **Do not interpret cropped atoms in such screenshots as layout defects.** Capture default and close-up views separately.

Only modify the **rendering inside existing scene objects and optional developer-only visual controls**. If a material enhancement forces a change in camera/layout/label code, reject that enhancement or provide an isolated rendering-only alternative.

## 2. Visual target — what an observer should see at a glance

The reference artwork has a clear hierarchy:

1. **Recognizable colorful nucleus** — multiple tightly-packed _glossy, illuminated_, visibly distinct model-colored protons/neutrons; even at default zoom each atom looks like an atom, not a smooth grey sphere with dandruff.
2. **Luminous electron system** — noncoplanar colorful energetic orbitals and soft, translucent shells, with moving highlights, motion trails and a few crisp bright electron points. A cloud should feel three-dimensional rather than thin hoops/flat dots.
3. **Electric routing network** — skinny filament with a fine bright core, colored traveling energy pulses and occasional branching arcs ONLY when attributable request events occur. Never an opaque grey pipe across the scene.
4. **Atmospheric depth and contrast** — tasteful glow/halos and faint local motes so the scene looks energetic even when idle. Preserve dark-background contrast and label readability; avoid washed-out white bloom.
5. **Distinct states and lanes** — steady motion/identity glow may be aesthetically rich when idle, but no fake throughput, queue pressure, completed jobs, failures, or active requests. Real measurements still drive the active effects.

### Appearance at two scales

- **Default topology zoom:** each node has a discernible colored nucleus and one/two sharp luminous orbital cues. Links are visually thin and subordinate to the atoms; the hub remains identifiable. No required change to existing framing.
- **User zooms in:** layered 3D particles and orbital volume become obvious, with beautiful colored rim highlights, bright electron points, and believable energy effects. Mesh tessellation, texture resolution, and instanced particle detail must hold up.

## 3. Required implementation work (ordered)

### T10.0 — Baseline and skill-guided material plan

- Read `AGENTS.md`, the current _local_ worktree, and original reference images. Don't accidentally work from the older public release when the local worktree has newer Step 9.2 changes.
- Capture a **baseline** at default zoom and operator-like close-up zoom, with deterministic live/DEMO signals and identical camera state for before/after.
- Use OmniRoute Skill Hub MCP search/load for WebGL2, GLSL, React Three Fiber, postprocessing, shader materials, GPU particles, rendering/performance and cinematic color. Record exact IDs, revisions, instructions applied and code locations. If hub unavailable, use local skill corpus and honestly label the fallback.
- Inspect actual dependencies. Existing release has `@react-three/fiber` 9.8.1 and `three` 0.186.1; do not assume `@react-three/postprocessing` is installed.
- Write a **5-point visual rubric** with reference-aligned examples before changing rendering code. Never accept “looks better” solely from a developer's opinion.

### T10.1 — Make one golden atom look spectacular FIRST

Build an isolated dev-only **material test bench** using exactly the same production `AtomNode`, `Nucleus`, `ElectronCloud` primitives, shaders, and lifecycle logic. It should show a provider atom, GPU atom, and hub in realistic sizes at two camera distances. It may feed deterministic explicitly labeled DEMO signals; it must not alter production scene layout or telemetry.

Render three provenance conditions: known model(s) (1 and 3 colors), unknown model, and stale. Prove model colors appear on the nucleus **from every relevant viewing angle**, not just in dev data objects.

Do not fan out changes to the whole topology until the golden atom passes reference comparison.

### T10.2 — Nucleus material and composition

- Audit `AtomNode.tsx`, `Nucleus.tsx`, `nucleusCluster.ts`, `sceneResources.ts` including three.js instance colors and emissive/Fresnel injection. Determine why final screen colors remain pale/grey despite model-color descriptors. Capture actual screenshots (not code assertions).
- Visually separate protons vs neutrons using material response/size, but preserve up to three **proven model** hues per GPU. Rich saturated colors, specular highlights, colored rim lighting, contact/shadow separation between nucleons, and clean silhouettes are required.
- Avoid a large uniform base sphere hiding colored nucleons. Improve the _materials/opacity/relative dimensions inside the atom only_, not the atom's world-space placement, collision bounds, or camera fit.
- Unknown/stale model assignment remains neutral, but neutral need not mean featureless flat grey: restrained blue-silver sheen is acceptable without representing a model.
- Prefer shared/instanced geometry/materials and per-instance color attributes; any shader injection must apply to instanced colors correctly. Avoid `onBeforeCompile` behavior whose color path loses model hue.

### T10.3 — Volumetric electron clouds and glowy orbital ribbons

- Upgrade `ElectronCloud.tsx` + related shaders. Keep existing orbital motion/number and lane-hue semantics but make them **visible and dimensional**.
- Combine: sharp animated electron heads; soft additive trails; a thin luminous orbital ribbon with gradient and texture/phase; one or more translucent depth-layered cloud shells/haze per atom; subtle irregular swirling (deterministic shader noise, not CPU-per-sprite randomness).
- Use view-dependent Fresnel/soft-particle edges or camera-facing billboards where appropriate; preserve transparency/depth sorting and avoid z-fighting. Do not turn everything into an opaque sphere or a giant overexposed halo.
- Colors: observed lane hue = dominant color; where lane is unknown, neutral/cool ambient is allowed but cannot imply an active lane. Hue transitions are smooth and frame-independent.
- Material quality must survive enlarged focused views and normal topology zoom.

### T10.4 — Filament and event FX cinematic pass

- Keep existing edges/endpoints, provenance rules, event pool, failure semantics, and active/idle gating.
- Replace anything that still looks like a pipe/flat ribbon with **sub-pixel-to-few-pixel fine electric strands**, a faint halo, and occasional traveling light packets. Use shader UV travel, a tapered envelope, subtle sine/noise warp, and narrow highlight; avoid physically moving the link endpoint.
- Active request: colored packet(s) visually travel. Completion: distinct short green/cyan discharge. Failure: sharp brief RED branching lightning plus nucleus red flash. No ambient fake job event when idle.
- Ensure bloom highlights the genuinely emissive particles/filaments without boosting the entire grey background or labels.

### T10.5 — Postprocessing and color science

- Evaluate _one_ compatible WebGL2 postprocessing path (e.g. `@react-three/postprocessing` EffectComposer + Bloom) **only if it materially improves the scene**. Selective bloom can be approximated via emissive HDR materials with `toneMapped=false` and `luminanceThreshold≈1` instead of an expensive second scene render; verify with actual library version. See the provided online documentation references in `REFERENCES.md`.
- Add restrained bloom/threshold, tonemapping/exposure consistency, optional tiny local particles/soft halo and subtle background depth cues. A light atmosphere should not fake job events, obscure data, or lower label contrast.
- Avoid postprocessing effects that reduce visibility on Safari/WebGL2, produce white cores, leak render targets, or double the total frame time. Provide a no-postFX fallback within the existing quality ladder.

### T10.6 — Honest visual control and accessibility

- Data-driven values remain anchored to real Observed/provenance fields. Decorative idle light, gentle orbital motion, and ambient particles are explicitly not operational telemetry. Emission event effects only for proven events.
- Respect `prefers-reduced-motion`: no fast orbit, jitter, strobing lightning, or aggressive pulsing. Colors and text still explain states.
- Preserve existing UI controls and labels. Do not add a new always-visible toolbar for this task.
- Put temporary A/B visual toggles behind a dev-only query parameter, not a production button. Remove or gate test-only controls at completion.

### T10.7 — Performance, stability and browser proof

- Benchmark 8 / 16 / 32 atoms using realistic links, with both idle and active event rates and low/high quality. Test actual hardware browser when available; software WebGL FPS does not establish real GPU performance.
- Target ≥60 FPS at normal fleet size on a capable discrete GPU and graceful ≥30 FPS fallback for low tiers; **record actual measured numbers and environment** instead of asserting they were achieved.
- Minimize material/geometry instance counts, keep per-frame updates outside React state, recycle temporary vectors and objects, avoid new render targets each telemetry update, and dispose WebGL resources on remount/context loss.
- Run at least 20 minutes with 3.5-second fleet telemetry updates and test 2D/Atomic toggling and forced context loss/recovery.

## 4. Why this deserves a different workflow

Stop implementing four separate small cosmetic tweaks and declaring success because unit tests pass. Require **two consecutive gates**:

**Gate A: material prototype (single atom)**. Create screenshot(s) showing the same GPU atom before/after at exact camera coordinates. The new nucleus and cloud must read immediately closer to the reference artwork. Without a genuinely striking atom, do not touch the full topology.

**Gate B: integration (entire existing graph)**. Apply the verified materials and energy effects across actual topology with no change to layout/camera/labels. Capture paired screenshots and 10–15 second motion videos under clearly labeled DEMO active/idle/failure scenarios and real workload when available.

### Quality rubric (each 0–5, reviewed from rendered screenshots)

| Criterion                | 0–1 (fail)                               | 4–5 (target)                                                   |
| ------------------------ | ---------------------------------------- | -------------------------------------------------------------- |
| Nucleus color separation | grey/white marble, colors invisible      | saturated clustered particles, visibly 1–3 distinct model hues |
| Electron-cloud depth     | small isolated dots or flat rings        | luminous ribbon, soft volumetric shell, sharp orbit highlights |
| Connections              | pipes, wide rectangles or flat dark bars | fine energetic filaments + distinct traveling packets          |
| Lighting/materials       | chalky white, dim matte spheres          | glossy/specular/color-rich rims, tasteful bloom                |
| Overall fidelity         | same as Step 8/9 at a glance             | unmistakable leap toward provided concept references           |
| Operational truth        | simulated traffic shown as live          | idle decorative vs measured workload explicitly separate       |

**Acceptance:** ≥4/5 on the first five visual criteria at a user-normal zoom _and_ an intentionally zoomed close-up, with no blocker on operational truth. If a baseline value already meets target, preserve it. Record before/after images and evaluator notes. If criteria fail, do another shader/material iteration rather than marking the task complete.

Do not use raw pixel equality against concept art; the concept contains impossible/fictitious data and different composition. Evaluate distinct visual features and hierarchy against the reference.

## 5. Proposed files (verify against current worktree)

Primary implementation scope:

```text
src/plugins/atomic-topology/scene/AtomNode.tsx
src/plugins/atomic-topology/scene/Nucleus.tsx
src/plugins/atomic-topology/scene/nucleusCluster.ts
src/plugins/atomic-topology/scene/ElectronCloud.tsx
src/plugins/atomic-topology/scene/EnergyLink.tsx
src/plugins/atomic-topology/scene/sceneResources.ts
src/plugins/atomic-topology/scene/AtomicScene.tsx        # scene-only light/postFX integration; NOT camera code
src/plugins/atomic-topology/quality.ts                   # shader/postFX budget only
src/plugins/atomic-topology/scene/shaders/*              # optional
src/plugins/atomic-topology/dev/*                        # optional isolated test bench
```

Keep the shared topology domain, metrics, `layout.ts`, `cameraFit.ts`, `SceneOrbitControls.tsx`, `AtomicLabels.tsx`, `AtomicControls.tsx`, and the 2D renderer UNCHANGED.

Unit tests (shader parameter bounds, deterministic model-color grouping, reduced motion, disposal), visual regression artifacts, and timed WebGL stability tests must accompany changed code.

## 6. Delivery contract for Menagerie

Deliver in the repository task area (respecting `AGENTS.md` tracked-artifact rules):

- `VISUAL_AUDIT.md` — what made the original UI look pale/flat, and actual fixes, by file/line.
- `SKILL_APPLICATION.md` — selected live Skill Hub/local corpus skills and exactly what was applied; no invented claims.
- `screenshots/baseline-default.png`, `baseline-closeup.png`, `after-default.png`, `after-closeup.png` (same camera states/viewports; archive older references separately).
- `screenshots/material-bench-{known,unknown,stale}.png` and 10–15-second short visual recordings where supported.
- `VISUAL_SCORECARD.md` with rubric scores, comparative notes and any remaining defects.
- `PERFORMANCE.md` with hardware/browser, actual frame times, GPU resources, 20-min soak and context-loss results.
- `TESTS.md` with reproducible commands and outcomes, exact source SHA, and deployment status (deployed/not deployed).

Do not claim actual production deployment, live graphics verification or pass scores without evidence. Do not deploy or push to production on the strength of this spec alone; follow repo deployment/PR permissions and operator workflow.

## 7. Later steps — not this implementation

**Step 11:** Optional, distinct GPU-focused detail scene and storytelling overlays when the user chooses an atom. It must be an opt-in view that reuses the _same_ renderer, telemetry truth, and interaction state, rather than changing current camera defaults.

**Step 12:** Long-term time travel/replay of fleet activity (request-trace driven), richer UI analytics and spatial traffic history, only after visual fidelity and actual telemetry are established.

Step 10 must deliver a dramatic visual improvement independently. Don't postpone it to Step 11.
