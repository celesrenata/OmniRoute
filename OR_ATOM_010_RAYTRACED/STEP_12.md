# STEP 12: request-trace time travel / replay

Branch `feat/atomic-raytraced-renderer`. Not deployed, nothing pushed. Environment: Apple M5 Max, headed Chrome (adapter vendor apple, metal-3), dev server from this worktree on :20199, the REAL `/home` in Atomic mode against the real call-log DB.

## What it is

Opt-in only. In the detail view the panel offers "Replay recorded requests". It fetches the call-log history once (never polled), then replays it: the same discharge, packet, failure-strike and feeder visuals play from recorded requests only. A persistent amber "REPLAY <timestamp> recorded history, not live" marker is shown for the whole session, the live telemetry badge is hidden, and "Exit replay" returns to live. Controls: play/pause, previous/next recorded event, 1x/4x/16x, loop, window (5/15/60 min), a scrubber. All native elements (keyboard operable). Reduced motion steps event to event on a 1.2 s timer, no continuous playback.

## Honesty rules

- Records come only from call-log rows: started at the row timestamp, one terminal record (completed, or failed for status >= 400 / error) at timestamp + the row's measured duration (no duration: at the row timestamp). In-flight or status-less rows get no invented outcome. Probes dropped. Nothing outside the window.
- Replay snapshot (`scene/replaySnapshot.ts`): traffic, in-flight models, lane and recent models are derived from records at the playhead. Live lifecycle is dropped. Every fleet-telemetry measurement is neutralised to "no data" (null, stale), so spin, queue vibration and device bars never show live values. Atom membership and positions are unchanged (tested), so the camera does not move. Health is not a recorded fact: kept from live, except live "unhealthy" reads "unknown".
- Spatial traffic history: per-provider decaying heat from recorded events lifts the link filament glow (`REPLAY_HEAT_GAIN`), and the existing usage feeder traces are driven by the replay pool at replay time (calls/min or in-flight from records).

## Files

New: `src/shared/topology/telemetry/traceHistory.ts`, `traceHistoryFetch.ts`; `scene/replayClock.ts`, `replaySnapshot.ts`, `replayController.ts`; `overlays/AtomicReplayPanel.tsx`; tests `traceHistory`, `replayClock`, `replaySnapshot`, `replayController`, `replayPanel` (+ a `since`/`until` case in `tests/unit/call-logs-row-filter.test.ts`); `scripts/ad-hoc/pw-atomic-step12.mjs`.
Changed: `app/api/usage/call-logs/route.ts` (additive `since`/`until`, 400 on invalid, also applied to the in-memory rows that bypassed the SQL filter), `docs/openapi.yaml`, `AtomicTopologyRenderer.tsx` (replay controller per instance, dev-only `window.__atomicReplay`), `scene/RtTopologyScene.tsx` (replay playhead for feeders, link heat), `scene/sceneContext.ts` (`replayNowRef`), `overlays/AtomicDetailPanel.tsx` (replay button; also fixed a focus-steal bug: the focus/Esc effect re-ran on every host render and pulled focus off the replay controls).
Frozen areas untouched: `git diff HEAD` is empty for layout.ts, cameraFit.ts, SceneOrbitControls.tsx, AtomicLabels.tsx, AtomicControls.tsx, labelCollision.ts, projection.ts and the 2D renderer.

## Live demo (real /home, real call logs)

Real traffic was sent through the dev server's own `/v1` (kiro 200s, bedrock real 403s). Window: last 5 min. Raw rows fetched independently by the script from `/api/usage/call-logs?since&until` and counted per provider/kind; replay then played through at 16x via the real buttons.

- Replay `injected` counts == `timeline` counts == call-log truth: {'bedrock': {'started': 12, 'completed': 0, 'failed': 11}, 'kiro': {'started': 22, 'completed': 22, 'failed': 0}} (injectedEqualsCallLogs=True). One bedrock request was still open when fetched: started without an outcome, as recorded.
- Seeks to a real in-flight moment, after a success and a failure: hub/provider chips and feeders follow the records (in-flight kiro: chip active, feeder basis inflight; failure: bedrock chip "error", red nucleus). Before the first event everything is idle.
- Exit: marker gone, panel gone, telemetry badge back, live chips back (bedrock error, kiro last).
- Keyboard: ArrowRight on the scrubber (delta 1500 ms), Enter on Next event advances, Space toggles play and pause (focus stays on the control).
- Perf (replay playing at 1x): vsync 54.6 fps p95 18.7 ms; uncapped 148.5 fps p95 23.7 ms p99 28.6 ms, 6 frames > 30 ms in 5 s. Reduced-motion run: counts also equal call logs, 286 samples, no errors.
- Console errors (excluding the known dev-origin WS ones): none.
  Evidence: `screenshots/step12/*.jpg`, `sidebyside-idea5-vs-replay.jpg`, `step12-report.json` (+ `reduced/`, `uncapped/` reports). PNG originals and recordings are gitignored. No video was recorded for this step.

## Against idea5 and limits

The replay view is the existing Step 11 scene, so the idea5 gaps in STEP_11.md still apply. The control panel (bottom-left) covers part of the scene and the legend on the small /home card; it is compact (400 px) but not collapsible. GPU atoms: no real GPU atom on this fleet, so GPU-atom replay (neutralised device facts) is covered only by unit tests. The mid-flight 'REPLAY loading' state shows the live scene under the marker. Window lengths 15/60 min were not exercised live (5 min only).

## Verification

| Command                                                                     | Result                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------- |
| `node --import tsx/esm --test tests/unit/atomic-topology/*.test.ts`         | 575 tests, 574 pass, 0 fail, 1 skipped                  |
| `node --import tsx/esm --test tests/unit/call-logs-row-filter.test.ts`      | 10 pass                                                 |
| `npm run typecheck:core`                                                    | 45 errors, identical to base; 0 in changed files        |
| `npm run lint`                                                              | 7 errors, the same pre-existing ones outside the plugin |
| `node scripts/ad-hoc/pw-atomic-step12.mjs` (also `REDUCED=1`, `UNCAPPED=1`) | flows above                                             |

## Checkpoint 4 sign-off package (absolute paths)

Reference: /Users/celes/sources/celesrenata/OmniRoute/.agents/tasks/atomic-raytraced/references/idea5.jpeg
Side-by-side, idea5 (left) vs real-GPU replay on the real /home (right): /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12/sidebyside-idea5-vs-replay.jpg
Real M5 Max captures (JPG previews; PNG originals alongside):

- /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12/01-live-default.jpg
- /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12/03-replay-opened.jpg
- /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12/05-moment-quiet-before-first-event.jpg
- /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12/05-moment-in-flight.jpg
- /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12/05-moment-failure.jpg
- /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12/07-after-exit-live.jpg
  Reports: /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12/step12-report.json, /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12/reduced/step12-report.json, /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12/uncapped/step12-report.json

### Scores (self, 0-5; replay reuses the Step 11 scene, so scene scores carry over from STEP_11.md; reviewer scores independently)

| Criterion                                                                                                                        | Score |
| -------------------------------------------------------------------------------------------------------------------------------- | ----: |
| Resemblance to idea5                                                                                                             |   3.5 |
| Immersion                                                                                                                        |     4 |
| Nucleus                                                                                                                          |     4 |
| Lighting                                                                                                                         |     4 |
| Operational truth (replay counts == call logs, nothing invented, live telemetry neutralised)                                     |  pass |
| Not claiming the visual bar is fully met: idea5 gaps from STEP_11.md remain, and the replay panel covers part of the small card. |

### Perf (replay playing 1x, real /home)

vsync 54.6 fps p95 18.7 ms; uncapped 148.5 fps p95 23.7 ms p99 28.6 ms (6 frames > 30 ms in 5 s). Reduced-motion run clean.
