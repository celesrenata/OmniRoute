# STEP 11: opt-in GPU / atom detail view

Base commit: `0c3d063b9` (plus the Step 11 commit that carries this file). Branch `feat/atomic-raytraced-renderer`. Not deployed, nothing pushed.
Environment: macOS, Apple M5 Max, headed Chrome via Playwright (real GPU), dev server from this worktree on :20199, golden DEMO topology (`/dev/atomic-bench?atoms=20`).

## What it is

The viewer focuses an atom (label click), the tooltip offers "Open detail view", and the camera flies in (idea5-style hero framing) while a DOM panel shows that atom's real telemetry. Escape / "Back to topology" restores the previous framing. The default view never changes: no detail code runs unless the viewer opts in.

## Files

New: `scene/detailState.ts` (pure state + view-model), `scene/detailFlight.ts` (pure fly-in math), `overlays/AtomicDetailPanel.tsx`, `tests/unit/atomic-topology/detailState.test.ts`, `detailFlight.test.ts`, `scripts/ad-hoc/pw-atomic-step11.mjs`.
Changed: `AtomicTopologyRenderer.tsx` (optional `detailAtomId`/`onDetailRequest`/`onDetailExit`, instance state, Reset/other-focus/vanished-atom exit paths), `overlays/AtomicTooltip.tsx` (button only when the host passes `onOpenDetail`), `scene/AtomicScene.tsx` (`DetailFlight`; `CameraRig` skips snapping the position only while detail is active), `scene/sceneContext.ts` (optional `detailAtomId`), `app/dev/atomic-bench/page.tsx` (bench wiring: label click focus, `?detail=1`).

## Honesty rules (directives 7 and 30)

- Values come from the descriptor; null device measurements read "no data", never 0.
- Active/Queued job panels appear only when `activeJobs`/`queuedJobs` are non-null (a real 0 is shown). Failed appears only from real `request-failed` events in the lifecycle pool for that provider within 60 s. GPU atoms have no provider id, so failures are never attributed to them. No value, no panel.
- Model to nucleon mapping uses only observed model ids and the scene's own deterministic nucleus allocator, with a basis label (live in-flight, call-log window, fleet residency). No model observed gives "neutral two-tone", nothing guessed.
- Activity wording reuses the tier text ("idle, no measured activity", "recent activity Nm ago"), so decorative vitality is never presented as live work.

## Camera

Uses the existing `computeCameraFit` (read-only) for the base distance; goal distance is 0.2 of it (focus view uses 0.38), floored at 240, above OrbitControls' minimum of 200. The fly-in eases over 1.7 s with a 0.55 rad yaw swing, then hands control back to the unchanged orbit controls; pointer/wheel on the canvas cancels it. Reduced motion snaps. The soft container clamp is untouched and did not fight the flight.
Frozen check: `git diff --stat 689178516` on `layout.ts`, `cameraFit.ts`, `labelCollision.ts`, `projection.ts`, `SceneOrbitControls.tsx`, `AtomicLabels.tsx`, `AtomicControls.tsx`, `ProviderTopology2D.tsx` is empty. No new camera-file exceptions beyond directive 15.

## Live results (`screenshots/step11/step11-report.json`, 0 console errors)

| State                                                      | Camera distance to target |
| ---------------------------------------------------------- | ------------------------- |
| Default (no detail UI: 0 panels, 0 buttons)                | 1300                      |
| Focus (tooltip + "Open detail view" present)               | 520                       |
| Detail fly-in at 250 / 700 / 1200 ms                       | 516 / 442 / 284           |
| Detail settled                                             | 313                       |
| After Escape (previous focus framing restored, panel gone) | 520                       |
| Reduced motion, 400 ms after opening                       | 305 (snapped)             |

Panel for `gpu:bench-host:bench-gpu-b` (DEMO fleet data): nucleus bench/mixtral-8x7b 34/34 nucleons (fleet residency), spin 1.61 rad/s measured, GPU util 35.0 %, VRAM 8.00/24.00 GB, 48.0 C, 120.0 W, hosted runtime rt-b (proven), Active jobs 1, Queued jobs 0, no Failed panel (no failure events). Provider deep link (`?node=provider:bench-primary&detail=1`) shows 3 live in-flight models (11/12/11 nucleons) and no device section.
Evidence: `default.jpg`, `focus.jpg`, `detail-t250/700/1200.jpg`, `detail.jpg`, `exit.jpg`, `detail-reduced.jpg`, `detail-provider.jpg`, `step11-flow.webm` (whole flow), `sidebyside-idea5-vs-detail.jpg`.

## Against idea5 (side-by-side)

Matches: atom fills the frame from a low three-quarter angle, hero emitter pad underneath, cyan rim, violet body, orbit wires, circuit-board floor, lit panel. Gaps (carried as polish, directive 33): the cloud rim is less dense and particulate than idea5, the floor is busier and brighter than idea5's, the walls are not the warm orange corridor, and the smooth ball nucleus is kept by operator decision (directive 1).

## Verification

| Command                                                             | Result                                                                                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `node --import tsx/esm --test tests/unit/atomic-topology/*.test.ts` | 490 tests, 489 pass, 0 fail, 1 skipped (+18 new)                                                                        |
| `npm run typecheck:core`                                            | 45 errors, all pre-existing; 0 in `atomic-topology`/`atomic-bench`                                                      |
| `npm run lint`                                                      | 7 errors, all pre-existing outside the plugin (scriptVault family); `eslint` on the plugin, bench and tests: 0 problems |
| `node scripts/ad-hoc/pw-atomic-step11.mjs ...`                      | live flow above                                                                                                         |

## Not verified

- "Reset view" leaving the detail view: wired in the instance listener, but the bench has no instance, so the dispatched event left the panel open there. Covered only by code reading, not a live run.
- Not run on the real `/home` page (no real fleet with GPU atoms locally); the bench uses DEMO data.
- Step 12 (replay) is not part of this step. No `step11.json` review existed, so there were no findings to fix.
