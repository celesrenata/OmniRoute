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

## Fix round (directive 42), checkpoint 4b

Commits: `176565915` loading cover (42.4), `37b487111` replayed-moment wording/chip (42.1), `c076e92af` collapsible transport bar (42.2), plus this evidence commit (42.3). Real /home, Atomic mode, headed Chrome on the M5 Max GPU, dev server :20199. Script: scripts/ad-hoc/pw-atomic-step12-fix.mjs (MODE=moments|panels|windows).

### 42.1 Replay visibly changes the scene

Cause of the old identical stills: the seek landed at start+150 ms of a 3-6 s request, and the panel read the live state. Now the script scans the recorded history (independently fetched call-log rows) and parks the playhead in the middle of the longest run of each replayed state (quiet, in flight, completed, failed), visited in recorded-time order. The panel shows the replayed activity (`Activity: replayed · in flight (N recorded requests)`, `· completed`, `· failed`, `· quiet`), and the bar has a time and a fleet chip (`fleet · quiet|N in flight|completed|failed`).

- Video (16.4 s, real /home, scrubber sweeping, 3 Kiro moments then the Bedrock failure; Kiro: completed -> quiet -> in flight, Bedrock: failed): /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12-fix/moments/replay-moments-quiet-inflight-completed-failed.webm
- Contact sheet: /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12-fix/moments/moments-contact-sheet-quiet-completed-inflight-failed.jpg
- Side by side with idea5 (failure moment): /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12-fix/sidebyside-idea5-vs-replay-failure.jpg (reference: /Users/celes/sources/celesrenata/OmniRoute/.agents/tasks/atomic-raytraced/references/idea5.jpeg)
- Stills (each with own timestamp, scrubber position, chip and panel text; `-early` is 0.45 s after the seek): /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12-fix/moments/A/ (Kiro: moment-quiet, moment-completed, moment-in-flight) and /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12-fix/moments/B/ (Bedrock: moment-quiet, moment-in-flight, moment-failed). Values per still are in step12-fix-moments.json next to them.
  Observed (Kiro): quiet 11:16:38 (scrubber 0.707, "replayed · quiet"), completed 11:13:58 (0.587, "replayed · completed (recorded success)"), in flight 11:15:23 (0.87, "2 recorded requests"). Bedrock: failed 11:13:56 ("replayed · failed (recorded failure)"), in flight, quiet. The scene differences are the nucleus colours and the one-shot completion/failure effects; the atoms themselves keep their step 11 look. The live fleet also has ambient Kiro/Ollama traffic, so the fleet chip can show other providers' state.

### 42.2 Slim collapsible transport bar

Default collapsed: one bar along the card bottom (Play, step, 1x/4x/16x, scrubber, time, fleet chip, More, Exit). More expands Loop, Window and the summary. The legend and detail panel lift above it through a CSS variable the bar publishes, and the REPLAY marker moved below the controls cluster (wraps instead of clipping). Live pairwise overlap check (legend, bar, detail panel, marker, controls) = none in all four states. Bar height as a share of the host: card collapsed 7.4 %, expanded 16.5 %; fullscreen 3.4 % / 7.7 %. Keyboard: Enter on More toggles it (verified live); all controls remain native.

- Card collapsed: /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12-fix/11-card-collapsed.jpg (page: /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12-fix/11-card-collapsed-page.jpg)
- Card expanded: /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12-fix/12-card-expanded.jpg
- Fullscreen collapsed: /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12-fix/13-fullscreen-collapsed.jpg
- Fullscreen expanded: /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12-fix/14-fullscreen-expanded.jpg
- Report: /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12-fix/step12-fix-panels.json

### 42.4 Loading

A neutral opaque cover (also on error) hides the whole scene while the history loads; the marker and bar stay above it. Live (call-logs delayed 3.5 s by the script): the topmost element at the card centre is the cover, and it is gone when ready. /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12-fix/10-loading-cover.jpg

### 42.3 Windows run live (real call-log DB, independent raw rows via the API)

| Window                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Rows | Records | Truncated | injected == call logs | timeline == call logs |   Load |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | ------: | --------- | --------------------- | --------------------- | -----: |
| 15 min                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |  137 |     274 | no        | yes                   | yes                   | 254 ms |
| 60 min                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |  271 |     542 | no        | yes                   | yes                   | 253 ms |
| The 60 min window does not reach the 2000-row cap (10 pages x 200), so truncation was NOT hit on the real data. The capped path is shown against SYNTHETIC responses (page.route, clearly a mock): 2000 rows, `history capped` chip in the bar and "(history capped; oldest rows omitted)" in the summary: /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12-fix/15-mock-capped.jpg. Play-through: real Play at 16x for 4 s, then the same clock path in large ticks to the end (dev API). Stills: /Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/step12-fix/windows/20-window-15min-opened.jpg, 20-window-60min-opened.jpg, 21-window-{15,60}min-{failure,success}.jpg; reports step12-fix-windows15.json, step12-fix-windows60.json. |

### Tests and checks

- `node --import tsx/esm --test tests/unit/atomic-topology/*.test.ts`: 588 tests, 587 pass, 0 fail, 1 skipped (new: replayMoment.test.ts, cover and bar cases in replayPanel.test.ts)
- `npm run typecheck:core`: 45 errors, same as base, none in atomic-topology; eslint on src/plugins/atomic-topology and the replay tests: clean
- Console errors on the real /home (excluding the known dev-origin WS ones): none
- Not done: no perf re-measure for this round (overlay-only change); the video was cut from per-atom recordings (Kiro 12.5 s + Bedrock failure 3.8 s)

## Operator sign-off

Step 12 APPROVED by the operator at checkpoint 4b (fix round, directive 42; code cde6be1f8 and earlier fix commits 176565915, 37b487111, c076e92af).
Carried to the perf/polish phase (OPERATOR_DIRECTIVES.md item 43): make the replayed in-flight state visibly distinct from quiet in the scene, with replayed packets on the proven link plus feeder activity driven by the replayed request count, from recorded data only.
