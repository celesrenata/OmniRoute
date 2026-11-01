# OR-ATOM-009 — demo telemetry harness scripts

Playwright harnesses that drive the **real** fleet-telemetry pipeline with
deterministic demo scenarios (S9.5 synthetic demo mode + S9.6 browser-truth
rows: "Live telemetry soak | 20 min", "2D↔Atomic repeated toggle" and
"Context loss + restore" — plus the per-row VALIDATION_MATRIX capture
driver).

**Validated live (2026-10-28)** against the **source-tree dev server on
`PORT=20999`** (`DATA_DIR=/tmp/or-atom-009-smoke`, login enabled). Note: the
pre-existing `20128` server on this machine is the _installed package_
(v16.3.1), whose `/api/telemetry/fleet` returns 404 — it is **not** a
valid target for these harnesses. All live runs used `BASE=
http://127.0.0.1:20999` with `CHROME_PATH` pointed at the cached
`chromium_headless_shell-1243` (the repo's Playwright build 1234 is not
cached — see Prerequisites).

## How the demo flows through the real pipeline (unchanged app code)

1. The dashboard mounts `ProviderTopology` → `useFleetTelemetry()` →
   `FleetTelemetryPoller`, which polls `GET /api/telemetry/fleet` every
   `intervalMs` (3.5 s, default), shape-validates the body
   (`isFleetTelemetryResponse`, fleetTelemetryPoller.ts:266), marks it
   stale once `age(reconciliation.capturedAt) > staleWindowMs` (10 s), and
   keeps the last-good reconciliation on transient error.
2. These scripts do **not** modify the app. They intercept that one request
   at the network layer (`page.route`) and serve the EXACT body the real
   endpoint would return — built by the app's own
   `buildDemoSnapshot(scenario, capturedAt)` +
   `reconcileSnapshot(snapshot)` (the same two calls
   `src/app/api/telemetry/fleet/route.ts:55` makes). The body is built
   Node-side (`lib/atomicDemo.mjs` `buildFleetBody()`), so it is
   byte-for-byte the server's shape and the fixtures in `fixtures/` are
   evidence of it.
3. Because the body's `capturedAt` is fixed at build time, the poller's own
   clock ages it → the demo data **STALES through the REAL staleness rules**
   instead of a fake prop. `unknown-stale` ships pre-aged 15 s
   (`capturedAtFor`) so the poller reports it stale from the first poll.
4. The browser half only (a) pre-selects the Atomic renderer in
   localStorage (`omniroute.topology.renderer=atomic`), (b) seeds the
   dev-only `window.__atomicDemo` handle (same shape
   `demoController.ensureDemoHandle()` exposes), and (c) samples FPS /
   canvas count / context-loss events. None of this is visible in the
   normal UI.

### Scenario → VALIDATION_MATRIX mapping

| `SCENARIO`          | Matrix row        | Body facts (from the real reconciler)                      |
| ------------------- | ----------------- | ---------------------------------------------------------- |
| `idle`              | Idle (measured 0) | 1 GPU · 1 runtime · 1 provider · fallback=false            |
| `unknown-stale`     | Unknown/stale     | 0 GPU · 1 runtime (null values, stale) · fallback=**true** |
| `tps-20`            | TPS 20            | 1 GPU · 1 runtime · fallback=false                         |
| `tps-80`            | TPS 80            | 2 GPU · 2 runtime · fallback=false                         |
| `queued-jobs`       | Queue spike       | 1 GPU · queued=7 · fallback=false                          |
| `mixed-lanes`       | Mixed lanes       | 1 GPU · 2 runtime (2 lanes) · fallback=false               |
| `completion`        | Completion        | 1 GPU · 1 runtime · 1 provider · all 0 · fallback=false    |
| `failed-request`    | Failed request    | 1 GPU · 1 runtime · 1 provider · all 0 · fallback=false    |
| `multi-runtime-gpu` | Multi-runtime GPU | 2 GPU · 2 runtime (sum, never split) · fallback=false      |

The scenario ids are the single source of truth in
`src/plugins/atomic-topology/dev/demoHarness.ts` (`DEMO_SCENARIO_IDS`) — the
scripts import it; if a scenario is added/renamed there, the scripts pick
it up automatically.

## Files

| File                              | Purpose                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/atomicDemo.mjs`              | Shared helpers: `buildFleetBody()` (Node-side, real app modules), `installFleetRoute()` (Playwright interception), browser `addInitScript` payloads, URL / canvas / sampling helpers.                                                                                                                                                                     |
| `fixtures/gen-fixture-bodies.mjs` | Bakes the 9 wire bodies into `fixtures/<scenario>.json` and shape-checks them against the poller contract + canonical-id rule. Run with `--verify` for a check-only pass.                                                                                                                                                                                 |
| `fixtures/<scenario>.json`        | Evidence: the exact `{ snapshot, reconciliation }` the real endpoint would serve for each scenario.                                                                                                                                                                                                                                                       |
| `soak.mjs`                        | S9.6 "Live telemetry soak" — per-minute evidence, mid-run remount, FPS p50/p95, hard gates GATE-1..6.                                                                                                                                                                                                                                                     |
| `contextLoss.mjs`                 | S9.6 "Context loss + restore" — forces `WEBGL_lose_context` on the live canvas, verifies the guard freezes + resumes, gates GATE-1..6.                                                                                                                                                                                                                    |
| `captureScenarios.mjs`            | All 9 VALIDATION_MATRIX rows in one run — per-scenario canvas PNG + telemetry badge (`available`/`stale`) + perf sample + gates C-1..C-4 (expected badge state is asserted per scenario). Warms the dev server once before the loop so the first scenario does not absorb the cold-compile cost (the badge freezes at first observation in the real app). |
| `toggleStability.mjs`             | S9.6 "2D↔Atomic repeated toggle" — drives the host's own `2D`/`Atomic` toggle buttons N times; verifies canvas teardown/remount, `aria-pressed` state and that the real poller re-runs on every Atomic entry; gates T-1..T-5.                                                                                                                             |

## Prerequisites

- `BASE` = the running dev server built from THIS source tree (the validated
  one: `http://127.0.0.1:20999` with `DATA_DIR=/tmp/or-atom-009-smoke`).
  The topology section must be reachable — with a login-gated server, pass
  `LOGIN_PASSWORD` (see below).
- `CHROME_PATH` = the chromium executable. The repo's Playwright version
  (1.62.1) maps to browser build **1234**, which was not cached on this
  machine; the cached one is **1243** — pass e.g.
  `CHROME_PATH=/Users/celes/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell`
  (or `npx playwright install chromium` to match). Scripts launch with
  SwiftShader software WebGL (`--use-angle=swiftshader
--enable-unsafe-swiftshader`) so the Atomic canvas mounts on a
  headless box with no GPU.
- `LOGIN_PASSWORD` (optional) = the dashboard management password; the
  harness fills the single `input[type=password]` on `/login`, submits, and
  re-navigates so the demo query params re-apply. No-op when the server has
  no login gate.
- `playwright` + `sharp` (both repo devDependencies — `npm install` first).
- The harnesses run under `node --import tsx` (the fixture generator and
  all five scripts import the app's real TS modules through the tsconfig
  `@/` path alias; tsx resolves it).

## Usage

```bash
# 1) Bake + verify the 9 fixture bodies (no browser needed):
node --import tsx OR_ATOM_009/scripts/fixtures/gen-fixture-bodies.mjs
node --import tsx OR_ATOM_009/scripts/fixtures/gen-fixture-bodies.mjs --verify

# 2) Per-row VALIDATION_MATRIX capture (all 9 scenarios, ~4 min):
BASE=http://127.0.0.1:20999 CHROME_PATH=... LOGIN_PASSWORD=... \
  node --import tsx OR_ATOM_009/scripts/captureScenarios.mjs

# 3) 2D↔Atomic repeated-toggle stability (12 pairs, ~3 min):
BASE=http://127.0.0.1:20999 CHROME_PATH=... LOGIN_PASSWORD=... \
  SCENARIO=tps-80 TOGGLES=12 \
  node --import tsx OR_ATOM_009/scripts/toggleStability.mjs

# 4) Live telemetry soak (one scenario; the matrix row is 20 min → DURATION=1200;
#    a 10-min run: DURATION=600):
BASE=http://127.0.0.1:20999 CHROME_PATH=... LOGIN_PASSWORD=... \
  SCENARIO=mixed-lanes DURATION=600 \
  node --import tsx OR_ATOM_009/scripts/soak.mjs

# 5) WebGL context loss + restore (one scenario):
BASE=http://127.0.0.1:20999 CHROME_PATH=... LOGIN_PASSWORD=... \
  SCENARIO=mixed-lanes \
  node --import tsx OR_ATOM_009/scripts/contextLoss.mjs
```

Evidence lands in `OR_ATOM_009/screenshots/` (`capture-<scenario>.png` +
`captureScenarios.json`, `toggleStability.json` + `-2d/-atomic.png`,
`soak-<scenario>.json/.log`, `contextLoss-<scenario>.json/.log`, per-minute/
phase PNGs). A gate failure exits non-zero and prints `VERDICT …: FAIL`.

## Known limitations (honest — see the completion report)

- **All evidence is DEMO.** The scenario bodies are deterministic demo data
  built by the app's own modules; they flow through the real poller but are
  NOT production measurements.
- **`renderer.info` is UNAVAILABLE in this checkout.** The OR-ATOM-008 soak
  read `window.__atomic.rendererInfo` (render.calls / geometries /
  textures); no module in the current tree exposes that handle, so the
  harnesses report it as `UNAVAILABLE` rather than fabricate numbers. The
  canvas-count / context-loss / FPS gates still run.
- **The diagnostics panel (`AtomicTelemetryDiagnostics.tsx`) is not wired
  into `ProviderTopology.tsx` in this checkout** (Phase 3 integrator
  scope — the controller's header documents the exact hook). The harness
  still sends `?topology-dev=1`, and `panelScenario` in the evidence JSON
  reports `UNAVAILABLE` when the panel is not present. The DEMO labeling
  comes from `window.__atomicDemo`, which the harness always seeds.
- **Auth is handled by `LOGIN_PASSWORD`** (fills the `/login` password form
  and re-navigates so the demo query params re-apply). The console errors
  `[LiveWS] Server error: FORBIDDEN_ORIGIN` seen in every run are the live
  WebSocket origin allow-list rejecting the headless origin; they do not
  affect the fleet **HTTP** poll path and are benign.
- **Soak duration**: `DURATION` defaults to 1200 s (the matrix's 20-min row)
  but accepts any value ≥ 600 s; the per-minute sample cadence is fixed at
  60 s. The 2026-10-28 live run used `DURATION=600` (10 min); the 20-min
  variant is NOT RUN.
- **SwiftShader flakiness**: under software WebGL the context can be lost
  spontaneously (observed in the live soak, minute 7, recovered by the app's
  `CanvasContextGuard`). soak.mjs GATE-4 therefore passes when every loss is
  **recovered** (lost == restored, scene still live, zero page errors) and
  the loss count is reported as evidence; an unrecovered loss fails the gate.
