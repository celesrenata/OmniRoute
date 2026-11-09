# TESTS (Gate B, round 6)

Source SHA of the code under test: `076bc2219ed03505ebeef69e9e9487dcb2cf434b` (short `076bc2219`; branch `feat/atomic-raytraced-renderer`; the following commit only adds docs/evidence).
Deployment status: **not deployed.** Nothing pushed, no PR opened, no production or fleet change.
Environment: macOS, Apple M5 Max, Node v24.21.0, headed Chrome via Playwright, dev server from this worktree on :20199.

## Commands and outcomes

| Command                                                                                                 | Outcome                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --import tsx/esm --test tests/unit/atomic-topology/*.test.ts`                                     | 467 tests, 466 pass, 0 fail, 1 skipped. New: `smallAtomLod.test.ts` (LOD weight, band 16 -> 46 css px, smooth cross-fade), `energyTiers.test.ts` (tier 0 greys, tier 1 floors and 70-95 % richness, tier 2 smooth 8-min decay, tier 3 floor, measured never lowers a tier, legacy path unchanged, reduced motion, tooltip Activity copy). |
| `npx eslint src/plugins/atomic-topology src/app/dev tests/unit/atomic-topology`                         | 0 problems (after replacing `Date.now()`-in-render in the tooltip).                                                                                                                                                                                                                                                                       |
| `npm run typecheck:core`                                                                                | 45 errors, all pre-existing (the same 45 on the base); 0 in `atomic-topology`.                                                                                                                                                                                                                                                            |
| `npm run lint`                                                                                          | 7 errors, all pre-existing and outside the plugin (scriptVault / scripts.ts / scriptVaultTools).                                                                                                                                                                                                                                          |
| `npm run test:vitest`                                                                                   | 54 files, 493 tests passed.                                                                                                                                                                                                                                                                                                               |
| `npm run check:cycles`                                                                                  | OK, no cycles (462 files).                                                                                                                                                                                                                                                                                                                |
| `node scripts/ad-hoc/pw-atomic-gateB.mjs ladder / loss / reduced / fallback / toggle 50 / soak 1200000` | See `PERFORMANCE.md` (all on this SHA, real GPU `apple/metal-3`).                                                                                                                                                                                                                                                                         |
| `node scripts/ad-hoc/pw-atomic-home.mjs ...`                                                            | Real `/home` Atomic captures + LOD distribution (`home-before/` = previous SHA `1d7bccc3f`, `home-after/` = this SHA).                                                                                                                                                                                                                    |
| `node scripts/ad-hoc/pw-atomic-gateB-capture.mjs ...` (+ `VIDEO=12000`)                                 | All round-6 stills and 4 videos, 0 console errors per capture.                                                                                                                                                                                                                                                                            |
| pre-commit hooks (lint-staged, docs-sync, any-budget, tracked-artifacts, ai-attribution)                | Pass on `076bc2219`.                                                                                                                                                                                                                                                                                                                      |

## New or changed tests (this round)

- `smallAtomLod.test.ts`: fully on at/below 16 css px, fully off at/above 46, smoothstep midpoint 0.5, monotonic with no step, a 45 px atom is mostly the full atom, 78 px is exactly the full atom.
- `energyTiers.test.ts`: see above.

## Frozen-area guard

`git diff 689178516 HEAD` is empty for `layout.ts`, `cameraFit.ts`, `labelCollision.ts`, `projection.ts`, `scene/SceneOrbitControls.tsx`, `overlays/AtomicLabels.tsx`, `overlays/AtomicControls.tsx`, `ProviderTopology2D.tsx`. Changed outside the scene this round: `overlays/AtomicTooltip.tsx` (Activity row), `AtomicTopologyRenderer.tsx` (two read-only descriptor fields).

## Known gaps

- No automated visual-regression diff; visual evidence is the captured images and videos. Shaders (PCB, platform, panels, LOD) are exercised only on a real GPU run, not in unit tests.
- The real local fleet has no tier-0 provider on screen; tier 0 is shown on the bench (`idle-20.jpg`) and covered by unit tests.
- The tab-hidden loop stop was driven by overriding `document.hidden` in an earlier round, not by an OS-level hidden tab.

---

# TESTS (Gate B, round 5)

Source SHA of the code under test: `96c17acf3` (branch `feat/atomic-raytraced-renderer`; the following commit only adds docs/evidence).
Deployment status: **not deployed.** Nothing pushed, no PR opened, no production or fleet change.
Environment: macOS, Apple M5 Max, headed Chrome via Playwright, dev server from this worktree on :20199.

## Commands and outcomes

| Command                                                                                                 | Outcome                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `node --import tsx/esm --test tests/unit/atomic-topology/*.test.ts`                                     | 458 tests, 457 pass, 0 fail, 1 skipped. New: `closeHeroWeight` ramp test in `rtTopologyScene.test.ts`.                                       |
| `npx eslint src/plugins/atomic-topology src/app/dev tests/unit/atomic-topology`                         | 0 problems.                                                                                                                                  |
| `npm run typecheck:core`                                                                                | 45 errors, all pre-existing: the same 45 with this round's diff stashed. 0 in `atomic-topology`.                                             |
| `npm run lint`                                                                                          | 7 errors, all pre-existing and outside the plugin (scriptVault / scripts.ts); 0 in the plugin.                                               |
| `npm run test:vitest`                                                                                   | Not run: the vitest include globs (`vitest.config.ts`) do not cover `src/plugins/atomic-topology` or `tests/unit/atomic-topology/*.test.ts`. |
| `node scripts/ad-hoc/pw-atomic-gateB.mjs ladder / loss / reduced / fallback / toggle 50 / soak 1200000` | See `PERFORMANCE.md` (all on this SHA, real GPU `apple/metal-3`).                                                                            |
| `node scripts/ad-hoc/pw-atomic-gateB-capture.mjs ...` (+ `VIDEO=12000`)                                 | All round-5 stills and 4 videos, 0 console errors per capture.                                                                               |
| pre-commit hooks (lint-staged, docs-sync, any-budget, tracked-artifacts, ai-attribution)                | Pass on `96c17acf3`.                                                                                                                         |

---

# (history) TESTS (Gate B, round 4)

Source SHA of the code under test: `a4e5713ee361d61887c3041358cdadd5e185d4ba` (branch `feat/atomic-raytraced-renderer`; later commits only add docs).
Deployment status: **not deployed.** Nothing pushed, no PR opened, no production or fleet change.
Environment: macOS 26.6.2, Apple M5 Max, Node v24.21.0, Chrome 157 (headed), Playwright, dev servers from this worktree (:20199) and `9805665e6` (:20198, comparison only).

## Commands and outcomes (this round)

| Command                                                                                                                              | Outcome                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck:core`                                                                                                             | 45 errors, all pre-existing (src/lib/db/scripts.ts, src/lib/scripts/scriptVault.ts, src/lib/embeddings, FlowCanvas css import, open-sse). 0 in `atomic-topology` or `src/app/dev`. |
| `npx tsc --noEmit -p tsconfig.typecheck-dashboard.json` filtered to atomic/bench                                                     | 0 errors.                                                                                                                                                                          |
| `npm run lint`                                                                                                                       | 7 errors, all pre-existing and outside the plugin; plus the stale-suppressions notice (not checked against the base).                                                              |
| `npx eslint src/plugins/atomic-topology src/app/dev tests/unit/atomic-topology`                                                      | 0 problems.                                                                                                                                                                        |
| `node --import tsx/esm --test tests/unit/atomic-topology/*.test.ts`                                                                  | 457 tests, 456 pass, 0 fail, 1 skipped.                                                                                                                                            |
| `npm run test:vitest`                                                                                                                | 54 files, 493 tests passed.                                                                                                                                                        |
| `npm run check:cycles`                                                                                                               | OK, no cycles (462 files).                                                                                                                                                         |
| `node scripts/ad-hoc/pw-atomic-gateB.mjs ladder / loss / reduced / fallback / toggle 50 / soak 1200000`                              | See `PERFORMANCE.md`.                                                                                                                                                              |
| `node scripts/ad-hoc/pw-atomic-visibility.mjs ab / loop`, `pw-atomic-closecmp.mjs`, `pw-atomic-camlimit.mjs`, `pw-atomic-camdbg.mjs` | See `PERFORMANCE.md` and `GATE_B.md`.                                                                                                                                              |
| Not run this round: `npm run build` (dev servers were occupying the worktree), `npm run check:docs-all` (docs are in a task folder). |

## New or changed tests (this round)

- `containerBounds.test.ts`: soft clamp (inside unchanged, never reaches the wall, monotonic, no snap); **default and every focus pose of the 8/16/20/32 golden topologies unchanged** at aspect 1/1.6/2.2; container is snug.
- `leaderBolt.test.ts`: stepped-leader determinism, connected main channel pinned to (0,0,0)-(0,0,1), birth monotonic, multi-generation branches that thin out, bounded; strike timeline (strokes after the leader, decay, afterglow, failure re-strikes more).
- `visibility.test.ts`: frustum planes + conservative sphere test (centre, sides, behind, far, straddling, bad data never culls); march-step scale (full at default size, monotonic, floor).
- `boardComponents.test.ts`: deterministic seeded placement, floor densest, nothing under atom pads, inside the container, large parts do not overlap, haze field only from magnetic/HV parts.
- `telemetryBinding.test.ts` (updated + 3 new): GPU+runtime merge (membership, aggregate of hosted runtimes, stale contributes nothing, runtime on two GPUs / unknown GPU / no proof stays its own atom, nothing else moves).
- `rtTopologyScene.test.ts`: hub-only dome flag on pedestals.

## Frozen-area guard

`git diff 689178516 HEAD` is empty for `layout.ts`, `cameraFit.ts`, `labelCollision.ts`, `projection.ts`, `scene/SceneOrbitControls.tsx`, `overlays/AtomicLabels.tsx`,
`overlays/AtomicControls.tsx`, `ProviderTopology2D.tsx`. Changed outside the scene: `overlays/AtomicTooltip.tsx` (hosted runtimes row), `AtomicTopologyRenderer.tsx` (merge), dev bench only for toggles.

## Known gaps

- No automated visual-regression diff; visual evidence is the captured images and videos. Shaders (PCB, links, parts) are exercised only on a real GPU run, not in unit tests.
- Tab-hidden loop stop was driven by overriding `document.hidden` (see `PERFORMANCE.md`), not by an OS-level hidden tab.
- Live telemetry was not available to the dev server (`FORBIDDEN_ORIGIN`).

# Earlier rounds (historical)

## Commands and outcomes (round 2, historical)

| Command                                                                                                | Outcome                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck:core`                                                                               | 45 errors, all pre-existing (open-sse, scriptVault, FlowCanvas css import). 0 in `atomic-topology` or `src/app/dev`.                                                                                       |
| `npx tsc` over `src/plugins/atomic-topology/**` and `src/app/dev/**` (temp tsconfig)                   | 0 errors.                                                                                                                                                                                                  |
| `npm run lint`                                                                                         | 7 errors, all pre-existing and outside the plugin (scriptVault tools / `z` unused). Lint also prints a stale-suppressions notice (`--prune-suppressions`); I did not check whether the base prints it too. |
| `npx eslint src/plugins/atomic-topology src/app/dev tests/unit/atomic-topology`                        | 0 problems.                                                                                                                                                                                                |
| `node --import tsx/esm --test tests/unit/atomic-topology/*.test.ts`                                    | 461 tests, 460 pass, 0 fail, 1 skipped (includes new `atomBatchDispose.test.ts`; haze tier tests rewritten).                                                                                               |
| `npm run test:vitest`                                                                                  | 493 passed (493).                                                                                                                                                                                          |
| `node scripts/ad-hoc/pw-atomic-gateB.mjs probe / loss / toggle 50 / soak 1200000 / reduced / fallback` | See `PERFORMANCE.md`. `fallback` (dev `?restore-fail=1`): returned to 2D in 1.7 s.                                                                                                                         |
| `node scripts/ad-hoc/pw-atomic-gateB-spikes.mjs`                                                       | Stress-case diagnosis, see `PERFORMANCE.md`.                                                                                                                                                               |
| `npm run build`                                                                                        | Green (standalone build produced; run with the dev server stopped).                                                                                                                                        |
| `node scripts/ad-hoc/pw-atomic-gateB-capture.mjs ...`                                                  | All Gate B screenshots and 3 videos (headed Chrome, real GPU).                                                                                                                                             |

Not run: `npm run check:cycles`, `npm run check:docs-all` (docs here are under a task folder, not `docs/`). The visual and perf runs use the dev server; the production build compiled but I did not run the scene from the standalone output.

## New or changed tests

- `atomBatchLayout.test.ts`: field layout invariants, strand LOD (1 at approved framings, bounded, monotonic), bucket hysteresis,
  rank order.
- `rtTopologyScene.test.ts`: measured-only energy input, neutral attribution, environment layout (floor below lowest atom, one
  pedestal per atom, corridor wider than the layout, input never mutated), link curve endpoints exactly hub and atom, link intensity bounds.
- `quality.test.ts` (rewritten): no tier ladder or hardware probe is exported; full retina DPR never capped.
- `webgl2-probe.test.ts` (extended): WebGPU alone mounts the 3D scene; neither GPU API -> 2D.

## Frozen-area guard

`git diff 689178516 -- layout.ts cameraFit.ts labelCollision.ts projection.ts scene/SceneOrbitControls.tsx overlays/AtomicLabels.tsx
overlays/AtomicControls.tsx src/app/(dashboard)/home/ProviderTopology2D.tsx` is empty. Their unit tests (`layout`, `cameraFit`,
`labelCollision`, `projection`, `sceneOrbitControls`, `sceneFocusPivot`) are unmodified vs `689178516` and pass. `CameraRig` and
`CameraStateWriter` function bodies in `AtomicScene.tsx` are byte-identical to `689178516` (checked by text extraction).

## Known gaps

- `atomBatchDispose.test.ts` (new) checks the batched layers register their resources and `dispose()` releases them, idempotently. The overlap subdue has no unit test; it is covered by the captures only.
- No automated visual-regression diff in CI; visual evidence is the captured screenshots.

## Legacy renderer deletion (after round 2)

After deleting the legacy renderer: `npm run typecheck:core` 45 errors (all pre-existing, 0 in plugin/dev), eslint plugin+dev+tests 0 problems,
`node --import tsx/esm --test tests/unit/atomic-topology/*.test.ts` 431 tests, 430 pass, 0 fail, 1 skipped (three legacy-only test files removed),
`npm run test:vitest` 493 passed, `npm run build` ok. Live (headed Chrome, M5 Max): default + close-up render, `atoms=20/32` uncapped 226 / 206 fps (p50 3.9 / 4.2 ms),
two-failed-restores fallback to 2D (1.7 s), forced loss x3 WebGPU and WebGL2 recovered, 2D<->Atomic x10 ok, `?atomic-fx=legacy` renders the ray-traced scene.
