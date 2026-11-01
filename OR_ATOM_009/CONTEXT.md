# OR-ATOM-009 — Live GPU Signal Choreography & Verified Attribution

**Target:** `celesrenata/OmniRoute` Atomic Topology renderer plugin  
**Agent:** Menagerie / Zoo / Roo  
**Scope:** Take the Step 8 visual effects and make them express _actual_ jobs, models, GPU throughput, and queues.  
**Priority:** Truthful, visible telemetry-driven behavior. No redesign.  
**Repo inspection:** Public `release/v3.8.52` at `7ad29c0c9b` includes Step 7 (`a2ba49d059`); the local worktree may already contain completed Step 8 not yet pushed. **Always inspect actual local worktree, branch, and dirty changes before editing.**

## Mission

The visual work from Steps 7 and 8 has given OmniRoute electrons, glow, nucleus particles, and (if Step 8 landed locally) more realistic plasma link effects. But the remaining major gap to the original vision is a **truthful, connected live inference simulation**. Right now, GPU/runtime atoms are primarily telemetry decorations alongside provider atoms. The operator should see which model is running on which GPU, what lane its jobs are in, how fast it is decoding, whether jobs are queued, and how each observed request travels through the proven provider → runtime → GPU chain.

**This task is NOT another camera/layout/label pass.** The last detailed screenshot was an intentionally zoomed observation, not a broken viewport.

### Hard freeze (do not change)

Camera, orbit/zoom/pan behavior, framing, `layout.ts`, `cameraFit.ts`, `SceneOrbitControls.tsx`, topology node positions, name labels, collision/projection, UI controls, existing Step 8 filaments/clouds/glows and 2D ReactFlow fallback. Do not replace the plugin framework, invent metric values, install a new metrics stack, or launch a general UI redesign. If Step 8 has not landed, do not skip it or reimplement it under Step 9; report its status and work on independent Step 9 bindings.

## 0. Source audit — known gaps to verify in local code

The following are observations of the **published** release, not assumptions about the user’s newer local checkout:

- `src/plugins/atomic-topology/AtomicTopologyRenderer.tsx`, `resolveAtomDescriptors`: GPU/runtime descriptors currently set `lane: "unknown"` / `laneHue("unknown")`, even when a proven upstream provider has an observed job lane. GPU `modelColors` are empty; runtime gets a single `modelId` color. Device `visualState` is always idle/unknown.
- `resolveLinkDescriptors` renders `snapshot.links`, which are predominantly hub → provider; `ReconciliationResult.edges` contains separately typed provenance-carrying relationships but is not turned into renderer links. Device atoms often show no actual request path.
- `src/shared/topology/telemetry/reconcile.ts` defines `provider_runtime`, `runtime_device`, `runtime_model` edges. It emits runtime→GPU only for _explicit device attribution_, and leaves unproven provider→runtime edges absent. **Preserve this strict rule.**
- `src/plugins/atomic-topology/scene/AtomNode.tsx`: the live `useFrame` principally updates vibration, breathing and discharges; `ElectronCloud` receives `descriptor.spin.value`, so measured TPS visibly affects electron orbit, but the non-hub proton/neutron _nucleus cluster_ does not yet clearly rotate independently. `Nucleus.tsx` hub spin is separate.
- `src/plugins/atomic-topology/visualEncoding.ts`: `spinRadiansPerSecond` and `queueVibration` already distinguish `measured`, `measured-zero` and `unavailable`. Retain provenance and quiet/unknown semantics. Current queue amplitude (`≤0.035` world units vs ~22-unit atom radius) may be visually imperceptible; verify on screen, do not blindly change mapping.
- `src/plugins/atomic-topology/overlays/AtomicTooltip.tsx`: already exposes important measurements. Extend narrowly only if necessary for attribution/source visibility; avoid label redesign.
- The published release includes Step 7 electrons and glow but not a verifiable Step 8 commit at inspection time. **Do not overwrite local Step 8 progress.**

## 1. Required Skill Hub workflow — before coding

Use the **live OmniRoute Skill Hub MCP** in the working environment. Do not invent skill IDs or claim every one of the user's ~910 installed skills was inspected.

Verified OmniRoute MCP tools:

- `omr_skill_list` — browse domains/skills and get catalog summary.
- `omr_skill_search` — targeted lexical searches with `limit <= 20`.
- `omr_skill_get` — load complete SKILL.md by exact returned ID.
- `omr_catalog_search` / `omr_catalog_load` / `omr_catalog_resource` — alternate discovery, instructions, reference assets.
- `omr_catalog_refresh` — only if permitted and newly imported skills are missing.

The service code is in `open-sse/mcp-server/tools/skillDiscoveryTools.ts`. REST mirror: authenticated `/api/skills/catalog`. MCP streamable HTTP: `/api/mcp/stream` only when enabled/configured. Keep tokens entirely server-side/in secret env; do not print, save or commit keys. Imported instruction skills are not executable by default; **read and apply** them rather than invoking `execute`.

Delegate independent search tracks:

1. `time-series smoothing motion design visual encoding real-time telemetry`.
2. `three.js react three fiber instancing animation useFrame performance`.
3. `graph edge flow traveling particles plasma shader multi-hop animation`.
4. `model attribution provenance data visualization interactive graph`.
5. `webgl context lost restore disposal resource leak profiling`.
6. `playwright browser video screenshot regression performance tracing`.

Choose 4–8 _actually available_ complementary skills; load full SKILL.md plus needed resources; record exact IDs/revisions, relevance, assigned worker, applied technique, changed paths and proof in `SKILL_AUDIT.md` and `SKILL_APPLICATION_REPORT.md`. If blocked, report exact cause and continue using local engineering knowledge. Do not stall forever on discovery.

## 2. S9.1 — Proven topology provenance / GPU-work attribution [P0]

Build a small **pure tested adapter** from existing `TopologySceneSnapshot` + `ReconciliationResult` + observed request lifecycle to the visualization bindings. Reuse existing telemetry; do not introduce additional polling or an alternative data model.

- Stable canonical identities: provider ID, `runtime:<host>:<runtime_id>`, `gpu:<host>:<device_uuid>`, and model ID. Never match UUID-prefixed display text, model strings, PCI `GPU 0`, or host nicknames as identity.
- A provider→runtime or runtime→GPU visual relationship may exist **only when evidence in normalized telemetry explicitly establishes it**. Honor `ReconciliationEdge.basis`/`sampledAt`. If no provider→runtime proof exists, keep the runtime visually unattached rather than drawing an invented link.
- Preserve one-to-many and many-to-many topology. Never split a runtime's aggregate TPS evenly across multiple GPUs. GPU TPS requires a device-specific measurement or unambiguous single-GPU attribution supported by the source contract.
- Do not duplicate queue values on several GPUs when a single runtime has multiple possible devices.
- Reconcile real model IDs per attributed runtime→GPU. A GPU may show up to three observed resident/active model colors. Colors represent **known model identities**, not fabricated fractional utilization. If no reliable weights, show equal visibility without suggesting equal load.
- Stale and unobserved fields remain neutral/unavailable. Measured zero is real zero.

Deliver `docs/specs/atomic-topology-step9-attribution-matrix.md` with each GPU and runtime's observed source, IDs, model/lane/TPS/queue associations and missing joins. If live network cannot be accessed, supply tests with deterministic fixtures and mark live verification pending.

## 3. S9.2 — Make _each actual nucleus_ rotate with measured TPS [P0]

The original requirement is nucleus motion, not just electron speed.

- Keep existing orbitals and cloud mechanics. Drive the **proton/neutron cluster** of each GPU/runtime atom from observed `outputTokensPerSecond` via the existing `spinRadiansPerSecond` encoding; do not use request counts, utilization, or fake values.
- Maintain a separate, slower ambient electron orbital motion when data is absent; ensure idle decoration never claims measured decoding.
- Smooth between sampled speeds using frame-rate-independent easing to avoid abrupt 3.5-second poll jerks. Avoid angular phase resets on snapshot updates, pause, focus, or remount.
- On measured zero, slow appropriately; on unavailable/stale show neutral non-indicative rotation. Make status visible in tooltip/diagnostics.
- Use `useFrame` and refs / instanced group rotation. No per-frame React state, unnecessary material allocation or geometry rebuild.

Acceptance: test fixture 0 → 20 → 80 tok/s → 0 → stale makes _the nucleus_ accelerate and decelerate smoothly, while the electron cloud remains a separate visual layer. Prove both visually (short video) and with pure easing tests.

## 4. S9.3 — GPU-specific queue vibration and model colors [P1]

- `runtime.queuedJobs` drives its runtime atom. A GPU atom vibrates only if its own scheduler queue is genuinely observed or an explicitly attributable single-GPU runtime queue is safely associated, without double counting. Otherwise mark queue unavailable for that GPU.
- Evaluate perceptibility at normal and operator-zoomed scales. If the current 0.035-world-unit cap is imperceptible, adjust **only the local vibration visual mapping**, not topology positions/layout; clamp to a restrained, non-nauseating shake around a fixed base transform.
- Keep `prefers-reduced-motion` fully static. Paused scene must genuinely freeze; resume must not jump.
- Show 1–3 distinct observed model colors within a GPU nucleus (derived from proven runtime residency/active requests). Neutral palette when no model attribution. Do not recolor the entire atom red for a past request failure.

## 5. S9.4 — Live lane color and end-to-end event choreography [P1]

- Propagate job lane color from an observed live request to a runtime/GPU **only along a proven attribution path**. No inference of lane from model name or provider category unless that is an explicit pre-existing, tested domain mapping with traceable source.
- Multi-lane workloads: retain separate lane signals if supported by the source; otherwise show the dominant _observed_ lane with provenance, no guesswork. The electron cloud should change hue smoothly as a real job changes.
- Reuse the existing lifecycle event pool. Route bounded pulses along the already-established link path: OmniRoute hub → provider → runtime → GPU **only for links that exist**; otherwise animate through the proven segment(s) and leave unknown edges unconnected.
- Keep Step 8's thin plasma style, completion impulse, brief red failure discharge; do not regress to thick pipes. Deduplicate repeated polling/lifecycle events; cap concurrent pulses.
- Request errors stay event-level, not persistent GPU/provider health changes.

## 6. S9.5 — Minimal operator evidence and diagnostic harness [P1]

Do not build a new dashboard or change permanent labels. Make _existing tooltip_ or an opt-in debug overlay explain what the atom means:

- Canonical GPU/runtime identity, attributed providers/models, current observed lane.
- Measured TPS and queue depth with source and sample age; distinguish measured zero vs unavailable vs stale.
- Whether the visible link is a proven relation and its basis.
- A clearly labeled **synthetic demo/test mode** (dev/test only, off in production) that injects deterministic 2–3 lane jobs, 0/20/80 TPS, queue spikes, success/failure and stale transitions through the same scene adapter without contaminating real API data.

No new telemetry source, uncontrolled user input queries, client-side secrets, or broad UI refactor.

## 7. S9.6 — Browser truth test and performance gate [REQUIRED]

Run against the actual local dashboard/approved test deployment. Baseline first, then after:

- 0, 1, 3 and 10 concurrent jobs, including mixed lanes, one failure, and a queued scenario.
- Device verification for known telemetry-capable machines where accessible (e.g. RTX 5090, RTX 4070 Ti SUPER, M5 Max). Report real vs simulated. Do not claim connection when source unreachable.
- 8 / 16 / 32 atom seeded fixtures while keeping normal scene layout/camera rules unchanged.
- Default and intentionally zoomed camera states; no judgment that deliberate zoom clipping is a layout defect.
- Pause, resume, reset, 2D/Atomic, reduced motion, tab hide/show, WebGL context loss/restore, 20-minute telemetry soak.
- Measure or clearly mark unavailable: FPS p50/p95, `renderer.info.render.calls`, geometries/textures, console errors and context-loss count. Check no persistent growth over successive telemetry updates and remounts.
- Scoped unit tests, TypeScript, lint and build per current repo instructions. Validate WebGL appearance with screenshot/video; passing unit tests alone is insufficient.

### Acceptance checklist

- [ ] New implementation preserves Step 8 graphics and the existing camera/layout/labels.
- [ ] Proven GPU/runtime/model relationships; unknown relations are visibly not fabricated.
- [ ] Real per-GPU/per-runtime nucleus rotation responds to measured TPS, not request counts.
- [ ] Runtime queue or unambiguously GPU-attributed queue causes perceptible bounded vibration; unavailable queue does not.
- [ ] GPU nucleus has up to three **observed** model colors, with no fabricated attribution.
- [ ] Clouds change lane hue when a real attributed job is active, neutral otherwise.
- [ ] Start/completion/failure pulses propagate through proven provider→runtime→GPU path(s), never fictional connections.
- [ ] Stale/zero/unavailable semantics are correct in renderer and diagnostics.
- [ ] No new subscription, telemetry fan-out or metric stack.
- [ ] Screenshot/video evidence and measured long-running stability/performance are provided.
- [ ] Skill Hub selection and application reports list actual loaded IDs and changed files.

## Execution: parallel but isolated

- **Reader A:** data joins / attribution gaps / schema and source labels (read-only).
- **Reader B:** TPS/nucleus rotation and frame loops (read-only).
- **Reader C:** job lane + event path / plasma pooling (read-only).
- **Reader D:** Skill Hub specialist search and full instruction selection (read-only).
- **Reader E:** testing, actual browser harness, benchmark plan (read-only).

Then delegate nonoverlapping implementation file ownership: adapter/tests, nucleus motion, lane/event mapping, browser harness. Integrator handles shared renderer + gateway code. Do not allow independent agents to race on `AtomicTopologyRenderer.tsx`.

## Required completion report

1. Exact branch and commit(s); local uncommitted diff status.
2. Selected **real** Skill Hub IDs/revisions and skill→technique→file/test mapping.
3. Attributed host/runtime/GPU/model/lane matrix (redact credentials and private secrets).
4. Before/after screenshots and short videos showing real vs demo modes.
5. Live observed TPS/queue and frame/memory benchmarks; explicitly label unavailable evidence.
6. Test/lint/typecheck/build and 20-minute-soak results.
7. What is still missing, especially unproven provider→runtime edges and per-device TPS.

**Do not claim completion based only on code or mocked demo.** If external fleet access is unavailable, complete the local tested work and clearly report the unfinished live validation rather than asserting it passed.
