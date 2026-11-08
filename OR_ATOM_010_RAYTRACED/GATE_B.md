# Gate B (round 2): full-topology integration, atmosphere, links, performance

Branch `feat/atomic-raytraced-renderer`, code SHA `9368b50a1d67b35919da82d1be4cf1c49051f854` (see `TESTS.md`). Not deployed, not pushed.
`OPERATOR_DIRECTIVES.md` was read and followed. `gateB.json` (CHANGES_REQUESTED, 8 findings) and its review doc were read first;
each finding is answered below.

## Findings fixed

| #   | Finding                                 | Result                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Close-up wash-out                       | Fixed. `atomBatch.ts` now projects every atom and divides the crowd gain by `1 + 0.7 * overlap` (covered fraction weighted by neighbour size, floor 0.12). Isolated atoms have overlap 0, so single/pair/close Gate A views are unchanged. `screenshots/gateB/preview/sidebyside-idea5-close.jpg` now keeps the violet body, cyan rim and green/blue/magenta nucleons on the focused atom. |
| 2   | Default-zoom wash-out                   | Fixed by the same overlap term (no camera, layout or exposure change). The centre cluster in `gateB-default-32.jpg` / `gateB-default-20.jpg` keeps deep violet/cyan hues. Trade-off: crowded centre atoms are now darker than before, by design.                                                                                                                                           |
| 3   | Immersion (back wall = nested frames)   | Fixed in kind. The back wall is now a procedural rack wall (panels, vent slats, warm/cyan LEDs) with a bright doorway, the side walls are 1.9x brighter. It is still shader-procedural and hazy at the far end, not modelled geometry.                                                                                                                                                     |
| 4   | Generous self-scores                    | Rescored in `VISUAL_SCORECARD.md`. Two rows stay below 4 at default zoom and are stated as such.                                                                                                                                                                                                                                                                                           |
| 5   | 32-atom grid stress unmet uncapped      | Cause investigated, not hidden. See `PERFORMANCE.md` "Stress-case diagnosis". Still unmet in uncapped p95/p99. The fps targets on the real topology are met. **I need an explicit operator decision whether to accept this.**                                                                                                                                                              |
| 6   | Inconsistent perf figures               | One canonical run now (`PERFORMANCE.md` top). The old 318/281/226/207 and 370/370/345/333 numbers are superseded; they were taken under different GPU load. "atoms=20" renders 24 atoms; the table says so.                                                                                                                                                                                |
| 7   | 2-failed-restores fallback never driven | Driven: `pw-atomic-gateB.mjs fallback` with dev flag `?restore-fail=1` on the real `/home` host. Forced device loss, rebuilds fail, host returned to the 2D renderer in 1.7 s (`2D` pressed, 0 atomic canvases).                                                                                                                                                                           |
| 8   | Hygiene                                 | Hardware-concurrency haze probe, medium/low haze tiers and LOW particle constants removed; `atomBatchDispose.test.ts` added; `npm run build` run and green. The legacy renderer itself still exists behind `?atomic-fx=legacy` for before/after captures; delete it before merge (decision below).                                                                                         |

## Status against the plan

C1 golden atom on every node, C2 links/lightning, C3 atmosphere, C4 no quality tiers (single profile, uncapped DPR, AA, bloom),
C5 device/context loss + 2D fallback (now driven), C6 reduced motion, C7/C7a perf, C8 review: done as described in `PERFORMANCE.md`,
`TESTS.md`, `VISUAL_SCORECARD.md`. Fallbacks that exist: reduced motion, WebGPU->WebGL2, context/device-loss rebuild, host 2D when no GPU rendering.

## Frozen-area guard

`git diff 689178516` is empty for `layout.ts`, `cameraFit.ts`, `labelCollision.ts`, `projection.ts`, `scene/SceneOrbitControls.tsx`,
`overlays/AtomicLabels.tsx`, `overlays/AtomicControls.tsx`, `ProviderTopology2D.tsx`. Dev A/B only through query params
(`?atomic-fx=legacy`, `?bloom=0`, `?backend=webgl`, `?restore-fail=1`, bench `?idle=1`, `?failure=cycle`, `?atoms=`).

## Decisions for the operator

1. Accept the Gate A 32-atom grid stress result (uncapped p95/p99 spikes, fps 107-121 and p50 7.6 ms) or ask for more geometry work?
2. Delete the legacy renderer now (loses the before/after toggle and ~7 legacy test files) or at merge time?
3. Cloud/orbit detail at the frozen default framing reads small (atoms are 40-90 px). Closing that gap needs a camera/layout change, which is frozen.

## Evidence index

`VISUAL_SCORECARD.md`, `PERFORMANCE.md`, `TESTS.md`, `VISUAL_AUDIT.md`, `SKILL_APPLICATION.md`. Reproduce: dev server on `:20199`
from this worktree, then `http://localhost:20199/dev/atomic-bench?atoms=20&paused=0` and `scripts/ad-hoc/pw-atomic-gateB*.mjs`.
