# OR-ATOM-008 — Plasma Filaments & Volumetric Atomic Fidelity

**Target:** `celesrenata/OmniRoute`, Atomic Topology renderer plugin  
**Execution environment:** Menagerie / Zoo / Roo  
**Priority:** visual uplift, not architecture rebuild  
**Repository baseline inspected:** `release/v3.8.52` at `a2ba49d059` (OR-ATOM-007) / `7ad29c0c9b` (production target documentation), 2026-10-27. **Inspect local worktree and current branch before editing.**

## Mission

We now have _visible electrons_. Step 8 should convert the current topology from pale atoms connected by thick solid gray beams into the cinematic, layered **electrically active GPU observability instrument** envisioned in the original concepts.

The screenshot supplied with this task is the real current UI. It is **not** evidence of a broken camera or topology placement. The user may intentionally zoom for inspection.

**HARD FREEZE: Do not change camera, zoom, auto-fit, layout, topology positions, node count, DOM labels, label collision logic, controls, existing navigation, provider/GPU identity or ReactFlow fallback.** Do not expand feature scope into telemetry backend reconstruction. If a regression is conclusively identified, report it separately, not as justification for refactoring protected code.

## What was confirmed in current repository

- `src/plugins/atomic-topology/scene/ElectronCloud.tsx` (release): Step 7 already supplies tilted shell groups and additive `spriteMaterial` electron sprites using `getSharedGlowTexture()`. **Build on it; do not replace with static dots.**
- `src/plugins/atomic-topology/scene/AtomNode.tsx`: base core and an instanced particle nucleus, neutral palette when models are unknown, additive glow sprite, telemetry-driven vibration and event-driven discharge tint.
- `src/plugins/atomic-topology/scene/Nucleus.tsx`: OmniRoute hub uses a prominent particle nucleus with shared glow.
- `src/plugins/atomic-topology/scene/EnergyLink.tsx`: still uses `new THREE.TubeGeometry(...)` and mostly solid `MeshStandardMaterial`, which produces visually heavy straight/curved beams; the desired lightning effect is not present.
- `src/plugins/atomic-topology/quality.ts`: high/medium/low effect budgets already exist.
- `src/plugins/atomic-topology/visualEncoding.ts`: job-lane hue and model ID color mappings already exist. Preserve proven semantics.
- Step 7 release commit: `a2ba49d059` — "feat(atomic): port OR-ATOM-007 visual-fidelity techniques onto release scene".
- There is a separate `feat/atomic-topology-plugin` branch containing Step 5/6 fixes. **Check whether fixes are integrated before changes; do not regress context or geometry disposal.**

**Visual read of screenshot:** orbiting electron points now exist; atoms still look like opaque gray balls with bright pale satellites; connections, particularly on the active lane, read as thick gray pipes; atomic cloud color/volume and nucleus model differentiation are too weak. This is a style/visualization issue, not a reason to move objects.

## Phase S8.0 — Load appropriate skills from OmniRoute Skill Hub MCP

**Skill discovery must happen before implementation.** Avoid guessing which of the user's ~910 skills are installed. Use the live authenticated MCP service from the development environment.

Available tools confirmed by repository source:

- `omr_skill_list` — inventory domains and installed skills.
- `omr_skill_search` — discover ranked candidate skills.
- `omr_skill_get` — read selected full SKILL.md.
- `omr_catalog_search`, `omr_catalog_load` and `omr_catalog_resource` — alternate catalog discovery/load and references.
- `omr_catalog_refresh` — only if newly imported skills are missing; requires appropriate permission.

Tool discovery code lives at `open-sse/mcp-server/tools/skillDiscoveryTools.ts`; REST mirror is `/api/skills/catalog`, which is protected with management auth. MCP service is commonly `/api/mcp/stream` with service settings and authorized scope. **Do not paste tokens in reports, commits or terminal logs.**

Parallel read-only searches (search individually; multiple targeted queries beat one keyword soup):

- `three.js webgl r3f reactive material shader glsl`
- `volumetric rendering clouds procedural noise fresnel`
- `gpu particles instancing points sprites bloom`
- `electric arcs lightning branching plasma discharge`
- `shader graph transparency blending tone mapping`
- `webgl performance profiling render targets memory leaks`
- `react three fiber component performance disposal`
- `browser visual regression playwright screenshots`
- `scientific data visualization animated telemetry encoding`

Select only useful, non-quarantined skills. Load **full content** for 4–10 complementary skills, including their resource files when referenced. Rank on practical relevance to the current repository, not generic popularity. Record exact IDs/revisions, core technique to apply, assigned worker, and actual file/test evidence in `SKILL_APPLICATION_REPORT.md`.

Imported skills are mostly _instruction-only_. Do not call `omr_catalog_execute` on a non-executable import. Loading skill instructions and applying them to code is the desired workflow.

If the catalog/MCP is inaccessible: diagnose settings/auth/root mount without exposing secrets; record blocker; proceed using repo knowledge and conventional engineering rather than fabricating an audit. Do not silently skip discovery.

## Phase S8.1 — Replace opaque route pipes with restrained plasma filaments [P0]

Primary file: `scene/EnergyLink.tsx` (and narrowly scoped shader/effect utilities as required).

- Keep existing link endpoints, geometry **path**, topology data, layout and event mapping unchanged; change the **rendered material/width and transient effects**.
- At rest: route should be fine, almost hairline and low-contrast, not a solid gray tube. Use a thin GPU-friendly line or narrow translucent filament with gentle halo. Aim for ~1–2 CSS pixels apparent idle core at normal scene framing, with stable fallback when perspective makes pixel width difficult.
- On active requests: an energy pulse visibly **travels along the already-established link path**. Do not use whole-tube emissive breathing as the only signal. Use arc-length/progress along curve, shader UV parameterization or bounded sprite packets.
- On completion: a short turquoise/green traveling impulse that decays cleanly.
- On failure: brief, unmistakable red branching electric discharge + destination flash; red must not latch permanently and must not overwrite provider health semantics.
- Use time-bounded deterministic branching/jitter (seeded by event ID), frame-independent and reduced-motion-aware. No uncontrolled random frame churn.
- If multiple in-flight requests, render a bounded pool of distinct pulses. Limit maximum effect instances/draw calls per route, and preserve event ordering/replay deduplication.
- `pause` freezes discharge position, `resume` continues without jumps; document-hidden suspends GPU work.
- Geometry/material/texture lifetime cleanup: do not leak on frequent telemetry updates, remount, or context restore.

## Phase S8.2 — Turn electron dots into translucent, volumetric atomic energy [P1]

Primary file: `scene/ElectronCloud.tsx` and narrowly scoped shader/material helpers.

- **Keep Step 7's electrons.** Add a visually coherent, very low-opacity electron density / orbital haze _around_ them. Think layered, soft billowing luminous shells, not a giant filled sphere or more solid disks.
- Use specialized graphics skill techniques such as Fresnel/radial falloff, small procedural noise, additive sprites, controlled alpha premultiplication, low-cost shader fog, or screen-space halo. Select based on verified installed skills and measured performance.
- Preserve multiple tilted orbitals, recognizable moving electron points, lane hue semantics, pause and reduced motion.
- The electron cloud should respond to the _actual known lane_. Unknown lane may be neutral but should remain attractive and clearly neutral; never invent active work.
- Keep the atom body and labels legible. Avoid blown-out white halo, banding, opacity stacking saturation, or excessive bloom.
- Implement high/medium/low quality with measurable particle and fragment budgets; integrated GPU fallback is required.

## Phase S8.3 — Distinct proton/neutron nucleus shading and model identity [P1]

Primary: `scene/AtomNode.tsx`, `scene/Nucleus.tsx`, `scene/geometry.ts`, `visualEncoding.ts` only where truly needed.

- Maintain current nucleus particles, model-to-color mapping, model-count limits and honest unknown model colors.
- Make individual protons and neutrons distinguishable via subtle shape/material, shading, occlusion and separated luminosity rather than washing all particles white.
- When observed model IDs exist, make 2–3 model colors clearly visible as groups in the nucleus. Preserve deterministic stable coloring across frame, redraw, and model order changes.
- When model attribution is unknown, use a subdued, intentionally neutral two-tone nucleus; _never fabricate model residency_.
- Improve perceived depth through correct material roughness, emissive intensity, limited rim lighting and particle separation. Avoid costly realtime shadows.
- **Nucleus rotation still maps measured tokens/sec**; queue vibration still maps measured inference scheduler depth. No request-count substitution or fake activity.

## Phase S8.4 — Integrate and test motion/event semantics [P1]

- Reuse existing normalized topology snapshot and event pool; do not add telemetry subscriptions.
- Test four states with fixtures and/or clearly marked diagnostic/demo mode: idle/unknown, lane-active, completion, failure. Include simultaneous traffic on different lanes.
- Ensure faint idle styling is not confused with offline/error and neutral colors are not labeled as observed models.
- Test action sequences: Pause → Resume, Reset, switch 2D↔Atomic, traffic live update, hide tab, remount, context loss/restore.
- Avoid changing the protected camera/layout/label modules.

## Phase S8.5 — Measured visual fidelity and operational stability [RELEASE GATE]

Menagerie must run a real browser against a local or approved test deployment and capture screenshot/video evidence:

- Default framing and **operator-zoomed detail** for the exact current topology shape.
- Idle, 2+ simultaneous active requests, completed event, failed event. Clearly distinguish synthetic diagnostic frames from live fleet data.
- 8 / 16 / 32 atom stress fixtures, without moving normal user topology or making a new layout.
- 20-minute telemetry polling soak with visual continuity and stable active WebGL context count.
- Collect `renderer.info.render.calls`, `renderer.info.memory.geometries`, `renderer.info.memory.textures` before and after soak. Do not claim performance from build/test passes alone.
- Target smooth 60 FPS on discrete GPU and graceful >30 FPS on supported integrated GPUs _where measured_. If hardware unavailable, record unverified targets.
- No memory trend from repeated remount/telemetry cycles; dispose temporary buffers, geometries, textures, shader programs, render targets where owned.
- Run scoped unit tests and repository's documented typecheck/lint/build commands for changed paths.

### Screenshot acceptance gate

A reviewer must be able to say, from default and zoomed-in frames:

1. The connections look like **fine electrical threads**, not thick opaque rods.
2. Electrons are visibly orbiting against soft luminous volume, without becoming a starfield of unrelated white dots.
3. Model-attributed nuclei show distinctly colored particle groups rather than gray-white balls.
4. Activity visibly travels through the graph; completion is short cool pulse; failure is a short red lightning flash.
5. Atoms and labels are still in **exactly the same places**, with the same camera/zoom behavior.
6. 2D fallback, pause/resume, reduced motion and live telemetry still work.

**Do not close Step 8 based solely on unit tests.** Iterate actual screenshots/video until the original style targets are materially closer.

## Explicit exclusions

Do **not** change: `layout.ts`, `cameraFit.ts`, `SceneOrbitControls.tsx`, `AtomicLabels.tsx`, label collision/projection, auto-frame rules, topology semantics, provider/GPU arrangement, provider names or status chips, controls. No replacement of existing frontend framework or renderer registry. No new telemetry infrastructure or credential handling. No cosmetic change that misrepresents actual metrics.

## Required deliverables

- Working code, branch/commit/diff summary.
- `SKILL_AUDIT.md` containing catalog size actually observed, exact skill IDs/revisions, selection reasoning; don't assert that all 910 were read.
- `SKILL_APPLICATION_REPORT.md` with skill-to-technique-to-file/test traceability.
- Before/after browser screenshots and at least short motion captures for traveling discharge and orbital clouds.
- Measurements for available hardware and 20-minute soak; explicit unverified blockers.
- Tests and confirmation that protected modules are unchanged.

## Source and references

- Repository: https://github.com/celesrenata/OmniRoute
- Step 7 release commit: https://github.com/celesrenata/OmniRoute/commit/a2ba49d059
- Three.js renderer resource accounting: https://threejs.org/docs/pages/WebGLRenderer.html
- Three.js disposal guidance: https://threejs.org/manual/pages/how-to-dispose-of-objects.html
- R3F frame loop: https://r3f.docs.pmnd.rs/next/frame-loop
