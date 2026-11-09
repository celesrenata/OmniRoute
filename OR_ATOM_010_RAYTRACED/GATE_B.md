# Gate B (round 3 + 4): full-topology integration, atmosphere, links, board, performance

Branch `feat/atomic-raytraced-renderer`, code SHA `a4e5713ee361d61887c3041358cdadd5e185d4ba` (see `TESTS.md`). Not deployed, not pushed.
`OPERATOR_DIRECTIVES.md` items 1-25 were read and followed. `gateB.json` (CHANGES_REQUESTED, 6 findings) and its review doc were
read first; the operator-note scope (hub-only dome, PCB container, container-bound camera, GPU+runtime merge, legacy removal,
GPU-timestamp root cause) is covered below. **I am not claiming the visual bar is met on every row** (see "Rows below the bar").

## Reviewer findings (gateB.json) and what happened

| #   | Finding                     | Result                                                                                                                                                                                                                                                                         |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Cloud/orbits at default 3/5 | Strand, orbit-wire and body gain floors at default distance (`atomBatch.ts` `readS`), wires 2.2/1.7 px, rim gain. Atoms now read as violet/cyan bundles with a cyan rim, but at the frozen default framing they are still 40-90 px: **still 3/5 at default, 4/5 at close-up**. |
| 2   | Resemblance 3/5             | **Not fixed.** Still 3/5 both zooms. idea5's dark-violet flower is only legible at close-up; the operator replaced the server-room backdrop with a PCB container (directive 14).                                                                                               |
| 3   | Immersion 3/5 at close-up   | Hazy slab replaced by a solid PCB container with real 3D parts (below). Scored 4/4.                                                                                                                                                                                            |
| 4   | Close-up neighbour clutter  | Non-focused atoms are dimmed (`FOCUS_NEIGHBOUR_DIM = 0.42`) in focus view (`RtTopologyScene.tsx` -> `BatchAtomFrame.dim`). See `focus-20` / `sidebyside-idea5-focus`.                                                                                                          |
| 5   | 32-atom grid tail           | Superseded by directive 21: deferred to the profile-and-optimize phase after Step 12. Not touched. Real-topology targets met (below).                                                                                                                                          |
| 6   | Legacy remnants             | Removed: `HazeQualityTier`/`HAZE_TIER_TABLE`, `LEGACY_BLOOM`, `bloomOverride`, `?atomic-fx=legacy` renderer. `?atomic-fx=rt` (Gate A golden-atom bench) is kept.                                                                                                               |

## Operator directives delivered this round (each its own commit)

- **17 legacy removal** `8a687aaf6`.
- **13/14/15/20 PCB container, hub-only dome + glowing pads, soft camera containment** `50bbabb48`, refined by `b082ce3a2`, `b7c58d69c`, `c0a2b518e`.
- **16 GPU + runtime merge** `4d2c65075`. A runtime proven (`runtime_device`) on exactly one known GPU has no atom; the GPU atom is its atom
  (models <=3, aggregate of fresh hosted runtimes' measured TPS / queue / jobs, own GPU TPS wins, provider carried only when unique).
  No proof, an unknown GPU, or proof on several GPUs keeps the runtime as its own atom (never guess, never double count). `layout.ts` unchanged.
  **Before/after node list (golden bench fleet, the only fleet available here):** before 4 device atoms
  (`gpu:bench-host:bench-gpu-a`, `gpu:...-b`, `runtime:bench-host:bench-rt-a`, `runtime:...-b`); after 2
  (`gpu-a` hosting `rt-a`, `gpu-b` hosting `rt-b`). **No real-fleet before/after:** the dev server's fleet feed is
  rejected (`[LiveWS] FORBIDDEN_ORIGIN`), so no real reconciliation was available.
- **22 flagship links / lightning** `6f8cf557a`: stepped-leader/DBM channels (`scene/leaderBolt.ts`) revealed by the advancing tip,
  return stroke + decaying re-strikes along a channel that mutates per stroke (`scene/strikeTimeline.ts` shared by CPU gate and shaders),
  white-hot core / red or cyan-green corona / volumetric glow in screen space, endpoint attachment flares + ionisation ring at the shells,
  ballistic sparks, floor light cast, decaying afterglow; idle links are thin braided living plasma filaments; active proven links add packets with trails and crawling micro-arcs.
  Strikes only from an event edge (no loop); reduced motion = steady soft tint, no flicker.
- **19 visibility savings** `ef5e7d003`: frustum culling (atoms + floor reflections), projected-size march steps, strike-only link draws hidden unless live,
  render loop stopped while the tab is hidden / canvas out of view. Measurements in `PERFORMANCE.md`: loop stop is a 100 % saving; culling and step scaling are **not measurable** on this GPU/workload.
- **23 PCB** `b7c58d69c`, `c0a2b518e`: crisp AA artwork scaled to the atoms + real instanced 3D parts (toroid/boxed chokes, SMD + colour-banded axial resistors,
  polymer/electrolytic cans with scored tops, MLCC, ICs with pins, connectors, heatsinks, seeded faintly blinking LEDs), analytic lighting, contact-shadow decals, haze/refraction near magnetic parts.
- **24 / 25 snug container, focus** `b082ce3a2`: see "Camera" and "Focus regression".

## Camera (directive 15, narrow exception): exactly what changed

New files only: `scene/ContainerCameraClamp.tsx` (per-frame soft clamp, `useFrame` priority 0.5, after the orbit update and before render) and
`scene/containerBounds.ts` (pure soft clamp). `AtomicScene.tsx` mounts the clamp's host (`RtTopologyContent` returns it) and a `VisibilityGate` (loop stop, not camera).
`SceneOrbitControls.tsx`, `cameraFit.ts`, `layout.ts`, `AtomicLabels.tsx`, `AtomicControls.tsx`, the 2D renderer: **no diff vs `689178516`**.
Container extents come from `environmentLayoutFor(descriptors, { position: fit.position })`: the default fit pose plus the atoms' own extents, so the default pose and
every focus pose lie in the unconstrained zone (unit-tested for every atom of the 8/16/20/32 golden topologies at aspect 1/1.6/2.2: `containerBounds.test.ts`).
**Camera-limit demo:** `screenshots/gateB/round4/camlimit.webm`, `camlimit.json`, stills `zoom-out|zoom-in|orbit-*.jpg`. Wheel zoom-out/in to the limits, orbit left/right/up/down to extremes,
right-drag pan: worst clearance to a wall/floor/ceiling **230.9 world units, inside = true** (`pw-atomic-camlimit.mjs`, 9 samples).

## Focus regression (directive 25): what I found

I reproduced it on the same target, `provider:bench-primary`, before = `9805665e6` (dev server on :20198), after = this branch:

- The container clamp is **not** the cause: camera position/target are identical with the clamp on and with `?clamp=0`
  (`pw-atomic-camdbg.mjs`: pos `[-94.39, 339.26, 1600.80]`, target `[-94.39, 24.0, 339.76]`, both). Camera math (`cameraFit.ts`, `CameraRig`) is unchanged; focus is a slide at the same distance, in both builds.
- What changed on screen: the GPU+runtime merge. The bench fleet lost its two lateral runtime atoms (x = +/-528), the topology's lateral extent shrank, and the same slide now frames a **narrower cluster** (about 35 % of the width vs about 49 % before). The default pose is unchanged (z = 1261).
- I made the container guarantee that the clamp never touches a focus pose (it could have, for atoms with large +z, with the old extents).
- **I did not add a closer focus framing**, because `cameraFit.ts` / CameraRig are frozen and the operator asked for "previous framing", which was this slide. If the operator wants the focused atom to fill the frame, that is a new camera behaviour (Step 11 opt-in view) and needs a decision.
  Captures: `focus-20.jpg`, `sidebyside-idea5-focus.jpg` (after); before captured the same way from :20198 (historical, not tracked).

## Status against the plan

C1-C8 as before plus the directives above. Fallbacks that exist: reduced motion, WebGPU->WebGL2, context/device-loss rebuild (2 failed restores -> host 2D), host 2D when no GPU rendering.
Performance (M5 Max, uncapped): **227 fps at 22 atoms, 191 fps at 34 atoms** (WebGPU); WebGL2 198 / 178. Targets (~120 @20, >=60 @32) met. 20-min soak, forced loss x3 per backend, 2D<->Atomic x50, reduced motion, fallback drive: all pass (details in `PERFORMANCE.md`).

## Rows below the bar (stated, not hidden)

Cloud/orbits at default 3/5; overall resemblance 3/5 at default and close-up. See `VISUAL_SCORECARD.md`. A pale-white strand bundle remains on crowded 32-atom centres (hues retained, no pink-white wash-out; `default-32.jpg`).

## Known gaps / decisions for the operator

1. Resemblance: idea5's dark-violet flower reads only at close-up at the frozen default framing; closing it needs a camera/layout change or an opt-in framing.
2. Focus view fills less of the frame than before in the golden bench (explained above); a closer focus is a camera change.
3. Walls and ceiling are deliberately calm (artwork detail 0.16/0.12) after a first pass looked like stray sticks; they are darker and sparser than the floor.
4. The 20-min soak ran against the dashboard with no live telemetry (`telemetry: null`, `[LiveWS] FORBIDDEN_ORIGIN` from the dev server origin), so the 3.5 s telemetry cadence was not exercised live; the bench cycle (`?failure=strike`) is the DEMO substitute.
5. Pre-existing React warning "Attempted to synchronously unmount a root while React was already rendering" on 2D<->Atomic toggles: reproduced on `9805665e6` (before this round); host code, not touched.
6. GPU timestamp root-cause of the 32-atom tail and deep profiling: deferred by directive 21.

## Evidence index

`screenshots/gateB/round4/` (jpg previews tracked, full PNGs on disk only): `default-8|16|20|32`, `close-20|32`, `focus-20`, `close-hub`, `idle-20`, `reduced-20`, `webgl2-20`,
`sidebyside-idea5-{default,close,focus,hub,default32,close32}.jpg`, strike stills `strike-failure-{default,close}.jpg`, `strike-completion-close.jpg`,
videos `video/{idle,active,strike}-{default,close}.webm` (12 s each; `strike-*` alternate completion and failure every 3 s via `?failure=strike`), camera demo `camlimit.*`.
`VISUAL_SCORECARD.md`, `PERFORMANCE.md`, `TESTS.md`, `VISUAL_AUDIT.md`, `SKILL_APPLICATION.md`.
