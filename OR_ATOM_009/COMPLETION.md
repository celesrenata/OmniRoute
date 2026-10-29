# OR-ATOM-009 — Demo Telemetry Harness: Completion Report

**Scope delivered (this worker, W3)**: the **dev-only + deterministic demo telemetry
harness** that drives the **real** fleet-telemetry pipeline without modifying
renderer/app code, plus the **browser-truth** evidence for the S9.5/S9.6
VALIDATION_MATRIX rows. The Phase-3 visual choreography (nucleus rotation,
queue vibration, lane hue, discharge pulses) is **NOT** in this worker's scope
and is **NOT** claimed here — only what was actually built and actually run is
reported.

## 1. Deliverable files (all pure additions — `git diff HEAD -- src/` is empty)

| File                                                                  | Role                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/plugins/atomic-topology/dev/demoHarness.ts`                      | The 9 deterministic scenarios (the single source of truth for `DEMO_SCENARIO_IDS`, the demo bodies, `expectedSignals`, and `expectedReconciled` — each pinned to the real reconciler's output).                                                                                                                                                                                                                    |
| `src/plugins/atomic-topology/dev/demoController.ts`                   | Client-side, dev-only controller: `detectDemoScenario()` (reads `?topology-demo=<id>`), `injectDemoTelemetry()` (wraps `window.fetch` to answer `/api/telemetry/fleet` with the scenario body built by the app's own `buildDemoSnapshot` + `reconcileSnapshot`), `ensureDemoHandle()`. Import side-effect-free; nothing runs unless the integrator calls it or the Playwright harness seeds `window.__atomicDemo`. |
| `src/plugins/atomic-topology/overlays/AtomicTelemetryDiagnostics.tsx` | Dev-only diagnostics overlay (Phase-3 hook documented in the controller header — **not wired** into `ProviderTopology.tsx`; that is the integrator's scope).                                                                                                                                                                                                                                                       |
| `tests/unit/atomic-topology/demoHarness.test.ts`                      | 8 unit tests: scenario-id set = matrix rows, canonical-id purity, determinism + non-mutation, `expectedSignals` vs the snapshot's own Observed values, `expectedReconciled` vs the real `reconcileSnapshot()`, zero-vs-unknown semantics, multi-GPU per-device sums, mixed-lane model classification. **8/8 pass.**                                                                                                |
| `OR_ATOM_009/scripts/lib/atomicDemo.mjs`                              | Shared harness lib: `buildFleetBody()` (Node-side, real app modules), `installFleetRoute()`, browser `addInitScript` payloads, URL/canvas/sampling helpers.                                                                                                                                                                                                                                                        |
| `OR_ATOM_009/scripts/fixtures/gen-fixture-bodies.mjs`                 | Bakes the 9 wire bodies to `fixtures/<scenario>.json` + shape-checks them (poller contract + canonical-id rule). `--verify`: 9/9 PASS.                                                                                                                                                                                                                                                                             |
| `OR_ATOM_009/scripts/captureScenarios.mjs`                            | All 9 VALIDATION_MATRIX rows in one run (canvas PNG + telemetry badge + perf sample + gates C-1..C-4).                                                                                                                                                                                                                                                                                                             |
| `OR_ATOM_009/scripts/toggleStability.mjs`                             | 2D↔Atomic repeated toggle via the host's own buttons (gates T-1..T-5).                                                                                                                                                                                                                                                                                                                                             |
| `OR_ATOM_009/scripts/soak.mjs`                                        | Live telemetry soak (gates GATE-1..6).                                                                                                                                                                                                                                                                                                                                                                             |
| `OR_ATOM_009/scripts/contextLoss.mjs`                                 | Forced WebGL context loss + restore (gates GATE-1..6).                                                                                                                                                                                                                                                                                                                                                             |
| `OR_ATOM_009/scripts/README.md`, `OR_ATOM_009/VALIDATION_MATRIX.md`   | Usage + the filled matrix.                                                                                                                                                                                                                                                                                                                                                                                         |

**Renderer/app code is unmodified.** The harness reaches the app only through:
(a) a network-layer intercept of `GET /api/telemetry/fleet`, and (b) browser
`addInitScript` (renderer-pref preselect, `window.__atomicDemo` seed, FPS/canvas
sampler). No app source was edited.

## 2. What was validated live (source-tree dev server `:20999`, SwiftShader WebGL)

All live runs: `BASE=http://127.0.0.1:20999`, `CHROME_PATH=
…/chromium_headless_shell-1243/…/chrome-headless-shell`, `LOGIN_PASSWORD=
oratom009-smoke-pw`.

| Check                                          | Result                                                                                                                                                                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gen-fixture-bodies.mjs --verify`              | **9/9 PASS**                                                                                                                                                                                                                                 |
| `captureScenarios.mjs` (all 9 rows)            | **PASS** — 0 page errors, canvas 1/1, badge state correct on every row (8× `available`, `unknown-stale` → `stale` from the real poller's own 10 s rule). Evidence `captureScenarios.json` + 9 PNGs.                                          |
| `toggleStability.mjs` (12 pairs)               | **PASS** — all 5 gates; 2D switch 159–190 ms, Atomic remount 230–521 ms, real poller re-ran each cycle (28 polls), no canvas growth. `toggleStability.json` + PNGs.                                                                          |
| `soak.mjs` (`mixed-lanes`, 10 min)             | **PASS** — all 6 gates; FPS 47/48 p50/p95, 172 polls served, canvas 1/1, 0 page errors; one **spontaneous** SwiftShader context loss at minute 7 **recovered** by the app's `CanvasContextGuard`. `soak-mixed-lanes.json` + per-minute PNGs. |
| `contextLoss.mjs` (`mixed-lanes`)              | **PASS** — all 6 gates; forced loss observed, restore observed, scene re-animates (`samplerFramesDelta=138`), 0 page errors. `contextLoss-mixed-lanes.json` + 3 PNGs.                                                                        |
| `demoHarness.test.ts`                          | **8/8 pass**                                                                                                                                                                                                                                 |
| `npm run typecheck:core`                       | Exit 2 — **46 pre-existing errors, none in any deliverable file** (all in `open-sse/*`, `src/lib/db/*`, `src/lib/embeddings/service.ts`, `src/lib/scripts/scriptVault.ts`, `AtomicScene.tsx` missing `paused` prop, `FlowCanvas.tsx`).       |
| `tsc --noEmit -p tsconfig.json` (full project) | **0 errors** (after the deliverable signature fix — see §3).                                                                                                                                                                                 |
| ESLint (4 deliverable TS/TSX files)            | **clean** (0 errors, 0 warnings).                                                                                                                                                                                                            |

**Demo evidence is DEMO.** Every number in the matrix is read from the served
deterministic demo body + the live page — never from production. `renderer.info`
(draw calls / geometry / texture counts) is **UNAVAILABLE** in this checkout
(no module exposes `window.__atomic.rendererInfo`); it is reported, not
fabricated. The completion/failed-request **discharge pulses** are lifecycle-
event driven and the demo body deliberately does not synthesize lifecycle
events, so those one-shot pulses are **NOT RUN** in demo mode (the honest
post-event quiet-state telemetry IS captured).

## 3. The lint "parse error" — resolved as a real syntax bug (and fixed)

`npx eslint` reported `demoController.ts:143:16 Parsing error: '{' or ';'
expected`. This was **not** a parser-config artifact. The function's return
type was written as `: (() => void) => void`, but in a declaration's
return-type position `: (() => void)` parses as a **parenthesized function
type** ("a function that _takes_ `() => void`"), leaving the trailing
`=> void` dangling — a genuine grammar violation. An isolated `tsc` repro of
`function f(): (() => void) => void {}` fails with the identical TS1144.

**Fix**: the function _returns_ an uninstaller, so the correct annotation is
`: () => void`. After the fix: full `tsc -p tsconfig.json` = 0 errors, ESLint
clean, unit test 8/8. (The project `typecheck:core` tsconfig uses a curated
`files` list that does not include `src/plugins/atomic-topology/dev/`, which
is why that command never flagged it.)

## 4. Bugs found and fixed in the harness this session

1. **`atomicRendererPrefInitScript()`** referenced the module-scope constant
   `RENDERER_PREF_KEY`. Playwright serializes init-script functions to a string
   and evaluates them in the page, where that identifier is undefined; the
   `try/catch` swallowed the `ReferenceError`, so the Atomic pref was never set
   → host resolved the default 2D renderer → the poller never enabled. **Fix**:
   inlined the literal `"omniroute.topology.renderer"` (self-contained init
   scripts must not reference module-scope identifiers).
2. **`perfSamplerInitScript()`** used bubbling-phase document listeners for
   `webglcontextlost`/`restored`, which do **not** bubble → counters stayed 0.
   **Fix**: capture-phase listeners (`, true`).
3. **`contextLoss.mjs`** re-derived the `WEBGL_lose_context` extension after
   loss (fails). **Fix**: cache it on `window.__atomicLoseContextExt` at loss
   time, read it back for `restoreContext()`.
4. **`captureScenarios.mjs`** first scenario falsely `stale`: the badge in the
   real app freezes at first observation (it computes `age = now - capturedAt`
   the first time a sample lands and never re-ages; `useEffect` deps =
   `[capturedAt]`, constant body). The first scenario absorbed the dev server's
   one-off cold-compile cost → first observation at ~13 s → stale. **Fix**: warm
   the server on a throwaway page before the loop.
5. **`soak.mjs`** remount hung: `route.stop()` ran _before_ `page.reload()`, so
   during the 30 s post-reload canvas-wait the reloaded document's polls hit
   the **real** (empty) endpoint and the Atomic canvas gate
   (`descriptors.length > 1`) never opened. **Fix**: install the fresh demo
   route _before_ stopping the old one so a demo handler is the sole active
   route across the reload.
6. **`soak.mjs` GATE-4** was "zero context losses", which conflates SwiftShader
   flakiness with an app failure. **Fix**: gate now passes when every loss is
   **recovered** (lost == restored, scene live, 0 page errors); the loss count
   is reported as evidence. An unrecovered loss still fails.

## 5. NOT RUN / UNAVAILABLE (honest)

- **20-minute soak** — a **10-min** run was executed (`DURATION=600`); the
  matrix's 20-min row is NOT RUN (one env var: `DURATION=1200`).
- **`renderer.info`** draw/geometry/texture counts — UNAVAILABLE (no handle in
  this checkout).
- **completion / failed-request discharge pulses** — NOT RUN (lifecycle events
  are not snapshot fields; the demo deliberately does not synthesize them).
- **Phase-3 visual choreography** (nucleus rotation speed, queue vibration,
  lane hue, pulses) — **out of scope for this worker**; not claimed.
- **`renderer.info`-backed "Draw calls / Geometry / Texture" matrix columns** —
  UNAVAILABLE (same reason).

## 6. How to reproduce the evidence

```bash
cd <worktree>
BASE=http://127.0.0.1:20999 \
CHROME_PATH=/Users/celes/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell \
LOGIN_PASSWORD=oratom009-smoke-pw \
  node --import tsx OR_ATOM_009/scripts/captureScenarios.mjs
# … plus toggleStability.mjs, soak.mjs, contextLoss.mjs (see
# OR_ATOM_009/scripts/README.md for the exact per-script env).
node --import tsx OR_ATOM_009/scripts/fixtures/gen-fixture-bodies.mjs --verify
node --import tsx/esm --test tests/unit/atomic-topology/demoHarness.test.ts
npx eslint src/plugins/atomic-topology/dev/demoHarness.ts \
  src/plugins/atomic-topology/dev/demoController.ts \
  src/plugins/atomic-topology/overlays/AtomicTelemetryDiagnostics.tsx \
  tests/unit/atomic-topology/demoHarness.test.ts
npx tsc --noEmit -p tsconfig.json
```

## 7. Cleanup

One-shot debug scripts under `OR_ATOM_009/scripts/tmp/` (the ad-hoc
`debug-*`, `smoke.mjs`, `variant-test.mjs`, `brace-check.mjs`, `bisect-parse.mjs`,
`token-walk.mjs`, `lint-probe.ts`, `probe-remount.mjs`) have been removed.

## 8. Final Phase — post-integration browser truth (2026-10-29)

After the harness was integrated into the source tree, the full browser evidence was
re-captured on 2026-10-29 against `http://127.0.0.1:21011` (source-tree dev server,
Playwright + SwiftShader software WebGL). This supersedes the W3-era captures:

- **9/9 scenario rows** PASS — `screenshots/captureScenarios.json` (all DEMO bodies served to the
  real `FleetTelemetryPoller` via `page.route`; 0 uncaught page errors; live canvas 1/1; per-row
  fps 41–57 under SwiftShader).
- **9/9 B7 injection rows** PASS — `screenshots/b7Injection.json`: each scenario re-served from
  the **in-page `window.fetch` wrapper** (`B-1 in_page_wrapper_installed: true`, `servedNetwork:
0`), proving the harness is transport-agnostic.
- **Gap-2 smoke** PASS — `screenshots/gap2Smoke.json` (G-1..G-7 true): `linkRows[0].proven ===
true` for `route:demo-provider`, unknown route → `unproven`, dev trigger present. G-8 canvas
  non-blank is a screenshot-only confirmation (SwiftShader pixel read-back inconclusive).
- **20-min soak** GATE-1..6 PASS — `screenshots/soak-mixed-lanes.json`: `durationSec: 1200`,
  fps p50 45 / p95 52, per-minute pixel diffs (min 0.14 / max 19.15) prove continuous animation,
  forced mid-soak context remount recovered (end `ctx lost/restored 1/1`, canvas 1/1,
  `fleetServed` 340), 0 page errors.
- **Forced context loss** 6/6 PASS — `screenshots/contextLoss-mixed-lanes.json`: settle → forced
  loss (`lost:1`, `webgl2` API) → restore (`restored:1`), rAF frames advanced +135, no canvas growth.
- **Stress matrix** verdict **true** — `screenshots/stressMatrix.json`: 8 / 16 / 32 atoms,
  S-1..S-5 all true at every count (15 / 11 / 8 fps under SwiftShader — the software-rasterizer
  floor; all above the sustained-fps gate).
- **2D ↔ Atomic toggle** verdict **PASS** — `screenshots/toggleStability.json`: 12 toggles,
  gates T-1..T-5 all true, end canvas 1/1, ctx 0/0, `servedTotal` 28, 0 page errors.
- **Unit suite** (re-run 2026-10-29): `tests/unit/atomic-topology/` — 394 tests, 393 pass /
  0 fail / 1 skipped.

Full per-row detail: `OR_ATOM_009/VALIDATION_MATRIX.md` (post-integration rewrite). Known gaps
are listed there honestly (renderer perf counters UNAVAILABLE, no live reduced-motion capture,
all rows DEMO — the live catalog/hub is down; see `SKILL_AUDIT.md` §1).

**Skill application (Step 9)**: `OR_ATOM_009/SKILL_APPLICATION_REPORT.md` (9 selected skills,
per-substep instructions + implementation anchors + verification evidence) and
`OR_ATOM_009/SKILL_AUDIT.md` (hub probe verdict, extraction verification — 47 files / 9 skill
dirs / 0 leakage, execution audit — all 9 instruction-only, none executed).
