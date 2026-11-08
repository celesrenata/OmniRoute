# TESTS (Gate B)

Source SHA of the code under test: `d0092133f3b2188f3ac489c0ad4c3e984dba7998` (branch `feat/atomic-raytraced-renderer`).
Renderer code is identical to `5c52015b5`, which the 20-minute soak ran on (later commits only changed measurement harness options and docs).
Deployment status: **not deployed.** Nothing pushed, no PR opened, no production or fleet change.

Environment: macOS 26.6.2, Apple M5 Max, Node v24.21.0, Chrome 157.0.8103.39 (headed), Playwright 1.63.0, dev server on `:20199`
from this worktree.

## Commands and outcomes

| Command                                                                                              | Outcome                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck:core`                                                                             | 45 errors, all pre-existing (open-sse, scriptVault, FlowCanvas css import). 0 in `atomic-topology` or `src/app/dev`.                                                                                       |
| `npx tsc` over `src/plugins/atomic-topology/**` and `src/app/dev/**` (temp tsconfig)                 | 0 errors.                                                                                                                                                                                                  |
| `npm run lint`                                                                                       | 7 errors, all pre-existing and outside the plugin (scriptVault tools / `z` unused). Lint also prints a stale-suppressions notice (`--prune-suppressions`); I did not check whether the base prints it too. |
| `npx eslint src/plugins/atomic-topology src/app/dev tests/unit/atomic-topology`                      | 0 problems.                                                                                                                                                                                                |
| `node --import tsx/esm --test tests/unit/atomic-topology/*.test.ts`                                  | 461 tests, 460 pass, 0 fail, 1 skipped.                                                                                                                                                                    |
| `npm run test:vitest`                                                                                | 493 passed (493).                                                                                                                                                                                          |
| `node scripts/ad-hoc/pw-atomic-gateB.mjs ladder / probe / loss / toggle 50 / soak 1200000 / reduced` | See `PERFORMANCE.md`.                                                                                                                                                                                      |
| `node scripts/ad-hoc/pw-atomic-gateB-capture.mjs ...`                                                | All Gate B screenshots and 3 videos (headed Chrome, real GPU).                                                                                                                                             |

Not run: `npm run check:cycles`, `npm run check:docs-all` (docs here are under a task folder, not `docs/`). Not run: `npm run build`
(the production Next build) in this pass; the scene is exercised through the dev server only.

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

- Plan tests `shaderParams`, `energyState`, `reducedMotion`, `sceneDisposal`, `boltGeometry` exist from Part A; no new disposal test
  for the batched layers (disposal runs through `rtRegistry.disposeAll()` and is covered only by the soak and 50x toggle).
- No automated visual-regression diff in CI; visual evidence is the captured screenshots.
