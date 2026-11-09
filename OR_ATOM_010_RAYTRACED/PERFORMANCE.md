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
