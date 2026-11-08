# TESTS (Gate B)

Source SHA of the code under test: `9368b50a1d67b35919da82d1be4cf1c49051f854` (branch `feat/atomic-raytraced-renderer`).
The 20-minute soak, loss, toggle, reduced-motion, fallback and perf runs in this round were all taken on this SHA.
Deployment status: **not deployed.** Nothing pushed, no PR opened, no production or fleet change.

Environment: macOS 26.6.2, Apple M5 Max, Node v24.21.0, Chrome 157.0.8103.39 (headed), Playwright 1.63.0, dev server on `:20199`
from this worktree.

## Commands and outcomes

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
