# OR-ATOM-005 — Fleet GPU Telemetry & Model Attribution

**Owner:** Menagerie / Zoo autonomous implementation task  
**Target:** `celesrenata/OmniRoute`, CURRENT LOCAL WORKTREE, not a pinned commit  
**Status:** Ready to execute  
**Reference:** `reference/current-state.png` (October 24, 2026, the current Atomic UI)

## Mission

**Step 5 means making the already-built Atomic topology display real measured fleet data.** Preserve the current artistic/rendering progress. The current screenshot is accepted as the visual baseline and is **not** a request to change framing, zoom, camera, graph geometry, placement, projected labels, controls, or visual styling. Do not touch these unless necessary to connect the data and then minimize the change.

Implement and connect an optional **centralized fleet metrics source** (Grafana's datasource-query API, direct Prometheus, or InfluxDB2 — use whichever the operator already has). Combine it with OmniRoute-native request telemetry and runtime telemetry, then map proven device/model/runtime associations into the Atomic scene. An unobserved measurement must stay unknown, not turn into simulated work.

## Verified repository baseline (published default branch; may lag local)

- `src/shared/topology/telemetry/types.ts`: `FleetTelemetryProvider`, `FleetTelemetrySnapshot`, `FleetResourceObservation`, `Observed<T>`; resource kinds `gpu|runtime|provider`; canonical ID helper `buildCanonicalResourceId()`.
- `src/shared/topology/telemetry/gateway.ts`: bounded server-side `FleetTelemetryGateway`, caching, validation, source aggregation.
- `src/shared/topology/telemetry/providers/omniroute.ts`: only source adapter registered so far, consumes provider connections, call logs, circuit breakers, limiter counts.
- `src/app/api/telemetry/fleet/route.ts`: management-authenticated, bounded API. No known home-scene consumer when last checked; verify local tree.
- `src/shared/topology/domain/types.ts`: scene snapshots, provider entities, model IDs, lifecycle events. GPU node kind exists as future support, but is not emitted by the baseline.
- `src/shared/topology/domain/normalizeTopology.ts`: builds provider-centric scene; do not conflate a provider with a GPU.
- `src/plugins/atomic-topology/AtomicTopologyRenderer.tsx`: already has nucleus model colors from in-flight IDs, and honest neutral TPS/queue encodings. Check local code before changing anything.
- `src/plugins/atomic-topology/visualEncoding.ts`: `spinRadiansPerSecond` and `queueVibration` are already defined. **Use measured output TPS, not active request count.**
- `src/app/(dashboard)/dashboard/HomeProviderTopologySection.tsx`: owns ONE visibility-gated live-request subscription; do not add another one.
- `docs/specs/atomic-topology-telemetry-matrix.md` and `docs/specs/atomic-topology-implementation-report.md`: previous source-only audit. An absence of Grafana config _in the repository_ does **not** establish the absence of a real external fleet stack; inspect existing environment, using authorized tooling.

## Non-negotiable freezes

**DO NOT change** camera, focus/reset behavior, zoom, framing, spatial layout, node placement, projected labels, existing orbit/atom appearance, connection geometry, colors for existing visual states, controls, navigation, or the ReactFlow 2D fallback. **Do not repeat prior visual-fidelity tasks.** Screenshot zoom levels are operator-controlled; do not diagnose intentional zoom as clipping.

Keep current effects/pause/reset behavior and existing subscription lifetime. Prefer data adaptation and renderer descriptor changes over refactoring scene primitives.

## Model of the fleet

```
OmniRoute lifecycle/call logs                  GPU/runtimes (host-local exporters)
  provider / request / model / lane             GPU UUID / utilization / VRAM / power
                |                               runtime model / tokens/sec / queue
                +------------+------------------------------+
                             |
              CENTRAL EXISTING METRICS BACKEND
                 Prometheus or InfluxDB2
                             |
                    optionally Grafana
                 (datasource-query facade)
                             |
             server-only FleetTelemetryProvider
                             |
                     FleetTelemetryGateway
             (identity, provenance, freshness)
                             |
                   authenticated fleet API
                             |
                 one shared visible-tab query
                             |
                    topology core snapshot
                             |
                    Atomic renderer plugin
```

_No browser → individual host calls; no per-atom HTTP polling; no Grafana dashboard HTML or panel scraping._ Host-side exporters/agents may reach the central backend over the existing WireGuard network. Direct queries to the central backend are equally valid and may be simpler than Grafana proxying.

## Workstreams and implementation gates

### T5.0 — Discover real fleet sources and current local implementation

- Inspect current `git status`, repo instructions, features and tests. Do not overwrite uncommitted Step 4 work.
- Determine what observability endpoints _already_ exist (Grafana datasource UIDs, actual central Prometheus/InfluxDB2 data, runtime metrics, Nix/Kubernetes exporters). Authorized read-only configuration/connection checks only; do not emit credentials in reports.
- Record which runtime exposes output TPS and true inference scheduler waiting jobs. Do **not** equate OmniRoute rate-limiter queue with a GPU scheduler queue.
- Check whether host and GPU UUID are available and whether runtime→device and provider→runtime mappings are provable.
- Update `docs/specs/atomic-topology-telemetry-matrix.md` with source, example metric/query, unit, labels, scrape interval, credentials reference (not secret), window, join key, and availability.
- This investigation must be bounded. Continue implementation using fixtures/configurable adapters if live access is blocked.

**Gate:** every metric has a verified source or a defined honest-unavailable path.

### T5.1 — Central metrics source adapter (one useful source first)

- Implement only the adapter(s) justified by T5.0: `prometheus`, `influxdb2`, or `grafana` under `src/shared/topology/telemetry/providers/`.
- If Grafana has all fleet datasources, use its **server-side datasource query API**, with service credentials held server-side. Grafana is not the metrics database; store query definitions in version-controlled code, not scraped dashboards.
- Narrow allowlisted queries only; controlled datasource UID, URL and metric names. Prevent user-defined arbitrary endpoint/PromQL/Flux execution and SSRF.
- Reuse existing gateway timeouts, LRU, validation, cancellation, and provenance; avoid additional per-atom backend calls. Timeouts/errors do not break the topology.
- Validate metric units, sample timestamps, zero versus unknown, stale (> configured freshness window), and monotonic counters/rates. Adapt to the actual backend data schema rather than inventing names.
- Optional provider configuration via approved existing settings/environment/secret mechanism. Never commit or print credentials.

**Gate:** one server-side normalized fleet snapshot returns measured GPU/runtime facts from configured backend; unit integration works with fixtures.

### T5.2 — Runtime attribution and topology reconciliation

- Canonical identities: `gpu:<host_id>:<device_uuid>`, `runtime:<host_id>:<runtime_id>`, `provider:<provider_id>` (or current repo equivalent). Never join by display label, guessed hostname, bare GPU index, or model name alone.
- Add explicit, provenance-carrying relationships for provider→runtime, runtime→device(s), and runtime→model(s). Support one-to-many and many-to-many correctly. If no reliable source can establish a relationship, leave it unattached.
- Deduplicate observations by canonical IDs, enforce stable identity over reorders, and handle model hot swaps and disappearing GPUs.
- Create GPU nodes **only for devices actually observed**. Cloud-only providers remain provider atoms. Avoid duplicating physical resource measurements across several logical providers.
- Distribute runtime TPS to GPUs **only if runtime metrics supply per-device attribution**. Never divide total TPS evenly across multiple GPUs as a guess. If unknown, show throughput at runtime/provider level instead.
- Likewise for model share: use known residency/load/dispatch observations; avoid guessing resident models from recent calls.

**Gate:** genuine GPU atoms appear when real identity is proven, alongside existing provider nodes without false edges.

### T5.3 — One live consumer path from fleet gateway to Atomic

- Reuse `GET /api/telemetry/fleet` or a small authenticated backend aggregator according to repo convention; reuse session/management auth (no frontend credentials).
- When Atomic is mounted and visible, fetch ONE bounded snapshot for the scene (not N requests per GPU). Prefer modest 2–5s UI cadence initially, tune cache TTL to the actual ingestion cadence; avoid misleading more-frequent-than-source updates. Abort on hidden/unmount/mode switch and coalesce in-flight fetches.
- Keep the existing lifecycle websocket exactly as is; do not create a second websocket for telemetry.
- Feed normalized device/runtime facts through topology core into plugin-neutral descriptors. Leave `2D` behavior intact.
- If no source is configured, endpoint is inaccessible, or data stale, show a concise `unavailable`/`stale` fact without pretending that an idle device is measured as zero.

**Gate:** switching 2D ↔ Atomic or hiding the dashboard stops unnecessary telemetry work; frontend never sees backend tokens.

### T5.4 — Bind existing animation controls to real measurements

- **Nucleus rotation** ← measured per-GPU output tok/s; no activeRequest→tok/s shortcuts.
- **Nucleus vibration** ← measured inference scheduler pending queue for THAT runtime/GPU. OmniRoute rate limiter queue is separately labeled, not silently mapped to GPU scheduler queue.
- **Particle model colors** ← observed model residency/assignment/activity, up to three colors, neutral remainder; retain current deterministic model palette.
- **Electron lane hues / discharge** ← existing OmniRoute lifecycle events, and runtime lanes only where explicitly observable. Do not replace already working Step 4 effects.
- **Details/tooltips** ← measured GPU utilization, VRAM, temperature, watts, TPS, queue, model IDs plus provenance/sample age where present.
- Debounce/ease numeric changes. Stale data returns to neutral visual behavior. Keep diagnostics separate from decorative idle motion.

**Gate:** measured movement responds during a real workload, and stops/neutralizes when data is unavailable.

### T5.5 — Verification and documentation

- Test with fixtures: 0 GPUs, one GPU/one model, one GPU/three models, multiple runtimes one GPU, one runtime multiple GPUs with insufficient attribution, disappearing GPUs, stale samples, zero counters, malformed responses, auth denial, gateway timeout, duplicate events.
- Test that job rate is a rate (windowed output token delta/seconds or trustworthy native runtime TPS). Never substitute call token totals or current active counts. Label per-call retrospective rate separately from instantaneous GPU throughput.
- Include external adapter fixture tests, auth tests, one query per poll, no browser secret exposure, hidden-tab/unmount cancellation, 2D unchanged, no duplicate WS.
- Validate via actual workloads if accessible; otherwise document exact operational blockers and finish tested adapters with a dry-run/mock source clearly labeled.
- Compare current screenshot to final: **the layout/camera/labels/effects should be unchanged** apart from legitimate new GPU atoms and data-driven motion/metrics.

**Gate:** existing tests plus new metrics/identity/consumer tests pass; report measured vs unavailable fields, test commands, screenshots, and remaining live access requirements.

## Data semantics to protect

| Value                       | Source that may assert it                              | Never substitute                        |
| --------------------------- | ------------------------------------------------------ | --------------------------------------- |
| Physical GPU inventory      | exporter / authenticated inventory source with UUID    | provider or logical route names         |
| GPU output tok/s            | runtime metric attributable to device                  | active request count, total token count |
| Queued jobs                 | runtime scheduler pending count attributable to device | OmniRoute limiter queue                 |
| Model assignment            | runtime residency or device binding                    | last requested model                    |
| Lane                        | OmniRoute job lifecycle/known modality                 | general provider category guess         |
| Utilization/VRAM/temp/power | exporter metrics                                       | inferred load from throughput           |
| Zero                        | fresh, explicit numeric measurement                    | null, missing, timed out, stale         |

## No-data and demo-mode policy

If external fleet backend access is unavailable in this execution environment, deliver configurable adapters, fixtures, wiring, and tests. Do **not** fabricate the user's fleet, pretend remote connection worked, or deploy a new observability stack automatically. A visibly labeled _demo/mock_ mode can be kept in tests/development only and must never contaminate real dashboards.

## Completion report

Report precisely: files changed, backend(s) truly connected, credential requirements without values, source identity matrix, attributed versus unattributed models/GPUs, request frequency, tests run/results, screenshots, metrics proven live, known gaps. **Do not claim all telemetry is live if only the websocket status is live.**
