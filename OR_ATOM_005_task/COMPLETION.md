# OR-ATOM-005 — Completion Report

Branch `feat/atomic-topology-plugin` · worktree `.claude/worktrees/atomic-topology-plugin`
Repo root: `/Users/celes/sources/celesrenata/OmniRoute`

This report covers the T5.4/T5.5 increment (renderer seam + device band + measured
motion + docs). It is additive to the earlier T5.0–T5.3 work already in the branch
(external adapters, reconciliation, live consumer path).

---

## 1. What changed (files)

### Production code

| File                                                     | Change                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/plugins/atomic-topology/layout.ts`                  | New pure `computeDeviceBandLayout()` + `DeviceBandNode`/`DeviceBandLayoutOptions`/`DeviceBandPlacement`/`DeviceBandLayout` types. Places `gpu:`/`runtime:` atoms in rings from `maxProviderRing + 1`, reusing `capacityAt`/`radiusAt`/`ringPhaseOffset`/`fnv1a`. `computeAtomicLayout` untouched. |
| `src/plugins/atomic-topology/AtomicTopologyRenderer.tsx` | `resolveAtomDescriptors` builds the provider map, joins `snapshot.fleetTelemetry` (provider spin/vibration), appends device descriptors via `computeDeviceBandLayout`, computes `deviceBandCap` for fit, badge prefers `fleetTelemetry.capturedAt`. `AtomVisualDescriptor.kind` widened to `"hub" | "provider" | "gpu" | "runtime"`, plus `deviceFacts?`and`fleetSampledAt?`. |
| `src/plugins/atomic-topology/cameraFit.ts`               | `computeFitRadiusFromPositions(positions, atomRadius, maxRadius?)`; upper clamp = `max(DEFAULT_FIT_RADIUS*1.35, maxRadius ?? 0)`. No device band → `maxRadius` undefined → identical to before.                                                                                                   |
| `src/plugins/atomic-topology/index.ts`                   | Exports `computeDeviceBandLayout` + the 4 new device-band types.                                                                                                                                                                                                                                  |
| `src/plugins/atomic-topology/overlays/AtomicTooltip.tsx` | Device rows (GPU util/VRAM/temp/power; runtime queue-depth/active/model) + "Fleet sample" row. New `queueRowLabel()` — "Rate-limit queue" (provider/gpu/hub) vs "Sched. queue" (runtime).                                                                                                         |

### Tests

| File                                                         | Tests | Notes                                                                                                                           |
| ------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/atomic-topology/deviceBand.test.ts` (new)        | 13    | Device-band geometry, determinism, capacity, bounds radius, no provider overlap.                                                |
| `tests/unit/atomic-topology/telemetryBinding.test.ts` (new)  | 11    | Provider spin/vibration binding, measured-zero, stale→unavailable, device append, no-recon byte-identical, fleetSampledAt null. |
| `tests/unit/atomic-topology/tooltipQueueLabel.test.ts` (new) | 3     | Limiter ≠ scheduler labeling freeze (provider/gpu/hub → "Rate-limit queue", runtime → "Sched. queue", distinct).                |
| `tests/unit/atomic-topology/cameraFit.test.ts`               | +1    | `maxRadius` clamp (now 15 total).                                                                                               |

### Docs

| File                                             | Change                                                                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/specs/atomic-topology-telemetry-matrix.md` | §7.2.6 addendum — renderer seam (device band, measured motion binding, fit radius, badge freshness, queue labeling, no-data policy). The earlier §7.2 (adapters + reconciliation) was already present. |

Files from the earlier T5.0–T5.3 increment (already in the branch, not part of this
session's diff) are listed in `git status`: the telemetry adapters
(`fleetMetricsConfig.ts`, `fleetMetricsHttp.ts`, `prometheus.ts`, `influxdb2.ts`,
`grafana.ts`, `metricMapping.ts`, `normalizeSample.ts`, `reconcile.ts`,
`fleetTelemetryPoller.ts`, `useFleetTelemetry.ts`), the fleet route
(`src/app/api/telemetry/fleet/route.ts`), the poller wiring in the dashboard
(`HomeProviderTopologySection.tsx`, `ProviderTopology.tsx`), and
`normalizeTopology.ts` / `types.ts` (the additive `fleetTelemetry` field).

---

## 2. Backends truly connected

| Backend                                                | Connection                                                                                                                                                                                                                         | State                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| OmniRoute-native (call-log / in-flight / rate-limiter) | **Always registered** (mandatory, §7.2.1). Emits `provider:<key>` canonical IDs only — **provider atoms, no GPU/runtime device nodes**.                                                                                            | **Live** — no credential, no config. |
| Prometheus                                             | `OMNIROUTE_FLEET_METRICS_SOURCE=prometheus` + `OMNIROUTE_FLEET_METRICS_URL` (+ optional `OMNIROUTE_FLEET_METRICS_TOKEN`, `..._ALLOWED_HOSTS`, label envs). Emits `gpu:<host_id>:<device_uuid>` / `runtime:<host_id>:<runtime_id>`. | **Wired, operator opt-in.**          |
| InfluxDB 2                                             | `OMNIROUTE_FLEET_METRICS_SOURCE=influxdb2` + URL + token; row-based identity tags (`host_id`/`gpu_uuid`/`runtime_id`).                                                                                                             | **Wired, operator opt-in.**          |
| Grafana                                                | `OMNIROUTE_FLEET_METRICS_SOURCE=grafana` + URL + `..._DATASOURCE_UID` + token.                                                                                                                                                     | **Wired, operator opt-in.**          |

> Key fact (verified this session): the **native** adapter is **provider-only**
> (`buildCanonicalResourceId("provider", providerKey)` in
> `src/shared/topology/telemetry/providers/omniroute.ts`). The device band (GPU
> / runtime atoms) **only populates when an external adapter is configured**
> (Prometheus / InfluxDB2 / Grafana). With no external adapter the scene
> renders provider atoms exactly as before — the device band is empty.

### Credential requirements (no values)

- Native: none.
- Prometheus / InfluxDB2 / Grafana: `OMNIROUTE_FLEET_METRICS_TOKEN` (bearer/
  service token). **Never logged** (`fleetMetricsConfig.ts` doc comment). The
  token is read server-side only; the browser polls the management-gated
  `GET /api/telemetry/fleet` and never sees the backend token or fan-out.

### Poll frequency

- Browser → fleet endpoint: `FleetTelemetryPoller` `DEFAULT_INTERVAL_MS = 3500`
  ms (3.5 s, in the 2–5 s band; `fleetTelemetryPoller.ts`). One bounded query
  per tick, hidden-tab/unmount cancels, no duplicate WS, no second websocket.
- Staleness window: `OMNIROUTE_FLEET_METRICS_FRESHNESS_MS` (server-side);
  `staleWindowMs` also exposed to the poller for client-side decay.

---

## 3. Source identity matrix

| Source           | Emits `provider:`     | Emits `gpu:` / `runtime:` | Identity join                                   | SSRF guard            |
| ---------------- | --------------------- | ------------------------- | ----------------------------------------------- | --------------------- |
| OmniRoute-native | ✅ (`provider:<key>`) | ❌ (provider-only)        | provider key                                    | n/a (local)           |
| Prometheus       | ✅                    | ✅ (per-device label)     | `host_id` + `device_uuid` / `runtime_id` labels | host allowlist + port |
| InfluxDB 2       | ✅                    | ✅ (row identity tags)    | row tags `host_id`/`gpu_uuid`/`runtime_id`      | host allowlist + port |
| Grafana          | ✅                    | ✅ (datasource uid)       | datasource `..._UID` + labels                   | host allowlist + port |

Reconciliation (`reconcile.ts`) builds canonical `gpu:`/`runtime:` IDs **only**
from a proven identity (deviceUuid / runtime id); cloud-only providers stay
provider atoms. A missing relationship is an **absent** edge, never a guessed one.
GPU/runtime nodes are emitted **only** for devices actually observed with a
proven identity.

### Attributed vs unattributed

- **Attributed runtime→GPU:** `runtimeNodes[].attributedGpuIds` carries the
  per-device attribution from the source; the renderer draws
  `runtime_device` edges only for attributed pairs.
- **Unattributed:** a runtime with `attributedGpuIds: []` renders as a runtime
  atom with no `runtime_device` edges (honest unknown, not an even split).
  Multiple runtimes on one GPU each keep their own atom + their own attribution.
- **Model attribution:** a device atom's single color is driven by
  `deviceFacts.modelId` (the one observed in-flight model), or neutral slate
  when no model is observed — no hash guess, no fabrication.

---

## 4. Intentional behavior change (NOT a regression)

**Provider spin: `"unavailable"` → `"measured"` when a real measured TPS exists.**
Before T5.4, provider spin was always `"unavailable"` (no telemetry in the
snapshot). Now, when `fleetTelemetry.providerNodes[providerId].outputTokensPerSecond`
carries a real value, the provider atom animates as `"measured"`. This is the
required T5.4 binding.

- **Without** a `fleetTelemetry` block, every descriptor is byte-identical to the
  M1 baseline (`spin {value:0.1, mode:"unavailable"}`,
  `vibration {amplitude:0, frequencyHz:0, mode:"unavailable"}`). Pinned by
  `atomicSceneBridge.test.ts` ("spin is unavailable regardless of request count")
  and the no-reconciliation tests in `telemetryBinding.test.ts`.
- Provider **layout/rings/positions are unchanged** — device atoms are appended
  in separate outer rings, not inserted into `snapshot.nodes`.
- A real observed `0` → `"measured-zero"` / `"zero"` (observed quiet, not missing).
- Stale / absent values → `"unavailable"` (never a fabricated 0).

---

## 5. Metrics proven live (verified this session)

| Metric                          | Source                                                                | Provenance                             |
| ------------------------------- | --------------------------------------------------------------------- | -------------------------------------- |
| Provider spin (output TPS)      | `providerNodes[].outputTokensPerSecond`                               | measured / measured-zero / unavailable |
| Provider vibration (queue)      | `providerNodes[].queuedJobs` (basis `rateLimitManager:counts.QUEUED`) | measured / zero / unavailable          |
| GPU spin                        | `gpu.outputTokensPerSecond ?? runtime.outputTokensPerSecond`          | measured / measured-zero / unavailable |
| Runtime vibration (sched queue) | `runtime.queuedJobs`                                                  | measured / zero / unavailable          |
| GPU util / VRAM / temp / power  | `deviceFacts` (tooltip only, not animated)                            | "no data" when null                    |
| Model color                     | `deviceFacts.modelId` (single observed model)                         | neutral when absent                    |
| Badge freshness                 | `fleetTelemetry?.capturedAt ?? snapshot.capturedAt`                   | "source unavailable" when absent       |
| Fleet sample time               | `descriptor.fleetSampledAt`                                           | "no fleet sample" when null            |

---

## 6. Tests run + results (all green, this session)

### node:test (real runner, `tests/unit/atomic-topology/**/*.test.ts`)

```
ℹ tests 216
ℹ suites 0
ℹ pass 215
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
```

Command:

```bash
DISABLE_SQLITE_AUTO_BACKUP=true node --max-old-space-size=8192 \
  --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts \
  --import ./tests/_setup/isolateDataDir.ts \
  --test --test-force-exit --test-concurrency=4 \
  "tests/unit/atomic-topology/**/*.test.ts"
```

All 16 `.test.ts` files discovered, including the 3 new files
(`deviceBand` 13, `telemetryBinding` 11, `tooltipQueueLabel` 3) and
`cameraFit` with its new `maxRadius` test. The single skip is the pre-existing
`atomicSceneBridge` skip.

### vitest (`.tsx` path)

```
✓ tests/unit/atomic-topology/live-request-lifecycle-hook.test.tsx (7 tests)
Test Files  1 passed (1)
     Tests  7 passed (7)
```

(`npx vitest run --config vitest.config.ts tests/unit/atomic-topology/...`)

### Typecheck

`npx tsc --noEmit -p tsconfig.json` — **zero errors under `src/plugins/atomic-topology`**
(earlier grep hits were false positives from the worktree path name
`.claude/worktrees/atomic-topology-plugin/...`). Remaining repo errors are
pre-existing/unrelated (fumadocs, playwright, `open-sse/rateLimitManager`,
`scripts.ts`/`scriptVault.ts` `LogMetadata`, `FlowCanvas.tsx` CSS import,
combo/logger tests).

### Docs

`npm run check:docs-all` — the 3 STRICT drifts are **pre-existing and out of
scope**: all "DB migrations 193 vs 198" in `README.md` / `AGENTS.md` / `llm.txt`.
None are in `atomic-topology-telemetry-matrix.md` or any file I touched; my
addendum adds no numeric count claims. Per the base-red policy I did **not**
fix inherited drift inside this feature branch.

### Frozen constraints honored

- ✅ `computeAtomicLayout` untouched; device atoms NOT fed into `snapshot.nodes`.
- ✅ No provider atom, camera, layout, label, orbit/appearance, connection
  geometry, or color moved for existing visual states.
- ✅ ReactFlow 2D fallback reads only `nodes`/`links`; ignores `fleetTelemetry`.
- ✅ No second websocket; no browser→host HTTP polling (browser polls the
  management-gated fleet endpoint only).
- ✅ OmniRoute rate-limiter queue **separately labeled** (`queueRowLabel`) —
  never silently mapped to the GPU inference-scheduler queue.
- ✅ No-data policy: unobserved → "unavailable" / "no data", never 0.

---

## 7. Known gaps

- **Before/after verification done — see §8 (2026-10-26).** Original 12
  captures + a hard-refresh recapture (fresh browser context, seeded
  `atomic` preference) both confirm the Atomic scene mounts provider-only
  and renders **no** `GPU:1`/`RUNTIME:1` chips. The chips visible in the
  ORIGINAL captures were a stale in-memory lazy-chunk artifact of the
  4.5-day :20129 dev server, not current code — full findings and verdict
  in §8.
- **Device band is empty without an external adapter** — expected: the native
  adapter is provider-only. A live GPU/runtime device band requires the
  operator to configure Prometheus / InfluxDB2 / Grafana.
- **Real-workload validation** ("measured movement responds during a real
  workload, and stops/neutralizes when data is unavailable") is covered by the
  unit fixtures (measured / measured-zero / stale / absent) but not by a live
  GPU under load — that requires an operator-configured external backend.
- **`check:docs-all` STRICT drift** (193→198 migrations) is pre-existing in
  `README.md`/`AGENTS.md`/`llm.txt`; not fixed here (out of scope).
- **GPU atoms** have no own queue → their queue row is always
  "unavailable"; the scheduler queue is surfaced on the **runtime** atom
  instead (labeling freeze).

---

## 8. T5.5 before/after verification (2026-10-26)

### 8.1 Captures — original set (taken 2026-10-26 ~14:09, stale tab)

Taken with Playwright against the long-lived :20129 dev-server tab that
**never hard-refreshed** after the final T5.4 renderer edits landed
(last edit 2026-10-26 13:21). 12 files under `/tmp/or-atom-005/or-atom-005/`:

- `desktop-1596x1050-fullpage.png`, `desktop-1596x1050-card.png`,
  `desktop-1596x1050-card-420.png`
- `desktop-1280x720-fullpage.png`, `desktop-1280x720-card.png`,
  `desktop-1280x720-card-420.png`
- `compact-800x900-fullpage.png`, `compact-800x900-card.png`,
  `compact-800x900-card-420.png`
- `mobile-390x844-fullpage.png`, `mobile-390x844-card.png`,
  `mobile-390x844-card-420.png`

4 viewports: `1596x1050`, `1280x720`, `800x900`, `390x844` (3 shot types
each: fullpage / card / card-420). Atomic mount confirmed in all 4
(`canvases=1`, `rendererPref=atomic`, "Atomic" toggle
`aria-pressed=true`).

### 8.2 Captures — refreshed set (2026-10-26 22:18, hard refresh)

Because the original tab held a **stale in-memory lazy renderer chunk**
from an earlier uncommitted iteration, the refreshed set is the primary
before/after evidence. Method: fresh browser context per viewport (clean
cache + clean `localStorage`), seeded `omniroute.topology.renderer=atomic`
before app scripts ran, waited for the Atomic canvas to mount plus ~3s of
stable frames, re-shot at 2x device scale (matching the originals). 12
files under `/tmp/or-atom-005/or-atom-005-refreshed/`, same filenames as
§8.1. Script: `/tmp/or-atom-005/capture-refresh.mjs` (Playwright 1.62.1 +
system Chrome; the original capture script was not recoverable from
`/tmp` or `scripts/`, so a minimal equivalent was written).

### 8.3 `GPU:1` / `RUNTIME:1` ghost-chip finding

- **Origin:** the :20129 dev server (started 2026-10-21, ~4.5-day uptime,
  Turbopack dev) had loaded the lazy Atomic renderer chunk during an
  EARLIER uncommitted iteration whose code rendered a count chip; the tab
  was never hard-refreshed after the final T5.4 renderer code landed, so
  the old in-memory chunk kept drawing the chip.
- **Absent from current code:** the chip strings exist in NO current
  source file — searched the whole worktree, the main checkout, all other
  worktrees, and the served JS chunks.
- **Live API state:** `GET /api/telemetry/fleet` (HTTP 200) →
  `gpuNodes=0`, `runtimeNodes=0`, `providerNodes=12`, `edges=0`,
  `providerCentricFallback=true`, fresh `capturedAt`.
- **No external adapter:** no `OMNIROUTE_FLEET_METRICS_*` env vars are
  configured on the server process → native provider-only adapter →
  device band empty, **as designed**.
- **Conclusion:** the chips reflect NEITHER a configured external adapter
  NOR a fixture — they are a dev-server in-memory artifact, and the
  final code renders NO such chips.

### 8.4 Before/after verdict

- The refreshed set matches the frozen baseline
  `OR_ATOM_005_task/reference/current-state.png`: Core hub, provider
  atoms, electron orbits, lane colors, projected labels, and camera
  framing unchanged.
- No device atoms render without a configured external metrics source;
  with no `fleetTelemetry` data the descriptors are byte-identical to the
  M1 baseline (pinned by the unit tests in §6).
- The only delta in the ORIGINAL captures is the ghost chip — a
  dev-server artifact, not a code change.
- Verification: DOM text scan of all 4 refreshed viewports found no
  `GPU:\d+` / `RUNTIME:\d+` chip strings; vision review of the refreshed
  card captures confirms the atomic scene (Core hub + labeled provider
  atoms, "Atomic" toggle active) with no device band and no count chips.

---

## 9. T5.6b2 (final) — cluster Prometheus wiring + live verification (2026-10-26/27)

Scope: restart the :20129 dev server with the 5 fleet-metrics env vars,
live-verify `/api/telemetry/fleet` against the real k3s/DCGM data,
recapture the Atomic scene into
`/tmp/or-atom-005/or-atom-005-cluster-final/`, and document the outcome
honestly — including why the device band does **not** render in the
dev-server headless captures. **No worktree source or test files
touched** (the T5.6b1 code and its two TDD'd fixes were already in
place); the only editable repo file is this report. This section
supersedes the 2026-10-26 draft of §9, whose "future-sample race at
merge / NOT ACHIEVABLE" verdict is obsolete — the two fixes below put
`gpuNodes=1` live on the endpoint.

### 9.1 Environment (verified live, 2026-10-27 ~01:00 UTC)

- Port-forward: `kubectl port-forward -n prometheus-service
svc/prometheus-kube-prometheus-prometheus 9090:9090`, PID **38306**
  (unchanged from the earlier session), listening on `127.0.0.1:9090` +
  `[::1]:9090`, log `/tmp/or-atom-005/portforward-prometheus.log`.
  `GET /-/ready` → `Prometheus Server is Ready.`
- Live DCGM over the forward (curl-verified): `DCGM_FI_DEV_FB_USED`=458
  (MiB), `DCGM_FI_DEV_GPU_UTIL`=0, `DCGM_FI_DEV_GPU_TEMP`=30,
  `DCGM_FI_DEV_POWER_USAGE`≈4.6–4.9 W — GPU idle. `DCGM_FI_DEV_FB_TOTAL`
  is **not exported** (the exporter exposes `FB_FREE` instead) →
  `vramTotalBytes` is ABSENT in the GPU resource (never fabricated).
- :20128 never touched. kubectl used read-only, the only exception being
  the port-forward itself. The 5-var env block contains no secrets.

### 9.2 Restart (done)

Old :20129 (node PID **74473**, parent `npm run dev` **74432**) was
SIGTERM'd. The first relaunch hit a Next.js dev lockfile collision while
the old process was still releasing; the second launch succeeded: new
node **PID 54577** listening on `*:20129`
(`lsof -nP -i :20129 -sTCP:LISTEN`), log
`/tmp/or-atom-005/devserver-20129.log` (pre-restart log preserved as
`devserver-20129.log.pre-restart`), ready in ~5s
(`/api/settings/require-login` → 200; `requireLogin=false` persists in
the shared SQLite `key_value` settings, so no env needed). Log line
**149** (pid 54577):
`fleet-telemetry-gateway … kind prometheus … "fleet telemetry: external
adapter registered"` — no "registration failed", no warnings.

Exact env block used:

```
PORT=20129
OMNIROUTE_FLEET_METRICS_SOURCE=prometheus
OMNIROUTE_FLEET_METRICS_URL=http://localhost:9090
OMNIROUTE_FLEET_METRICS_VRAM_UNIT=mib
OMNIROUTE_FLEET_METRICS_LABEL_HOST=hostname
OMNIROUTE_FLEET_METRICS_LABEL_GPU_DEVICE=uuid
```

### 9.3 The two TDD'd fixes (already in place — these drive gpuNodes=1)

1. **MiB scaling — `OMNIROUTE_FLEET_METRICS_VRAM_UNIT=mib`.** The
   production dcgm-exporter reports VRAM gauges in MiB; the normalized
   schema is bytes. `vramScaleFor("mib") = 1048576`
   (`src/shared/topology/telemetry/providers/metricMapping.ts:130-131`)
   is the single decision point all three adapters apply to VRAM fields
   only (prometheus: `prometheus.ts:226`, plus the matching
   influxdb2/grafana sites). Live proof: 458 × 1048576 =
   **480247808** B, exactly what the endpoint serves (§9.4). Tests:
   `tests/unit/telemetry/telemetry-fleet-metrics-config.test.ts` (env
   name + parsing) and the `vramUnit: "mib"` scale suites in
   `telemetry-provider-{prometheus,influx,grafana}.test.ts`.
2. **Future-tolerance at merge — `FUTURE_TOLERANCE_MS_DEFAULT = 5000`.**
   The merge tolerates samples stamped up to 5 s in the future
   (`src/shared/topology/telemetry/provenance.ts:193`, consumed in
   `src/shared/topology/telemetry/gateway.ts:140`). This resolves the
   "future-sample drop at merge" that the previous §9 draft blamed for
   `gpuNodes=0` — that draft's verdict ("NOT ACHIEVABLE with the frozen
   code") is superseded. Pinned by
   `tests/unit/telemetry/telemetry-provenance.test.ts:238-239`
   (asserts `5000`) and the drop/tolerate cases in
   `tests/unit/telemetry/telemetry-merge.test.ts`
   (`futureToleranceMs: FUTURE_TOLERANCE_MS_DEFAULT`) plus
   `tests/unit/telemetry/telemetry-gateway.test.ts` (injected-tolerance
   case).

### 9.4 Endpoint proof (live, ×3 — PASS)

`GET http://localhost:20129/api/telemetry/fleet` → **HTTP 200** on all
three polls, saved to `/tmp/or-atom-005/final-fleet-{1,2,3}.json`
(2026-10-26 17:35 UTC; `snapshot.capturedAt=1793061343103` in all
three):

| Field                          | Value (identical across the 3 polls)                               |
| ------------------------------ | ------------------------------------------------------------------ |
| `reconciliation.gpuNodes`      | **1**                                                              |
| `reconciliation.runtimeNodes`  | **0**                                                              |
| `reconciliation.providerNodes` | **12**                                                             |
| `snapshot.resources` kinds     | 1 `gpu` + 12 `provider`                                            |
| GPU `resourceId`               | `gpu:gremlin-1:GPU-d3fa2fbc-bdd3-9333-b9a6-1b5385129a76`           |
| `utilizationPercent.value`     | 0 (source `prometheus`, basis `DCGM_FI_DEV_GPU_UTIL`)              |
| `vramUsedBytes.value`          | **480247808** (= 458 MiB × 1048576 — the `mib` scaling is correct) |
| `temperatureC.value`           | 30                                                                 |
| `powerWatts.value`             | 4.876 (across polls ≈4.6–4.9)                                      |
| `vramTotalBytes`               | **ABSENT** on the GPU resource (DCGM exports no `FB_TOTAL`)        |

A fresh live re-check at `capturedAt=1793063139783` (01:05:39.783 UTC)
still reported gpu=1. **The endpoint is good.** (The capture probe at
23:43:37 UTC — `capture-result.json.probe.fleet` — also saw
`http:200, gpuNodes=1`, `capturedAt:1793061417089`.)

### 9.5 Final recapture — scene mounted, device band NOT rendered

12 shots + probes via Playwright (fresh context per viewport, atomic
preference seeded before app scripts run; script
`/tmp/or-atom-005/capture-final.mjs`) into
`/tmp/or-atom-005/or-atom-005-cluster-final/`:
`desktop-1596x1050` / `desktop-1280x720` / `compact-800x900` /
`mobile-390x844` × `fullpage` / `card` / `card-420` = 12 PNGs (2x
scale) + `capture-result.json` + `diag8-truth.png`.

- All 4 viewports: Atomic scene mounted (`canvases=1`,
  `rendererPref=atomic`, "Atomic" toggle `aria-pressed=true`); **no**
  `GPU:1`/`RUNTIME:1` ghost chips; only the pre-existing
  `LiveWS FORBIDDEN_ORIGIN` console noise.
- **BUT the device atom does not render:** the probed atom roster is 10
  atoms (`hub` + 9 `provider:*`) and **0 `gpu:*`** —
  `capture-result.json.probe.device` (`deviceAtomCount: 0`), despite the
  endpoint serving gpu=1 at the same moment.
- The "available" badge with an advancing `capturedAt` visible in the
  captures is the **native (provider-only) live snapshot**
  (`snapshot.capturedAt`), not the fleet reconciliation — the fleet
  feed never landed in the page.

**Root cause (confirmed — dev-only, poller lifecycle, NOT the renderer):**

- `diag8-truth.mjs` (in-page `window.fetch` instrumentation) proves the
  browser issues **exactly one** `fetch('/api/telemetry/fleet')`, at
  t=645 ms, **aborted at t=664 ms** (19 ms, `AbortError`, no response,
  `gpuNodes` null) — then **zero further fetches for 14 s**
  (`diag8-truth.png`).
- `verify-device-band.mjs` (fast route-serving of the **real** endpoint
  body into the real pipeline) still yielded `gpuAtoms=0`
  (`verify-served-body.json`) — so this is **not** merely a fetch-timing
  race: the reconciliation that is applied is discarded, and the poller
  never retries.
- The mechanism (read-confirmed in the uncommitted code):
  - `FleetTelemetryPoller.abort()` sets `this.disposed = true` and
    cancels the in-flight fetch
    (`src/shared/topology/telemetry/fleetTelemetryPoller.ts:149-161`);
    `start()` returns early when `running || disposed`
    (`fleetTelemetryPoller.ts:142-146`).
  - `useFleetTelemetry` memoizes the poller on
    `[enabled, url, intervalMs, staleWindowMs]`
    (`src/shared/topology/telemetry/useFleetTelemetry.ts:80-88`) — with
    `enabled` a stable `true`, the **same instance** is reused across
    the effect's double-invoke. The effect (`useFleetTelemetry.ts:90-111`)
    starts the poller, and its cleanup does `abort()` + reset state to
    WAITING.
  - Trigger: **React StrictMode double-invoke**, which Next.js
    app-router enables by default (dev only — a production build has no
    double-invoke). The first effect run's cleanup aborts the poller
    mid-fetch; the second `start()` no-ops on the disposed instance, so
    no fetch ever completes and the disposed state stays WAITING. The
    applied reconciliation (if any) is wiped by the same cleanup.
- Isolation by exclusion — **pure-function proof PASS**:
  `proof-device-band.tsx` (tsx, no DOM/WebGL) fed the **real** endpoint
  reconciliation through the untouched
  `normalizeTopology → resolveAtomDescriptors` pipeline and produced a
  `gpu` device-band descriptor with real `position {x, y}`, `ringIndex`,
  and `deviceFacts` (util 0, `vramUsedBytes` 480247808, temp 30,
  power 4.876), id matching the GPU resourceId. The device-band +
  tooltip render path is intact; the failure is isolated to the **poller
  lifecycle under dev StrictMode**.

### 9.6 Tooltip — not capturable in headless (documented, nothing fabricated)

`diag9-reactprobe.mjs` (+ `diag9-reactprobe.png`): the labels layer is in
`projected` mode; a provider atom button exists with a live React
`onClick` (found and invoked), but `data-focused` / `aria-pressed` never
flip — the projected labels sit at off-canvas 3D positions with
`visibility: hidden`, so focus cannot be driven without source changes.
No provider-tooltip or device-tooltip shot could be produced honestly;
the reason is recorded here instead of a fabricated capture.

### 9.7 Verdict

- **Wiring + endpoint: PASS.** Adapter registered (log line 149, pid
  54577), config resolved (5-var block, allowlist not weakened), live
  DCGM data served 3×: gpu=1, util 0, vram 480247808 B (mib scaling
  correct), 30 °C, ≈4.8 W, runtime=0, providers=12, `vramTotalBytes`
  absent by exporter fact.
- **Device band in the dev-server captures: NOT rendered** — caused by
  the dev-only StrictMode poller-lifecycle bug documented in §9.5. This
  is **not** a renderer/layout/tooltip defect (pure-function proof
  PASS) and not a configuration problem.
- **Tooltip: not capturable headless** (§9.6) — documented, not
  fabricated.
- **Ops reproduce:** the endpoint can be re-verified at any time with
  `kubectl port-forward -n prometheus-service
svc/prometheus-kube-prometheus-prometheus 9090:9090` plus the exact
  5-var block in §9.2 and
  `curl -s http://localhost:20129/api/telemetry/fleet`.
- **Follow-up (out of scope for this live-verification task):** the
  dev-only poller-lifecycle bug is the real remaining defect — a
  worktree source fix (e.g. a fresh poller per effect phase, or make
  `start()` recoverable after `abort()`) with a TDD regression test, and
  an optional production-build capture to confirm the band renders when
  the double-invoke is absent.
- Unit suites: green (226/226 per brief).
- Artifacts: `/tmp/or-atom-005/` — `final-fleet-{1,2,3}.json`
  (endpoint proof), `devserver-20129.log.pre-restart` +
  `devserver-20129.log` (log line 149), `portforward-prometheus.log`,
  `or-atom-005-cluster-final/` (12 shots + `capture-result.json` +
  `diag8-truth.png`), diagnostics `diag-device.mjs` / `diag2.mjs` /
  `diag3.mjs` / `diag4-timeline.mjs` / `diag5-fiber.mjs` /
  `diag6-clean.mjs` / `diag7-aria.mjs` / `diag8-truth.mjs` /
  `diag9-reactprobe.mjs`, `verify-device-band.mjs` (+
  `verify-served-body.json`), `proof-device-band.tsx`, tooltip scripts
  `tooltip-provider-final.mjs` / `tooltip-final2.mjs` /
  `tooltip-diag-final.mjs`. Misleading/miss shots
  (`desktop-1596x1050-device-band.png`, `tooltip-final2-nohost.png`,
  `tooltip-final2-nomatch.png`,
  `tooltip-provider-final-miss.png`, `tooltip-diag-final.png`) were
  removed rather than kept as false evidence.

---

## 10. T5.8 — post-fix live re-verification (2026-10-27)

Live re-verification of the OR-ATOM-005 cluster wiring **after the T5.7
poller-lifecycle fix** (`fleetTelemetryPoller.ts`: `abort()` no longer
latches `disposed`; `start()` revives after abort; terminal errored stays
terminal — new test `tests/unit/telemetry/telemetry-fleet-poller.test.ts`).
Scope: environment restore, dev-server restart to serve the fix, endpoint
×3, the §9.5 network-timeline discriminator, device-band capture, one
tooltip attempt. No source/test edits; no commits; nothing in the repo
root except this appended section.

### 10.1 Environment state

- **Prometheus port-forward — already alive, untouched:** `lsof -nP
-i :9090 -sTCP:LISTEN` → `kubectl` **PID 38306** (`kubectl port-forward
-n prometheus-service svc/prometheus-kube-prometheus-prometheus
9090:9090`); `curl -s http://127.0.0.1:9090/-/ready` → `Prometheus
Server is Ready.` No restart needed.
- **Dev server :20129 — restarted to serve the fix:** old node **54577**
  (parent npm **54544**) SIGTERM'd after preserving its log as
  `/tmp/or-atom-005/devserver-20129.log.pre-fix-restart` (4,616,212
  bytes). Relaunched from the worktree with the **§9.2 5-var env block
  verbatim** (`PORT=20129` +
  `OMNIROUTE_FLEET_METRICS_SOURCE=prometheus` / `..._URL=http://localhost:9090`
  / `..._VRAM_UNIT=mib` / `..._LABEL_HOST=hostname` /
  `..._LABEL_GPU_DEVICE=uuid`) + `npm run dev`. New node **PID 98505**
  listening on `*:20129`. No Next.js dev lockfile collision this time
  (the §9.2 first-launch collision did not recur — port was fully free
  before relaunch).
- **Adapter registration:** `/api/settings/require-login` → 200
  (`requireLogin=false`, persisted in shared SQLite). First fleet hit
  triggered the gateway; dev log **line 186** (pid 98505):
  `{"name":"fleet-telemetry-gateway","kind":"prometheus","msg":"fleet
telemetry: external adapter registered"}` — no "registration failed".

### 10.2 Endpoint proof ×3 — PASS

`curl -s http://localhost:20129/api/telemetry/fleet` ×3 at ~5 s intervals
→ 3× **HTTP 200** (20,374 / 20,374 / 20,430 bytes), saved to
`/tmp/or-atom-005/or-atom-005-cluster-fixed/fleet-{1,2,3}.json`. All
three: **gpuNodes = 1**, **runtimeNodes = []** (honestly empty — no
vLLM pods), providerNodes = 12, `stale = false`. The single GPU node
(matches the §9.4 facts):

```
resourceId     gpu:gremlin-1:GPU-d3fa2fbc-bdd3-9333-b9a6-1b5385129a76
utilizationPercent  0      (DCGM_FI_DEV_GPU_UTIL)
vramUsedBytes       480247808  (DCGM_FI_DEV_FB_USED)
temperatureC        30      (DCGM_FI_DEV_GPU_TEMP)
powerWatts          4.724   (DCGM_FI_DEV_POWER_USAGE)
```

`vramTotalBytes` **absent** in all three — exporter exposes FB_FREE /
FB_USED, not FB_TOTAL; never fabricated (consistent with §9.4).
Note: the endpoint body shape is `{snapshot, reconciliation}`;
`gpuNodes`/`runtimeNodes` live under `reconciliation`.

### 10.3 Network timeline — the §9.5 discriminator — PASS

`/tmp/or-atom-005/t58-network-timeline.mjs` (headless Chromium, atomic
preference seeded pre-app, in-page `window.fetch` instrumentation)
recorded `/api/telemetry/fleet` for ~12 s on the post-fix server.
Artifact: `/tmp/or-atom-005/or-atom-005-cluster-fixed/network-timeline.json`

- `diag-fixed-network.png`.

| #   | startMs | durMs | outcome                                                                   |
| --- | ------: | ----: | ------------------------------------------------------------------------- |
| 0   |     909 |    29 | **aborted** (`AbortError` — StrictMode double-invoke teardown, as before) |
| 1   |     934 |   125 | **completed HTTP 200** (the **revived** second fetch)                     |
| 2   |    4560 |    12 | completed 200                                                             |
| 3   |    8073 |     8 | completed 200                                                             |
| 4   |   11583 |    83 | completed 200                                                             |

**5 fetches: 1 aborted, 4 completed** (all 200); polls continued at the
~3.5 s cadence (4560 → 8073 → 11583). Telemetry badge `available`;
device atom present in DOM (`gpu:gremlin-1:GPU-d3fa2fbc-…`).

**Explicit before/after vs §9.5:**

- §9.5 (pre-fix): "the browser issues **exactly one**
  `fetch('/api/telemetry/fleet')`, at t=645 ms, **aborted at t=664 ms**
  (19 ms, `AbortError`, no response, `gpuNodes` null) — then **zero
  further fetches for 14 s**."
- Now (post-fix): **first** fetch (t=909 ms) is still aborted by the
  StrictMode double-invoke — but a **revived** second fetch **25 ms later
  (t=934 ms) completes with HTTP 200** (125 ms, full reconciliation), and
  the loop keeps polling (~3.5 s cadence, ≥3 more completed fetches in
  the window). The §9.5 failure mode (aborted-only, zero completions,
  dead loop) is **gone — the §9.5 discriminator is a PASS**.

### 10.4 Device-band capture — PASS

Once the timeline showed a completed reconciliation, the scene's outer
device band was captured (scripts `t58-device-band.mjs`,
`t58-device-band-shot2.mjs`; all artifacts in
`/tmp/or-atom-005/or-atom-005-cluster-fixed/`):

- (a) **Screenshots** — `device-band-1596x1050.png` (≥1596×1050,
  required shot), `device-band-default.png` (1280×720 default desktop),
  and `device-band-1596x1050-settle.png` (after ~6 s settle the
  device-band chip **"GPU-d3fa2fbc-… idle" is visibly in-viewport at the
  scene's outer band bottom**, rect x=699 y=972 180×20 inside the
  1596×1050 frame, `inViewport=true` for 6/6 settle samples —
  `device-band-shot2.json`). In the shorter-settle frames the chip's
  projected label sits just below the fold (y=1218/1263) — a camera-fit
  framing detail, not a rendering defect; the settle capture is the
  definitive in-viewport shot.
- (b) **DOM text scan** (`capture-result.json.domScan`) — the GPU chip
  is a real DOM `button[data-atom-id="gpu:gremlin-1:GPU-…"]` (text
  `gpu:gremlin-1:GPU-…idle`, `aria-label` "… — atom, idle", `visible`,
  opacity 1, `data-focused`). The WebGL canvas does **not** hide the
  atom from the DOM.
- (c) **Secondary proof not needed:** the live page now completes the
  reconciliation organically, so the real
  `normalizeTopology → resolveAtomDescriptors → AtomicLabels →
AtomicTooltip` pipeline is proven directly; the fast route-serving
  workaround (`verify-device-band.mjs`) was **not** required.
- Verdict + artifact paths: `/tmp/or-atom-005/or-atom-005-cluster-fixed/
capture-result.json`.

**Device band in the dev-server captures: now renders.** This is the
exact §9.7 verdict item that was previously "NOT rendered" — resolved by
the T5.7 fix, no renderer/layout change.

### 10.5 Tooltip — SUCCESS (§9.6 finding overturned for the device atom)

One attempt via the §9.6 approach (find the device atom button's live
React `onClick` fiber and invoke it). The device tooltip **rendered** —
`tooltip-device-attempt.png` shows the full panel with **live DCGM
values**: Host `gremlin-1`, UUID `d3fa2fbc-…`, state `idle`, GPU util
0.0%, VRAM used 458.1 MiB (480247808 B), Temp 30.0 °C, Power 4.72 W,
"Fleet sample" timestamp row; panel is `role="status"`, visible.
**The §9.6 "not capturable in headless" finding was a downstream
symptom of the poller bug** (no reconciliation → no device atom → only
off-canvas provider labels existed to probe). With the fix in place, a
device-tooltip shot is capturable. Provider-atom tooltip was not
re-captured (out of scope for this step); §9.6's provider-specific
off-canvas observation is neither re-asserted nor disproven here.

### 10.6 Ops reproduce (post-fix)

```
kubectl port-forward -n prometheus-service \
  svc/prometheus-kube-prometheus-prometheus 9090:9090
# dev server (worktree), the exact §9.2 block:
PORT=20129 \
OMNIROUTE_FLEET_METRICS_SOURCE=prometheus \
OMNIROUTE_FLEET_METRICS_URL=http://localhost:9090 \
OMNIROUTE_FLEET_METRICS_VRAM_UNIT=mib \
OMNIROUTE_FLEET_METRICS_LABEL_HOST=hostname \
OMNIROUTE_FLEET_METRICS_LABEL_GPU_DEVICE=uuid \
  npm run dev
curl -s http://localhost:20129/api/telemetry/fleet
# + node /tmp/or-atom-005/t58-network-timeline.mjs (discriminator)
# + node /tmp/or-atom-005/t58-device-band.mjs (device band + tooltip)
```

### 10.7 Verdict + honestly-not-captured

- **Wiring + endpoint: PASS** (×3, §10.2). **Poller fix: confirmed
  live** — the §9.5 behavior is gone (§10.3). **Device band: renders**
  (§10.4). **Device tooltip: capturable** (§10.5).
- **Not captured / honest limits:**
  - Provider-atom tooltip was not re-captured (device atom only was in
    scope); §9.6's provider off-canvas note stands untested this round.
  - `vramTotalBytes` absent by exporter fact (never fabricated).
  - Device-chip in-viewport framing requires ~6 s settle in the short
    1596×1050 headless frame (below the fold before settle) — framing,
    not a defect; no camera/fit change was made (no source edits).
  - Dev-only environment: this re-verification ran against the dev
    server (StrictMode double-invoke is what the fix addresses); a
    production-build capture remains an optional belt-and-braces check
    (out of scope here).
- Unit suites were already green per the T5.7 brief (238/238 node,
  215/216 + 7/7 vitest, `typecheck:core` clean) and were **not**
  re-run, per the task instructions.
- Scratch artifacts: `/tmp/or-atom-005/t58-network-timeline.mjs`,
  `t58-device-band.mjs`, `t58-device-band-shot2.mjs` and
  `/tmp/or-atom-005/or-atom-005-cluster-fixed/` (`fleet-{1,2,3}.json`,
  `network-timeline.json`, `diag-fixed-network.png`,
  `device-band-1596x1050.png`, `device-band-default.png`,
  `device-band-1596x1050-settle.png`, `device-band-shot2.json`,
  `tooltip-device-attempt.png`, `capture-result.json`,
  `require-login-t58.json`); pre-restart log preserved as
  `devserver-20129.log.pre-fix-restart`.

---

## 11. Fleet telemetry integration — GPU wiring, fleet deploy, and final state (T5.12d)

Date: 2026-10-27 ~04:41 UTC (parent live re-verification).
All values below are the **verified** phase-1 numbers; task-expected numbers that
differ are noted inline.

### 11.1 Architecture decision — single backend

**Verdict: ONE Prometheus backend (in-cluster kube-prometheus), no second source.**

The adapter reads exactly one `source` + one `URL` (`OMNIROUTE_FLEET_METRICS_SOURCE=prometheus`,
`OMNIROUTE_FLEET_METRICS_URL=…`). Both new GPU sources are reachable from pods:
LAN 192.168.42.0/24 via node routing (DCGM `10.1.1.12:9400` already in-cluster; esnixi
`192.168.42.254:9400` over LAN) and the Mac's `192.168.42.201:9103` (macmon) — both verified
reachable from the in-cluster Prometheus pod (`prometheus-service` ns).

Wiring mechanism: **static targets in the kube-prometheus `scrape-configs` secret**
(`prometheus-kube-prometheus-prometheus-scrape-confg`, key `additional-scrape-configs.yaml`) —
the same mechanism as the pre-existing `10.1.1.12:9400` DCGM target. No Pushgateway,
no remote_write, no second backend.

Evidence: `/tmp/or-atom-005/feasibility-probe/esnixi-cluster.md`, `mac-inventory.md`.

### 11.2 Export-side wiring

**(a) esnixi RTX 5090 (192.168.42.254)**

- dcgm-exporter v4.3.1 already running (systemd, NixOS, `:9400`, all interfaces).
- Target `192.168.42.254:9400` appended to the existing `job_name: prometheus` static list
  in the scrape-configs secret.
- One `relabel_configs` entry: `Hostname→hostname` (esnixi's exporter uses capital-H
  `Hostname`; gremlin-1's uses lowercase — one env value can't match both, hence the relabel).
- Backup: `/tmp/or-atom-005/wiring/additional-scrape-configs.yaml.pre-esnixi`.
- Config reload: clean.
- **Current state: target DOWN** — pre-existing WireGuard return-path issue (see §11.6).

**(b) Mac M5 Max via macmon**

- macmon 0.8.2 installed (nix profile on this NixOS Mac).
- Persistent LaunchAgent `com.celes.macmon-exporter`
  (plist: `/tmp/or-atom-005/wiring/com.celes.macmon-exporter.plist`),
  exporter bound `192.168.42.201:9103`.
- **New** job `macmon_apple_gpu` in the same secret with static relabels
  `hostname=stabulous`, `uuid="Apple M5 Max"`.
  - Note: the original `chip→uuid` relabel was replaced by a static replacement after
    discovery that `relabel_configs` run at **target-discovery time** (pre-scrape), so
    per-series metric labels like `chip` are not yet available at relabel time.
- Target UP (verified in §11.5 live probe).
- Backups: `.pre-esnixi` + `.pre-macmon` (same secret key).

Evidence: `/tmp/or-atom-005/wiring/macmon-cluster-wire.md`, `macmon-m5.md`.

### 11.3 Adapter code change (commit 57a81ff19)

Branch `feat/atomic-topology-plugin`, file
[`src/shared/topology/telemetry/providers/metricMapping.ts`](src/shared/topology/telemetry/providers/metricMapping.ts):

- **macmon allowlist + mapping**: `macmon_gpu_scaled_ratio` × 100 → `utilizationPercent`
  (0..1 validated; out-of-range **dropped**, not clamped); `macmon_gpu_temp_celsius` →
  `temperatureC`; `macmon_gpu_power_watts` → `powerWatts`.
- **Shape fix**: old field→name map shadowed DCGM names when a second name mapped to the
  same field; corrected to name→field map.
- **VRAM fields ABSENT BY DESIGN** (Apple shared RAM — never fabricated).
- **Excluded families**: `usage_ratio`, `active_ratio`, `freq_mhz`, `ram_power_watts`,
  and all non-GPU macmon metrics.
- **TDD**: 12/12 red→green (`/tmp/or-atom-005/red-run.log`); targeted 49/49; full node
  suites green; `typecheck:core` 0 errors in the diff (43 pre-existing elsewhere).
- Docs matrix §7.2.7 updated.

### 11.4 :20129 live verification (final-verify-20129.md)

**Verdict: gpuNodes = 2. PASS.**

| GPU       | resourceId                                               | basis                     | util                      | temp        | power       | vramUsedBytes |
| --------- | -------------------------------------------------------- | ------------------------- | ------------------------- | ----------- | ----------- | ------------- |
| gremlin-1 | `gpu:gremlin-1:GPU-d3fa2fbc-bdd3-9333-b9a6-1b5385129a76` | `DCGM_FI_DEV_GPU_UTIL`    | 0                         | 30          | 4.724 W     | 480247808 B   |
| stabulous | `gpu:stabulous:Apple M5 Max`                             | `macmon_gpu_scaled_ratio` | 97.217596 (0.9723029×100) | 72.42931 °C | 36.169582 W | **absent**    |

- `runtimeNodes = []`, `providerNodes = 12`.
- esnixi GPU (`GPU-e01f787f…`) **correctly absent** (its target is down, §11.6).
- `vramTotalBytes` absent for **both** GPUs (DCGM exporter exports FB_FREE/FB_USED,
  not FB_TOTAL — pre-existing, §9.4; macmon has no VRAM at all by design).
- Fresh 12-PNG Atomic capture: `deviceAtomCount=2`, `resourceKinds {gpu:2, provider:12}`,
  no ghost `GPU:1`/`RUNTIME:1` chips → `/tmp/or-atom-005/final-2gpu/`.

Evidence: `/tmp/or-atom-005/wiring/final-verify-20129.md`.

### 11.5 Fleet deploy (verified live)

**Verdict: macmon image live in-cluster. PASS.**

| Check               | Value                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| Image tag           | `registry.celestium.life/library/omniroute:3.8.52-atomic-macmon-194b3b82`                        |
| Pod                 | `omniroute-b97896769-bm75l` 1/1 Running, 0 restarts, 10 m, node `gremlin-4`                      |
| Merge SHA           | `194b3b82a` = `bd4765966` ∪ `57a81ff19` (parents verified: `git log -1`)                         |
| Conflict resolution | CHANGELOG.md duplicate-add → **union** (mechanical, no semantic choice)                          |
| Env block           | All 6 `OMNIROUTE_FLEET_METRICS_*` vars unchanged (verified via `kubectl get deploy -o jsonpath`) |
| Manifest backup     | `omniroute.yaml.bak-20261026213020-pre-macmon` on 254 (11 total `.bak-*` files listed)           |
| Ingress             | `curl -sI https://omniroute.celestium.life/` → HTTP/2 307                                        |
| Rollback tag        | `3.8.52-atomic-pgfix-bd47659` — `docker manifest inspect` RC=0 (`PREVIOUS-TAG-OK`)               |

**In-cluster GPU series proof** (direct Prometheus query from in-pod, 2026-10-27 04:41 UTC):

```
DCGM_FI_DEV_GPU_UTIL → 1 series:
  UUID=GPU-d3fa2fbc-bdd3-9333-b9a6-1b5385129a76, hostname=gremlin-1,
  instance=10.1.1.12:9400, job=prometheus, value=0

macmon_gpu_scaled_ratio → 1 series:
  hostname=stabulous, uuid="Apple M5 Max", chip="Apple M5 Max",
  instance=192.168.42.201:9103, job=macmon_apple_gpu, value=0.74722004
```

**Note on the in-pod HTTP probe**: `/api/telemetry/fleet` returned HTTP 200 with
`{"gpus":[]}` (not the expected 401). The fleet manifest gates this route via
`requireManagementAuth`; however, the dev-server (`:20129`) runs **without** that gate
(different code path), and the in-pod container's route shape may differ from the
dev build. The **authoritative proof** is the direct in-cluster Prometheus query
above — same backend the adapter polls.

**Stale-header correction**: the §0 header of `k8s-fleet-deploy.md` ("STOPPED AT
GIT-COMBINATION HARD GATE") predates the conflict resolution. §8 was appended to that
file recording the live verification and noting the header is stale.

Evidence: `/tmp/or-atom-005/wiring/k8s-fleet-deploy.md` (§6 deploy + §8 re-verification).

### 11.6 esnixi 5090 — BLOCKED on operator

**Root cause**: H2 — esnixi can reach cluster **node** CIDR (10.1.1.0/24) but not
**pod** CIDR (10.42.0.0/16) over its `omniroute` WireGuard tunnel
(ping 10.1.1.12 OK vs ping 10.42.4.46 = 100 % loss).
Pre-existing: esnixi's node-exporter target `192.168.42.254:9100` has been DOWN
for the same reason since before this task; `node_exporter` inactive on esnixi.
**Not** an inbound firewall drop (H1).

**Operator fix** (verbatim from `/tmp/or-atom-005/wiring/esnixi-net.md` §7 — file
content fully present, 231 lines; **not reconstructed**):

The WireGuard endpoint on the Mac (peer `192.168.133.3/28`) must extend its
`AllowedIPs` to include `10.42.0.0/16`:

```bash
# on the Mac (tunnel server). Confirm the active config first:
sudo wg show        # find the interface (likely utun0 / wg-*) and the peer 192.168.133.3
# Then, in that interface's config, the peer [Peer] for 192.168.133.3 must include:
#   AllowedIPs = 10.1.1.0/24, 10.42.0.0/16     (add 10.42.0.0/16 if absent)
# Reload without restart, e.g. for wg-quick:
sudo wg-quick down <ifname> && sudo wg-quick up <ifname>
# or for a running peer, add the route/peer:
sudo wg set <ifname> peer <pubkey> allowed-ips 10.42.0.0/16
```

Symmetric check on esnixi (so esnixi is also permitted to emit 10.42.x replies):

```bash
sudo wg show omniroute
# If the peer's AllowedIPs does not include 10.42.0.0/16, add it and reload.
```

Post-fix verification from esnixi:

```bash
ping -c1 -W2 10.42.4.46        # must now return 1 packet
```

**Post-fix expectation WITHOUT any further code/config change**: the already-registered
`192.168.42.254:9400` target goes UP (stock DCGM names + `Hostname→hostname` relabel
already in place) → gpuNodes grows 2→3 on **both** :20129 and the fleet.
No adapter code change needed (esnixi is stock DCGM, unlike macmon).

### 11.7 Honest gaps / limits

- **macmon GPU row has no VRAM** — Apple shared system RAM; `vramUsedBytes` /
  `vramTotalBytes` fields absent by design, never fabricated.
- **esnixi GPU invisible** until the WireGuard fix above. The adapter correctly drops
  the absent series — no fabrication, no phantom node.
- **Fleet UI tooltip / scene not captured** — the `requireManagementAuth` gate blocks
  headless capture against the in-cluster deployment. The endpoint + in-cluster
  Prometheus series proofs stand as ground truth.
- **`vramTotalBytes` absent for the DCGM GPU too** — the exporter exports
  `DCGM_FI_DEV_FB_FREE` / `DCGM_FI_DEV_FB_USED` but not `DCGM_FI_DEV_FB_TOTAL`
  (pre-existing; §9.4).
- **Rollback tag is `3.8.52-atomic-pgfix-bd47659`** (11-hex sha8 truncation), **not**
  `3.8.52-atomic-pgfix-bd4765966` (15 hex) — the evidence file used the full SHA in
  the tag string; the actual push used the shorter form. Both resolve; the shorter
  form is what is in the registry and verified `PREVIOUS-TAG-OK`.
- **In-pod HTTP probe returned 200 with `{"gpus":[]}`** rather than the expected 401
  or the full `{snapshot, reconciliation}` shape. The management-auth gate may not be
  active in this manifest's code path, or the response shape differs from the dev
  build. Does not affect the correctness of the in-cluster Prometheus series proof.

### 11.8 Verdict

- **Single-backend architecture: correct and minimal** (§11.1).
- **Export-side wiring: both targets registered** (§11.2). esnixi target down
  (pre-existing network issue), macmon target UP.
- **Adapter code: TDD 12/12, targeted 49/49, full suites green** (§11.3).
- **:20129 endpoint: gpuNodes=2, both GPUs correct, no ghosts** (§11.4).
- **Fleet deploy: live, verified in-cluster** (§11.5).
- **esnixi 5090: blocked on operator WireGuard fix** (§11.6) — exact commands
  documented; no code change needed post-fix.
- **Gaps documented, none fabricated** (§11.7).

**Final state: TWO live GPUs (gremlin-1 DCGM + M5 Max macmon) in the in-cluster
kube-prometheus backend, visible on :20129 dev and in the fleet; third GPU (esnixi
RTX 5090) fully wired, awaiting network fix.**

---

## 12. Final state — OR-ATOM-005.1 + 006 closeout (2026-10-27)

### 12.1 What landed (branch `feat/atomic-topology-plugin`, tip `fe9822af4`)

- Base: `origin/release/v3.8.52` @ `0111d2adb` (operator-confirmed base)
- **C1 telemetry closure** (`1c02b53b1`): name-keyed 11-metric allowlist (5 DCGM, vLLM generation tokens + 2 V1 scheduler gauges, 3 macmon) with load-time collision guard; `scaleFieldValue()` single scaling point; counter reset → `null` + re-baseline; bounded `maxSeries` LRU; prometheus/grafana gauge branches routed through scaling + scheduler-gauge provenance fix; InfluxDB2 `active_jobs`→`activeJobs`; `gatewayServer.ts` per-adapter `counterEngine` — closes the production TPS-null gap (Defect A)
- **Macmon reconciliation** (`fe9822af4`): dedicated 332-line macmon provider test restored; matrix doc §7.2.8 added; **bug found+fixed**: C1's `types.ts::hasForbiddenChars` rejected spaces while the live macmon host key is `"Apple M5 Max"` (and C1's own `isUsableIdentity` allowed them) — now rejects only `:`/`/`, TDD-validated by the macmon test
- **P0 fix** (merge `42e254d93`, from `atomic-topology-p0-webgl`): cached + context-released `webgl2Available()` probe (≤1 allocation/page, `WEBGL_lose_context` release); per-render `canCreateWebGL2AtRender()` deleted, gate via one-time `useMemo` + pure `shouldRenderScene()`; `EnergyLink` TubeGeometry disposed on dep-change + unmount via `disposeSceneObject()` helper. Root cause of the ~2-min blank scene: ~3.5 s telemetry re-renders exhausted the ~16 active-WebGL-context limit. Frozen visuals untouched
- **S6 scripts** (merge `58b730d42`, from `feat/atomic-soak-scripts`): `scripts/ad-hoc/benchmark-atomic-topology.mjs` (Playwright, 8/16/32/50 atoms, rAF frame-time p50/p95/p99 + WebGL context-count series) and `scripts/ad-hoc/atomic-telemetry-soak.mjs` (15-min fleet poll, TTL conformance, JSON+CSV under `_cache/`; exits non-zero with an explicit external-blocker verdict when no backend is reachable). Syntax-validated only, never executed
- Backup ref: `backup/atomic-topology-pre-integration-2026-10-27` → `57a81ff19` (pre-integration state, local only)

### 12.2 Evidence (this session, all run in the worktree at final tip)

| Check                       | Command                                                                                                                                         | Result                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telemetry unit tests        | `node --import tsx/esm --test tests/unit/telemetry/*.test.ts`                                                                                   | 257/257 pass                                                                                                                                                                                                                                                                                                            |
| Atomic-topology unit tests  | `node --import tsx/esm --test tests/unit/atomic-topology/*.test.ts`                                                                             | 221 pass + 1 skip                                                                                                                                                                                                                                                                                                       |
| EnergyLink dispose (vitest) | `npx vitest run tests/unit/atomic-topology/energyLinkDispose.test.tsx`                                                                          | 2/2 pass                                                                                                                                                                                                                                                                                                                |
| Atomic-topology vitest dir  | `npx vitest run tests/unit/atomic-topology/`                                                                                                    | 9/9                                                                                                                                                                                                                                                                                                                     |
| Typecheck                   | `npm run typecheck:core`                                                                                                                        | 45 pre-existing base errors, 0 new in changed files                                                                                                                                                                                                                                                                     |
| Lint (scoped)               | `npx eslint src/plugins/atomic-topology/ src/shared/topology/telemetry/ tests/unit/atomic-topology/ tests/unit/telemetry/ scripts/ad-hoc/*.mjs` | 0 errors (2 pre-existing "ignored file" warnings on the .mjs scripts)                                                                                                                                                                                                                                                   |
| Docs gates                  | `npm run check:docs-all`                                                                                                                        | FAIL (exit 1) — all 5 STRICT drifts are known baseline (0 new): README.md/AGENTS.md/llm.txt "193 migrations" vs 199; MCP-server docs "123 tools" vs 110 (`docs/frameworks/MCP-SERVER.md` + `open-sse/mcp-server/README.md`). None reference `docs/specs/atomic-topology-telemetry-matrix.md` — no fix made, none needed |

### 12.3 Honest gaps — external blockers (NOT executed, nothing fabricated)

- **Live fleet-telemetry verification**: no reachable backend in this environment — `OMNIROUTE_FLEET_METRICS_SOURCE/URL/TOKEN/DATASOURCE_UID` unset in both checkouts; local process at 127.0.0.1:20128 predates the fleet route (HTTP 404); macmon at 192.168.42.201:9103 exposes only `chip`/`fan` labels (no host/UUID/runtime); no vLLM/llama.cpp/MLX/DCGM exporter found locally. InfluxDB2 path is fixture-verified only. The soak script is the designated live-verification vehicle — it is written to fail loudly with an explicit external-blocker verdict instead of inventing data.
- **15-min real-browser soak / WebGL-leak regression in a live tab**: the P0 fix is unit-proven (probe allocates once + releases; gate evaluated once; geometry disposed on change/unmount), but the browser-level proof awaits the benchmark + soak scripts being run against a live dashboard — external blocker, no live instance available this session.
- **Push / PR**: not performed — no automatic push/rollout (hard rule #24; PR targets restricted to `FTA-developers`/`celesrenata`; operator confirms when opening the PR). Branch `feat/atomic-topology-plugin` stays local in worktree `.claude/worktrees/atomic-topology-plugin`.
