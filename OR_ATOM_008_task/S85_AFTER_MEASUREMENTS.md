# OR-ATOM-008 S8.5 AFTER-Measurements (Recovery Run)

**Worker:** OR-ATOM-008 S8.5 RECOVERY (7b55e16a…/worker-1) · **Date:** 2026-10-27 (UTC)
**Gate:** 20-minute after-soak, **headed** full Chromium (Playwright `chromium-1243`, `headless: false`,
no SwiftShader args), viewport 1440×900, `omniroute.topology.renderer=atomic` init script,
per-minute FPS + context trackers, forced mid-point remount (`REMOUNT_AT=600`), traffic injection
(`TRAFFIC_AT≈420s`), dev server `PORT=20140 npm run dev` (S8 tree assembled in worktree; probe wired
live in `AtomicScene.tsx` for instrumentation only — the probe is NOT in the shipped patch).

## Why this run exists

The previous Menagerie batch (`2de83902…`) **stalled at minute 2** of its after-soak: the harness
launched **SwiftShader software-render `chrome-headless-shell`** (15–17 fps, no GPU), which froze the
rAF sampler loop and never wrote `soak-after.json`. All other evidence from that batch (before
baseline, after-desktop-*.png, stress matrix, dispose proof) is **valid and pre-audited** and is
carried into this report. This headed rerun is the **authoritative gate evidence** for S8.5.

## Verdicts — `soak-after.json`

```json
{
  "stableContexts": true,
  "disposeOk": true,
  "noUnboundedGrowth": true,
  "allFramesNonBlank": true,
  "pass": true
}
```

| Verdict             | Value    | Meaning                                                                                                                        |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `stableContexts`    | **true** | `contextLost=0`, `contextRestored=0` for all 20 minutes                                                                        |
| `disposeOk`         | **true** | forced remount at t≈600s: pre `live=1/peak=1` → post `live=1/peak=1`, `remounts=1` — old canvas disposed, no canvas leak       |
| `noUnboundedGrowth` | **true** | renderer.info flat over 20 min: calls=272, triangles=107862, geometries=43, textures=3, programs=6 — identical before vs after |
| `allFramesNonBlank` | **true** | all 20 per-minute frames + final non-blank (pixelVar 4747–4861, meanLum 751)                                                   |

## FPS (per-minute, 20 samples)

```
[118, 120, 121, 121, 120, 120, 120, 120, 120, 120, 120, 120, 120, 119, 120, 120, 120, 120, 120, 120]
```

- **min 118 / avg 120.0 / max 121** (display-locked ≈120 Hz on the M5 Max)
- Before-baseline (pre-audited, same machine, headed): **120 fps**
- 2D-fallback (pre-audited, integrated GPU): **58 fps**
- Attempt 1 (dead batch) under SwiftShader headless-shell: 15–17 fps — **invalidated by the stall; NOT used as evidence**

## Per-minute FPS + context table (summary of `soak-after.json.perMinute`)

|   min |         t | fps | live/peak canvases | ctxLost | geoms | tex | calls |                     remounts                      |
| ----: | --------: | --: | :----------------: | :-----: | :---: | :-: | :---: | :-----------------------------------------------: |
|     1 |     69.2s | 118 |        1/1         |    0    |  43   |  3  |  272  |                         0                         |
|     2 |    129.3s | 120 |        1/1         |    0    |  43   |  3  |  272  |                         0                         |
|     3 |    189.3s | 121 |        1/1         |    0    |  43   |  3  |  272  |                         0                         |
|     4 |    249.4s | 121 |        1/1         |    0    |  43   |  3  |  272  |                         0                         |
|   5–9 |  309–549s | 120 |        1/1         |    0    |  43   |  3  |  272  |                         0                         |
|    10 |      609s | 120 |        1/1         |    0    |  43   |  3  |  272  | **1** (forced remount t≈600s: pre 1/1 → post 1/1) |
| 11–19 | 669–1149s | 120 |        1/1         |    0    |  43   |  3  |  272  |                         1                         |
|    20 |     1209s | 120 |        1/1         |    0    |  43   |  3  |  272  |                         1                         |

Renderer info before vs after (identical — no growth):
calls **272** → **272** · triangles **107862** → **107862** · geometries **43** → **43** ·
textures **3** → **3** · programs **6** → **6** · liveCanvases **1** → **1** (peak **1**).

## Traffic injection + metrics

- Forced remount (t≈600s): `pre live=1 peak=1 remounts=0` → `post live=1 peak=1 remounts=1` — **dispose proof in soak** (no canvas/context leak).
- Mid-soak traffic (t≈420s): 2× `POST /v1/chat/completions` → **200/200** (`kiro/claude-haiku-4.5`).
- Metrics polling: `/api/provider-metrics` 200s accumulated to **401** over the soak (steady traffic, no stall).
- `pageErrors`: **0**. Console errors: **1 unique** — `[LiveWS] Server error: FORBIDDEN_ORIGIN Origin not allowed` (dev-server live-WS origin check, environment noise; not scene-related).

## Pre-audited evidence carried from batch `2de83902…` (valid, unchanged)

- **Stress matrix** (`screenshots/stress-matrix.json`, pre-audited; 8/16/32-atom fixtures):
  - 8 atoms → **247** render calls · 16 atoms → **484** · 32 atoms → **952** (geometries 36/69/135; programs constant at 6; liveCanvases=1 throughout; 0 page/console errors).
  - **Dispose proof** (32-atoms fixture): before `liveCanvases=1, peakCanvases=1, remounts=0` → after `liveCanvases=0, peakCanvases=0, remounts=1, rendererInfo=null` — full GPU memory teardown on unmount.
- **After-desktop frames** (`screenshots/after-desktop-steady.png`, `-traffic.png`, `-zoom-detail.png`, `-2d.png`) — steady, traffic-injected, zoom detail, and 2D fallback.
- **2D fallback: 58 fps** (integrated GPU).

## GPU / target status

- Machine: **Apple M5 Max (integrated GPU)**. Soak FPS above (avg 120) is the authoritative **"after"** on this hardware.
- **Discrete-GPU 60 fps target: UNVERIFIED** (no discrete GPU available on this machine).

## Required outputs produced (this run)

`OR_ATOM_008_task/screenshots/`: `soak-after.json` · `soak-after.log` · `soak-after-min-1…20.png`
(the harness numbers per-minute frames 1..20; the pre-audited batch used the same 1-based naming) ·
`soak-after-remount.png` · `soak-after-final.png` (+`soak-after-final-page.png` element-screenshot
fallback artifact). All 20 per-minute frames present, no FATAL, single clean run to completion.
