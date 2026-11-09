# TESTS (Gate B, round 4)

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
