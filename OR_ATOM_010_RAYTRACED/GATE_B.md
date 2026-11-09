# Gate B (round 5): full-topology integration, atmosphere, focus framing, DOF isolation

Branch `feat/atomic-raytraced-renderer`, code SHA `96c17acf3` (`git log -1 96c17acf3`). **Not deployed**, not pushed, no PR.
`OPERATOR_DIRECTIVES.md` items 1-25 re-read. `gateB.json` (round 4, CHANGES_REQUESTED, 7 findings) and `gateB.md` were read first; every finding is addressed below.
Evidence: `screenshots/gateB/round5/` (jpg tracked, full-res PNG on disk only), all from headed Chrome on the Apple M5 Max (WebGPU adapter `apple/metal-3`), golden DEMO topology, 1600x1000 @2x.

## Reviewer findings (gateB.json round 4) and what happened

| #   | Finding                                                          | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Focus view frames the atom small and distant (directive 25)      | **Fixed.** `CameraRig` (`scene/AtomicScene.tsx`) now flies the focus pose in along the same viewing direction to `FOCUS_DISTANCE_FACTOR = 0.38` of the fit distance (no rotation, orbit controls still own zoom/rotation, soft container clamp unaffected). Before/after at the same target `provider:bench-primary`: `focus-before-after.jpg` (left = previous build `a4e5713ee` behaviour captured on this server before the edit, right = now). The focused atom now fills the centre of the frame.                                                                                                                                         |
| 2   | Cloud/orbits at default 3/5 (glassy white-violet orbs)           | Root cause: at 40-90 px, hundreds of 1 px hairline strands and orbit wires sum additively per pixel to white. Now, driven by the existing projected-size factor `far` (0 at close-up, so the approved close look is unchanged): strand gain x(1-0.55 far) and tip hue held violet, orbit-wire energy x(1-0.7 far), plasma body emission x(1+1.5 far) and body density x(1+3.2 far crowd^2) for a filled violet flower, glass shell faded x(1-0.7 far) so the plasma reads first, cyan rim sparkles lifted. `default-before-after.jpg` shows the change on the same frame. Self-score 4 at default (32-atom centre still paler, see scorecard). |
| 3   | Resemblance 3/5 (no hero isolation, no DOF)                      | DOF + bokeh + hero isolation added (finding 4/5). Re-scored in `VISUAL_SCORECARD.md`: 4 close-up/focus, **3 at the frozen default framing** (honest: a 22-atom topology at default zoom is not a single hero atom).                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 4   | Close-up neighbour clutter                                       | **Fixed.** Cinematic DOF in the post chain (`scene/rt/rendererFactory.ts`, 16-tap highlight-weighted golden-angle bokeh gather). Focus view: the focused atom's projected disc stays sharp, everything outside defocuses and neighbours dim to 0.24 (was 0.42). Zoomed close-up without a focus: the atom nearest the screen centre becomes the hero once it spans >=0.09 of the view height (`closeHeroWeight`, smooth ramp to 1 at 0.17, unit-tested), neighbours defocus and dim to 0.55. `close-20`, `close-hub`, `focus-20`, `sidebyside-idea5-{close,hub,focus}`.                                                                        |
| 5   | Immersion at default 3/5 (no visible DOF bokeh / orbs at depths) | The far room (walls/ceiling, depth > 2.3x focus distance) falls into hexagonal bokeh; floating orbs gain lifted (they now read at several depths). Atoms write no depth, so the background threshold is set beyond the floor behind the topology and atoms stay sharp at default. `default-20`, `sidebyside-idea5-default`. PCB container kept (directive 14).                                                                                                                                                                                                                                                                                 |
| 6   | Stale "host-resolved quality tier" comment                       | Removed (`AtomicScene.tsx` now says: no quality tiers, full retina DPR + AA).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 7   | Engineering gates (informational)                                | Re-measured on this SHA, no regression (below). The DOF gather is branch-skipped where CoC is 0 (first version without the branch cost WebGL2 ~20 %; with it, numbers are back at round-4 levels).                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Camera: exactly what changed this round

Only the focus branch of `CameraRig` in `scene/AtomicScene.tsx` (directive 25 is the operator's explicit request to restore a close focus framing).
`cameraFit.ts`, `SceneOrbitControls.tsx`, `layout.ts`, `AtomicLabels.tsx`, `AtomicControls.tsx`, the 2D renderer: **empty diff vs `689178516`** (checked with `git diff --stat`).
Default pose, reset and auto-fit are untouched (the default fit path does not go through the new code). Telemetry semantics and routing untouched.

## Performance on this SHA (M5 Max, headed Chrome, uncapped, `pw-atomic-gateB.mjs ladder`)

WebGPU 8/16/20/32 atoms (10/18/22/34 rendered): **327 / 276 / 231 / 193 fps**. WebGL2: 239 / 227 / 202 / 174 fps. Targets (~120 @20, >=60 @32) met on both backends.
Forced loss x3 per backend: recovered every time, 1 canvas. Reduced motion: static while idle, orbit renders. Two failed restores -> host 2D in 1.73 s. 2D<->Atomic x50: peak 1 canvas, 0 at end, switch p50 35 ms. 20-min soak: see `PERFORMANCE.md`.

## Rows below the bar (stated, not hidden)

Overall resemblance at the frozen default framing: 3/5 (self). Everything else self-scored >=4; see `VISUAL_SCORECARD.md`.

## Evidence index (round 5)

`screenshots/gateB/round5/`: `default-8|16|20|32`, `close-20|32`, `close-hub`, `focus-20`, `focus-webgl2`, `idle-20`, `reduced-20`, `webgl2-20`,
`sidebyside-idea5-{default,default32,close,close32,focus,hub}.jpg`, `focus-before-after.jpg`, `default-before-after.jpg`,
videos (12 s) `video/{idle-default,active-close,focus-active,strike-default}.webm`. Round-4 strike/link videos remain valid (link code unchanged).

---

# (history) Gate B (round 3 + 4): full-topology integration, atmosphere, links, board, performance

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
