# Directive 33 polish gaps: status in this phase

| gap                                                                                            | status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| /home: too many large bokeh orbs in the upper half                                             | **Changed (subtle).** `motes.ts`: high in the volume, big defocused orbs shrink by up to 45 % and two in five fade out. Dust and the lower / nearer orbs are unchanged. Bench default view (paused, identical camera), before = round-2 default, after = this build: SSIM 0.987, of which the new "Sync to display refresh rate" chip in the controls row is part of the diff. Preview: `/Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/perf/polish-bokeh/topo-20-before-after-preview.jpg`; diff x16: `/Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/perf/polish-bokeh/topo-20-diff-x16-preview.jpg`. Needs the operator's eye. |
| /home: labels overlapping the cluster                                                          | **Not changed.** The default-view label layout lives in frozen files (`AtomicLabels.tsx`, `labelCollision`, `projection`; directive 39.1 freeze).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| close-up: some nuclei read as plain blue blobs                                                 | **Not changed, by rule.** Those are atoms with no observed model; directive 2 requires a blue-silver neutral nucleus for unknown attribution, never a model hue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| idea5 dense particulate cloud rim; fine petal voids at 40-80 px; small-atom nucleus legibility | **Not done.** Each is a visible change to the approved atom shader and needs its own review round.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| close-up orbit wires sparse                                                                    | **Not done.** Same reason.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| walls (dark wire-grid vs idea5 warm orange server corridor)                                    | **Not done.** Environment art change; separate review round.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

---

# Directive 43: replayed "in flight" vs "quiet" made visibly distinct

**Method:** the real /home replay (60 min window) of this dev server's real recorded requests (the llama-cpp burst from directive 41).
`pw-atomic-replay-distinct.mjs` scans the playhead for llama-cpp's own in-flight moment (its route link "active") and a quiet
moment. At each moment it waits 7 s, then records the link packet state (dev `__atomicLinkDbg`), the feeder level and a still.

**Changes (recorded data only):**

- **Feeders during replay:** the replayed in-flight count is the recorded truth, so it is never treated as stale. The feeders now
  follow the replayed request count (basis "inflight"). Before, `inFlightStale` was true on the dev origin, the in-flight signal
  was ignored, and the replayed feeders stayed at 0.
- **Live data excluded:** live call-log rows are never used in replay (`callLog: false`).
- **Paused replay:** a paused replay snaps feeders and link heat to the replayed moment instead of keeping the previous moment's
  eased level.
- **Link heat floor:** `inFlightHeat(n)` raises a provider's route-link heat while recorded requests are in flight
  (1 request -> 0.57, 3 -> 0.92; 0 when none). The link glows for the whole recorded span, not only right after the start event.
- **Debug record:** the dev feeder record now carries the current eased level.

**Result** (`/Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/perf/replay-distinct/replay-distinct.json`):

| moment              | replay chip           | llama-cpp link | packets | llama-cpp feeder (basis, value, level) | hub feeder         |
| ------------------- | --------------------- | -------------- | ------- | -------------------------------------- | ------------------ |
| 16:37:03, in flight | "fleet · 1 in flight" | active         | 3       | inflight, 1, 0.270                     | inflight, 1, 0.270 |
| 16:51:27, quiet     | "fleet · quiet"       | healthy        | 0       | calls, 0, 0                            | 0                  |

**Stills** (card, same camera):

- Whole card: `/Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/perf/replay-distinct/replay-quiet-vs-inflight.jpg` (quiet | in flight).
- Link region, 2x: `/Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/perf/replay-distinct/replay-link-crop-v2.jpg`. In flight shows the bright hub to llama-cpp filament with travelling
  packets, a hotter hub halo and the ACTIVE chips. Quiet has none of these.

Tests: `replaySnapshot.test.ts` covers `inFlightHeat`, and `feederCallLog.test.ts` covers replay excluding live rows.
---

# Directive 41: usage-driven feeder traces verified on REAL data

**Method:** real requests through the dev server's own `/v1/chat/completions`, sent to the local model `llama-cpp/deepseek-v4.1-flash-1017`
(on this machine, /bin/zsh). Each request writes real call-log rows. Harness: `pw-atomic-feeders-real.mjs`. It samples the dev-only
`window.__atomicFeeders` (signal basis/value, target, eased level per atom) on the real /home in Atomic mode.

**Root cause found (first run, before the fix): 12 real 200-OK requests left every feeder at 0.** The feeder call rate read only the
live lifecycle event pool. On the dev origin the live websocket is rejected (`FORBIDDEN_ORIGIN`, item 38.5), so no lifecycle event
ever arrived, and the call-log rows, which item 40 names as the third signal, were never consulted.

**Fix:**

- `recentModels.ts` `deriveRecentCallTimes` collects the completed, non-test call times per provider over the last 60 s.
- `normalizeTopology` carries them as `node.recentCalls` (`source: "call-log"`, absent when there are none).
- The descriptor carries `recentCallTimes` (the hub gets the union).
- `atomFeederSignal` uses the larger of the live-event rate and the call-log rate. They describe the same requests, so the two are
  never summed. The renderer counts on its own clock, so the rate decays without a new snapshot.
- Replay never reads live call-log rows.
- The host refreshes the snapshot only when the call signature changes, i.e. when a real call arrives (`ProviderTopology.tsx`).

**Second finding (host data, worked around, not changed):** `/api/usage/call-logs` lists every just-finished request twice. One row is
the in-memory entry (`detailState: "in-memory"`, start timestamp); the other is the persisted row (completion timestamp, different id).
The route's id-based de-duplication cannot match them. The first fixed run therefore counted 2 calls per request. The feeder now
collapses the pair (same provider, connection, model and duration, with start + duration within 250 ms of the persisted row) and
uses the completion time. The duplicate rows still appear in the API and logs grid; that is outside this phase's scope.

**Result after the fix** (`/Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/perf/feeders-real/feeders-real.json`): 12 requests, all 200, about 10 s each (the local GPU was busy).
value = calls/min, target = mapped intensity, level = eased level.

| sample                   | provider:llama-cpp (value / target / level)             | hub               | every other atom (8 providers) |
| ------------------------ | ------------------------------------------------------- | ----------------- | ------------------------------ |
| before                   | 0                                                       | 0                 | 0                              |
| after request 2 / 5 / 10 | 1 / 0.084 / 0.084; 4 / 0.247 / 0.247; 6 / 0.320 / 0.320 | same as llama-cpp | 0                              |
| burst end                | 4 / 0.247 / 0.246                                       | same              | 0                              |
| idle + 30 s              | 3 / 0.202 / 0.202                                       | same              | 0                              |
| idle + 75 s              | 0 (no record lit)                                       | 0                 | 0                              |

Feeders light only on the atom with real activity (and the hub that routed it), proportionally to the call rate. They decay to zero
about a minute after the last call. The glow is "ever so slightly" by design (item 40), so the numbers above are the primary
evidence. Stills (before | burst end | idle + 75 s): `/Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/perf/feeders-real/feeders-real-before-burst-idle.jpg`.
Tests: `tests/unit/atomic-topology/feederCallLog.test.ts` (window, de-dup, in-memory/persisted pair, aliases, provenance,
signatures, provider/hub lit with others zero, decay, replay exclusion, max-not-sum).
---

# PERFORMANCE: profile-and-optimize phase, round 3 (directive 45: 30 fps target)

## What changed

- **Render loop** (`scene/AtomicScene.tsx` `FrameDriver`, `scene/frameRate.ts`): R3F's own loop is off (`frameloop="never"`).
  One rAF loop asks a deadline throttle on every tick and calls R3F `advance()` only when a frame is due.
  - A tick that is not due returns at once: no `useFrame` subscriber runs, so there is no scene update and no GPU submit.
  - The throttle advances its deadline by exactly 1/30 s (2 ms jitter tolerance) and re-anchors after a stall. That holds 30 fps on
    60 Hz (every 2nd tick), 120 Hz (every 4th) and 144 Hz (5/4 alternating) displays (unit-tested).
  - The R3F clock is driven with the rAF timestamp, so every `delta` is the real time between rendered frames.
  - The hidden-tab / off-screen stop is folded into the same loop: it is cancelled, then restarted with a normal-length first frame.
- **"Sync to display refresh rate"** checkbox in the existing Atomic controls cluster, next to Fullscreen, styled as a control chip.
  - Unchecked (default) = 30 fps; checked = every rAF tick.
  - Persisted in `localStorage["omniroute.atomic.syncRefresh"]` (SSR snapshot false, blocked storage safe) and read through `useSyncExternalStore`.
  - Native checkbox in a label (keyboard: Space), with a tooltip and an `aria-describedby` hint on the GPU trade-off.
- **Time-based motion audit.**
  - Already time-based: scene clock (`advanceSceneTime`, delta clamp 0.1 s), electron and swirl clocks, flicker / bolt re-strike
    (`flickerClock`), link strikes / packets / completion flash, feeder and replay-heat easing, DOF focus ease, energy smoothing,
    fly-in / lens / drift (`exp(-k*dt)`, `driftMs`), orbit-pivot slide, replay transport (`setInterval` with measured dt), container clamp (stateless).
  - **Fixed:** OrbitControls damping decayed per `update()`, i.e. per frame. `orbitDampingFor(delta)` scales it by elapsed time
    (0.08 at the 60 fps reference, unchanged feel at 60 Hz), so the glide is the same length in seconds at 30 and 120 fps (unit-tested).
- **Quality defaults:** half-res floor reflection (44.1) stays. **Cloud-only reduced-res hero translucency is now the default**
  (`resolveHeroScale` 0.5, `resolveHeroStrands` false, always so in production). Dev overrides: `?herores=1` (off) and
  `?herostrands=1` (cloud + strands, dev only). Evidence for cloud-only is round 2 (SSIM 0.997-0.9997).

## Evidence (M5 Max, real /home Atomic, window on the built-in 120 Hz panel, normal vsync)

Rendered-frame intervals come from `window.__atomicFrameTimes` (written only when a frame is actually rendered). GPU busy % is ioreg
"Device Utilization" for the whole GPU. Power is `AppleSmartBattery SystemPowerIn` for the whole machine. Neither can be attributed
to this page alone: the blank-page baseline was GPU 23 % mean (0-38 %) and 47.3 W, from a local inference server running in the background.
SystemPowerIn updates only every few seconds, so the power column is coarse. Two interleaved rounds
(`pw-atomic-framerate.mjs`, `/Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/perf/framerate-30-vs-sync.json`):

| state                               | 30 fps: fps / interval p5-p50-p95 ms / GPU busy mean % | synced 120 Hz: fps / interval p5-p50-p95 / GPU busy mean % |
| ----------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| rest, default view                  | 30.0 / 32.5-33.3-34.2 / 44.5, 44.1                     | 120.0 / 7.5-8.3-9.3 / 66.1, 64.5                           |
| interacting (continuous orbit drag) | 30.0 / 32.6-33.3-34.2 / 46.3, 44.3                     | 120.0 / 7.6-8.3-9.1 / 64.9, 67.4                           |
| replay playing (8x)                 | 30.0 / 32.5-33.3-34.2 / 46.3, 42.3                     | 120.0 / 7.4-8.3-9.3 / 66.6, 68.6                           |
| fullscreen + OpenAI detail          | 30.0 / 32.5-33.3-34.4 / 39.1, 38.1                     | 120.0 / 7.6-8.3-9.1 / 65.5, 76.3                           |
| system power (W, coarse)            | 47.3, 48.5 (round 1); 43.6 (round 2)                   | 56.4 (round 1); 41.4-41.9 (round 2)                        |

- **Cadence:** every 30 fps interval lies in 32.5-34.4 ms (histograms in the JSON). That is exactly every 4th 8.33 ms vsync, with no 25 or
  42 ms gaps, in all four states.
- **GPU busy:** about 20 points lower at 30 fps (38-46 % vs 64-76 %, both including the ~23 % background). The power column is
  dominated by the background load and its slow update, so it does not resolve the difference.
- **Motion speed** (`pw-atomic-motion-speed.mjs`, `/Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/perf/framerate/motion-speed.json`): electron orbit angular speed of 110 orbits,
  unwrapped over 4 s, at 30 fps (rendered 30.0) vs synced (rendered 119.8). Speed ratio 1.0006-1.0009 (mean 1.0008, sampling quantisation).
  Speeds are identical.
- **Recording at 30 fps:** `/Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/perf/framerate/home-30fps.webm` (12 s of the real /home).
- **Backends** (`pw-atomic-backend-check.mjs`, bench detail view with the hero pass active): WebGPU 30.0 fps throttled, 120 synced;
  WebGL2 30.0 throttled, 114.5 synced; no console errors. The first WebGL2 run after a backend switch rendered 6 fps for a few
  seconds while shaders compiled, then settled at 30.
- **Persistence** (`pw-atomic-framerate.mjs persist`, `/Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/perf/framerate/persist.json`): default unchecked = "30". Space on the focused
  checkbox -> checked, stored "1" -> reload -> still checked, loop "sync", 120 fps -> uncheck -> "30", 30 fps -> reload -> unchecked.
  Chip: `/Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/perf/framerate/controls-chip.jpg`. In the real /home card (702 css px wide) the cluster spans x 434-838 px and does not overlap
  the 2D/Atomic toggle (293-379) or the Live badge (925-978).

---

# PERFORMANCE: profile-and-optimize phase, round 2 (directive 44)

Same machine and method as round 1 (below). Background load: a local model server (`ds4-server`) kept the GPU at 50-99 %
"Device Utilization" for most of this session. `pw-atomic-profile.mjs` now has `WAIT_QUIET=1`: it waits on a blank page
until the whole GPU reads <= 10 % for 3 s before each sample, and it records the utilisation right after (`after`).
Most samples still had `after` 75-98 %, so the fps columns are noisy. GPU timestamps are the steadier signal.

## 44.1 Half-resolution floor reflection is now the default (shipped)

`resolveMirrorScale()` (`scene/rt/mirrorPass.ts`) returns 0.5 by default and always in production. The dev override `?mirrorres=1`
draws the reflection inline at full resolution, and `?mirrorres=<0.1..0.99>` picks another scale. Round 1 has the approved
evidence (SSIM 0.998-0.999, diff confined to the reflections, 32 atoms 120 fps at 120 Hz).
Regression check on this build vs the round-1 `mirrorres=0.5` captures: topo-16 / 20 / 32 / 20-close max diff 0-1 level (identical).
topo-08 differs only on the board trace pulses (max 214, SSIM 0.998). Its own r1-vs-r2 floor also differs there: the board pulses
run on wall-clock time and the bench's `paused=1` freezes only the atoms. The Gate A bench scenes (single default/close/idle,
grid 32), which do not use the reflection pass, match round 1 exactly (max 0-1).

## 44.2 Reduced-resolution hero translucency (built, dev flag only, NOT default)

Flag: `?herores=0.5` (cloud march + strands at 0.5x). `&herostrands=0` = cloud march only, strands at full res.
Off unless set (`resolveHeroScale`), and never in production.

How it works (`scene/rt/heroPass.ts`, `heroUniforms.ts`, `shaders/atomImpostor.ts`, `shaders/plasmaStrands.ts`, `rt/atomBatch.ts`):

- **Hero:** only the focused atom (detail/focus view), or the close-up hero when no atom is focused. Every other atom is unchanged.
- **Cloud:** the cloud march (shared code, `marchCloud`) runs for the hero in a low-res pass, `heroCloud` mesh, RGBA32F.
  - It uses the same ray, glass refraction and nucleus termination (hit distance only, no nucleus shading).
  - It writes the emission plus both transmittances, packed exactly in fp32 (11 bits each) with a nucleus-hit flag.
- **Upsample:** the hero's full-res impostor skips the march and reads the target back with a 4-tap bilinear upsample that is
  nucleus-hit aware (depth-aware). Taps whose nucleus flag differs from the full-res pixel are weighted 0.02, so cloud from
  the other side never bleeds over the full-res nucleus edge.
- **Stays full DPR:** the nucleus, glass shell, cyan limb and flare (same shader), plus sparkles (the closed cyan rim), wires,
  bolts, board, links, labels and UI.
- **Strands (cloud+strands mode):** the hero row leaves the bucket draws.
  - It is drawn once into a low-res additive target at width-compensated, energy-conserving pixel size, then composited
    additively at the strands' renderOrder (9).
  - It is drawn once into the (half-res) floor reflection.

### Identical-state A/B (`pw-atomic-hero-ab.mjs`)

Each scene is loaded once with the flag. The clock is frozen (bench `paused=1`, /home Pause button), and a press without movement
stops the detail view's cinematic drift. The pass is switched off and on live (`window.__atomicHeroEnabled`), so camera, time and
data are identical. "floor" = off vs off again, i.e. the same state's own capture-to-capture noise.

| scene                                            | hero    | cloud + strands at 0.5 (SSIM, % px > 2 / > 8 levels, max) | cloud only at 0.5 (SSIM, % > 2 / > 8, max) | floor max                                    |
| ------------------------------------------------ | ------- | --------------------------------------------------------- | ------------------------------------------ | -------------------------------------------- |
| real /home card (~700x418 css), OpenAI detail    | yes     | **0.99929**, 3.71 / 0.62, 72                              | **0.99966**, 2.31 / 0.15, 171              | 72 / 171 (1-2 px)                            |
| real /home fullscreen (3196x1996), OpenAI detail | yes     | **0.98650**, 9.01 / 4.46, 102                             | **0.99866**, 4.06 / 0.23, 42               | 0                                            |
| bench detail, provider                           | yes     | **0.99037**, 8.01 / 3.19, 78                              | **0.99833**, 4.27 / 0.40, 35               | 0                                            |
| bench detail, hub                                | yes     | **0.97823**, 12.15 / 6.02, 115                            | **0.99728**, 6.24 / 0.69, 35               | 0                                            |
| bench close-up (zoom 8, close hero)              | yes     | 0.97495                                                   | 0.97461                                    | 231 (this scene does not freeze; not usable) |
| bench default view                               | no hero | identical (max 0)                                         | identical (max 0)                          | 0                                            |

What the diff shows (worst-region crops, 1:1 device px, before | after | diff x16):

- **Cloud + strands:** the hero's hairline strands become visibly softer and slightly thicker at 0.5x. That is a visible change
  at fullscreen and close-up. Crops: `/Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/perf/preview/hero-ab-cloud-strands_home-fs-detail-worst-crop.jpg`,
  `.../hero-ab-cloud-strands_bench-detail-hub-worst-crop.jpg`, `.../hero-ab-cloud-strands_home-card-detail-worst-crop.jpg`,
  `.../hero-ab-cloud-strands_bench-detail-worst-crop.jpg`.
- **Cloud only:** differences are low-amplitude, fine-grained noise inside the cloud body (the march jitter is now per low-res pixel).
  There are no edge or nucleus artefacts. Crops: `/Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/perf/preview/hero-ab-cloud-only_home-fs-detail-worst-crop.jpg`,
  `.../hero-ab-cloud-only_bench-detail-hub-worst-crop.jpg`, `.../hero-ab-cloud-only_home-card-detail-worst-crop.jpg`,
  `.../hero-ab-cloud-only_bench-detail-worst-crop.jpg`.
- **Full PNGs** (on disk): `/Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/perf/hero-ab-cloud-strands/{off,on,diff}/` and `/Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/perf/hero-ab-cloud-only/{off,on,diff}/`.

### Fullscreen detail perf (real /home, 3196x1996, OpenAI detail, 3 interleaved rounds, `/Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/perf/ab-hero-fullscreen.txt`)

| build                                    | GPU ms/frame (timestamps) | uncapped fps          |
| ---------------------------------------- | ------------------------- | --------------------- |
| default (half-res reflection)            | 6.3 / 6.5 / 10.4          | 106.5 / 105.6 / 64.7  |
| `herores=0.5&herostrands=0` (cloud only) | 5.8 / 5.1 / 7.7           | 121.6 / 115.2 / 81.6  |
| `herores=0.5` (cloud + strands)          | 4.5 / 4.5 / 4.5           | 124.3 / 117.4 / 111.7 |

Cloud + strands cuts the hero frame's GPU time by about 30-55 % and reaches ~112-124 fps uncapped in fullscreen detail (target

> = 120: met in 1 of 3 rounds, within the noise of the other two). Cloud only saves less (about 10-25 %). The remaining GPU time
> under the flag is mostly the hero's full-res impostor shading (nucleus trace, glass, limb), measured with `hideLayers=impostor`
> at 1.9-2.6 ms. The uncapped p95/p99 stay at the presentation beat from round 1 (25-45 ms); they are not render cost.
> The run labelled "capped" in that file did not engage vsync in fullscreen and is not used here.

**Decision needed (directive 44.2):** cloud + strands meets the fps target but softens the hero's hairline strands (SSIM 0.978-0.999).
Cloud only is near-invisible (SSIM 0.997-0.9997) but does not reach 120 fps. Neither is the default until the operator chooses.
---

# PERFORMANCE: profile-and-optimize phase, round 1 (directives 19, 21, 41)

Apple M5 Max (40-core GPU), macOS, headed Chrome via Playwright, WebGPU adapter `apple/metal-3`, real GPU (no SwiftShader).
Bench viewport 1600x1000 CSS px at DPR 2 (canvas 3196x1996), MSAA + bloom + DOF + post on, no quality tier.
Background load was NOT controlled: with no bench running, `ioreg` showed GPU "Device Utilization" at 38-55 %
(WindowServer, Discord, TIDAL, Kiro) and BTLEServer at ~99 % CPU. A/B comparisons below are interleaved runs in the same session.

## Method

| Tool (all in `scripts/ad-hoc/`)                                              | What it measures                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pw-atomic-profile.mjs`                                                      | Per frame: rAF delta, CPU time inside `pipeline.render()` (JS submit), GPU time from WebGPU timestamp queries (`?gputime=1`, three `trackTimestamp`, resolved every frame). `CAPPED=1` = normal vsync, `WINPOS=0,0` = window on the built-in 120 Hz ProMotion panel, default = uncapped (`--disable-gpu-vsync --disable-frame-rate-limit`). Modes: bench queries, `home` (real /home, Atomic), `home:detail=<id>`, `home:fs` (Fullscreen button + OpenAI detail). |
| `pw-atomic-presents.mjs`                                                     | Frames the page renders vs frames the GPU process actually presents (Chrome trace, `gpu`/`viz`).                                                                                                                                                                                                                                                                                                                                                                  |
| `pw-atomic-stall-probe.mjs`, `pw-atomic-cpu-tail.mjs`, `pw-atomic-trace.mjs` | Where a slow frame blocks: wrapped `GPU*` prototypes, CPU sampling split by slow/fast frame, GPU-process trace events.                                                                                                                                                                                                                                                                                                                                            |
| `pw-atomic-pacing-control.mjs`                                               | Control: a raw WebGPU page (no three.js, one full-screen draw with N ALU iterations) under the same flags.                                                                                                                                                                                                                                                                                                                                                        |
| `pw-atomic-uploads.mjs`, `pw-atomic-tris.mjs`, `pw-atomic-ablate.mjs`        | `writeBuffer` volume per frame, triangle/instance inventory, cumulative ablation.                                                                                                                                                                                                                                                                                                                                                                                 |
| `pw-atomic-perf-capture.mjs` + `atomic-perf-diff.mjs`                        | Identical-camera captures (frozen clock: topology bench `paused=1`, Gate A grid `t=7.25`; warm-up load first; each scene captured twice to measure the build's own determinism) and pixel diff: max/mean abs, % pixels > 2 and > 8 levels, PSNR, 8x8 luma SSIM, side-by-side and x16 diff images.                                                                                                                                                                 |

Bench "atoms=N" renders N providers + hub + merged device atoms (8 -> 10, 16 -> 18, 20 -> 22, 32 -> 34). The real /home fleet renders 10 atoms.

## Finding 1: the uncapped p95/p99 tail (and the 32-atom grid tail) is presentation back-pressure, not render cost

Uncapped, baseline (this branch at `60bb0af23`), 8 s windows:

| case                 | rAF fps | rAF p50 / p95 / p99 ms           | GPU ms/frame (timestamps, mean) | CPU in render() p50 | slow frames > 12 ms recur every |
| -------------------- | ------: | -------------------------------- | ------------------------------: | ------------------: | ------------------------------- |
| atoms=20 (22)        | 177-197 | 1.6-4.7 / 22.1-22.5 / 22.7-23.7  |                         2.5-3.1 |             1.1-1.5 | 6-7 frames                      |
| atoms=32 (34)        | 165-185 | 2.1-4.8 / 22.2-23.2 / 23.5-24.7  |                        2.75-3.2 |             1.3-1.5 | 7 frames                        |
| Gate A grid count=32 |  75-107 | 8.6-12.6 / 43.9-65.1 / 44.8-66.2 |                         6.3-9.2 |    n/a (bench loop) | 2-11 frames                     |

- The GPU needs 2.5-3.2 ms per frame for the topology and 6-9 ms for the grid, yet every 6th-7th frame takes ~22 ms (grid: ~44-65 ms).
  A 22 ms frame is not GPU work: no single frame's GPU time comes near it.
- Where the main thread blocks: in a slow frame the time is spent inside `GPURenderPassEncoder.setPipeline` (CDP sampling: 3.5 s of 5 s in slow
  frames), i.e. the Dawn wire command ring is full and the renderer waits for the GPU process to drain it.
- Why the GPU process stops draining: the trace shows `IOSurfaceImageBacking::WaitForCommandsToBeScheduled` on `CrGpuMain` (~17 ms per present).
  At each compositor present the GPU process waits until Metal has scheduled every queued command buffer that touches the canvas surface.
- **Presents vs renders** (`pw-atomic-presents.mjs`, 2 s): uncapped atoms=20 renders 177 frames/s but the GPU process presents **27.5/s**;
  atoms=32 169.5 vs 28; grid32 89 vs 14. Capped (vsync), every rendered frame is presented: 60.5 vs 60 (60 Hz monitor), 110.5 vs 110.5 (120 Hz panel).
  So uncapped mode renders ~6 frames that are never shown for every frame that is, and each present waits ~6 frames x GPU time. That is the
  6-7-frame beat and the 22 ms (topology) / 44-65 ms (grid, 6-9 ms GPU frames) tail.
- **Control without our code:** a raw WebGPU page with one full-screen draw shows the same signature once it runs at a similar rate:
  ~170 fps -> p50 0.1 / p95 12.9 / p99 14.7 ms; ~190 fps -> 0.1 / 17.5 / 18.5; ~160 fps -> 0.2 / 17.8 / 25.5. It is Chrome/macOS presentation
  pacing with vsync disabled.
- Rejected fixes (measured, reverted): a frames-in-flight governor (`onSubmittedWorkDone`, limit 2/3/4) cut the uncapped p99 to 17.8 ms but
  dropped rendered fps to 97-119 (the completion round-trip is slower than presentation); trimming `writeBuffer` uploads to the used prefix
  (1.1 MB/frame -> less) did not change the tail. Upload volume is not the cause.
- Conclusion: uncapped fps on this machine is a GPU-headroom indicator, not what a user sees. The user metric is vsync-capped presented frames on
  the 120 Hz panel (below). GPU timestamps give the true per-frame GPU cost. With vsync on, the 22/44 ms tail does not exist (capped grid32 at 60 Hz:
  p95 17.4, p99 17.5, 0 spikes; at 120 Hz: no frame above 17.7 ms).

## Finding 2: what costs GPU time (timestamps, uncapped, interleaved, bench)

| A/B (atoms=20 unless noted)                                                       |                   GPU ms/frame | note                                                                                  |
| --------------------------------------------------------------------------------- | -----------------------------: | ------------------------------------------------------------------------------------- |
| baseline                                                                          |                        2.9-3.8 |                                                                                       |
| impostor cloud ray-march loop removed (dev hack, not shipped)                     |                            1.5 | the march is ~50 % of the frame                                                       |
| nucleus trace removed (dev hack)                                                  |                            2.7 | nucleus ~0.3 ms                                                                       |
| `hideLayers=impostor,impostorMirror,atomDepth`                                    |                           1.85 | all impostors ~1.9 ms                                                                 |
| `hideLayers=impostorMirror`                                                       |                 3.0 (from 3.8) | floor reflection of the impostors ~0.8 ms                                             |
| all board parts hidden                                                            |         1.8-2.0 (from 3.1-3.4) | board parts ~1.4 ms, noisy                                                            |
| grid32: march removed / nucleus removed                                           |           2.8 / 6.7 (from 7.0) | march ~4.2 ms of 7                                                                    |
| fullscreen detail (`pw-atomic-fs-profile.mjs`): DPR 1 / atoms hidden / env hidden | 2.7 / 0.8 / 1.8 (from 7.8-8.1) | per mesh (noisy): strands -2.0, strandMirror -2.7, impostor -3.9, impostorMirror -2.9 |

Capped at 120 Hz, the frames that miss vsync go away when the impostors or one of the two mirror layers are hidden
(atoms=20: 110 fps / 58 missed -> 120 fps / 0 missed with `impostorMirror` hidden, 119.7 / 2 with `strandMirror` hidden), while hiding all
board parts does not help (110.8 / 55). The ray-marched impostor and the floor reflection decide whether a 120 Hz frame fits.

## Non-visible work (directive 19)

- Already in place and re-verified: frustum culling of strands/sparkles/links, projected-size march steps and strand buckets, and the render loop
  stop when the canvas is off-screen (IntersectionObserver) or the tab is hidden (0 scene frames in 3 s, measured in Gate B round 4).
- New finding: in uncapped mode ~85 % of rendered frames are never presented (Finding 1). With normal vsync this waste is zero (rendered = presented),
  so no change is needed for users.
- Tried and rejected because they saved nothing measurable (interleaved A/B, all within noise, reverted, pixel diff <= 1 level):
  rotating the sample direction instead of the 13 petal axes per march step (the Metal compiler already hoists it), and skipping march samples
  in the empty outer cloud shell (beyond `reach + 0.08`).
- Board parts on walls/ceiling are not frustum-culled per instance; the GPU clips them, and hiding all parts did not move the 120 Hz result.

## Shipped in this round: no visible change (pixel-identical)

The only production-path edits are dev-only (no effect in production builds): GPU timestamp queries on the Gate A bench renderer behind `?gputime=1`,
a dev handle on the bench, `?hideEnv=1` on the bench, and the `?mirrorres=<scale>` experiment below (default off).
Identical-camera captures, baseline `60bb0af23` vs this round's default, 9 scenes (topology 8/16/20/32, 20 close-up, Gate A grid 32,
single default/close/idle): **max abs difference 0 in every scene** (PSNR inf, SSIM 1). Build determinism (r1 vs r2): max 0-1 level.
Full PNGs (on disk, gitignored): `/Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/perf/before/`, `.../perf/after/`,
side-by-sides and x16 diffs in `.../perf/diff-after/`; previews (tracked) `.../perf/preview/diff-after_*`.

## Experiment awaiting operator decision: half-resolution floor reflection (`?mirrorres=0.5`, NOT shipped)

`src/plugins/atomic-topology/scene/rt/mirrorPass.ts`: the two mirror layers (`impostorMirror`, premultiplied over; `strandMirror`, additive) are
rendered into their own half-resolution targets and composited back with one full-screen quad each, at the same renderOrder and blend equation.
Over-blends accumulated over transparent black composite exactly (associativity), additive layers commute, so only the reflection's resolution changes.

Measured, capped at 120 Hz on the built-in panel, 3 interleaved pairs (`.../perf/ab-mirror-capped120.txt`):

| case                                              | full-res reflection fps (missed vsyncs / 5 s)          | half-res reflection fps (missed)            |
| ------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------- |
| atoms=32 (34)                                     | 101.5 / 109.8 / 109.4 (93 / 51 / 53), p99 16.7-17.2 ms | **120 / 120 / 120 (0 / 0 / 0), p99 9.2 ms** |
| real /home fullscreen + OpenAI detail (3196x1996) | 60.7 / 66.5 / 65.8                                     | 90.0 / 88.9 / 80.4                          |

Pixel diff at identical camera (5 topology scenes): mean abs 0.08-0.22 levels, 1.5-3.0 % of pixels differ by > 2 levels, 0.2-0.7 % by > 8,
PSNR 42.8-50.7 dB, SSIM 0.9982-0.9993. All differences are inside the reflections (the x16 diff is black elsewhere); max local difference
135-212 levels on single pixels of thin reflected strands/nucleon edges, which the half-res reflection renders slightly softer.
Worst-region crop, 1.5x (before | half-res | diff x16): `/Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/perf/preview/diff-mirror-half_topo-20-worst-crop-before-after-diff.jpg`.
Full side-by-sides: `/Users/celes/sources/celesrenata/OmniRoute/.claude/worktrees/atomic-raytraced-renderer/OR_ATOM_010_RAYTRACED/screenshots/perf/diff-mirror-half/` (previews `.../perf/preview/diff-mirror-half_*`).
Because a change remains (a slightly softer reflection), it is not shipped (directive 41: stop and show the operator).

## Targets (vsync on, 120 Hz built-in panel, this round's default build)

| case                                  |         fps | p50 / p95 / p99 ms                | missed vsyncs | target                                                                           |
| ------------------------------------- | ----------: | --------------------------------- | ------------: | -------------------------------------------------------------------------------- |
| real /home, Atomic, 10 atoms (2 runs) |   120 / 120 | 8.3 / 9.1-9.2 / 9.3-9.4           |             0 | ~120 at real fleet: **met**                                                      |
| real /home, OpenAI detail open        | 120 / 119.8 | 8.3 / 9.0-9.3 / 9.3-9.4           |           0-1 | met                                                                              |
| bench atoms=8 (10)                    |         120 | 8.3 / 9.1-9.2 / 9.3               |             0 | met                                                                              |
| bench atoms=16 (18)                   |         120 | 8.3 / 8.9-9.3 / 9.2-9.3           |             0 | met                                                                              |
| bench atoms=20 (22)                   | 101.5-115.8 | 8.3-8.4 / 9.2-16.7 / 16.7-17.5    |  25-111 / 6 s | ~120: not met under this background load                                         |
| bench atoms=32 (34)                   |  98.7-109.9 | 8.3-8.4 / 16.6-16.7 / 16.9-17.5   |  61-128 / 6 s | >= 60: **met**; healthy p95/p99 needs the half-res reflection (120 fps, p99 9.2) |
| Gate A grid count=32                  |   86.7-90.5 | 8.4 / 16.8 / 17.4-17.5            | 177-200 / 6 s | >= 60: met                                                                       |
| real /home fullscreen + detail        |   60.7-82.5 | 16.5-16.7 / 17.0-17.6 / 17.4-25.1 |               | directive 41 >= 120: **not met**                                                 |

No frame above 25.2 ms in any capped run. The missed vsyncs at 20-32 atoms are single 16.7 ms frames (one missed vsync), never stalls.

## What remains

- Fullscreen detail >= 120 fps needs directive 41's mixed-resolution hero translucency (cloud march + strands at 0.5-0.7x with depth-aware upsample)
  on top of the half-res reflection; both change pixels slightly, so both need the operator's go-ahead.
- Directive 41's real-traffic feeder verification, directive 43 (replayed in-flight distinctness) and the directive 33 polish items are not part of this round.

---

# PERFORMANCE (Gate B, round 7)

Code SHA `a6d18051bac49fe744f91e6cde8c7ae21b72e998`. Apple M5 Max, headed Chrome (adapter `apple/metal-3`), 1600x1000 CSS px @ DPR 2 (bench), MSAA + bloom + DOF + post, no quality tier, uncapped, 5 s rAF deltas. Background GPU load not controlled.

## 8 / 16 / 20 / 32 atoms, uncapped (`node scripts/ad-hoc/pw-atomic-gateB.mjs ladder`; rendered = param + hub + merged devices)

| atoms (rendered)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | WebGPU avg fps | WebGPU p50 / p95 / p99 (ms) | WebGL2 avg fps | WebGL2 p50 / p95 / p99 (ms) | `b7d7ea448` (before DOF change) WebGPU / WebGL2 | round 6 WebGPU / WebGL2 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------: | --------------------------: | -------------: | --------------------------: | ----------------------------------------------: | ----------------------: |
| 8 (10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |          212.8 |           1.4 / 21.4 / 22.5 |          166.8 |            6.4 / 9.8 / 14.3 |                                   228.4 / 193.0 |           255.4 / 217.4 |
| 16 (18)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |          198.0 |           1.6 / 21.9 / 23.2 |          182.4 |           5.4 / 10.0 / 13.0 |                                   211.4 / 194.6 |           231.0 / 215.0 |
| 20 (22)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |          177.2 |           4.6 / 22.0 / 23.0 |          154.0 |           6.5 / 11.3 / 16.8 |                                   196.0 / 180.0 |           200.6 / 198.6 |
| 32 (34)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |          171.4 |           2.6 / 19.4 / 19.9 |          117.8 |           8.1 / 24.3 / 26.9 |                                   175.4 / 162.6 |           192.2 / 153.4 |
| Targets (~120 fps @ ~20 atoms, >= 60 fps @ 32): **met** on both backends. Spikes: 0 (WebGL2: 1 at 8). Cost of this round, measured. The petal sheets add 2 baked-noise samples per march step, and the analytic limb adds 1 per pixel (`b7d7ea448`: -2 to -10 % vs round 6). The viewer-based DOF (`a6d18051b`) blurs by true camera depth, so the whole far room now takes the 16-tap gather (before, the background CoC started at 2.3 x the focus distance and atoms had no depth). It also adds one depth-only sphere draw. That costs a further -4 to -27 %, most on WebGL2 at 32 atoms (163 -> 118). No target regressed. The gather cost is a candidate for the deferred profile phase (directive 21): half-resolution CoC/gather, or fewer taps for small CoC. |

## Real dashboard LOD distribution (`pw-atomic-home.mjs`, dev-only `window.__atomicLodStats`, this SHA)

| case                                                   | atoms | css px diameter min / median / max | LOD weight > 0.5 | 0 < weight <= 0.5 |
| ------------------------------------------------------ | ----: | ---------------------------------- | ---------------: | ----------------: |
| real fleet (mostly idle)                               |    10 | 39.2 / 50.2 / 78.3                 |                0 |                 3 |
| `topology-demo=mixed-lanes`                            |    11 | 26.9 / 35.6 / 56.9                 |                2 |                 8 |
| `topology-demo=unknown-stale`                          |    11 | 21.8 / 35.6 / 56.9                 |                2 |                 8 |
| `topology-demo=idle`                                   |    11 | 25.4 / 35.6 / 56.9                 |                2 |                 8 |
| Unchanged from round 6 (the LOD band was not touched). |

## Forced context / device loss (`loss`): 3/3 WebGPU `device.destroy` and 3/3 WebGL2 `WEBGL_lose_context` recovered, 1 canvas, 3196x1996, p50 8.3 ms after.

## Fallback (`fallback`): two failed restores -> host 2D in 1740 ms, 0 atomic canvases, 2D pressed.

## Reduced motion (`reduced`): static while idle (`staticWhileIdle: true`), orbit renders a new frame (`orbitRendersNewFrame: true`).

## 2D <-> Atomic toggle x50 (`toggle 50`, real host): 50/50 Atomic, 50/50 2D, peak 1 canvas, 0 at end, switch p50 59 ms / max 161 ms, heap 79.0 -> 86.9 MB over 40 toggles. Console: pre-existing `[LiveWS] FORBIDDEN_ORIGIN` and the pre-existing React "synchronously unmount a root" warning.

## 20-minute soak (`soak 1200000`, real `/home`, Atomic renderer, 40 samples of 30 s, this SHA)

20.0 min, 40 samples, display-synced at 60 Hz. Median sample 60.3 fps, p50 16.6-17.6 ms, 0 context losses, 1 canvas throughout. Heap: start 87.3 MB, end 86.0 MB, max 100.7 MB (flat). **Dips:** the first sample (warm-up, 42.7 fps, p99 183 ms) and 3 consecutive samples at about 14.5-15.5 min (41.7-43 fps, p99 ~34 ms, i.e. alternating 16.7/33 ms frames). No other process was started by me during that window, and I did not identify the cause. 167 frames over 30 ms in total, almost all in those 4 samples. The round-7 soak on `b7d7ea448` (before the DOF change) showed the same pattern (min 41.7 fps, 109 spikes), so it is not specific to the DOF change. Console: pre-existing `[LiveWS] FORBIDDEN_ORIGIN` (dev origin, `telemetry: null`) and the React unmount warning.
**Not exercised:** the 3.5 s live telemetry cadence (dev origin rejected by the websocket).
---

# PERFORMANCE (Gate B, round 6)

Code SHA `076bc2219ed03505ebeef69e9e9487dcb2cf434b`. Apple M5 Max, headed Chrome (adapter `apple/metal-3`), 1600x1000 CSS px @ DPR 2 (bench), MSAA + bloom + DOF + post, no quality tier, uncapped, 5 s rAF deltas. Background GPU load not controlled.

## 8 / 16 / 20 / 32 atoms, uncapped (`node scripts/ad-hoc/pw-atomic-gateB.mjs ladder`; rendered = param + hub + merged devices)

| atoms (rendered)                                                                                                                                                                                                                                                                                                                                                                                                 | WebGPU avg fps | WebGPU p50 / p95 / p99 (ms) | WebGL2 avg fps | WebGL2 p50 / p95 / p99 (ms) | round 5 WebGPU / WebGL2 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------: | --------------------------: | -------------: | --------------------------: | ----------------------: |
| 8 (10)                                                                                                                                                                                                                                                                                                                                                                                                           |          255.4 |           3.1 / 20.4 / 21.4 |          217.4 |            4.4 / 7.6 / 10.0 |             326.6 / 239 |
| 16 (18)                                                                                                                                                                                                                                                                                                                                                                                                          |          231.0 |           2.0 / 20.9 / 22.1 |          215.0 |            4.5 / 7.8 / 11.2 |             275.6 / 227 |
| 20 (22)                                                                                                                                                                                                                                                                                                                                                                                                          |          200.6 |           2.3 / 21.3 / 22.7 |          198.6 |            5.1 / 9.0 / 11.1 |             231.0 / 202 |
| 32 (34)                                                                                                                                                                                                                                                                                                                                                                                                          |          192.2 |           2.2 / 21.6 / 22.6 |          153.4 |           6.1 / 12.3 / 14.5 |             192.6 / 174 |
| Targets (~120 fps @ ~20 atoms, >= 60 fps @ 32): **met** on both backends. Spikes: 0 (WebGL2: 1 each at 8 and 32). The WebGPU p95 tail (~21 ms) is the known pattern, deferred by directive 21.                                                                                                                                                                                                                   |
| Why it is slower than round 5 at 8-20 atoms: directive 31 moved the LOD switch from ~170 css px to 16-46 css px, so most atoms now render the full ray-traced atom (round 5 rendered the cheaper LOD for them), plus the platform / reflection / panel shading. Round 6a (LOD up to 170 px) measured 349 / 324 / 270 / 231 fps, which is the cost of the earlier LOD choice for comparison. No target regressed. |

## Real dashboard (`/home`, Atomic mode, 1440x900 @2x, real local fleet) LOD distribution (`pw-atomic-home.mjs`, dev-only `window.__atomicLodStats`)

| case                                                                                                                                                                                                                                                                         | atoms | css px diameter min / median / max | atoms with LOD weight > 0.5 | atoms with 0 < weight <= 0.5 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: | ---------------------------------- | --------------------------: | ---------------------------: |
| real fleet (mostly idle)                                                                                                                                                                                                                                                     |    10 | 39.2 / 50.2 / 78.3                 |                     0 (0 %) |                     3 (30 %) |
| `topology-demo=mixed-lanes`                                                                                                                                                                                                                                                  |    11 | 26.9 / 35.6 / 56.9                 |                           1 |                            7 |
| `topology-demo=unknown-stale`                                                                                                                                                                                                                                                |    11 | 21.8 / 35.6 / 56.9                 |                           2 |                            8 |
| `topology-demo=idle`                                                                                                                                                                                                                                                         |    11 | 25.4 / 35.6 / 56.9                 |                           2 |                            8 |
| Before this round (LOD fully on below ~170 css px): 100 % of the atoms in every case. Target "< 25 % in LOD": met for the real fleet (0 % mostly-LOD); the demo scenarios (larger 11-atom layout, smaller atoms) have 9-18 % mostly-LOD and the rest in the cross-fade tail. |

## Forced context / device loss (`loss`): 3/3 WebGPU `device.destroy` and 3/3 WebGL2 `WEBGL_lose_context` recovered, 1 canvas, 3196x1996, p50 8.3 ms after.

## Fallback (`fallback`): two failed restores -> host 2D in 1701 ms, 0 atomic canvases, 2D pressed.

## Reduced motion (`reduced`): static while idle (`staticWhileIdle: true`), orbit renders a new frame (`orbitRendersNewFrame: true`).

## 2D <-> Atomic toggle x50 (`toggle 50`, real host): 50/50 Atomic, 50/50 2D, peak 1 canvas, 0 at end, switch p50 34 ms / max 149 ms, heap 86.4 -> 89.0 MB over 40 toggles (flat), 81.5 MB after forced GC. Console: pre-existing `[LiveWS] FORBIDDEN_ORIGIN` and the pre-existing React "synchronously unmount a root" warning (reproduced on `9805665e6`, host code).

## 20-minute soak (`soak 1200000`, real `/home`, Atomic renderer, 40 samples of 30 s)

20.0 min on the dashboard (real host), 40 samples: avg fps 45.3-60.3 (the window was display-synced at 60 Hz this run; the round-5 soak ran at 120 Hz), p50 16.7-16.7 ms, p95 17-17.7 ms, p99 max 133.5 ms, 3 spikes over 30 ms in total (one 30 s sample dipped to 45.3 fps avg / 133 ms p99 at about 4 min, when I ran `npm run check:cycles` on the same machine; every other sample is 60.3 fps), 1 canvas, context lost 0; heap start 89 MB, end 95.4 MB, max 96.7 MB (flat; +6 MB over 20 min is within allocator noise, no growth trend in the 40 samples). Console: pre-existing `[LiveWS] FORBIDDEN_ORIGIN` (dev origin, so `telemetry: null`) and the pre-existing React unmount warning.
**Not exercised:** the 3.5 s live telemetry cadence. The dev server's websocket rejects this origin (`FORBIDDEN_ORIGIN`), so `telemetry` stayed `null`; this is a rendering/stability soak, not a live-data soak.

## Visibility savings / profile phase

Unchanged from round 5 (frustum culling, projected-size march steps, hidden-tab stop). The deeper profile (GPU timestamps, the 32-atom tail, the p95 stalls) stays deferred to the post-Step-12 phase (directive 21).
---

# PERFORMANCE (Gate B, round 5)

Code SHA `96c17acf3`. Apple M5 Max, headed Chrome (adapter `apple/metal-3`), 1600x1000 CSS px @ DPR 2, MSAA + bloom + DOF + post, no quality tier, uncapped, 5 s rAF deltas.
Background GPU load not controlled.

## 8 / 16 / 20 / 32 atoms, uncapped (`node scripts/ad-hoc/pw-atomic-gateB.mjs ladder`; rendered = param + hub + merged devices)

| atoms (rendered)                                                                                                                                                                   | WebGPU avg fps | p50 / p95 / p99 ms | WebGL2 avg fps | p50 / p95 / p99 ms |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------: | ------------------ | -------------: | ------------------ |
| 8 (10)                                                                                                                                                                             |          326.6 | 0.9 / 15.0 / 15.6  |          239.4 | 4.0 / 7.1 / 9.2    |
| 16 (18)                                                                                                                                                                            |          275.6 | 2.9 / 16.0 / 19.9  |          227.2 | 4.2 / 7.1 / 9.6    |
| 20 (22)                                                                                                                                                                            |          231.0 | 1.2 / 21.3 / 22.5  |          202.4 | 4.5 / 8.7 / 11.1   |
| 32 (34)                                                                                                                                                                            |          192.6 | 2.3 / 21.5 / 22.5  |          174.0 | 5.5 / 10.0 / 12.0  |
| Targets: ~120 fps @ ~20 atoms and >=60 fps @ 32: **met** on both backends. Spikes: 0. The WebGPU p95 tail (~20 ms) is the same pattern as round 4 and is deferred by directive 21. |
| DOF cost: the first DOF build (gather on every pixel) measured WebGPU 206 / 185 and WebGL2 162 / 140 fps at 20 / 32; skipping the gather where CoC = 0 restored the numbers above. |

## Forced context / device loss (`pw-atomic-gateB.mjs loss`): 3/3 WebGPU `device.destroy` and 3/3 WebGL2 `WEBGL_lose_context` recovered, 1 canvas, 3196x1996, p50 8.3 ms after.

## Fallback (`fallback`): two failed restores -> host 2D in 1730 ms, 0 atomic canvases, 2D pressed.

## Reduced motion (`reduced`): static while idle true, orbit renders a new frame true.

## 2D <-> Atomic (`toggle 50`): 50/50 mounts each way, peak 1 canvas, 0 at end, switch p50 35 ms / max 142 ms, heap 79.9 -> 88.0 MB over 50 toggles.

## 20-minute soak (`soak 1200000`): 20.0 min on the dashboard (real host, display-synced 120 Hz), 40 samples: avg 120.3 fps every sample, p50 8.3 ms throughout, p95 8.9-9.2 ms, 0 spikes, 1 canvas, context lost 0; heap start 106.8 MB, end 88.4 MB, max 106.8 MB (flat). Console: pre-existing `[LiveWS] FORBIDDEN_ORIGIN` (dev origin, so `telemetry: null`) and the pre-existing React unmount warning.

---

# (history) PERFORMANCE (Gate B, round 4)

Only measured numbers. Unmet targets are stated as unmet. Code SHA `a4e5713ee361d61887c3041358cdadd5e185d4ba`. Apple M5 Max, macOS 26.6.2, headed Chrome 157 (WebGPU adapter
`apple/metal-3`), Playwright, 1600x1000 CSS px at DPR 2 (3200x2000), MSAA + bloom + post on, no quality tier, uncapped
(`--disable-frame-rate-limit --disable-gpu-vsync`), 5 s `requestAnimationFrame` deltas. Background GPU load was not controlled (other apps running).

## 8 / 16 / 20 / 32 atoms, uncapped (`pw-atomic-gateB.mjs ladder`, golden DEMO topology; "atoms rendered" = param + hub + merged devices)

| Param (rendered)                                                                                                                                                                       | WebGPU fps | p50 ms | p95 ms | p99 ms | WebGL2 fps | p50 | p95 |  p99 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------: | -----: | -----: | -----: | ---------: | --: | --: | ---: |
| 8 (10)                                                                                                                                                                                 |      324.6 |    2.5 |   14.4 |   15.1 |      250.8 | 4.1 | 6.6 |  9.2 |
| 16 (18)                                                                                                                                                                                |      272.0 |    2.9 |   16.6 |   19.9 |      225.4 | 4.4 | 7.4 | 10.0 |
| 20 (22)                                                                                                                                                                                |      227.0 |    1.3 |   21.2 |   22.2 |      198.0 | 4.8 | 8.7 | 11.4 |
| 32 (34)                                                                                                                                                                                |      190.6 |    2.0 |   21.9 |   23.1 |      178.2 | 5.7 | 9.8 | 11.6 |
| Targets: about 120 fps at about 20 atoms **met** (227 fps), >= 60 fps at 32 atoms **met** (191 fps). No errors, no spikes over 30 ms.                                                  |
| The p95/p99 of 20-23 ms on the larger WebGPU topologies is one 17-24 ms frame in about 20 (p50 stays 1.3-2.9 ms); not a sustained slowdown. Deep profiling is deferred (directive 21). |

## No regression on the real topology (previous round vs now, same machine, same session, 3 interleaved runs, uncapped, `probe`)

"Before" = `9805665e6` (dev server :20198), "now" = this branch (:20199). The merge removes two device atoms, so before renders 24/36 atoms and now 22/34.

| Query                                                                                                                                                                                | before fps (3 runs)               | now fps (3 runs)                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- | ---------------------------------- |
| atoms=20                                                                                                                                                                             | 228.4 / 220.0 / 205.0             | 229.8 / 229.0 / 213.2              |
| atoms=32                                                                                                                                                                             | 211.0 / 203.4 / 186.6             | 200.0 / 193.2 / 187.8              |
| atoms=32 close-up (wheel zoom x7, `pw-atomic-closecmp.mjs`)                                                                                                                          | 93.8 / 91.6 / 86.6 (p95 37-65 ms) | 102.6 / 94.0 / 96.2 (p95 45-46 ms) |
| Verdict: no measurable regression from the PCB container, 3D parts, new links or the merge. The close-up 32-atom case runs at about 95 fps with a 45 ms p95 (stalls), which is worse |
| than the default-view p95 and goes to the deferred profile phase.                                                                                                                    |

## Directive 19: visibility savings (before = `?cull=0` savings off, on = default; same build, 3 interleaved rounds, medians, `pw-atomic-visibility.mjs ab`)

| Scenario                                                                                                                                                                           | off fps (p50/p95 ms)         | on fps (p50/p95 ms) |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------- |
| default, 20 atoms                                                                                                                                                                  | 221.6 (2.3 / 21.0)           | 218.6 (2.2 / 21.1)  |
| default, 32 atoms                                                                                                                                                                  | 197.2 (3.3 / 21.5)           | 193.2 (2.2 / 21.6)  |
| close-up (zoom 7), 32 atoms, most off-screen                                                                                                                                       | 84.0 (9.9 / 63.1)            | 84.4 (8.7 / 62.9)   |
| closer (zoom 11), 32 atoms                                                                                                                                                         | 85.6 (9.7 / 62.8)            | 88.6 (9.7 / 62.5)   |
| **Frustum culling and projected-size march-step scaling save nothing measurable on this GPU/workload** (differences are within run-to-run noise): frame time is dominated by fixed |
| full-screen work and the few big on-screen atoms, not by culled atoms. I am reporting that rather than claiming a saving. The idle-link draws that used to run every frame (bolt   |
| mesh, now flare/spark/floor draws) are hidden unless a strike is live; that is not separately measurable either.                                                                   |
| **Render-loop stop (measured, 3 s windows of `window.__atomicRtFrames`, headed Chrome):**                                                                                          |
| State                                                                                                                                                                              | scene frames rendered in 3 s |
| ---                                                                                                                                                                                | ---:                         |
| visible                                                                                                                                                                            | 757                          |
| canvas scrolled out of view (IntersectionObserver)                                                                                                                                 | **0**                        |
| back in view                                                                                                                                                                       | 736                          |
| tab hidden (`visibilitychange`; driven by overriding `document.hidden` because Playwright tabs are separate windows)                                                               | **0**                        |
| tab visible again                                                                                                                                                                  | 722                          |
| So the GPU frame time spent on a hidden or out-of-view canvas goes from a full frame loop to zero.                                                                                 |

## Forced context / device loss (`loss`, 16-atom default, x3 per backend)

WebGPU `device.destroy()` x3: canvas replaced each time (`replaced: true`, 1 canvas, 3196x1996), p50 after 3.3 / 3.3 / 2.7 ms (before 2.5), 451-458 frames in the window. WebGL2
`WEBGL_lose_context` x3: replaced each time, p50 4.0 / 4.4 / 4.0 ms (before 4.6). 0 console errors.
**Two-failed-restores fallback** (`fallback`, dev `?restore-fail=1`, real `/home`): returned to the 2D renderer in 1681 ms, 0 atomic canvases, `2D` pressed.

## 2D <-> Atomic x50 (`toggle 50`, real `/home` host)

50/50 Atomic mounts, 50/50 2D mounts, peak 1 canvas, 0 at the end, switch p50 17 ms (max 200 ms), JS heap 80.4 MB at the end (curve 75.9, 107.7, 80.2, 110.4, 86.7 MB at 0/10/20/30/40: sawtooth, no growth).
Console: `[LiveWS] FORBIDDEN_ORIGIN` (dev server origin) and a React "synchronously unmount a root" warning that I reproduced on `9805665e6` too (host code, pre-existing).

## 20-minute soak (`soak 1200000`, real `/home`, Atomic renderer, 40 samples of 30 s)

Capped by the browser at 60 Hz: avg 60.3 fps, p50 16.6-16.7 ms, p95 18.1-18.6, p99 18.5-18.7, 0 spikes, 1 canvas throughout, **0 context losses**. Heap 122.8 MB at start, 86.3 MB at end (max 122.8): no growth.
**Not exercised:** the 3.5 s live telemetry cadence. The dev server's websocket rejects this origin (`FORBIDDEN_ORIGIN`), so `telemetry` stayed `null` for the whole run; the soak is a rendering/stability soak, not a live-data soak.

## Reduced motion (`reduced`)

`staticWhileIdle: true` (no frames rendered while idle), `orbitRendersNewFrame: true` (a camera change renders one new frame), 0 errors. Reduced motion also freezes embers, LED blinking, haze and link flicker (steady soft tint on events).

## GPU timestamps / 32-atom grid tail

Not done: deferred to the dedicated profile-and-optimize phase after Step 12 (operator directive 21). The Gate A grid stress result below is unchanged and still **unmet** uncapped.

---

# Gate B round 2 (historical; superseded by the round 4 section above)

Only measured numbers. Unmet targets are stated as unmet. **This section is the canonical run;** the older tables below
(first round, taken at 21-24 % and 100 % GPU load) are kept for history and are superseded where they disagree.

## Canonical run (code SHA `9368b50a1d67b35919da82d1be4cf1c49051f854`)

Apple M5 Max, macOS 26.6.2, headed Chrome 157 (WebGPU adapter `apple/metal-3`), Playwright, 1600x1000 CSS px at DPR 2 (3200x2000), MSAA +
bloom + post on, no quality tier. Uncapped (`--disable-frame-rate-limit --disable-gpu-vsync`), 5 s `requestAnimationFrame` deltas.
Background GPU load was **not** quiet: `ioreg` device utilisation 41 % before and 65 % after the runs (other apps). Numbers are therefore
a lower bound on headroom.

| Param (atoms rendered)                                                                                                                           | WebGPU avg fps | p50 |  p95 |  p99 | WebGL2 avg fps | p50 |  p95 |  p99 |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------: | --: | ---: | ---: | -------------: | --: | ---: | ---: |
| atoms=8 (12)                                                                                                                                     |            300 | 3.0 |  5.4 | 16.6 |            232 | 4.1 |  6.3 | 10.0 |
| atoms=16 (20)                                                                                                                                    |            261 | 3.3 | 12.0 | 21.4 |            205 | 4.8 |  7.4 | 11.4 |
| atoms=20 (24)                                                                                                                                    |            212 | 4.2 | 10.1 | 22.2 |            155 | 6.4 | 10.2 | 15.4 |
| atoms=32 (36), run 1                                                                                                                             |            194 | 4.4 | 22.2 | 23.9 |            153 | 6.1 | 11.8 | 14.3 |
| atoms=32 (36), run 2                                                                                                                             |            198 | 4.3 | 21.8 | 22.9 |                |     |      |      |
| atoms=20 focused on one atom (25)                                                                                                                |            254 | 3.2 | 20.5 | 21.7 |                |     |      |      |
| Targets: about 120 fps at about 20 atoms (**met**, 261 / 212 fps at 20 / 24 atoms) and >= 60 fps at 32 atoms (**met**, 194-198 fps at 36 atoms). |
| The per-frame cost rose slightly versus round 1 (345 fps at 24 atoms) because the room is richer (rack wall) and the machine was loaded          |
| (41-65 % vs 21-24 %); I did not isolate the two. The p95 of 20-22 ms on the larger topologies is one 17-24 ms frame in about every 20, not a     |
| sustained slowdown (p50 stays 3-4.4 ms).                                                                                                         |
| Capped 60 Hz window (normal browser): round 1 measured 60.2 fps, p99 17.7 ms at 8 / 20 / 32 atoms; not re-run this round.                        |

## Stress-case diagnosis (Gate A 32-atom grid, `bench:count=32`): UNMET uncapped, cause narrowed

Unchanged result: avg 107-121 fps, p50 7.6-8.9 ms, **p95 41-44 ms, p99 44-46 ms** (target p95 <= 16.7, p99 <= 25). Experiments this round
(`pw-atomic-gateB-spikes.mjs`, `probe` with `VW`/`VH`):

| Variable changed                                                                                                                            | Result                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Viewport 400x250 / 800x500 / 1600x1000 (same DPR 2)                                                                                         | p50 7.0 / 7.2 / 7.6 ms, long-frame period 118 / 236 / 130 ms. **Pixel count does not matter.**                         |
| `bloom=0`                                                                                                                                   | Identical (p95 43.2, p99 44.9). Post chain is not the cause.                                                           |
| Atom count 2 / 12 / 20 / 24 / 28 / 32 (800x500)                                                                                             | 0 / 0 / 14 / 18 / 39 / 37 frames over 30 ms in 5 s. Starts between 12 and 20 atoms and scales with atom count.         |
| Wrapped `GPUQueue.submit` + `onSubmittedWorkDone`                                                                                           | Completion latency 300+ ms (GPU work queued far ahead). The main-thread JS callback itself stalls for the long frames. |
| Reading: the stress case is bound by per-atom GPU geometry work (strands, wires, bolts), not by fill or post. With vsync off, the           |
| presentation queue fills and the page is blocked for about three vsync intervals (43 ms) every few frames. I did not capture a GPU          |
| timestamp trace, so "queue back-pressure" is an inference from the measurements above, not a proof. Real topology at 36 atoms does not show |
| the 43 ms stall (p99 23-24 ms). Capped 60 Hz it was clean in round 1 (p99 17.3 ms).                                                         |

## 20-minute soak (real dashboard `/home`, Atomic renderer)

`node scripts/ad-hoc/pw-atomic-gateB.mjs soak 1200000` on this code SHA, 20.0 min, 40 samples, 1 canvas throughout, context-lost events 0.
Frame p50 per sample 1.2-5.5 ms (shared GPU), JS heap start 127.2 MB, end 72.1 MB, max 127.2 MB (sawtooth, no growth).
Only console messages: `[LiveWS] Server error: FORBIDDEN_ORIGIN` (dev server origin rule, unrelated) and the React "unmount a root while rendering"
warning (pre-existing host teardown, also present with `?atomic-fx=legacy`).

## Forced context / device loss (`pw-atomic-gateB.mjs loss`, 16 atoms) on this code SHA

WebGPU `GPUDevice.destroy()` x3: canvas replaced each time, 1 canvas, p50 4.4-4.5 ms (before 4.2), 0 errors. WebGL2 `WEBGL_lose_context` x3:
canvas replaced each time, p50 5.0-5.1 ms (before 5.5), 0 errors.
Two failed restores (`pw-atomic-gateB.mjs fallback`, `/home?restore-fail=1`): after a forced loss, every rebuild fails; the host disposed the
Atomic instance and mounted the 2D renderer in 1.7 s (0 atomic canvases, `2D` pressed).

## 2D <-> Atomic toggling x50 (real host `/home`) on this code SHA

50/50 Atomic mounts, 50/50 2D mounts, peak canvases 1, end canvases 0, switch latency p50 16 ms / max 186 ms, JS heap after GC 74.8 / 79.4 /
116.6 / 82.3 / 111.5 MB at toggles 0/10/20/30/40, final 78.5 MB (no growth; the mid-run peaks are un-collected garbage).

## Reduced motion

`pw-atomic-gateB.mjs reduced`: static while idle (`staticWhileIdle: true`), an orbit drag renders a new frame (`orbitRendersNewFrame: true`).
---

# Older measurements (round 1, superseded where they disagree)

Only measured numbers. Unmet targets are stated as unmet.

## Machine, browser, load

- Apple M5 Max (40-core GPU), 128 GB, macOS 26.6.2, Chrome 157.0.8103.39 (headed, real GPU, WebGPU adapter `apple/metal-3`),
  Playwright 1.63.0, Node v24.21.0.
- Viewport 1600x1000 CSS px, DPR 2 (3200x2000 px canvas, no DPR cap). MSAA, bloom, post chain on. No quality tier exists.
- Uncapped runs add `--disable-frame-rate-limit --disable-gpu-vsync` so frame times show GPU headroom, not the 60 Hz cap.
- Background load, recorded honestly. GPU "Device Utilization %" (`ioreg`, 1 s samples) before the final runs: 21-24 % (after the
  operator closed the GPU consumers; it was 100 % earlier in the session and 41-44 % right after). Adobe Creative Cloud
  helpers, BTLEServer (about 99 % CPU), Kiro, Discord and WindowServer were still running. The 20-minute soak ran while a
  second headed browser was occasionally used for screenshots.
- Measure method: `requestAnimationFrame` deltas over 5 s (`scripts/ad-hoc/pw-atomic-gateA-live.mjs`, `pw-atomic-gateB.mjs`).

## Baseline re-measure (operator request): Gate A HEAD `6b5f5fe32`, default single atom, uncapped

| Run                              | Idle GPU util | default p50 | close p50 | 20 atoms p50 / p95 | 32 atoms p50 / p95 |
| -------------------------------- | ------------- | ----------- | --------- | ------------------ | ------------------ |
| Gate A report (round 11)         | n/a           | 2.7 ms      | 8.1 ms    | 8.0 / 11.2         | 11.2 / 30.3        |
| Re-measured, GPU util about 40 % | 40-42 %       | 2.90 ms     | 8.60 ms   | 9.0 / 11.4         | 11.7 / 41.3        |
| Re-measured, GPU util about 22 % | 21-24 %       | **2.70 ms** | 7.60 ms   | 7.6 / 10.3         | 9.8 / 27.3         |

The default single-atom baseline reproduces the Gate A 2.7 ms figure once the GPU is quiet, so the comparison below is valid.
(An earlier pair of runs at 100 % device utilisation gave 9.7 ms. That figure was a loaded GPU, not a regression.)

## Gate B full topology, WebGPU, uncapped (golden DEMO topology via `/dev/atomic-bench?atoms=N`)

`atoms=N` produces N providers plus the hub plus the device atoms in the DEMO snapshot, so the rendered atom count is higher.
Final runs, 3 repeats for the 32 row:

| Param                                                 | Atoms rendered |                   p50 |                p95 |                   p99 | avg fps |
| ----------------------------------------------------- | -------------: | --------------------: | -----------------: | --------------------: | ------: |
| atoms=8                                               |             12 |               2.70 ms |               4.30 |                 15.60 |     370 |
| atoms=16                                              |             20 |               2.70 ms |               4.20 |                 15.30 |     370 |
| atoms=20                                              |             24 |               2.90 ms |               4.50 |                 16.10 |     345 |
| atoms=32                                              |             36 | 3.00 / 2.90 / 3.00 ms | 4.70 / 4.60 / 4.60 | 16.90 / 16.70 / 16.50 | 333-345 |
| atoms=20, focused on one atom (`node=`, wheel zoom 8) |             24 |               2.90 ms |               4.60 |                 16.60 |     345 |

The p99 of about 16.7 ms is one display-link beat (a 16.7 ms frame every ~150 ms), the same beat the Gate A baseline shows.
Targets: about 120 fps at about 20 atoms (met, 345 fps), >= 60 fps at 32 atoms (met, 333 fps), uncapped 32-atom
p95 <= 16.7 ms and p99 <= 25 ms (**met on the full topology: p95 4.6, p99 16.9**).

The `pw-atomic-gateB.mjs ladder` mode (a separate harness with a 1600x1000 viewport) gave p50 2.7-4.3 ms but p95 7.8-21.6 ms
on WebGPU in a back-to-back run (8 / 16 / 20 / 32 atoms: p95 11.2 / 20.0 / 7.8 / 21.6). That run is noisy (the same 32-atom case gave p95
9, 12 and 21.5 in three consecutive probes), which is the presentation beat below, not render time. Do not read it as a per-case difference.

### WebGL2 backend (forced with `backend=webgl`), uncapped

| Param    | Atoms |    p50 |  p95 |  p99 | avg fps |
| -------- | ----: | -----: | ---: | ---: | ------: |
| atoms=8  |    12 | 3.9 ms |  6.1 |  8.0 |     251 |
| atoms=16 |    20 | 4.2 ms |  8.2 | 10.5 |     216 |
| atoms=20 |    24 | 4.9 ms |  8.9 | 11.2 |     201 |
| atoms=32 |    36 | 5.4 ms | 10.3 | 12.0 |     174 |

### Capped (normal 60 Hz window)

| Case                              | avg fps |  p50 |                p95 |                p99 |
| --------------------------------- | ------: | ---: | -----------------: | -----------------: |
| topology atoms=8 / 20 / 32        |    60.2 | 16.7 | 17.5 / 17.6 / 17.6 | 17.6 / 17.6 / 17.7 |
| Gate A single-atom grid, 20 atoms |    60.2 | 16.7 |               17.2 |               17.4 |
| Gate A single-atom grid, 32 atoms |    60.2 | 16.7 |               17.0 |               17.3 |

## The Gate A 32-atom grid stress case (UNMET in uncapped mode)

`/dev/atomic-bench?atomic-fx=rt&count=32`: 32 excited atoms on a grid with every atom about 4x larger on screen than in the real
default topology, a deliberate crowd stress test.

|                                        |        p50 |      p95 |      p99 |
| -------------------------------------- | ---------: | -------: | -------: |
| Gate A HEAD, GPU util about 22 %       |     9.8 ms |     27.3 |     62.2 |
| This branch, uncapped (best of 2 runs) | **7.2 ms** | **42.3** | **43.8** |
| This branch, 60 Hz capped              |       16.7 |     17.0 |     17.3 |

p50 improved (9.8 to 7.2 ms) and capped 60 Hz is clean, but the **uncapped p95 and p99 for this stress grid are not met**
(p95 42 ms, p99 44 ms against the 16.7 / 25 ms targets). The spikes are a regular ~43 ms frame about every ~430 ms (the same
beat appears in the Gate A baseline close-up, p99 43.6 ms). I believe this is presentation pacing with vsync disabled when the GPU is the
bottleneck, but I did not verify it with GPU timestamp queries. The verified fact is: real topology 32 atoms meets the target,
the 32-grid stress case does not (uncapped), and it is clean when capped.

## What the C7a batching changed (measured, same session)

- Before (Gate A HEAD), 32-atom grid: p95 27-41 ms, p99 62-67 ms. Per atom 28 render objects, each with its own uniform upload.
- After: the vertex-heavy layers (strands, mirror strands, sparkles, orbit wires, bolts, flares, links, motes, pedestals) are
  one instanced draw per layer for all atoms. Impostors stay two draws per atom (nucleon loops were about 30 % slower from a large
  indexed buffer). 8 batched draws plus 2 draws per atom.
- Rejected experiments (measured): all hot data in one indexed uniform buffer (+30 % close-up cost); per-variant bolt instance
  lists (about 40 ms stall each flicker); per-atom strand LOD that drops the closed rim (visible hollow shells, reverted: sparkles are never LOD'd).
- Projected-size work scaling (plan lever): the strand draw uses a rank-sorted index prefix by bucket (12.5/25/50/100 %) with
  hysteresis once an atom is below half the approved projected size. It is exactly 1 at the approved default, close and pair framings.

## GPU memory / renderer.info

Not instrumented in this pass. JS heap during the 20-minute soak is below. GPU buffers are fixed-size per batch (fields buffer 24 vec4 per
atom, one dynamic buffer 35 vec4 per atom, one 44-texel static texture row per atom). I did not read `renderer.info` memory counters,
so I make no GPU-memory claim.

## 20-minute soak (real dashboard `/home`, Atomic renderer, 24 s sampling windows)

Run on commit `5c52015b5` (renderer code identical to the final code SHA below). `node scripts/ad-hoc/pw-atomic-gateB.mjs soak 1200000`.
The page is the real host with its own live telemetry poller at its default cadence (the harness does not replace the cadence
with a 3.5 s injected feed; `OR_ATOM_009/scripts/soak.mjs` remains the injected-feed harness and was not re-run).

- Duration 20.0 min, 40 samples, 1 canvas throughout, `webglcontextlost` events: 0, no page errors from the renderer.
- Frame time p50 per sample 1.2-5.6 ms. The soak ran on a shared GPU (second browser for screenshots), so the upper end is load.
- JS heap: start 147.7 MB, end 89.5 MB, max 147.7 MB (sawtooth, no growth).
- Only console error: `[LiveWS] Server error: FORBIDDEN_ORIGIN` (the dev server rejects the live websocket origin; unrelated to rendering).

## Forced context / device loss (`pw-atomic-gateB.mjs loss`, 16 atoms)

| Backend | Forced with                                                   | Result x3                                                             |
| ------- | ------------------------------------------------------------- | --------------------------------------------------------------------- |
| WebGPU  | `GPUDevice.destroy()` via `window.__atomicForceContextLoss()` | canvas replaced each time, 1 canvas, p50 3.2-3.4 ms, 0 console errors |
| WebGL2  | `WEBGL_lose_context`                                          | canvas replaced each time, 1 canvas, p50 4.2-5.1 ms, 0 console errors |

The clock freezes (`sceneState.contextLost`), the Canvas (renderer, pipeline, materials, environment) is rebuilt on a fresh canvas,
and the failure counter resets after 3 healthy frames. After two consecutive failed rebuilds the instance throws on the next
`update`, which the host's existing update-failure path turns into the 2D renderer. The two-failed-rebuild fallback path to 2D was
not driven end to end in a browser (only the three recoverable losses were).

## 2D <-> Atomic toggling x50 (real host `/home`, buttons `2D` / `Atomic`)

50/50 Atomic mounts, 50/50 2D mounts, peak canvases 1, end canvases 0, switch latency p50 16 ms / max 151 ms,
JS heap after forced GC at toggles 0/10/20/30/40: 74.8 / 83.2 / 80.0 / 83.5 / 80.5 MB, final 78.6 MB (flat).
Console: `FORBIDDEN_ORIGIN` (unrelated) and one React warning "Attempted to synchronously unmount a root while React was already
rendering". That warning also appears with `?atomic-fx=legacy` (pre-existing host teardown behaviour, not caused by the new scene).

## Reduced motion

`prefers-reduced-motion: reduce`: two screenshots 2.5 s apart are byte-identical (static frame), and an orbit drag renders a new
frame (`reduced-a/b/c-orbited.png`). No orbit drift, noise drift, swirl or strobing; events show as steady colour (failure =
steady red bolt, no flash).
