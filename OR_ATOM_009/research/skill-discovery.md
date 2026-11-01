# OR-ATOM-009 — Step 9 Skill Discovery Report

> **⚠️ LIVE HUB UNAVAILABLE → LOCAL-FALLBACK (freshly re-probed this session).**
> The live Skill Hub was probed on `127.0.0.1:20128` at **2026-10-28T08:16:24Z–08:16:46Z (UTC)**.
> The MCP transport is **disabled (HTTP 503)** and the WP4 Skill-Hub REST catalog is **not exposed
> by the running binary (HTTP 405)**, so live `omr_skill_*` / `omr_catalog_*` discovery was impossible.
> **No live skill inventory count is claimed and no skill was live-loaded.** All discovery was
> performed against the local `skills-import/*.zip` corpus (same corpus OR-ATOM-008 audited).
> The `~910 installed skills` figure in `OR_ATOM_009/CONTEXT.md` was **never observed** and is not
> asserted here.

## 1. Live probe (exact evidence, this session)

- **Probe window:** `2026-10-28T08:16:24Z → 2026-10-28T08:16:46Z` (UTC), all on loopback `127.0.0.1:20128`.
- **Listener:** `lsof -nP -iTCP:20128 -sTCP:LISTEN` → `node` **PID 4016** (celes), IPv4 `127.0.0.1:20128 (LISTEN)`.
  (Note: PID differs from OR-ATOM-008's probe PID 45184 — the process was restarted since; same verdict.)

| #   | Probe                                                                                     | Status  | Response (observed, abridged)                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `GET /api/mcp/status`                                                                     | **200** | `{"status":"offline","online":false,"enabled":false,"transport":"stdio","heartbeat":{"pid":37826,"lastHeartbeatAt":"2026-10-01T05:45:01.145Z","version":"1.8.1","pidAlive":false,"heartbeatAgeMs":2341883920,"toolCount":110},"httpTransport":{"online":false,"transport":null},"activity":{"totalCalls24h":0,"lastCallTool":"omniroute_test_combo",...}}` — MCP **offline/disabled**, heartbeat stale since 2026-10-01 |
| 2   | `POST /api/mcp/stream` (JSON-RPC `initialize`)                                            | **503** | `{"error":"MCP server is disabled. Enable it from the Endpoints page."}`                                                                                                                                                                                                                                                                                                                                                |
| 3   | `GET /api/mcp/sse`                                                                        | **503** | `{"error":"MCP server is disabled. Enable it from the Endpoints page."}`                                                                                                                                                                                                                                                                                                                                                |
| 4   | `GET /api/skills`                                                                         | **200** | `{"data":[],"total":0,"page":1,"limit":50,"totalPages":0,"skills":[],"provider":"skillssh","popularDefaults":["git","terminal","postgres","kubernetes","playwright"]}` — live registry **empty**                                                                                                                                                                                                                        |
| 5   | `GET /api/skills/catalog?query=graphics`                                                  | **405** | empty body — WP4 catalog route not exposed by the running binary                                                                                                                                                                                                                                                                                                                                                        |
| 6   | `POST /api/skills/catalog` `{"action":"load","id":"imported:general/webgpu-threejs-tsl"}` | **405** | empty body — same                                                                                                                                                                                                                                                                                                                                                                                                       |

**Verdict: UNAVAILABLE** — live catalog discovery and live load are impossible on this deployment.
This matches OR-ATOM-008's independent probe (2026-10-27, `OR_ATOM_008_task/SKILL_AUDIT.md` lines 32–57)
and the documented local-fallback path. No live inventory count is claimed.

### MCP tool names verified from source (NOT from the wire — server is disabled)

| Tool                                                                                    | Defined at                                                                                                                                 |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `omr_skill_search`, `omr_skill_get`, `omr_skill_list`, `omr_catalog_refresh`            | [`open-sse/mcp-server/tools/skillDiscoveryTools.ts`](open-sse/mcp-server/tools/skillDiscoveryTools.ts) (names at lines 123, 144, 185, 210) |
| `omr_catalog_search`, `omr_catalog_load`, `omr_catalog_resource`, `omr_catalog_execute` | [`open-sse/mcp-server/tools/catalogTools.ts`](open-sse/mcp-server/tools/catalogTools.ts) (names at lines 70, 117, 169, 217)                |
| `omniroute_skills_list` (registry list, scope `read:skills`)                            | [`open-sse/mcp-server/tools/skillTools.ts`](open-sse/mcp-server/tools/skillTools.ts) (line 27)                                             |

REST mirror (source-verified): `GET/POST /api/skills/catalog` maps to the four `omr_catalog_*`
tools, gated by `requireManagementAuth` — [`src/app/api/skills/catalog/route.ts`](src/app/api/skills/catalog/route.ts)
(lines 1–28). On the running binary this route returns 405 (probe #5/#6 above).
Caller policy/scope would have been `read:catalog` (search/list/get) — **UNVERIFIED at runtime** because
the transport is disabled; stated from source only.

## 2. Local fallback corpus — search and selection

Same corpus OR-ATOM-008 already audited (`OR_ATOM_008_task/SKILL_AUDIT.md`, 13 417 lines):
10 zips in `skills-import/`, **1410 raw SKILL.md** (≈909 unique after the duplicated 501-skill
`trading`/`TRADING SKILLS` set). Per-package counts and search-term hit counts are reproduced there
(lines 64–112) and are **reused, not re-derived** — OR-ATOM-008's grep table covers the Step 9 terms:
`graphics 4 · glsl 1 · particle(-system) 1 · plasma 0 · volumetric 0 · shader 2 · threejs 1 ·
webgpu 1 · reduced-motion 3 · accessibility 28 · performance 276 · animation 12 · motion 127`.

Re-verification this session: the selected frontmatter IDs/versions below were read directly from
the freshly extracted files under `OR_ATOM_009/research/skills/*/SKILL.md` and match OR-ATOM-008's
selection table (`OR_ATOM_008_task/SKILL_AUDIT.md` lines 114–126) exactly.

### Selected skills (9) — Step 9 topic fit

| #   | Skill ID                    | Revision (frontmatter) | Source (zip → path)                                                                 | Step 9 topic(s)                                                                                                       | Status                    |
| --- | --------------------------- | ---------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | `webgpu-threejs-tsl`        | (no version field)     | `skills-import/webgpu-threejs-tsl.zip` → `webgpu-threejs-tsl/`                      | WebGL/R3F animation stack; GPU perf patterns; **WebGL/WebGPU context/device-loss handling**                           | **local** (live hub down) |
| 2   | `performance`               | 2.0                    | `skills-import/web-quality.zip` → `web-quality/performance/`                        | GPU/frame perf budgets, RUM + lab measurement, trace-based diagnosis (soak gate)                                      | **local**                 |
| 3   | `core-web-vitals`           | 2.0                    | `skills-import/web-quality.zip` → `web-quality/core-web-vitals/`                    | CLS/INP/LCP guards so the canvas never causes layout shift / long tasks                                               | **local**                 |
| 4   | `accessibility`             | 2.0                    | `skills-import/web-quality.zip` → `web-quality/accessibility/`                      | WCAG 2.2 incl. `prefers-reduced-motion`; reduced-motion = fully static scene                                          | **local**                 |
| 5   | `accessibility-compliance`  | (no version field)     | `skills-import/engineering.zip` → `engineering/accessibility-compliance/`           | ARIA/inclusive patterns, reduced-motion checklist (tooltip/diagnostics surface)                                       | **local**                 |
| 6   | `web-quality-audit`         | 2.0                    | `skills-import/web-quality.zip` → `web-quality/web-quality-audit/`                  | Read-only rendered-verification QA (screenshot/HTML analysis of captures)                                             | **local**                 |
| 7   | `visual-design-foundations` | (no version field)     | `skills-import/engineering.zip` → `engineering/visual-design-foundations/`          | Color theory/design tokens → **visual encoding** of up-to-3 observed model colors + neutral-unknown palette           | **local**                 |
| 8   | `interaction-design`        | (no version field)     | `skills-import/engineering.zip` → `engineering/interaction-design/`                 | Motion timing/easing (frame-rate-independent smoothing), pulse/discharge micro-interactions, reduced-motion fallbacks | **local**                 |
| 9   | `game-developer`            | 1.1.0                  | `skills-import/fullstack-development.zip` → `fullstack-development/game-developer/` | 60+ FPS optimization targets, profiling, object pooling, particle systems                                             | **local**                 |

All 9 are **instruction-only** (markdown + snippets); none was executed (OR-ATOM-008 audit, lines
144–145 — consistent). "Status" = where the content was obtained from: `local` because the live
hub was down; IDs are the exact frontmatter `name` values, never invented.

**Not selected (why)** — carried over from OR-ATOM-008 (lines 128–138) and still valid for Step 9:
`TRADING SKILLS/*` + `trading/*` (zero graphics/telemetry relevance); `bloom`/`motion`/`shad` prose
hits (trading/design prose, no technique); `react-native-design`, `tailwind-design-system`,
`react-native-expert` (wrong stack); `godot-gdscript-patterns`, `flutter-expert` (wrong engine);
`best-practices`, `seo`, `pptx-visual-assets` (no WebGL/signal-encoding signal).

## 3. Verbatim extraction

`/tmp/or-atom-008-corpus` no longer exists, so per task step 3 every selected skill was
**re-extracted from the corpus zips** this session (fresh `unzip` of the original `skills-import/*.zip`,
then byte-copy) into `OR_ATOM_009/research/skills/<skill-id>/` preserving original text and layout.
**47 files, 9 skill dirs, no `__MACOSX`/`.DS_Store` leakage.**

| Skill dir (`OR_ATOM_009/research/skills/…`) | Files | Key Step 9 references (verbatim, in-place)                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webgpu-threejs-tsl/`                       |    16 | `docs/device-loss.md` (WebGPU device loss **and** WebGL fallback context loss/recovery), `docs/limits-and-features.md`, `docs/compute-shaders.md`, `docs/materials.md`, `docs/post-processing.md`, `docs/core-concepts.md`, `examples/particle-system.js`, `examples/custom-material.js`, `templates/compute-shader.js` (all `clock.getDelta()` / frame-rate-independent motion patterns) |
| `performance/`                              |     3 | `SKILL.md` (baseline → trace → change → report), `references/MEASUREMENT.md`, `references/RUM.md`                                                                                                                                                                                                                                                                                         |
| `core-web-vitals/`                          |     4 | `SKILL.md`, `references/CLS.md`, `references/INP.md`, `references/LCP.md`                                                                                                                                                                                                                                                                                                                 |
| `accessibility/`                            |     3 | `SKILL.md` (incl. `prefers-reduced-motion`), `references/WCAG.md`, `references/A11Y-PATTERNS.md`                                                                                                                                                                                                                                                                                          |
| `accessibility-compliance/`                 |     5 | `SKILL.md`, `references/wcag-guidelines.md`, `references/aria-patterns.md`, `references/mobile-accessibility.md`, `references/details.md`                                                                                                                                                                                                                                                 |
| `web-quality-audit/`                        |     2 | `SKILL.md`, `scripts/analyze.sh`                                                                                                                                                                                                                                                                                                                                                          |
| `visual-design-foundations/`                |     4 | `SKILL.md`, `references/color-systems.md`, `references/typography-systems.md`, `references/spacing-iconography.md`                                                                                                                                                                                                                                                                        |
| `interaction-design/`                       |     4 | `SKILL.md` (Timing Guidelines table, Purposeful Motion), `references/animation-libraries.md` (incl. "Easing Functions"), `references/microinteraction-patterns.md`, `references/scroll-animations.md`                                                                                                                                                                                     |
| `game-developer/`                           |     6 | `SKILL.md` (Core Workflow: "Profile and optimize for 60+ FPS … frame time ≤16 ms"), `references/performance-optimization.md` (+ ecs/unity/unreal/multiplayer refs, out of scope for S9)                                                                                                                                                                                                   |

The worker should treat these directories as the authoritative instruction source; the OR-ATOM-008
"FULL LOADED INSTRUCTIONS" section (`OR_ATOM_008_task/SKILL_AUDIT.md` line 182 onward) contains the
same text cross-checked against the corpus.

## 4. Application plan — skill → OR-ATOM-009 work

Mapping to the Step 9 work items in `OR_ATOM_009/CONTEXT.md` §2–§7 (S9.1–S9.6). Frozen zones
(camera, `layout.ts`, `cameraFit.ts`, `SceneOrbitControls.tsx`, labels/collision, Step 8 visuals,
2D ReactFlow fallback) are untouched by every mapping below.

### 4.1 Attribution binding (S9.1) — proven provider → runtime → GPU

| Skill                                        | Specific instructions to follow                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visual-design-foundations`                  | `references/color-systems.md` + `SKILL.md` design-token discipline: the ≤3 observed model colors in a GPU nucleus must come from a small, consistent token-derived palette; **unknown/stale → neutral**, never invented hues (CONTEXT §2 "Colors represent known model identities, not fabricated fractional utilization"; §2 "Stale and unobserved fields remain neutral/unavailable. Measured zero is real zero."). |
| `accessibility` / `accessibility-compliance` | When S9.5's tooltip/debug overlay surfaces canonical IDs + link basis, follow `references/wcag-guidelines.md` / `references/aria-patterns.md`: distinguishable state names, no color-only meaning, neutral vs measured-zero vs unavailable wording.                                                                                                                                                                   |

**NO-SKILL-COVERED:** the identity/evidence rules themselves (`runtime:<host>:<runtime_id>`,
`gpu:<host>:<device_uuid>`, honor `ReconciliationEdge.basis`/`sampledAt`, no even-splitting of
aggregate TPS) are **domain rules from CONTEXT §2**, not from any corpus skill.

### 4.2 Nucleus TPS motion (S9.2) — measured tokens/sec drives the proton/neutron cluster

| Skill                | Specific instructions to follow                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `webgpu-threejs-tsl` | Every motion example uses **frame-rate-independent delta time**: `clock.getDelta()` clamped (`Math.min(delta, 0.1)`) in `examples/particle-system.js`, `templates/compute-shader.js`, `examples/post-processing.js`. Apply the same pattern to the nucleus `useFrame` rotation so a 3.5 s poll jitter never causes an angular jump; keep rotation as a ref-driven instanced-group rotation, no per-frame React state (CONTEXT §3).                                                                                                                                                                     |
| `interaction-design` | `SKILL.md` "Timing Guidelines" table + `references/animation-libraries.md` "Easing Functions": choose a short settle time for speed changes and ease between _sampled_ speeds (frame-rate-independent); avoid phase resets on snapshot update/pause/remount. **Honesty note:** the corpus contains **no EMA/exponential-moving-average skill** — the smooth between-samples easing must be composed from these easing instructions + the existing `visualEncoding.ts` provenance (`measured` / `measured-zero` / `unavailable`) and `scene/motion.ts` helpers; do not claim the corpus prescribed EMA. |
| `game-developer`     | `SKILL.md` Core Workflow step 4 ("frame time ≤16 ms") and `references/performance-optimization.md`: keep the extra nucleus rotation within the per-frame budget; no per-frame geometry rebuild.                                                                                                                                                                                                                                                                                                                                                                                                        |

### 4.3 Queue vibration (S9.3) — perceptible, bounded, attributable

| Skill                                        | Specific instructions to follow                                                                                                                                                                                                         |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `game-developer`                             | `references/performance-optimization.md`: bounded, deterministic per-frame transforms (offset around a fixed base transform), pooling-friendly; clamp to a restrained shake (CONTEXT §3 "clamp to a restrained, non-nauseating shake"). |
| `interaction-design`                         | `references/microinteraction-patterns.md` — feedback must communicate a real state change; vibration only while a _real attributable_ queue is observed; `prefers-reduced-motion` → static.                                             |
| `accessibility` / `accessibility-compliance` | `references/WCAG.md` / `references/wcag-guidelines.md` `prefers-reduced-motion` rules: fully static under reduce; paused scene genuinely freezes, resume must not jump (CONTEXT §3).                                                    |
| `visual-design-foundations`                  | Neutral palette when no queue attribution exists (same token discipline as §4.1).                                                                                                                                                       |

### 4.4 Event flow choreography (S9.4) — pulses along _proven_ links only

| Skill                       | Specific instructions to follow                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webgpu-threejs-tsl`        | Traveling-emission + traveling-particle techniques: `examples/earth-shader.js` (time-uniform-driven emission along geometry), `examples/particle-system.js` (instanced particles along paths), `docs/materials.md` — reuse on Step 8's thin plasma links, keeping that style (CONTEXT §4 "Keep Step 8's thin plasma style … do not regress to thick pipes"). Bounded, deduplicated, capped concurrent pulses (event pool) per CONTEXT §4. |
| `interaction-design`        | `SKILL.md` Purposeful Motion ("Feedback / Orientation / Focus / Continuity") + `references/microinteraction-patterns.md`: completion = brief cool impulse, failure = brief red discharge, both **event-level**, not persistent state recoloring (CONTEXT §4 "Request errors stay event-level, not persistent … health changes").                                                                                                          |
| `visual-design-foundations` | Smooth hue shift of the electron cloud when a real attributed job changes lane (`references/color-systems.md`); dominant observed lane with provenance, no name-based inference.                                                                                                                                                                                                                                                          |

**NO-SKILL-COVERED (partially):** "multi-hop graph/energy-link choreography" as such has no corpus
skill — OR-ATOM-008 already recorded zero hits for `plasma`/`volumetric`/`electrical`. It is composed
from `webgpu-threejs-tsl` traveling-emission/particle instructions + `interaction-design` timing
tables, as OR-ATOM-008 did for Step 8.

### 4.5 Demo harness (S9.5) — synthetic demo/test mode + diagnostics

| Skill                                        | Specific instructions to follow                                                                                                                                                                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accessibility` / `accessibility-compliance` | `references/aria-patterns.md`: the opt-in debug overlay/tooltip states (measured / measured-zero / unavailable / stale) must be textually distinguishable and labeled "synthetic demo mode (dev/test only, off in production)" per CONTEXT §5. |
| `visual-design-foundations`                  | Demo-mode lane/model colors use the same design-token palette as live data so demo ≠ visual fiction.                                                                                                                                           |

**NO-SKILL-COVERED:** deterministic fixture injection (0/20/80 TPS, 2–3 lanes, queue spikes,
success/failure, stale) is a test-design task from CONTEXT §5 — no corpus skill covers it.

### 4.6 Browser / soak validation (S9.6)

| Skill                | Specific instructions to follow                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `performance`        | `SKILL.md` "How it works": **baseline first, then after** — measure, trace, change, re-measure, report before/after with conditions and uncertainty; findings without a runnable measurement are **hypotheses**, not results (mirrors CONTEXT §7 "Measure or clearly mark unavailable"). `references/MEASUREMENT.md` + `references/RUM.md`: field-plus-lab baseline, trace-based diagnosis, real vs simulated labeling. |
| `core-web-vitals`    | `references/CLS.md` / `INP.md` / `LCP.md`: the canvas must add no layout shift, long tasks, or LCP regression across the 0/1/3/10-job matrix, atom-count fixtures (8/16/32), pause/resume/reset, tab hide/show (CONTEXT §7).                                                                                                                                                                                            |
| `game-developer`     | `SKILL.md` step 4–5 + `references/performance-optimization.md`: 60+ FPS target, profiling (console errors, `renderer.info.render.calls`, geometries/textures, context-loss count), stable frame rate under stress, no persistent growth over successive telemetry updates/remounts; 20-minute soak.                                                                                                                     |
| `web-quality-audit`  | `SKILL.md` + `scripts/analyze.sh`: read-only analysis of captured renders/screenshots to verify appearance (WebGL validation requires screenshots/video — "passing unit tests alone is insufficient", CONTEXT §7).                                                                                                                                                                                                      |
| `webgpu-threejs-tsl` | `docs/device-loss.md`: the **WebGL context loss/restore** soak step (CONTEXT §7 "WebGL context loss/restore") — handle `webglcontextlost`/`webglcontextrestored`, recover or rebuild resources, count losses. `docs/limits-and-features.md`: device-limit awareness for the RTX 5090 / 4070 Ti SUPER / M5 Max checks ("Report real vs simulated. Do not claim connection when source unreachable.").                    |
| `accessibility`      | `prefers-reduced-motion` capture in the validation matrix (CONTEXT §7 "reduced motion").                                                                                                                                                                                                                                                                                                                                |

**NO-SKILL-COVERED:** Playwright/headless-capture specifics — OR-ATOM-008's corpus search found
**zero** `playwright`/`headless`/`puppeteer`/`soak` hits in any SKILL.md (this report re-verified the
absence in OR-ATOM-008's verbatim instruction corpus). The capture/soak harness is therefore composed
from `web-quality-audit` (rendered-output QA) + `performance` (measurement workflow) + repo tooling
(`playwright.config.ts` at repo root; OR-ATOM-008's soak harness pattern in
`OR_ATOM_008_task/scripts/soak.mjs`). No corpus skill is claimed as a Playwright authority.

## 5. Topics with NO matching skill (explicit)

| Step 9 topic                                                       | Corpus status                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Time-series smoothing — EMA / exponential moving average (by name) | **NO SKILL.** 0 hits for "EMA"/"exponential moving average". Closest available: `interaction-design` easing + `webgpu-threejs-tsl` clamped-delta-time patterns (used as the composition basis; do not present as an EMA skill). |
| Preattentive visual attributes / visual-encoding theory (by name)  | **NO SKILL.** 0 hits. Closest available: `visual-design-foundations` color theory (applied to model-color encoding + neutral-unknown).                                                                                          |
| Graph flow / energy-link choreography (as a named discipline)      | **NO SKILL.** 0 hits for `plasma`/`volumetric`/`electrical`. Composed from `webgpu-threejs-tsl` + `interaction-design` (as OR-ATOM-008 did).                                                                                    |
| Playwright / headless capture / soak-testing (by name)             | **NO SKILL.** 0 hits. Composed from `web-quality-audit` + `performance` + repo Playwright config.                                                                                                                               |
| Proven attribution / identity-binding rules (S9.1)                 | **NO SKILL.** Domain rules live in `OR_ATOM_009/CONTEXT.md` §2, not in the corpus.                                                                                                                                              |
| Synthetic demo-mode fixture design (S9.5)                          | **NO SKILL.** From CONTEXT §5.                                                                                                                                                                                                  |
| Live Skill Hub discovery                                           | **UNAVAILABLE** (probe §1). Live inventory count: not claimed; the "~910" figure is unobserved.                                                                                                                                 |

Everything else (WebGL/R3F animation + GPU perf, GPU perf budgets, reduced-motion/accessibility,
visual-encoding-adjacent color theory, motion timing/easing, context-loss handling, rendered-output
QA) **is** covered by a selected real skill — see §2 and §4.

## 6. Honesty / provenance summary

- Every ID above is an exact frontmatter `name` read from the extracted corpus file this session
  (§3 table); revisions are exact frontmatter `version` values — `(no version field)` is a fact,
  not a placeholder.
- Every external claim cites a path: probes (§1) cite the live responses; corpus facts cite
  `OR_ATOM_008_task/SKILL_AUDIT.md` (with line anchors) and the extracted files under
  `OR_ATOM_009/research/skills/`.
- Nothing was invented: no live count, no invented skill IDs, no execution of instruction-only skills.
- Only new files were created, all under `OR_ATOM_009/research/` (`research/skill-discovery.md` +
  `research/skills/**`); no existing file was modified; no git operation was run on the main repo.
- UNVERIFIED items, marked as such: runtime caller scope/policy (transport disabled), device
  telemetry for RTX 5090/4070 Ti SUPER/M5 Max (out of probe scope), live hub inventory.
