# OR-ATOM-009 Visual + Telemetry Validation Matrix (post-integration)

Use real/browser captures. For simulated data, mark **DEMO** conspicuously. For disconnected
metrics, mark **UNAVAILABLE**.

> **All rows below are DEMO evidence, captured POST-INTEGRATION on 2026-10-29** against the
> source-tree dev server at `http://127.0.0.1:21011` (SwiftShader software WebGL). Every scenario
> body is built by the app's own `buildDemoSnapshot()` + `reconcileSnapshot()` (byte-for-byte the
> real endpoint's shape) and is served to the **real** `FleetTelemetryPoller` via a network-layer
> intercept (`page.route`) — the app code is unmodified. Values below are read from the served demo
> body + the live page (`OR_ATOM_009/screenshots/captureScenarios.json`, `b7Injection.json`,
> `gap2Smoke.json`, `toggleStability.json`, `stressMatrix.json`, `contextLoss-mixed-lanes.json`,
> `soak-mixed-lanes.json`).
>
> **Source column**: `demo:` = value from the deterministic demo body (never a live production
> measurement). **Age** = the demo body's age as the poller's clock saw it at capture (fresh
> scenarios are pinned at `t` at build → age ≈ settle time; `unknown-stale` is pinned at `t−15 s`).
> **Nucleus speed / cloud hue / discharge result** are the _expected rendered behavior_ for the
> served signals per the Phase-3 binding contract (speed ∝ measured TPS, lane hue by lane type,
> one-shot pulses from lifecycle events); the PNGs are the observed canvas state at that moment.
> The scene's _dynamic_ pulse/rotation cannot be asserted from a single still frame — those are
> covered by the Stability soak (per-minute pixel diffs prove continuous animation) and by
> `expectedSignals` in `demoHarness.ts`.

## Scenario matrix (9 rows)

| Scenario (badge)              | Proven device / runtime                                                                                     | TPS value + source + age                                                                                                 | Queue + source + age                                                                    | Lane hue (expected)                     | Demo label + source + age                             | Nucleus speed (expected)       | Cloud hue (expected) | Lifecycle event (expected)             | Screenshot + badge + canvas + served                                                                                                      | Verdict  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------- | ------------------------------ | -------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **DEMO** Idle (measured zero) | GPU `A` ↔ runtime `A` via `runtime_device` edge (fallback=false)                                            | 0 tok/s — source `demo: measured zero (explicit 0, not unknown)`, `stale:false` — age 10.4 s                             | runtime 0 — source `demo: measured zero` — age 10.4 s                                   | neutral (no active lane)                | `demo/idle-chat` — source `demo` — age 10.4 s         | stopped (0 TPS)                | neutral              | none (no lifecycle event in demo body) | `screenshots/capture-idle.png` (badge **available**, canvas 1/1, 0 page errors, served=4)                                                 | **PASS** |
| **DEMO** Unknown/stale        | **no GPU row** → `providerCentricFallback` = **true**                                                       | null (stale, absent) — source `demo: stale sample aged out — value decayed to unknown (null)`, `stale:true` — age 25.6 s | null (stale) — source `demo` — age 25.6 s                                               | neutral (unknown)                       | unknown (absent) — source `demo`                      | frozen/unknown (stale decay)   | neutral              | none                                   | `screenshots/capture-unknown-stale.png` (badge **stale** — the real poller's own verdict on the 15 s-pre-aged body, canvas 1/1, served=4) | **PASS** |
| **DEMO** 20 TPS               | GPU `A` ↔ runtime `A` (per-device attribution, fallback=false)                                              | 20 tok/s — GPU `demo: runtime per-device attribution → GPU A` — age 10.5 s; runtime 20 — `demo: measured 20 output TPS`  | runtime 0 — source `demo: measured zero` — age 10.5 s                                   | neutral                                 | `demo/20tps-chat` — source `demo` — age 10.5 s        | ∝ 20 TPS                       | neutral              | none                                   | `screenshots/capture-tps-20.png` (badge **available**, GPU util 55%, canvas 1/1, served=4)                                                | **PASS** |
| **DEMO** 80 TPS               | GPU `A`(40) + GPU `B`(40) ↔ runtime `A`(40) + runtime `B`(40) (per-device, fallback=false)                  | 80 tok/s total — GPU `A` 40 + GPU `B` 40 — `demo: per-device attribution` — age 10.5 s; runtimes 40+40                   | runtime 0 — source `demo: measured zero` — age 10.5 s                                   | neutral                                 | `demo/80tps-chat` — source `demo` — age 10.5 s        | ∝ 80 TPS (split across 2 GPUs) | neutral              | none                                   | `screenshots/capture-tps-80.png` (badge **available**, canvas 1/1, served=4)                                                              | **PASS** |
| **DEMO** Queued jobs          | GPU `A` ↔ runtime `A` (per-device, fallback=false)                                                          | 20 tok/s — `demo: runtime per-device attribution → GPU A` — age 10.5 s                                                   | runtime **7** — source `demo: measured 7 queued jobs` — age 10.5 s                      | neutral                                 | `demo/queued-jobs` — source `demo` — age 10.5 s       | ∝ 20 TPS + bounded vibration   | neutral              | none                                   | `screenshots/capture-queued-jobs.png` (badge **available**, canvas 1/1, served=4)                                                         | **PASS** |
| **DEMO** Mixed lanes          | GPU `A` ↔ runtime `A`(12) + runtime `B`(8); provider aggregate 20 (fallback=false)                          | 20 tok/s provider aggregate — `demo: provider aggregate throughput (20 = 12+8)` — age 10.5 s                             | runtime 0 — source `demo: measured zero` — age 10.5 s                                   | lane hues by type (embedding vs vision) | `demo/mixed-lanes` — source `demo` — age 10.5 s       | ∝ per-lane TPS                 | lane-typed hues      | none                                   | `screenshots/capture-mixed-lanes.png` (badge **available**, canvas 1/1, served=4)                                                         | **PASS** |
| **DEMO** Completion           | GPU `A` ↔ runtime `A` (per-device, fallback=false)                                                          | 20 tok/s — `demo: runtime per-device attribution → GPU A` — age 10.4 s                                                   | runtime 0 — source `demo: queue drained after completion (explicit 0)` — age 10.4 s     | neutral                                 | `demo/completion` — source `demo` — age 10.4 s        | ∝ 20 TPS → settle              | neutral              | completion one-shot pulse              | `screenshots/capture-completion.png` (badge **available**, canvas 1/1, served=4)                                                          | **PASS** |
| **DEMO** Failed request       | GPU `A` ↔ runtime `A` (per-device, fallback=false)                                                          | 0 tok/s — GPU + runtime + provider all `demo: … measured zero after the dropped request (explicit 0)` — age 10.6 s       | runtime 0 — `demo: failed request dropped — queue back to measured 0` — age 10.6 s      | neutral                                 | `demo/failed-request` — source `demo` — age 10.6 s    | stop on failure                | neutral              | failed one-shot pulse                  | `screenshots/capture-failed-request.png` (badge **available**, canvas 1/1, served=4)                                                      | **PASS** |
| **DEMO** Multi-runtime/GPU    | GPU `A`(90 = 60+30, **not split**) + GPU `B`(util 12%) ↔ runtime `A`(60) + runtime `B`(30) (fallback=false) | GPU `A` 90 — `demo: two runtime per-device attributions → GPU A (60+30, not split)` — age 10.5 s                         | runtime `B` **2** — source `demo: measured 2 queued jobs (explicit count)` — age 10.5 s | neutral                                 | `demo/multi-runtime-gpu` — source `demo` — age 10.5 s | ∝ 90 GPU / 60+30 runtimes      | neutral              | none                                   | `screenshots/capture-multi-runtime-gpu.png` (badge **available**, canvas 1/1, served=4)                                                   | **PASS** |

**Cross-cutting checks (all 9 rows, `captureScenarios.json`):** 0 uncaught page errors on every
row; live canvas 1/1 on every row; `window.__atomicDemo` label present and matching on every row;
telemetry badge state matched the predicted state on every row (the real poller produced
`available` for fresh bodies and `stale` for the pre-aged `unknown-stale` body). Per-row fps
(SwiftShader): idle 42, unknown-stale 41, tps-20 41, tps-80 41, queued-jobs 41, mixed-lanes 48,
completion 57, failed-request 57, multi-runtime-gpu 41.

## B7 network-injection verification (9/9)

`b7Injection.json` — each scenario re-captured with the demo body served from the **in-page
`window.fetch` wrapper** (S9.5) instead of the network layer: `B-1 in_page_wrapper_installed:
true` and `servedNetwork: 0` on all 9 rows, badge state matched, 0 page errors. Proves the demo
harness is transport-agnostic (the same body drives the poller whether it comes from the network
or the in-page wrapper).

## Gap-2 smoke (S9.1 attribution binding)

`gap2Smoke.json` — verdict **PASS** (G-1..G-7 true):
`linkRows[0].proven === true` for `route:demo-provider` ("PROVEN · call-log route · sampled 0s
ago"); the unknown route `route:definitely-not-a-provider` → trigger reason `unproven`;
`G-4 dev_trigger_present: true`. **G-8 canvas-nonblank** WebGL pixel read-back is **inconclusive
under SwiftShader** (software rasterizer) → confirmed visually via
`screenshots/step9-final/gap2/diag-page.png`.

## Stability

All rows below were run live against the source-tree dev server (Playwright + SwiftShader
software WebGL, 2026-10-29). **Browser console errors: every row's only console error is the
benign `[LiveWS] Server error: FORBIDDEN_ORIGIN`** (live-WS origin allow-list; does not affect
the HTTP fleet poll path) — **zero** uncaught page errors on any row.

| Test                                         | Duration                         | FPS (SwiftShader)                                                                        | Draw calls                                                                    | Geometry start/end     | Texture start/end      | Notes                                                                                                                                                                                                            |
| -------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DEMO** Live telemetry soak (`mixed-lanes`) | **20 min** (1200 s, full)        | p50 45 / p95 52 (20 per-minute samples, `animated: true`)                                | **UNAVAILABLE** — `window.__atomic.rendererInfo` not exposed in this checkout | **UNAVAILABLE** (same) | **UNAVAILABLE** (same) | GATE-1..6 PASS; forced context remount mid-soak → canvas 1/1, end `ctx lost/restored 1/1`, `fleetServed` 340 by end; per-minute pixel diffs (min 0.14 / max 19.15) prove continuous animation (no frozen frames) |
| **DEMO** Forced context loss (`mixed-lanes`) | ~30 s (settle → force → restore) | 44 at settle / 44 after restore                                                          | **UNAVAILABLE**                                                               | **UNAVAILABLE**        | **UNAVAILABLE**        | 6/6 GATE PASS: settle → forced loss (`lost:1`, via `webgl2` API) → restore (`restored:1`), scene re-animates (rAF frames advanced +135), canvas count did not grow (no leak)                                     |
| **DEMO** Stress 8 / 16 / 32 atoms            | ~20 s each                       | 15 / 11 / 8 fps (SwiftShader software-rasterizer floor; all pass the sustained-fps gate) | **UNAVAILABLE**                                                               | **UNAVAILABLE**        | **UNAVAILABLE**        | `stressMatrix.json` verdict **true**; S-1..S-5 all true at all three atom counts (canvas mounted, body served, sustained fps, no canvas growth, zero page errors)                                                |
| **DEMO** 2D ↔ Atomic toggle stability        | ~120 s (12 toggles, `tps-80`)    | 31 on first 2D cycle (end sample null — mid-switch)                                      | **UNAVAILABLE**                                                               | **UNAVAILABLE**        | **UNAVAILABLE**        | `toggleStability.json` verdict **PASS**, gates T-1..T-5 all **true**; end canvas 1/1, ctx 0/0 (no loss on view switch), `servedTotal` 28, 0 page errors                                                          |

**Reduced-motion**: fully-static scene is covered at the unit level (`tests/unit/atomic-topology/`
— 394 tests, 393 pass / 0 fail / 1 skipped, re-run 2026-10-29) and by the paused/reduced-motion
hold path in [`src/plugins/atomic-topology/scene/AtomNode.tsx:272`](src/plugins/atomic-topology/scene/AtomNode.tsx:272);
**no live reduced-motion capture** was taken (see Known gaps).

## Known gaps

- **Renderer perf counters** (`drawCalls`, geometry/texture counts) are **UNAVAILABLE**: the
  source checkout does not expose `window.__atomic.rendererInfo`. FPS, canvas live/peak,
  context lost/restored and fleet-served counts are the available perf signals.
- **Reduced-motion live capture**: verified by unit tests + the paused hold path, but no
  `prefers-reduced-motion` emulated browser capture was produced this session.
- **G-8 canvas-nonblank** WebGL read-back is inconclusive under SwiftShader; the non-blank claim
  rests on the screenshot (`screenshots/step9-final/gap2/diag-page.png`) rather than a pixel read-back.
- **Live production data**: every row is **DEMO** (the live catalog/hub is down — see
  `SKILL_AUDIT.md` §1). No production telemetry is claimed.

## Verdict

**PASS** — 9/9 scenario rows, 9/9 B7 injection rows, gap-2 smoke PASS, 20-min soak GATE-1..6 PASS,
forced context loss 6/6, stress 3/3, toggle T-1..T-5. Zero uncaught page errors on any row.
