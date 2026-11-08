# Gate B: full-topology integration, atmosphere, links, performance

Branch `feat/atomic-raytraced-renderer`, source SHA in `TESTS.md`. Not deployed, not pushed.
`OPERATOR_DIRECTIVES.md` was read and followed (balls kept and glowing, alive non-uniform rotating strands, crowd subdue, no quality tier, idea5 as the look reference).
`gateB.json` did not exist at the start of this round, so there were no review findings to fix first.

## Status against the plan

| Item                                                                   | Status                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 roll the golden atom across the graph (hub, provider, gpu, runtime) | Done. `scene/RtTopologyScene.tsx`, `scene/rt/atomBatch.ts`. Legacy light rig removed from the default path.                                                                                                                                                                             |
| C2 links and lightning                                                 | Done. `scene/shaders/linkStrand.ts`: batched ribbon, proven-only packets (`filament.ts`), completion impulse, red failure bolt plus nucleus flash. `provenPulse.ts`, `discharge.ts`, `oneShot.ts` reused. Old `plasmaInjection` tests are unchanged and pass (legacy path only).        |
| C3 atmosphere                                                          | Done, decorative only, scaled from layout bounds (read only). Corridor, reflective grid floor, instanced holographic pedestals, world-space DOF bokeh, post chain. Label contrast 15.2-15.6:1 vs 14.9:1 before. Replaced the flat background with the room (host canvas keeps `alpha`). |
| C4 collapse quality                                                    | Done. `quality.ts` is one profile. GPU gate = WebGPU or WebGL2.                                                                                                                                                                                                                         |
| C5 context / device loss                                               | Done and driven live for WebGPU and WebGL2 (3 forced losses each). The "2 failed restores -> 2D" path is implemented but was not driven in a browser.                                                                                                                                   |
| C6 reduced motion                                                      | Done. Static frame per update, orbit still renders, no strobing.                                                                                                                                                                                                                        |
| C7 perf                                                                | Real topology: 20-24 atoms 345 fps, 36 atoms 333 fps, p95 4.6 ms, p99 16.9 ms (targets met).                                                                                                                                                                                            |
| C7a batching                                                           | Done, target met on the real 32-atom topology. **Unmet** on the Gate A 32-atom grid stress case in uncapped mode (p95 42 ms, p99 44 ms), clean at 60 Hz (p99 17.3). See `PERFORMANCE.md`.                                                                                               |
| C8 review                                                              | Self-scored in `VISUAL_SCORECARD.md`: default lighting 3, everything else >= 4. Not all rows reach 4 at default zoom.                                                                                                                                                                   |

Not done in Gate B: deleting the legacy renderer (kept behind `?atomic-fx=legacy` until approval), GPU memory counters,
`npm run build`, a unit test for batched-layer disposal.

## Frozen-area guard

Empty diff vs `689178516` for `layout.ts`, `cameraFit.ts`, `labelCollision.ts`, `projection.ts`, `scene/SceneOrbitControls.tsx`,
`overlays/AtomicLabels.tsx`, `overlays/AtomicControls.tsx`, `ProviderTopology2D.tsx`. Camera, orbit, zoom, reset and auto-fit
code paths are the same functions (`CameraRig`, `CameraStateWriter` text-identical). Telemetry semantics and routing untouched.
Dev A/B only through query params: `?atomic-fx=legacy`, `?bloom=0`, `?backend=webgl`, bench `?idle=1`, `?failure=cycle`, `?atoms=`.

## Decisions I made that you may want to change

1. The impostor stays 2 draws per atom (not batched) because a batched uniform buffer measured about 30 % slower in the nucleon
   loops. Everything else is batched. That keeps 32 atoms at about 3 ms but means draw count grows with atom count (72 impostor draws at 36 atoms).
2. A failure shows a red branching bolt and a nucleus red flash for about 1.2 s (steady red under reduced motion). Colour is the
   existing failure red, not a model hue.
3. Hub is 1.6x the ring atom size, a focused atom 1.18x (same factor as before), so the hub reads as the primary object.

## Evidence index

See `VISUAL_SCORECARD.md` (images, videos), `PERFORMANCE.md` (numbers), `TESTS.md` (commands, SHA), `VISUAL_AUDIT.md`,
`SKILL_APPLICATION.md`. Reproduce: `node scripts/dev/run-next.mjs dev` (PORT 20199), then
`http://localhost:20199/dev/atomic-bench?atoms=20&paused=0` and the scripts `scripts/ad-hoc/pw-atomic-gateB*.mjs`.
