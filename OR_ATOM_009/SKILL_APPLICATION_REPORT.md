# OR-ATOM-009 — Skill Application Report (Step 9)

Per-substep: which selected skills (ID + revision) applied, the specific instructions followed
(cited to the verbatim copy under `OR_ATOM_009/research/skills/<id>/`), the implementation
anchor, and the verification evidence. Skill IDs are the exact frontmatter `name` values from the
selected local-corpus files — see `OR_ATOM_009/research/skill-discovery.md` §2/§3. The live
hub/corpus server was **down** (6-probe table, `skill-discovery.md` lines 19–41), so all content
came from the local `skills-import/*.zip` corpus; no live inventory count is claimed.

Selected skills (9): `webgpu-threejs-tsl` (no version field), `performance` 2.0,
`core-web-vitals` 2.0, `accessibility` 2.0, `accessibility-compliance` (no version field),
`web-quality-audit` 2.0, `visual-design-foundations` (no version field),
`interaction-design` (no version field), `game-developer` 1.1.0.

## S9.1 — Attribution binding (proven provider → runtime → GPU; color = attribution)

- `visual-design-foundations` (`references/color-systems.md` + design-token discipline,
  `OR_ATOM_009/research/skills/visual-design-foundations/SKILL.md`): ≤3 observed model colors
  come from a small token-derived palette; unknown/stale → neutral, never invented hues
  (`OR_ATOM_009/research/skill-discovery.md` §4.1).
- `accessibility` / `accessibility-compliance` (`references/wcag-guidelines.md`,
  `references/aria-patterns.md`): state names distinguishable, no color-only meaning,
  neutral vs measured-zero vs unavailable wording (§4.1).
- Implementation: link rows carry `proven: provenLinkIds.has(link.id)` —
  [`src/plugins/atomic-topology/AtomicTopologyRenderer.tsx:656`](src/plugins/atomic-topology/AtomicTopologyRenderer.tsx:656)
  (field declared at line 301); neutral palette for unknown/stale rows.
- Evidence: `OR_ATOM_009/screenshots/gap2Smoke.json` — `linkRows[0].proven === true`
  (`route:demo-provider`, "PROVEN · call-log route · sampled 0s ago"); unknown route
  `route:definitely-not-a-provider` → trigger reason `unproven`; screenshot
  `OR_ATOM_009/screenshots/step9-final/gap2/diag-page.png`.

## S9.2 — Nucleus TPS motion (measured tokens/sec drives spin)

- `webgpu-threejs-tsl` (`examples/particle-system.js`, `templates/compute-shader.js`,
  `examples/post-processing.js`): frame-rate-independent delta (`Math.min(delta, 0.1)` clamp)
  so poll jitter never causes an angular jump; motion as ref-driven instanced transforms,
  no per-frame React state (`skill-discovery.md` §4.2).
- `game-developer` (`references/performance-optimization.md`): preallocated state, no per-frame
  allocation (§4.2).
- Implementation:
  - `NUCLEUS_SMOOTH_TAU_SECONDS = 1.0` —
    [`src/plugins/atomic-topology/scene/nucleusMotion.ts:43`](src/plugins/atomic-topology/scene/nucleusMotion.ts:43);
  - `createRotationSmoothing()` — `nucleusMotion.ts:78` (dt-scaled EMA `alpha = 1 - exp(-dt / tau)`
    at `nucleusMotion.ts:99-100`; frame-rate independence: "two small steps" converge to the same
    value as one large step — `nucleusMotion.ts:65-68`);
  - `tpsToRadiansPerSecond()` — `nucleusMotion.ts:146` (saturation at 2000 TPS,
    `nucleusMotion.ts:125`);
  - per-atom stable smoother ref, fresh sample adopts / gap decays toward 0 —
    [`src/plugins/atomic-topology/scene/AtomNode.tsx:272-306`](src/plugins/atomic-topology/scene/AtomNode.tsx:272);
  - stale spin decays to frozen (stale = unknown, not a fake speed).
- Evidence: unit suite `tests/unit/atomic-topology/` (394 tests, 393 pass / 0 fail / 1 skipped,
  re-run 2026-10-29); live spin across all 9 scenarios
  (`OR_ATOM_009/screenshots/captureScenarios.json`, 42–57 fps SwiftShader, 0 page errors).

## S9.3 — Queue vibration (perceptible, bounded, attributable)

- `game-developer` (`references/performance-optimization.md`): bounded, deterministic
  per-frame transforms around a fixed base transform — clamp to a restrained shake
  (`skill-discovery.md` §4.3).
- `interaction-design` (`references/microinteraction-patterns.md`): feedback only for a real
  attributable state change; `prefers-reduced-motion` → static (§4.3).
- `accessibility` / `accessibility-compliance` (`references/WCAG.md`,
  `references/wcag-guidelines.md`): fully static under reduce; resume must not jump (§4.3).
- Implementation: `QUEUE_VIBRATION_MAX_AMPLITUDE = 0.03` —
  [`src/plugins/atomic-topology/scene/nucleusMotion.ts:161`](src/plugins/atomic-topology/scene/nucleusMotion.ts:161);
  reduced-motion → static scene (paused path holds state; see `AtomNode.tsx:272` comment).
- Evidence: `OR_ATOM_009/scripts/fixtures/queued-jobs.json` — runtime queue value **7**
  (source `runtime`, `stale: false`, basis "demo: measured 7 queued jobs"); zero-queue rows
  carry measured-zero. Live: `OR_ATOM_009/screenshots/capture-queued-jobs.png`
  (badge available, canvas 1/1, 0 page errors, served=4).

## S9.4 — Event flow choreography (pulses along _proven_ links only)

- `webgpu-threejs-tsl` traveling-emission/particle instructions composed with `interaction-design`
  timing tables (§4.4; "multi-hop graph/energy-link choreography" has no single corpus skill —
  explicit NO-SKILL-COVERED in `skill-discovery.md` §5).
- `visual-design-foundations` (`references/color-systems.md`): smooth hue shift on lane change,
  dominant observed lane with provenance, no name-based inference (§4.4).
- Implementation:
  - `DEFAULT_PULSE_CAP = 3`, `DEFAULT_DEDUPE_WINDOW_MS = 150`, `DEFAULT_PULSE_LIFETIME_MS = 2500` —
    [`src/plugins/atomic-topology/scene/provenPulse.ts:47`](src/plugins/atomic-topology/scene/provenPulse.ts:47),
    `provenPulse.ts:53`, `provenPulse.ts:59`;
  - `PULSE_PERIOD_S = 2.5`, `MAX_PACKET_POOL`-bounded preallocated packet pool —
    [`src/plugins/atomic-topology/scene/EnergyLink.tsx:110`](src/plugins/atomic-topology/scene/EnergyLink.tsx:110),
    `EnergyLink.tsx:252-262`, pool gated on `isActive && descriptor.proven, reduced`
    (`EnergyLink.tsx:425`);
  - proven-only: `proven: provenLinkIds.has(link.id)` (`AtomicTopologyRenderer.tsx:656`).
- Evidence: `OR_ATOM_009/screenshots/pulse-mixed-lanes.png` (+ full-page) — pulses on proven
  links; `pulse-unknown-stale.png` — no pulses for the unproven/stale link.

## S9.5 — Demo harness (synthetic demo/test mode + diagnostics)

- `accessibility` / `accessibility-compliance` (`references/aria-patterns.md`): overlay/tooltip
  states textually distinguishable (measured / measured-zero / unavailable / stale) and labeled
  "synthetic demo mode (dev/test only, off in production)" (§4.5).
- `visual-design-foundations`: demo lane/model colors from the same design tokens (§4.5).
- `web-quality-audit` (2.0): read-only rendered-verification QA — screenshot + HTML analysis of
  each capture (§4.5/§4.6).
- Implementation:
  - in-page `window.fetch` wrapper (default fetcher is bare `fetch(url, { signal })`) —
    [`src/plugins/atomic-topology/dev/demoController.ts:17-22`](src/plugins/atomic-topology/dev/demoController.ts:17);
  - diagnostics panel row states —
    [`src/plugins/atomic-topology/overlays/AtomicTelemetryDiagnostics.tsx:192`](src/plugins/atomic-topology/overlays/AtomicTelemetryDiagnostics.tsx:192);
  - 9 hand-written deterministic fixtures with `basis` strings —
    `OR_ATOM_009/scripts/fixtures/{idle,unknown-stale,tps-20,tps-80,queued-jobs,mixed-lanes,completion,failed-request,multi-runtime-gpu}.json`
    (e.g. `unknown-stale.json`: `value: null, stale: true, basis: "demo: stale sample aged out — value decayed to unknown (null)"`).
- Evidence: `OR_ATOM_009/screenshots/b7Injection.json` — 9/9 PASS, each row
  `B-1 in_page_wrapper_installed: true`, `servedNetwork: 0` (body from the in-page wrapper,
  not the network); `OR_ATOM_009/screenshots/gap2Smoke.json` — `G-4 dev_trigger_present: true`,
  `G-1..G-7` true.

## S9.6 — Browser / soak validation (gates, soak, stress, context loss, toggle, reduced-motion)

- `performance` (`references/trace-based-analysis.md`, `references/rum.md`): lab measurement —
  fps / dtMax / dt p95, canvas live/peak, ctx lost/restored, per-minute soak samples
  (`skill-discovery.md` §4.6).
- `core-web-vitals`: CLS/INP guards so the canvas never causes layout shift / long tasks (§4.6).
- `web-quality-audit` (2.0): screenshot + HTML analysis of each capture (§4.6).
- `game-developer` (`references/performance-optimization.md`): 60 FPS targets, profiling
  (`skill-discovery.md` §4.6).
- `accessibility` (2.0): `prefers-reduced-motion` fully static (covered at unit level; see
  Known gaps — no live reduced-motion capture).
- Implementation: soak/audit script
  [`scripts/ad-hoc/or-atom-009/audit.ts`](scripts/ad-hoc/or-atom-009/audit.ts) (scenario
  capture, forced context loss, remount, toggle, stress rows).
- Evidence (all 2026-10-29, `http://127.0.0.1:21011`):
  - 9-scenario matrix: `OR_ATOM_009/screenshots/captureScenarios.json` — 9/9 PASS;
  - b7 injection: `OR_ATOM_009/screenshots/b7Injection.json` — 9/9 PASS;
  - gap-2 smoke: `OR_ATOM_009/screenshots/gap2Smoke.json` — PASS (G-1..G-7; G-8 canvas-nonblank
    WebGL read-back inconclusive under SwiftShader → visual confirmation via screenshot);
  - forced context loss: `OR_ATOM_009/screenshots/contextLoss-mixed-lanes.json` — 6/6 GATEs PASS
    (settle → `lost:1` → `restored:1`, rAF frames advanced +135, no canvas growth);
  - stress matrix 8/16/32 atoms: `OR_ATOM_009/screenshots/stressMatrix.json` — verdict true;
  - 2D↔Atomic toggle stability: `OR_ATOM_009/screenshots/toggleStability.json` — T-1..T-5 true;
  - 20-min soak: `OR_ATOM_009/screenshots/soak-mixed-lanes.json` — GATE-1..6 PASS,
    `durationSec: 1200`, `after.fleetServed: 340`, end canvas 1/1, ctx lost/restored 1/1,
    0 page errors.

## Execution audit

All 9 selected skills are **instruction-only** (markdown + reference snippets). **None was
executed** — applied as guidance to the implementation and to the validation design. Consistent
with the OR-ATOM-008 audit (`OR_ATOM_008_task/SKILL_AUDIT.md` lines 144–145).
