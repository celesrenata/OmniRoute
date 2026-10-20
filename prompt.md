---
id: OR-ATOM-001
title: OmniRoute Atomic Topology Plugin — Pluggable 3D GPU/Fleet Observability
version: 2.0.0
status: ready-for-implementation
priority: high
spec_type: plugin-feature
execution_mode: milestone-driven
repository: celesrenata/OmniRoute
baseline_commit: c02725a418fab4ac23b479deb6550f83355e8a36
primary_entrypoint: src/app/(dashboard)/home/ProviderTopology.tsx
owner: user
---

# OmniRoute Atomic Topology Plugin — Roo/Zoo/Menagerie Implementation Spec

> **Agent instruction:** Implement this feature in the existing OmniRoute repository, preserving all established behavior. Read the current checkout first. Treat the pinned commit as a reference, **not** as permission to reset or overwrite a newer working tree. Complete milestones in dependency order, run relevant checks at each boundary, and report what changed, how it was verified, and what remains unavailable in real telemetry. Do not fabricate runtime measurements or silently replace real measurements with animation proxies.

## 0. Executive brief

Build **Atomic Topology as a pluggable topology renderer**, not as a monolithic rewrite of
`ProviderTopology.tsx`.

OmniRoute core remains responsible for topology semantics, request lifecycle state,
navigation, authorization, and normalization. A small **Topology Renderer Plugin API**
becomes the extension boundary. The current ReactFlow implementation is retained as the
built-in 2D renderer and the new Atomic renderer is the first heavyweight plugin.

The Atomic plugin renders an interactive, real-time, GPU-accelerated 3D observability scene:

1. **Each real GPU/device becomes one atom** when physical device identity and attribution
   are available. Provider atoms remain the honest fallback when only provider-level data
   exists.
2. **Proton/neutron color distribution = up to three observed model IDs** associated with
   that atom, with a neutral remainder for unknown/other models.
3. **Electron-cloud hue = request/job lane** such as chat, prefill, decode, embedding,
   rerank, image/vision, audio, or system.
4. **Electrical discharge = request activity and transitions**. Failed jobs produce a
   short red discharge/flash; persistent health state is represented separately.
5. **Nucleus angular velocity = measured output tokens/sec**.
6. **Nucleus vibration amplitude = measured scheduler queue depth for that GPU/runtime**.
7. **Device utilization, VRAM, temperature, power, and other fleet telemetry may come from
   an external observability backend** when OmniRoute itself does not own those metrics.

The fleet telemetry design must be source-agnostic. OmniRoute must not make the browser
scrape individual machines. Host exporters/agents feed a **central telemetry backend**,
and the Atomic plugin consumes a normalized server-side telemetry API.

Supported telemetry source strategies:

- OmniRoute-native request/runtime telemetry.
- Prometheus-compatible backend queried centrally.
- InfluxDB 2 queried centrally.
- Grafana as an **optional centralized query facade** via its datasource query API when
  multiple underlying datasources already exist there.
- Future adapters without changing the renderer contract.

**Important:** Grafana is normally a visualization/query layer, not the metric store. Do
not scrape Grafana dashboards or panel HTML. If Grafana is used, query its datasource API
server-side with a service credential and treat it as a facade over Prometheus/Influx/etc.
Prefer direct backend queries when one backend already contains the needed data.

**Definition of done:** OmniRoute has a reusable topology-renderer extension point, the
existing 2D renderer remains intact, Atomic Topology is lazy-loadable and optional, telemetry
has explicit provenance/freshness, fleet metrics can be sourced from a centralized backend,
and no synthetic GPU/device facts are presented as real.

## 1. Grounded baseline at the pinned commit

### Verified integration points

- `src/app/(dashboard)/home/ProviderTopology.tsx` currently uses `@xyflow/react` through `FlowCanvas`; center router plus provider nodes, deterministic concentric elliptical rings, status-based edge rendering, and provider-page clicks.
- `src/shared/components/flow/FlowCanvas.tsx` is **shared** with other studio graphs; do **not** modify it for specialized 3D behavior or break its remount/refit stabilization.
- `src/shared/components/flow/edgeStyles.ts` defines shared health/traffic colors and priority: error > active > last-used > healthy > idle.
- `src/app/(dashboard)/home/topologyUtils.ts` resolves provider aliases and merges special embeddings/audio nodes. Retain alias matching and names.
- `src/app/(dashboard)/home/topologyLabel.ts` prioritizes friendly entry names over registry names and raw provider IDs. Preserve this.
- `src/app/(dashboard)/dashboard/HomeProviderTopologySection.tsx` owns a **visibility-gated `useLiveRequests({enabled})` subscription**, passes flattened active requests to `ProviderTopology`, and displays header counters.
- `src/app/(dashboard)/dashboard/HomePageClient.tsx` supplies provider entries and last/error providers, and controls whether the topology section is shown. Do not create another unconditional live socket there.
- `src/app/(dashboard)/home/HomeRecentRequests.tsx` polls `/api/usage/call-logs?limit=60&excludeTests=1` about every 3 seconds, gates polling by visibility and enabled, filters connection-test rows, and renders the adjacent Recent Requests panel. Do not duplicate that poll merely for visual effects.
- Package snapshot includes Next.js 16, React 19, `@xyflow/react`, `next-intl`, and Zustand; **R3F/Three.js are not installed at this reference commit**. Check current package versions before adding compatible dependencies.

### Critical data truth

At baseline the topology receives `{providers, activeRequests: [{provider,model}], lastProvider, errorProvider}`. It **does not** receive trustworthy per-GPU identity, measured output tok/s, scheduler queue length, per-GPU assignment, or per-model VRAM residency. Therefore:

- Phase-one provider view must work with today's data.
- GPU atom mode is unlocked only when actual resource inventory and routing attribution exist.
- Unknown metrics render as `—` / `unavailable`, with restrained neutral visual behavior; they **must not** be invented from a request count or token totals.
- The Recent Requests `tokens.in/out` fields are token **counts**, not tokens/sec. Never relabel them as throughput.
- A job failure and a persistent unhealthy connection are different states. A failure can flash briefly; the health border may remain independent.

Primary code reference: https://github.com/celesrenata/OmniRoute/blob/c02725a418fab4ac23b479deb6550f83355e8a36/src/app/%28dashboard%29/home/ProviderTopology.tsx

## 2. Agent operating contract

### Before editing

1. Inspect git status, current HEAD, package manager/lockfile, repository instructions (`AGENTS.md`, Roo/Zoo rules, conventions), nearby tests, and current component implementations. Never overwrite uncommitted work.
2. Compare referenced files with the pinned commit; use the **actual checkout** as source of truth and note divergences.
3. Locate actual producer(s) of live lifecycle events, usage/call logs, provider metrics, route IDs, GPU/device telemetry, and any runtime scheduler/queue metrics. Record a capability matrix: `available`, `derived-with-provenance`, `unavailable`.
4. Use the smallest compatible dependency set. Keep 3D code lazy-loaded; ensure 2D and server rendering are unaffected.
5. Produce an implementation checklist against the milestone IDs below. Work autonomously within the existing repo, stopping only for an irreducible decision/security issue.

### Non-negotiable constraints

- Do not add fabricated GPU names, synthetic live traffic, dummy token/sec values, or misleading queue figures outside a clearly labeled **demo mode that is off by default**.
- Do not modify routing decisions, provider health, model selection, API semantics, or logging logic just to make visualization easier.
- Do not replace `FlowCanvas` in other parts of the application.
- Do not add a second WebSocket or polling loop when existing data can be shared via a hook/store.
- Do not leak API keys, headers, raw prompt contents, private request IDs, internal credentials, or more host identifiers than the operator is already authorized to see.
- Honor the existing theming, `next-intl` localization, and home appearance/visibility gating.
- The 3D renderer must not cause build failures in server, Electron, PWA, test, or headless contexts.
- Use a **stable 3D layout**; activity updates must never reshuffle atom positions or reset the camera.
- New shared rendering helpers cannot assume GPU presence at import time.

## 3. User-facing requirements and priority

| ID    | Requirement                                       | Priority | Acceptance evidence                                                        |
| ----- | ------------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| FR-01 | Select 2D / 3D inside existing Home topology card | P0       | Toggle works, session preference persists, 2D remains functional           |
| FR-02 | OmniRoute hub with connected provider atoms       | P0       | Existing nodes/aliases/edge statuses preserved                             |
| FR-03 | Physical-GPU mode when genuinely mapped           | P1       | One atom per known GPU with provider association; clear mode labels        |
| FR-04 | Colored model particles in nucleus                | P0       | Up to top-three _individual_ model IDs with legend; unknowns neutral       |
| FR-05 | Electron clouds recolor by active lane            | P0       | Deterministic mapping, mixed lanes represented without flicker             |
| FR-06 | Animated energy filaments represent work          | P0       | Active/complete/error transitions and health all distinct                  |
| FR-07 | Failed request flashes red once                   | P0       | Burst on new failure ID, decays, no endless repeated flash                 |
| FR-08 | Spin speed tracks measured output tok/s           | P1       | Smooth monotonic mapping; `unknown` handled honestly                       |
| FR-09 | Vibration tracks actual queued jobs               | P1       | Zero = still; positive = progressive amplitude; unknown = no asserted load |
| FR-10 | Click, hover, camera orbit, zoom, focus           | P0       | Provider navigation parity; tooltips show source and units                 |
| FR-11 | Accessible, responsive, safe fallback             | P0       | Keyboard/DOM alternative, reduced motion, WebGL/WebGPU failure fallback    |
| FR-12 | Live requests and Recent Requests not broken      | P0       | Existing gating, filters and adjacent table retained                       |
| FR-13 | Real data availability indicated per metric       | P0       | Missing measurements display clearly, no silent estimation                 |
| FR-14 | Frame-time and resource budget observed           | P0       | Measured performance meets agreed gates in §12                             |

## 4. Plugin architecture

### 4.1 Core principle

`ProviderTopology.tsx` becomes a **renderer host**, not the owner of Three.js/WebGPU/WASM
implementation details.

```text
HomePageClient
    │
    ▼
HomeProviderTopologySection
    │  existing visibility-gated live request subscription
    ▼
Topology Domain / Normalizer
    │
    ├──────────────► built-in renderer: ReactFlow 2D
    │
    └──────────────► renderer registry
                       │
                       └── Atomic Topology Plugin
                            ├── R3F / Three.js renderer
                            ├── optional WebGPU path
                            ├── optional WASM compute helper
                            ├── atom scene
                            ├── event/discharge pool
                            └── DOM overlays / camera / picking

Fleet Telemetry Gateway (server side)
    ├── OmniRoute native adapter
    ├── Prometheus adapter
    ├── InfluxDB2 adapter
    └── Grafana datasource-query adapter
              │
              ▼
       normalized AtomicTelemetrySnapshot
```

### 4.2 Renderer plugin contract

Introduce the narrowest useful internal extension API. Do **not** build a global third-party
plugin marketplace as part of this feature.

```ts
export interface TopologyRendererPlugin {
  id: string;
  name: string;
  version: 1;

  /** Browser/runtime capability check only; no data fetching here. */
  supported(): boolean | Promise<boolean>;

  mount(
    container: HTMLElement,
    initial: TopologySceneSnapshot,
    options: TopologyRendererOptions
  ): TopologyRendererInstance;
}

export interface TopologyRendererInstance {
  update(snapshot: TopologySceneSnapshot): void;
  resize(width: number, height: number): void;
  setPaused(paused: boolean): void;
  focusNode(nodeId: string): void;
  dispose(): void;
}
```

If R3F integration is cleaner as a React component, the concrete API may be expressed as a
React renderer registration rather than imperative `mount()`. Preserve the same separation:
**core owns data; plugin owns rendering**.

### 4.3 Built-in 2D renderer

The existing ReactFlow implementation becomes the reference built-in renderer.

Requirements:

- Behavior remains byte-for-byte equivalent where practical.
- Existing provider status precedence is preserved.
- Existing click navigation is preserved.
- `FlowCanvas` stays shared and is not polluted with Atomic-specific logic.
- 2D is always available as fallback.

### 4.4 Atomic renderer plugin

The Atomic renderer must be:

- client-only / lazy-loaded;
- optional;
- independently disposable;
- safe to fail without breaking the dashboard;
- isolated from topology subscription lifecycle;
- capable of accepting provider-only snapshots before GPU telemetry exists.

Suggested module boundary:

```text
src/shared/topology/
  domain/
  renderer/
  telemetry/

src/plugins/atomic-topology/
  index.ts
  manifest.ts
  AtomicTopologyRenderer.tsx
  scene/
  overlays/
  shaders/
  wasm/               # only if profiling later proves a need
```

Do not force these exact paths if the current checkout has a stronger convention.

### 4.5 Rendering and WebAssembly decision

Use `@react-three/fiber` + compatible `three` for v1. WebGL2 is the reliable baseline.
WebGPU is progressive and feature-detected.

WASM is **not** the rendering API. Add a Rust/`wasm-bindgen` or other WASM compute helper
only if profiling demonstrates that layout/particle math materially benefits. The Home page
must never require WASM to render.

### 4.6 Separation of responsibilities

- **Topology core:** provider/device/model identity, edges, health/traffic semantics,
  navigation IDs, authorization.
- **Telemetry gateway:** source adapters, authentication, query execution, normalization,
  freshness, caching, rate limiting.
- **Scene snapshot:** renderer-neutral immutable data.
- **Visual encoding:** deterministic metric-to-color/motion mapping.
- **Renderer plugin:** GPU drawing, interpolation, camera, picking, effects.
- **DOM overlay:** labels, tooltips, accessible controls, keyboard navigation.

## 5. Entity semantics: provider and GPU are not the same thing

### Initial/default: Provider Topology

- Reuse all existing provider nodes (including custom provider nodes, embeddings and audio) plus central OmniRoute router.
- Providers are presented as **provider atoms**, not physical GPU atoms.
- Provider-level requests and health drive glow/links where data exists.
- Provider-level actual output throughput may be displayed _only_ if instrumented with correct attribution; otherwise show unknown.

### Additional: GPU Topology

- GPU inventory entries require a durable ID such as `{nodeId, deviceUuid}`; include backend/runtime type and optional provider ownership. Handle one local host with multiple GPUs.
- An actor using a remote provider (OpenAI, xAI, Bedrock, etc.) must remain a provider node unless the physical GPU is actually exposed by an authorized telemetry source.
- A routed job has `{providerId, resourceId?}`; only associate with a specific GPU when the runtime exposes that assignment.
- If the user switches to GPU mode and there are no attributed devices, show a useful explanation, **not** phantom GPU atoms; offer Provider View.
- Avoid double-counting shared endpoints/GPU resources. Physical GPU telemetry may be present even when request attribution is not; label compute throughput as unknown in that case.

### Graph link semantics

- Hub → Provider: routing connectivity/traffic, always safe to represent from current data.
- Provider → GPU: show only for confirmed inventory ownership or runtime mapping.
- GPU → GPU: show only if a real job transition or communication edge is instrumented, never arbitrary decorative topology.
- Nucleus ↔ job orbit particles: _metaphorical local activity_, never presented as physical data transfer.

## 6. Typed scene and event contract

Create a dedicated type file; refine these sketches based on existing conventions:

```ts
export type AtomKind = "hub" | "provider" | "gpu";
export type HealthState = "healthy" | "unhealthy" | "unknown";
export type TrafficState = "active" | "recent" | "idle";
export type JobLane =
  | "chat"
  | "prefill"
  | "decode"
  | "embedding"
  | "rerank"
  | "vision"
  | "image"
  | "audio"
  | "system"
  | "unknown";
export type RequestPhase = "queued" | "started" | "streaming" | "completed" | "failed";

export interface Observed<T> {
  value: T | null; // null = not observed; not zero
  source: "live-event" | "call-log" | "runtime" | "provider-metrics" | "derived";
  sampledAt: number; // epoch milliseconds
  windowMs?: number; // for rates/composition
  stale?: boolean;
  basis?: string; // e.g. output-token-delta, active-job-count
}

export interface AtomicModelShare {
  modelId: string; // stable identifier, not only family
  fraction: number; // relative to explicitly named basis
  basis: "active-job-count" | "output-token-share" | "measured-vram-share";
}

export interface AtomicLaneShare {
  lane: JobLane;
  fraction: number;
}

export interface AtomicNode {
  id: string; // stable canonical, e.g. provider:xxx, gpu:host:uuid
  kind: AtomKind;
  label: string;
  providerId?: string;
  routeId?: string;
  resourceId?: string;
  aliases?: string[];
  health: HealthState;
  traffic: TrafficState;
  lastRoutedAt?: number;
  latestErrorAt?: number;
  outputTokensPerSecond?: Observed<number>;
  queuedJobs?: Observed<number>;
  activeJobs?: Observed<number>;
  modelShares?: Observed<AtomicModelShare[]>;
  laneShares?: Observed<AtomicLaneShare[]>;
  utilizationPercent?: Observed<number>;
  vramUsedBytes?: Observed<number>;
  vramTotalBytes?: Observed<number>;
}

export interface AtomicLink {
  id: string;
  source: string;
  target: string;
  kind: "route" | "ownership" | "observed-transfer";
  health: HealthState;
  traffic: TrafficState;
}

export interface AtomicEvent {
  id: string; // stable dedupe key; no prompt content
  at: number;
  kind: "request-started" | "request-completed" | "request-failed";
  providerId: string;
  resourceId?: string;
  modelId?: string;
  lane?: JobLane;
  linkId?: string;
}

export interface AtomicSnapshot {
  schemaVersion: 1;
  capturedAt: number;
  nodes: AtomicNode[];
  links: AtomicLink[];
  events: AtomicEvent[];
}
```

### Data normalization invariants

1. Distinguish absent data (`null`/undefined) from a measured `0`.
2. Reject negative/NaN/Infinity telemetry and out-of-order samples where necessary.
3. Preserve existing alias matching, friendly labels, connection health, and last-used recency as separate dimensions.
4. Stable IDs survive reorder, reconnect, window resize, and event refresh.
5. Unique provider-node routes and physical device identity are never conflated.
6. Deduplicate live events via ID; if an existing payload lacks a durable event ID, derive a bounded collision-resistant key from available non-sensitive lifecycle fields and document its limitations.
7. Aggregates specify whether rates are **output**, **input**, or **total** tokens/sec and the time window.
8. Raw model IDs used for colors are canonicalized case-insensitively where appropriate, without losing a human-friendly label.
9. Windowed model composition comes from an explicit basis (e.g. active-job-count); do not claim this means installed weights/VRAM occupancy.
10. Do not allow renderer lifecycle to influence telemetry subscription lifecycle.

## 7. Detailed visual/animation specification

### 7.1 The atom

- Nucleus is a cluster of non-overlapping instanced spheres with rough metallic/ceramic material and soft emissive rim highlights; rotate as a coherent group with optional minor independent axial motion.
- Orbitals are 2–3 tilted elliptical translucent paths with a volumetric-looking _shader/sprite approximation_ of electron probability clouds, not thousands of independent transparent meshes.
- Small luminous electron particles move on predefined deterministic orbital paths; enhance perceived motion with streak trails.
- A faint neutral outer shell indicates a known idle/healthy provider; discrete ring counts are decorative, **never implicit numerical metrics**.
- Labels stay legible and face the camera; prefer DOM overlays projected from world coordinates, with collision prioritization.

### 7.2 Model particles: three colors per atom

- Use the **top three individual model IDs by the observed composition basis** for a GPU/provider. A deterministic seeded palette/hash keyed on model ID produces the same color in every atom; reserve muted gray for all other/unknown models.
- Model percentages must sum to 1 (normalized only when basis is valid and nonzero); sort deterministically using contribution then ID.
- Each model gets both proton-colored and neutron-colored _stylized particles_ within its own color family; the two material finishes differentiate particle types while model hue stays consistent.
- Particle count allocation = largest-remainder distribution of shares across a fixed sphere budget (e.g. 16–40, LOD-dependent); never imply actual particle number means real hardware atom count.
- If model data is unknown, show an elegant neutral nucleus with `Model mix unavailable` on hover; do **not** assign three fictional models.
- Add a model legend on selection or via bottom legend; show basis and window in tooltip.

### 7.3 Electron clouds: hue per lane

| Lane              | Suggested hue                | Notes                                                 |
| ----------------- | ---------------------------- | ----------------------------------------------------- |
| Chat / completion | Cyan `#22D3EE`               | General generation                                    |
| Prefill           | Green `#34D399`              | Only distinguish when measured                        |
| Decode            | Electric blue `#60A5FA`      | Only distinguish when measured                        |
| Embeddings        | Violet `#A78BFA`             | Embedding requests                                    |
| Rerank            | Amber `#FBBF24`              | Ranking                                               |
| Vision / image    | Indigo `#818CF8`             | Multimodal input or generation; label exact operation |
| Audio             | Teal `#2DD4BF`               | TTS/STT                                               |
| System            | Lime `#A3E635`               | Internal tasks                                        |
| Unknown           | Desaturated silver `#94A3B8` | No claim about lane                                   |

- Dominant observed lane controls main cloud hue. If two lanes have meaningful share, add a second distinct shell/arc; if three or more, add a third faint accent rather than averaging to muddy gray.
- Hue transitions must interpolate over ~0.3–0.7 s; use threshold/hysteresis so a fast alternating stream does not strobe.
- Failure red is an **event overlay**, never a permanent replacement for the true lane hue.

### 7.4 Discharges and transitions

- A health link is an always-visible slender line: healthy dim green, idle unknown muted, unhealthy red outline, last-used amber recency marker. Preserve precedence semantics from existing `edgeStyles` while recognizing health and traffic are separate.
- Active request start: launch one bright packet/pulse from hub along the confirmed route link toward the correct target, with a brief local nucleus→electron glint.
- Streaming: continuous lower-intensity filament with occasional data packet motion, bounded by particle pool limits.
- Completion: one teal/green confirmation discharge, decaying smoothly within ~600–1100 ms.
- Failure: sharp red/white arc, red flash on target and link, transient fracture sparks, return to normal within ~650–1200 ms; persistent provider unhealthy state remains visible independent of burst.
- Multiple concurrent jobs are coalesced into intensity/count, not an unbounded number of discharges.
- Failure events must be replay-proof: if a polling response shows the same failed job 10 times, trigger **one** flash.
- No raw prompts or secrets in particle/tooltip data.

### 7.5 Spin = throughput

- Only use **measured completed output-token rate**, preferably rolling 5 s with optional 1 s smoothing; document sampling and source.
- Derive normalized speed with a stable, configurable reference range (or calibrated hardware baseline), not a per-frame changing auto scale:

```ts
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const r = clamp01(Math.log1p(Math.max(0, outputTPS)) / Math.log1p(referenceTPS));
const targetRadiansPerSecond = 0.1 + 1.65 * r;
// target is eased over time; camera FPS must not affect actual angular speed.
```

- For **measured 0**, spin at decorative idle baseline 0.10 rad/s (UI must label observed 0).
- For **unavailable rate**, use neutral slow motion and label `TPS unavailable`; never encode request count as TPS.
- Ease rate changes over 250–600 ms; integrate motion using delta seconds with a clamp to avoid jumps on tab reactivation.
- The legend must explicitly identify `output tok/s`, never simply `tokens`.

### 7.6 Vibration = queued jobs

- A queue is a request waiting for a specific GPU's scheduler resource, as reported by an actual backend queue. Do **not** infer queued state from current live active request count, request age, or high utilization.
- If real `queuedJobs=0`: absolutely no load-driven vibration.
- If positive: smooth small-amplitude nucleus vibration and 1–3 expanding pressure rings; configurable formula:

```ts
const q = Math.max(0, queuedJobs);
const amplitude = Math.min(0.035, 0.006 * Math.sqrt(q)); // world units
const frequencyHz = Math.min(9, 1.5 + 0.55 * q);
```

- Cap camera-space displacement to approximately 2 px at normal zoom; avoid harsh jitter. If queue metric is unknown, disable queue vibrations and show `Queue unavailable`.
- If a queue drains, ease back to stillness over 0.4–0.8 s.

### 7.7 Idle, disconnected, stale

- Healthy and no traffic: soft visible silhouette, low orbit speed, no active discharge.
- Disconnected/unhealthy: stable red diagnostic marker/outline; no repeated request failure flash without a new event.
- Stale telemetry (suggest: >3 sampling intervals): fade motion feedback toward neutral, preserve last known numeric reading with `stale` annotation; do not silently display it as live.
- No model and no active data: render a graceful neutral atom, not an empty black scene.

## 8. Composition and interaction

### The current Home card remains the integration point

- Maintain the existing Home grid: topology to the left, `HomeRecentRequests` to the right. The source mockups are **visual inspiration**, not authorization to replace the whole page or duplicate Recent Requests inside the renderer.
- In card header add compact controls: `2D`, `3D`, `Provider / GPU` (GPU conditional), `Fit`, `Motion`, and `Expand`. Fit controls match existing pan/zoom expectations.
- Existing card is approximately 300 px high on small screens / 420 px on larger screens. Render a legible simplified 3D composition there; fullscreen/detail mode supports the dramatic mockup treatment and expanded legends/charts.
- On smaller widths suppress secondary labels, reduce effects, and let users focus one atom.
- User-selected mode stored in browser-local preference (guard SSR); if browser rendering fails, fall back to 2D automatically.
- Clicking provider atom navigates to the existing `/dashboard/providers/${routeId ?? providerId}` logic. Clicking a GPU atom opens a meaningful detail drawer or existing device page **only if implemented**; never build a broken URL.
- Tooltip includes: name, type (Provider or GPU), exact model IDs, lane(s), state, queue, output tok/s, observation time, source/basis, and explicit unknowns.
- Orbit camera with pointer drag; wheel/pinch zoom; double-click focuses; Escape returns to overview; keyboard-accessible parallel node list lets non-pointer users navigate.
- Provide legend in light/dark themes and visible words/icons, not color alone. Honor `prefers-reduced-motion` including stable static orbitals and no flashing.

### Stable deterministic 3D layout

- Keep central router fixed at origin; provider nodes on rings with deterministic angle assignments keyed to stable IDs; avoid moving nodes on each traffic update.
- Use ring capacities and approximate ordering from current 2D layout as a starting point, with z-offsets and orbital tilt to prevent overlap.
- Re-layout only when membership changes, use stable transitions, retain selected item and camera where possible. Avoid react-key remounting the scene on routine telemetry.
- For large deployments, allow a top-level provider cluster view and focused per-provider GPU expansion instead of showing 100 overlapping atom labels.

## 9. Fleet telemetry architecture

### 9.1 Do not query every host from the browser

The Atomic UI must never fan out from the user's browser to host-local Prometheus instances,
exporters, vLLM endpoints, or GPU management APIs.

The fleet should have one **centralized query path**:

```text
GPU / Runtime Host
  ├── GPU exporter / host agent
  ├── runtime metrics (vLLM/Ollama/MLX/etc.)
  └── optional local Prometheus/agent
            │
            │ WireGuard and/or authenticated HTTPS
            ▼
Central metrics backend
  ├── Prometheus / Mimir / VictoriaMetrics-compatible
  └── and/or InfluxDB2
            │
            ├────────► Grafana dashboards
            │
            └────────► OmniRoute Fleet Telemetry Gateway
                               │
                               ▼
                      Atomic Topology Plugin
```

WireGuard is therefore transport between the **host telemetry producer and the central
collector/backend**, not a reason for the dashboard to open one connection per GPU host.

### 9.2 Pull vs push collection

Both are valid; choose based on the existing fleet.

**Central pull**

```text
central Prometheus
   ├── scrape wg-host-1:exporter
   ├── scrape wg-host-2:exporter
   └── scrape wg-host-N:exporter
```

Good when all WireGuard peers are stable and centrally reachable.

**Agent / remote-write push**

```text
host exporter -> Prometheus Agent / Alloy / compatible agent
                    │
                    └── remote_write -> central backend
```

Prefer this when host connectivity/NAT/service discovery makes central scraping cumbersome.

For InfluxDB2, the equivalent pattern is an agent such as Telegraf or another collector
sending samples to the central InfluxDB instance.

The spec does not mandate one observability product. It mandates a normalized query layer.

### 9.3 Grafana is allowed, but as a query facade

If all fleet metrics are already reachable through one Grafana instance, implement an
optional `GrafanaTelemetryProvider`.

It may query Grafana's server-side datasource query API so OmniRoute can reuse the exact
Prometheus/Influx datasources Grafana already knows about.

Rules:

- Never scrape rendered dashboards, panels, HTML, PNGs, or frontend state.
- Never ship a Grafana service-account token to the browser.
- Queries execute server-side inside OmniRoute.
- Use a least-privilege read-only Grafana service account.
- Keep PromQL/Flux/query definitions in versioned OmniRoute telemetry code, not hidden in a
  dashboard panel.
- Cache short-lived query results so each browser session does not multiply Grafana load.
- Treat Grafana as a facade. The underlying datasource remains the metric authority.

**Preference order:**

1. OmniRoute-native data for request lifecycle/routing/model/lane facts.
2. Direct centralized Prometheus/Influx query when a single backend has the metric.
3. Grafana datasource API when it materially simplifies access to heterogeneous existing
   datasources.

### 9.4 Telemetry provider interface

```ts
export type TelemetrySourceKind = "omniroute" | "prometheus" | "influxdb2" | "grafana" | "runtime";

export interface FleetTelemetryProvider {
  id: string;
  kind: TelemetrySourceKind;
  probe(signal?: AbortSignal): Promise<TelemetryProviderStatus>;
  snapshot(query: FleetTelemetryQuery, signal?: AbortSignal): Promise<FleetTelemetrySnapshot>;
}

export interface TelemetryProviderStatus {
  available: boolean;
  checkedAt: number;
  message?: string;
}

export interface FleetTelemetryQuery {
  providerIds?: string[];
  hostIds?: string[];
  gpuIds?: string[];
  windowMs: number;
}

export interface FleetTelemetrySnapshot {
  schemaVersion: 1;
  capturedAt: number;
  resources: FleetResourceObservation[];
}
```

Implement a **gateway/aggregator** that can merge multiple providers into one normalized
snapshot and annotate every field with source and sample time.

### 9.5 Canonical fleet identity

Cross-source joins require stable labels. Define canonical IDs rather than matching by
display names.

Minimum identity dimensions:

```text
host_id
runtime_id
provider_id
gpu_id / device_uuid
model_id
job_id or request_id (when privacy-safe and needed)
lane
```

Recommended GPU key:

```text
gpu:<host_id>:<device_uuid>
```

Do not use PCI index (`GPU 0`) as the only persistent identity because ordering can change.

### 9.6 Separate device metrics from inference metrics

A GPU exporter can tell us things such as:

- utilization;
- VRAM used/total;
- temperature;
- power;
- clocks;
- hardware/device identity.

It generally **cannot by itself** tell us:

- OmniRoute request lane;
- output tokens/sec for one request/model;
- scheduler queue depth;
- which logical OmniRoute provider routed the request;
- exact model-to-GPU assignment when the runtime does not expose it.

Those must come from OmniRoute and/or the inference runtime.

Therefore telemetry fusion should look like:

```text
OmniRoute lifecycle
   ├── provider/model/lane/request state
   └── route/resource attribution when available

Inference runtime metrics
   ├── output token counters/rates
   ├── scheduler running/pending jobs
   └── model/device assignment

Fleet GPU metrics
   ├── utilization
   ├── VRAM
   ├── temperature
   └── power
```

The gateway joins these only when stable IDs prove the association.

### 9.7 Required metric provenance

Every observed field must retain provenance:

```ts
export interface Observed<T> {
  value: T | null;
  source:
    | "omniroute-live"
    | "omniroute-call-log"
    | "runtime"
    | "prometheus"
    | "influxdb2"
    | "grafana"
    | "derived";
  sampledAt: number;
  windowMs?: number;
  stale?: boolean;
  basis?: string;
}
```

If Grafana proxies a Prometheus query, either use `source: "grafana"` plus
`basis: "datasource=prometheus:..."` or preserve both facade and underlying datasource in
extended metadata.

### 9.8 Query cadence and caching

- Request lifecycle events: event-driven using the existing gated live feed.
- Fleet/device telemetry: target roughly 1–2 Hz for an expanded live scene; lower cadence
  is acceptable for temperature/power.
- Do not query central metrics once per atom.
- Query one bounded fleet snapshot, cache it server-side for a short TTL, normalize once,
  and fan it out to the UI.
- Stop/pause requests when the topology card is hidden or the document is backgrounded.
- Stale data must visibly decay to neutral behavior rather than pretending it is live.

### 9.9 Security

- Grafana/Prometheus/Influx credentials remain server-side.
- Support env/secret-store configuration; never persist tokens in client settings.
- Use read-only credentials and allowlisted datasource/query targets.
- Do not expose arbitrary PromQL/Flux execution to unauthenticated browser callers.
- Bound query time ranges and result sizes.
- Do not expose raw prompts/content through telemetry labels.

### 9.10 M0 telemetry audit

The first implementation milestone must produce a matrix covering:

- which required fields already exist inside OmniRoute;
- which fields exist in runtime metrics;
- which device metrics already exist in the fleet observability stack;
- where those metrics currently live (Prometheus, InfluxDB2, Grafana datasource, other);
- canonical labels available for joining them;
- missing identity links;
- collection path over WireGuard;
- freshness and units;
- auth method.

Do not add a new metrics stack until this audit proves the current one is insufficient.

## 10. Proposed files and extension boundaries

These are conceptual targets. Follow the current checkout's conventions instead of creating
folders mechanically.

```text
src/shared/topology/
  domain/
    types.ts
    normalizeTopology.ts
    layoutIdentity.ts
  renderer/
    types.ts
    registry.ts
    BuiltinReactFlowRenderer.tsx
  telemetry/
    types.ts
    gateway.ts
    mergeSnapshots.ts
    provenance.ts
    providers/
      omniroute.ts
      prometheus.ts
      influxdb2.ts
      grafana.ts

src/plugins/atomic-topology/
  index.ts
  manifest.ts
  AtomicTopologyRenderer.tsx
  scene/
    AtomicScene.tsx
    AtomNode.tsx
    Nucleus.tsx
    ElectronCloud.tsx
    EnergyLink.tsx
  overlays/
    AtomicControls.tsx
    AtomicLegend.tsx
    AtomicLabels.tsx
    AtomicTooltip.tsx
  visualEncoding.ts
  layout.ts
  eventPool.ts
  capabilities.ts

src/app/(dashboard)/home/
  ProviderTopology.tsx          # renderer host / mode selection
  ProviderTopology2D.tsx        # extracted current implementation

src/app/api/.../
  # Add a narrow authenticated fleet-telemetry route only if existing API conventions
  # do not already provide the right place.

tests/unit/
  # topology domain, provider adapters, gateway merge/provenance, visual encodings

tests/...browser/e2e...
  # follow verified repository conventions
```

### Plugin loading

Atomic must be loaded through the renderer registry and dynamic client import. It must not
be statically pulled into the baseline server/home bundle.

A conceptual registration:

```ts
registerTopologyRenderer({
  id: "atomic",
  label: "Atomic",
  load: () => import("@/plugins/atomic-topology"),
  capability: "webgl2",
});
```

If the codebase has no generic plugin system, this registry **is the feature-scoped plugin
boundary**. Do not expand scope into designing an application-wide plugin platform.

## 11. Milestones and executable task ledger

Each milestone has a gate. Parallel read-only investigation is encouraged. Avoid concurrent
writes to the same integration files.

### M0 — Audit current topology and fleet observability [BLOCKING]

- [ ] Inspect current OmniRoute checkout, tests, instructions and package versions.
- [ ] Audit `ProviderTopology`, `HomeProviderTopologySection`, live-request events,
      provider metrics and call logs.
- [ ] Audit the actual fleet observability path: host exporters/agents, WireGuard reachability,
      Prometheus-compatible storage, InfluxDB2, Grafana datasources and runtime metrics.
- [ ] Record stable host/GPU/runtime/model IDs and label compatibility.
- [ ] Produce `docs/specs/atomic-topology-telemetry-matrix.md`.
- [ ] Decide whether OmniRoute should query the underlying metrics backend directly or use
      Grafana as the central query facade for each metric family.
- [ ] Do not deploy new telemetry software unless the audit identifies a concrete gap.

**Gate:** every desired visual metric has a real source, a planned source, or explicit
`unavailable` behavior; no fabricated telemetry.

### M1 — Topology renderer plugin boundary [BLOCKING]

- [ ] Extract the current ReactFlow implementation into the built-in 2D renderer.
- [ ] Create renderer-neutral `TopologySceneSnapshot` domain types.
- [ ] Create the topology renderer registry/contract.
- [ ] Convert `ProviderTopology.tsx` into the renderer host with mode selection/fallback.
- [ ] Preserve current navigation, aliases, health/traffic precedence and empty state.
- [ ] Add dynamic client loading and failure isolation.

**Gate:** existing 2D behavior is unchanged; no Atomic dependency is required for 2D.

### M2 — Fleet Telemetry Gateway [BLOCKING FOR REAL GPU MODE]

- [ ] Implement common provider interface and normalized observations/provenance.
- [ ] Implement OmniRoute-native adapter first.
- [ ] Implement only the external adapters justified by M0:
      Prometheus, InfluxDB2 and/or Grafana datasource-query facade.
- [ ] Keep all observability credentials server-side.
- [ ] Implement bounded server-side caching, timeout, cancellation, stale handling and
      query result validation.
- [ ] Join resources only using stable canonical IDs.
- [ ] Add provider/gateway unit tests with fixtures; no live infrastructure dependency in CI.

**Gate:** a single normalized snapshot can represent device + runtime + OmniRoute facts
without browser-to-host fan-out.

### M3 — Static Atomic renderer plugin [BLOCKING]

- [ ] Add compatible Three.js/R3F dependencies only after current package audit.
- [ ] Draw central OmniRoute hub and current provider atoms.
- [ ] Implement deterministic stable ring/3D placement.
- [ ] Implement nucleus, orbitals/clouds, labels, hover, focus, zoom/orbit and navigation.
- [ ] Implement reduced-motion and unsupported-GPU fallback.
- [ ] Keep model/TPS/queue visuals neutral when observations are absent.

**Gate:** Atomic mode is optional, beautiful and functional with provider-only data.

### M4 — Real request activity and discharges [BLOCKING]

- [ ] Reuse the existing gated live-request subscription; do not open another.
- [ ] Map known lanes to electron-cloud hue.
- [ ] Implement bounded start/stream/complete/fail visual event pool.
- [ ] Flash new failures red once; maintain persistent health separately.
- [ ] Preserve active/recent/healthy/error semantics.
- [ ] Test out-of-order events, reconnects, toggles and expiry.

**Gate:** live OmniRoute activity changes the scene correctly without duplicate subscriptions.

### M5 — Fleet GPU atoms and measured motion [CONDITIONAL ON REAL DATA]

- [ ] Render one atom per canonically identified physical GPU when inventory is available.
- [ ] Associate provider/runtime/model edges only where attribution is proven.
- [ ] Map measured output tok/s to spin.
- [ ] Map runtime scheduler pending jobs to vibration.
- [ ] Map observed model shares to nucleus particle colors.
- [ ] Add utilization/VRAM/temp/power details where fleet telemetry supplies them.
- [ ] Mark missing/stale metrics explicitly.
- [ ] Support provider-only mode when GPU attribution is incomplete.

**Gate:** no phantom devices, no model-to-GPU guesses, no token-rate inference from token
counts alone.

### M6 — Performance, hardening and release [RELEASE]

- [ ] Instancing/LOD/effect caps, hidden-tab pause, disposal and context-loss recovery.
- [ ] Server-side telemetry query caching and browser request coalescing.
- [ ] Quality profiles for discrete/integrated/mobile GPUs.
- [ ] i18n, theme, keyboard access, high-contrast labels and reduced motion.
- [ ] Benchmark scene and telemetry gateway independently.
- [ ] Document external telemetry configuration, including Grafana facade and direct
      Prometheus/Influx options.
- [ ] Keep the 2D renderer as a zero-external-telemetry rollback path.

**Gate:** release acceptance, browser matrix, tests, performance budgets and rollback all pass.

## 12. Performance and compatibility acceptance

Performance targets are **release targets, to measure**, not preexisting benchmark results:

- Desktop discrete GPU: >=55 FPS median with 25 provider atoms, 2 orbitals each, up to 40 simultaneous active job indications, at 1080p dashboard width.
- Typical integrated GPU: >=30 FPS median in balanced/low profile with 20 atoms.
- Scene state processing <=3 ms p95 on the main thread per telemetry update (excluding network/renderer), verified by profiler.
- Main Home page must not ship or initialize the 3D renderer when the section is hidden or 2D mode is selected.
- Prefer instancing and shaders; cap per-atom particles, animated arc segments and total bloom passes. Avoid expensive transparent sphere stacks.
- React render frequency not tied to RAF; use imperative R3F frame updates for transforms and a low-frequency snapshot store for telemetry.
- Pause RAF or use frameloop demand mode when offscreen/hidden as appropriate; stop GPU effects when document hidden; release geometries/materials/buffers on unmount.
- Zoom, resize and data refresh cannot thrash mount/unmount or refit every tick.
- Browser matrix: Chrome/Edge and Firefox with WebGL2; Safari/macOS; unsupported/headless and WebGL context-loss path; mobile low quality. WebGPU is progressive, not required to ship.
- No 3D import must crash Next.js server rendering, CLI/backend builds, Electron, tests, or SSR.

### Automated test matrix

- Pure tests: state priority, stable IDs, alias matching, layout determinism, same-model stable colors, top-3 weights, missing data, stale data, normalized spin curve, queue mapping, bounded vibration, event dedupe and TTL.
- Component tests: 2D/3D preference, lazy import, empty scene, navigation, tooltip accuracy, locale, reduced motion, no measured metrics fallback.
- Integration tests: lifecycle state start→complete and start→fail, last-used preserving health, multiple providers with aliases, virtual GPU resource mapping, missing/unknown `resourceId`.
- Contract tests: endpoint auth, schema validation, no sensitive payload data, 0 distinct from missing, request token counts distinct from tok/s.
- Browser tests: canvas initialization, interactive camera, keyboard list, reduced motion, fallback on unsupported GPU/context loss; deterministic screenshot comparisons (disable animation or fix time seed).
- Leak tests: repeated Home navigation, mode toggles, reconnects and tab-visibility cycles do not accumulate subscriptions, timers or GPU resources.
- Regression: existing 2D graph, other `FlowCanvas` consumers, Home recent-requests filtering and polling.

Run repo-supported narrow tests first (the baseline package includes `npm run test:scoped`, `npm run lint`, and Node test scripts), then the appropriate build/typecheck/CI checks confirmed in the actual checkout. Do not report checks as passed unless executed. Record exact commands and results in completion note.

## 13. Failure and rollback behavior

- If WebGL2/WebGPU init fails: log safe diagnostic detail, show a non-blocking `3D unavailable` notice, auto-switch to functional 2D; user can retry later.
- If telemetry stops: retain topology and accessible labels, mark last metrics stale; tone down performance-derived animations, do not fail the whole view.
- If event payload changes: schema validation drops invalid events and keeps graph functional.
- If live socket is disabled by Home appearance setting: no rendering loop, socket subscription or telemetry polling should remain active for this feature.
- Use a user-facing 2D/3D preference and optionally a rollout feature flag to permit rollback without removing code.

## 14. Release acceptance checklist

- [ ] 2D view is unchanged in data semantics/navigation and other shared flow canvases still work.
- [ ] 3D scene visible, aesthetically consistent with approved atomic dashboard mockups and responsive in embedded card/fullscreen.
- [ ] Physical GPU atom mode makes no fabricated GPU attribution claims.
- [ ] Distinct model-colored nucleus particles represent up to three _real model IDs_, not randomly invented families.
- [ ] Lane cloud hue is tied to actual observed/derivable lane, unknown is neutral.
- [ ] Live transitions illuminate actual routes; failure is an unmistakable **brief red discharge** that does not repeat for the same event.
- [ ] Spinning nucleus has deterministic monotonic dependence on **measured output tok/s** or clearly indicates rate unavailable.
- [ ] Queue vibration reflects **actual queued GPU jobs** or explicitly indicates queue unavailable.
- [ ] Hover/click/focus, camera controls, labels, accessible alternative, locale and reduced motion are operational.
- [ ] 2D fallback works without WebGL and after context loss; lazy load and visibility gating prevent unnecessary GPU/socket activity.
- [ ] No regressions in Home Recent Requests filtering, provider health and last-used indication, aliases, provider routing or other `FlowCanvas` consumers.
- [ ] Benchmarks, tests, build checks and documented remaining instrumentation gaps are attached to implementation report.

## 15. Deliverables the agent must leave in the repository

1. Working feature in source, with tests and any exact dependencies/lockfile changes.
2. `docs/specs/atomic-topology-telemetry-matrix.md` documenting OmniRoute/runtime/fleet sources, Grafana-vs-direct query choice, IDs, units and unavailable data.
3. `docs/specs/atomic-topology-implementation-report.md` containing milestone states, touched files, tests and real benchmark measurements.
4. Short user documentation covering controls, legend, modes, fallback and known data gaps.
5. A final concise execution summary: **implemented / tested / blocked / deferred** with no invented pass claims.

## 16. Execution prompt for Roo/Zoo/Menagerie

> **Implement OR-ATOM-001 v2 from this Markdown spec against my existing OmniRoute
> checkout. Atomic Topology is a renderer plugin, not a monolithic rewrite of
> `ProviderTopology.tsx`. First complete M0 by auditing both OmniRoute telemetry and my
> existing fleet observability stack. Do not assume new Prometheus/Influx/Grafana
> infrastructure is necessary if equivalent metrics already exist. If Grafana already
> centralizes heterogeneous datasources, a server-side Grafana datasource-query adapter is
> acceptable; do not scrape dashboards and never expose observability credentials to the
> browser. Build the renderer registry and retain ReactFlow as the built-in 2D fallback.
> Implement a normalized fleet telemetry gateway with provenance and stable host/GPU IDs,
> then implement Atomic as a lazy-loaded plugin. Use real runtime queue and output-token
> measurements for vibration/spin, and real GPU inventory for GPU atoms. Unknown remains
> unknown. Preserve current subscription gating, routes, health semantics and Recent
> Requests behavior. Work autonomously through all feasible milestones, use parallel
> read-only workers where useful, run scoped tests/builds, and finish with exact
> verification evidence.**

### Reference links

- Provider topology at the pinned commit: https://github.com/celesrenata/OmniRoute/blob/c02725a418fab4ac23b479deb6550f83355e8a36/src/app/%28dashboard%29/home/ProviderTopology.tsx
- Home section owner: https://github.com/celesrenata/OmniRoute/blob/c02725a418fab4ac23b479deb6550f83355e8a36/src/app/%28dashboard%29/dashboard/HomeProviderTopologySection.tsx
- Home parent: https://github.com/celesrenata/OmniRoute/blob/c02725a418fab4ac23b479deb6550f83355e8a36/src/app/%28dashboard%29/dashboard/HomePageClient.tsx
- Existing request panel: https://github.com/celesrenata/OmniRoute/blob/c02725a418fab4ac23b479deb6550f83355e8a36/src/app/%28dashboard%29/home/HomeRecentRequests.tsx
- Shared FlowCanvas: https://github.com/celesrenata/OmniRoute/blob/c02725a418fab4ac23b479deb6550f83355e8a36/src/shared/components/flow/FlowCanvas.tsx

**Visual reference:** The four approved concept renderings generated earlier in the conversation establish visual direction. They illustrate desired appearance, **not** source-of-truth telemetry values or real deployment hardware.
