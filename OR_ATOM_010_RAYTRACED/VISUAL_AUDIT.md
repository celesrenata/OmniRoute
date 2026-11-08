# VISUAL_AUDIT: why the Step 8/9 Atomic topology looked flat, and what changed

Branch `feat/atomic-raytraced-renderer`. Source SHA is in `TESTS.md`. Before = the legacy renderer, since deleted (the
before images are historical captures). After = the default.

Evidence (all from headed Chrome on the Apple M5 Max, real GPU, DEMO data, same viewport and the production camera):
`screenshots/gateB/preview/before-after-default.jpg`, `before-after-close.jpg`, `sidebyside-idea5-default.jpg`,
`sidebyside-idea5-close.jpg`, `sidebyside-idea5-close-hub.jpg`.

## Why it looked flat (legacy renderer)

| Cause                                                                                                                                              | Where                                                                   | Effect                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Atoms were 8-24 instanced mesh spheres with a Fresnel `onBeforeCompile` patch. No real ray tracing, no inter-ball reflection, occlusion or shadow. | `scene/AtomNode.tsx`, `scene/Nucleus.tsx`, `scene/sceneResources.ts`    | Plastic dots. The model colours were a flat tint, not lit glass-like balls.             |
| The electron "cloud" was a few hundred additive sprites, capped by a quality tier.                                                                 | `scene/ElectronCloud.tsx`, `scene/cloudShells.ts`, `scene/cloudHaze.ts` | No volume, no radial plasma, no silhouette. Sprites piled up to white blobs.            |
| Links were `Line2` hairlines plus a plasma ribbon.                                                                                                 | `scene/EnergyLink.tsx`                                                  | Thick white bars at default zoom, no lightning character.                               |
| Bloom was an `EffectComposer` pass, off by default because it washed the scene.                                                                    | `scene/AtomicScene.tsx`, `quality.ts`                                   | No glow roll-off, no HDR. Everything sat at one brightness.                             |
| Flat `#05060f` background, `fogExp2`, ambient plus point light.                                                                                    | `scene/AtomicScene.tsx` `SceneContent`                                  | No sense of place. The atoms floated on a blank page.                                   |
| Quality tiers (`high`/`medium`/`low`/`none`) capped DPR at 2 or 1, dropped AA and shells by hardware probe.                                        | `quality.ts`, `AtomicTopologyRenderer.tsx`                              | The weakest supported machine (M5 Max) was still treated as something to downgrade for. |

## What changed (by file)

| File                                                                                  | Change                                                                                                                                                               |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scene/rt/atomBatch.ts`, `impostorSlot.ts`, `atomData.ts`, `atomLayout.ts`            | The approved Gate A atom (ray-traced nucleons, glass shell, volumetric cloud) on every atom, with all vertex-heavy layers batched across atoms (C7a).                |
| `scene/shaders/atomImpostor.ts`                                                       | Per-atom analytic ray trace of 24/40 nucleons plus a ray-marched cloud, model hues self-lit, never washed to white.                                                  |
| `scene/shaders/plasmaStrands.ts`, `orbitWire.ts`, `boltStrand.ts`, `atomFlares.ts`    | 2600 GPU hairline strands plus rim sparkles, 11 orbit wires with electron heads, fractal bolts, streak/glow/ring flares. One instanced draw per layer for all atoms. |
| `scene/shaders/linkStrand.ts`, `scene/RtTopologyScene.tsx`                            | Rebuilt links: screen-space plasma ribbon, proven-only packets, teal completion impulse, red branching failure bolt plus nucleus red flash.                          |
| `scene/shaders/environment.ts`, `scene/shaders/motes.ts`, `scene/rt/topologyScene.ts` | idea5 atmosphere scaled from layout bounds (read only): corridor, reflective grid floor, instanced holographic pedestals, world-space DOF bokeh motes.               |
| `scene/rt/rendererFactory.ts`                                                         | `WebGPURenderer` (WebGL2 backend fallback) plus the HDR post chain: bloom, edge RGB shift, split-tone grade, vignette, grain, ACES.                                  |
| `scene/AtomicScene.tsx`                                                               | `RtAtomicScene` (default), loss recovery, (legacy scene deleted). `CameraRig` and `CameraStateWriter` are byte-identical to `689178516`.                             |
| `quality.ts`, `capabilities.ts`, `index.ts`, `AtomicTopologyRenderer.tsx`             | Tiers removed. Single full-fidelity profile (uncapped DPR, AA, bloom). GPU gate is WebGPU or WebGL2, 2D otherwise.                                                   |

## Honest limits

- The room is decorative. It is tagged as such here and in code, and it never reads or changes layout positions.
- At the frozen default framing a 20-atom topology is small on screen, so per-atom detail reads mostly at close range.
  The default view shows glowing domed atoms, links and the room. The close-ups show the idea5 detail.
- The room corridor is rendered as a shader over a camera-following shell, so its racks are procedural, not modelled.
- The legacy path was deleted after round 2 (operator: "delete now"). Its quality-tier remnants (hardware probe, medium/low haze, LOW particle constants) were removed in round 2.

## Round 2 (review findings)

- Wash-out came from additive light stacking where atom discs overlap (centre cluster at default, neighbours in the focus view), which the per-atom
  size curve did not see. `atomBatch.ts` now measures screen-space overlap between atoms and divides the crowd gain by it.
- The "nested blue frames" back wall is now a rack wall (panels, vents, LEDs) with a bright doorway, and the side walls are brighter.
