# OR-ATOM-008 — S8.5 BEFORE-soak Measurements (pre-S8 baseline)

**Worker:** OR-ATOM-008 S8.5 BEFORE-soak RETRY (3rd attempt; worker-1 of batch `0b5b16bc`)
**Run window:** `2026-10-27T23:53:13Z` → `2026-10-28T00:14:10Z` (1200 s = exactly 20 min, no extension)
**Harness:** proven hardened `soak.mjs` reused from sibling after-worker (batch `7b55e16a`, worker-1):
`headless:false` full Chromium (no SwiftShader), viewport 1440×900, `localStorage renderer=atomic`
init script, per-minute FPS + WebGL-context trackers, forced mid-point remount, traffic injection,
finally-block partial JSON+log on crash. Only edit applied for the baseline is the mandated edit (a)
(`noUnboundedGrowth` → `true` when BOTH before/after `rendererInfo` are null).

## Baseline identity

- Worktree HEAD (snapshot commit): **`b33447f5e`** — _"Zoo parallel task snapshot"_.
- **Pre-S8 baseline content = `b83f63bdf`** (short sha) — _"docs(topology): OR-ATOM-007 evidence, skill
  audit + application report"_ — which **is MAIN HEAD** (`git -C MAIN log -1` = `b83f63bdf`).
- **Important nuance (honest):** in this snapshot the S8 changes were **committed into `b33447f5e`**,
  not left uncommitted. So the instructed `git checkout HEAD -- src/plugins/atomic-topology` would have
  restored **S8, not the baseline**. The plugin + test tree was therefore reverted to `b83f63bdf`
  (snapshot parent = MAIN HEAD) instead.
- Revert scope (exactly the 12 files the S8 snapshot commit touched in this scope):
  - 5 modified restored to `b83f63bdf` content: `AtomicTopologyRenderer.tsx`, `scene/AtomNode.tsx`,
    `scene/ElectronCloud.tsx`, `scene/EnergyLink.tsx`, `scene/Nucleus.tsx`.
  - 4 S8-only scene files removed: `scene/{filament,plasmaShader,cloudHaze,nucleusCluster}.ts`
    (`_diagProbe.tsx` was already absent — it was never in this snapshot).
  - 3 S8-only tests removed: `tests/unit/atomic-topology/{electronCloudHaze,nucleusCluster,sceneFilament}.test.ts`.
- **Verified baseline:** `git diff b83f63bdf -- src/plugins/atomic-topology tests/unit/atomic-topology`
  → **0 lines**. `scene/` contains no `filament/plasmaShader/cloudHaze/nucleusCluster/_diagProbe`;
  `grep -rl 'cloudHaze\|plasmaShader\|nucleusCluster'` → **no matches**.
- Dev server: `PORT=20141 npm run dev` in this worktree (`node_modules` hardlinked from MAIN via
  `cp -al`, `.env` copied). Port 20141 was free at start (leftover-PID check returned none).

## soak-before.json verdicts (as produced)

| Verdict             | Value                   | Meaning on the pre-S8 baseline                                                                                                                                                                                                                                                              |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stableContexts`    | **false**               | Requires `window.__atomic.liveCanvases === 1` on both sides + `contextLost === 0`. The S8.5 diagnostic probe (`window.__atomic`) is **absent** from the pre-S8 tree, so `liveCanvases` reads `null` → assertion is unsatisfiable **by instrumentation gap, not by a real context problem.** |
| `disposeOk`         | **absent** (not `true`) | Requires `remountResult.post.liveCanvases` from `window.__atomic` → `undefined` pre-S8 → not `true` (instrumentation gap, same root cause).                                                                                                                                                 |
| `noUnboundedGrowth` | **true**                | Mandated edit (a): both before/after `rendererInfo` are `null` → recorded **UNVERIFIED**, not a violation.                                                                                                                                                                                  |
| `allFramesNonBlank` | **true**                | Probe-independent: every one of the 20 per-minute frames has `pixelVar > 1`.                                                                                                                                                                                                                |
| `pass`              | **false**               | Conjunction; fails only on the two probe-dependent verdicts above.                                                                                                                                                                                                                          |

> `window.__atomic` / `probeRemount` / `rendererInfo` do not exist anywhere in the pre-S8 tree
> (full-tree grep on both `b83f63bdf` and snapshot `b33447f5e` → empty). This is the expected
> consequence of running the after-side harness against a before baseline.

### Genuine, probe-independent stability signals (all clean)

- **WebGL context lost / restored:** **0 / 0** (DOM `webglcontextlost`/`webglcontextrestored`
  counters, `before`/`after` blocks of `soak-before.json`). This is the real context signal and it
  shows **no context loss over the full 20 min** — i.e. the underlying `stableContexts` intent is
  met; only the probe-gated assertion cannot be expressed as `true`.
- **pageErrors:** `[]` (none).
- **Canvas:** single 702×420 canvas stable before→after (matches the after-soak's canvas geometry).

## FPS (per-minute, 20 samples)

- **min / avg / max = 119 / 119.95 / 120** (min-1 = 119, min-2…min-20 = 120).
- Consistent with a **120 fps display-locked headed** Apple M5 Max.

## Frame / pixel-variance (allNonBlank evidence)

- Per-minute `pixelVar` min **5613** / max **5699** / avg **5653** — tightly stable (no drift, no
  blank frames, no unbounded growth signature).
- Final frame: `pixelVar=5664`, `meanLum=751`, `702×420`.
- `allFramesNonBlank = true`.

## Console errors

- Deduped console errors: **only** `[LiveWS] Server error: FORBIDDEN_ORIGIN — Origin not allowed`.
  This is **pre-existing noise** (present identically on the after-soak) and is **not** attributable
  to the atomic-topology renderer or to S8. No renderer/WebGL/console exceptions of interest.

## renderer.info before / after — UNVERIFIED

- `before.rendererInfo = null`, `after.rendererInfo = null` (probe absent pre-S8). Therefore
  `render.calls`, `memory.geometries`, `memory.textures` are **UNVERIFIED** for the before baseline;
  `noUnboundedGrowth` is recorded as UNVERIFIED (mandated null-null → true) and is **not** a measured
  pass.
- **Recorded before-side calls evidence (first attempt):** `renderer-info-before.json` from
  `$OLD_BATCH/worker-2/OR_ATOM_008_task/screenshots/` — **`render.calls ≈ 201.14/frame`** at 120 fps
  (96,747 calls over a 4.01 s window; `memory.geometries` / `memory.textures` = UNVERIFIED — R3F v9.8.1
  store not attached to the canvas DOM element). This is the cited before-baseline call-rate figure.

## GPU note

- **Apple M5 Max** integrated GPU (`ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Max)`), run
  **headed** → display-locked at **120 fps**.
- The **discrete-GPU 60 fps target is UNVERIFIED** on this machine (only the M5 Max integrated path
  is available here).

## Why this retry exists (attempt history)

1. **Attempt #1** (batch `2de83902`): a **139-frame** before-soak **FATAL'd at min=138** on a
   post-gate extension and **did not write `soak-before.json`**. Root cause = duration was extended
   beyond the gate. This retry therefore ran **exactly** `DURATION=1200` with **no** extension.
2. **Attempt #2** (batch `7b55e16a`, worker-2, BEFORE side): the worker **stopped after 3 mistakes
   with zero artifacts**.
3. **This attempt:** full clean 20-min run, all artifacts written, exit 0.

## Task.json status decision

Per the task rule — "if all real gate verdicts (`stableContexts`, `disposeOk`, `allNonBlank`) are
true → `completed`; if any is false → `blocked`" — `stableContexts` is **false** (and `disposeOk` is
not `true`) because the S8.5 probe is absent in the pre-S8 baseline. The before-soak itself ran
cleanly (0 context lost/restored, all frames non-blank, stable ~120 fps, no page errors), so this is a
**probe-instrumentation gap, not a soak defect**. `task.json` is set to `blocked` with that one-line
reason; no other field is touched.
