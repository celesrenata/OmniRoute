# SKILL_APPLICATION (Gate B, round 6)

Code SHA `076bc2219ed03505ebeef69e9e9487dcb2cf434b`. Rules applied this round (what each changed in the work):

| Rule                                                                                                                                                                                       | Applied how                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPERATOR_DIRECTIVES.md` 26-31 (binding, win over ART_DIRECTION where they conflict)                                                                                                       | 26-29: LOD, reflective board with racing pulses, lit panel walls, hero platform. 30: four-tier energy ladder. 31: LOD band measured on the real dashboard and lowered to 16 -> 46 css px, LOD is the same atom, edge-only chromatic aberration, real `/home` before/after with the LOD fraction. Nucleons stay smooth glossy balls (directive 1). |
| Directive 30 honesty                                                                                                                                                                       | Tier 2 comes only from real timestamps (`observedModels.sampledAt`, snapshot `traffic: recent`); tier 1 is decorative and the tooltip says "idle, no measured activity"; nothing is synthesised.                                                                                                                                                  |
| `ART_DIRECTION.md` (idea5)                                                                                                                                                                 | Petal flowers, cyan rims, thin bright arcs, orange accents, holographic platform, reflective floor, bokeh.                                                                                                                                                                                                                                        |
| Hard freeze (camera/orbit/zoom/reset/auto-fit, `layout.ts`, `cameraFit.ts`, `SceneOrbitControls.tsx`, `AtomicLabels.tsx`, `AtomicControls.tsx`, 2D renderer, telemetry semantics, routing) | Empty diff vs `689178516`. New descriptor fields are derived read-only. Dev A/B toggles are query params only (`?platform=0`, `?pdbg=`).                                                                                                                                                                                                          |
| No quality tiers / "optimize, do not downgrade"                                                                                                                                            | The LOD renders the same atom for tiny projected sizes; full retina DPR + AA unchanged. Fallbacks only: reduced motion, WebGPU->WebGL2, device-loss recovery, 2D renderer. The energy "tiers" of directive 30 are semantic activity tiers, not render-quality tiers.                                                                              |
| AGENTS.md testing rule                                                                                                                                                                     | `smallAtomLod.test.ts`, `energyTiers.test.ts` added; shaders are exercised on a real GPU run only (stated in `TESTS.md`).                                                                                                                                                                                                                         |
| AGENTS.md Demo-grade verification                                                                                                                                                          | Every visual claim comes from a real headed-Chrome capture on the M5 Max, including the real `/home` dashboard and 12 s recordings; perf from the uncapped ladder; loss/toggle/reduced/fallback/soak from the harness.                                                                                                                            |
| AGENTS.md git and docs rules                                                                                                                                                               | Worktree on `feat/atomic-raytraced-renderer`, conventional commits with checks recorded, no AI attribution (hook passes), nothing pushed, working notes only under `OR_ATOM_010_RAYTRACED/`.                                                                                                                                                      |
| Failure-loop rule                                                                                                                                                                          | Two failed tuning attempts on the same symptom (pale disc) triggered bisection with part masks; the LOD "invisible at default" symptom triggered a debug read of the actual LOD input instead of more gain changes.                                                                                                                               |

---

# SKILL_APPLICATION (round 5 addendum)

Code SHA `96c17acf3`. `webgpu-threejs-tsl` (local) applied again: the DOF is a TSL node in the existing `RenderPipeline` (`pass()` color + `getViewZNode()`, `TextureNode.sample()` taps, `If` branch to skip zero-CoC pixels), uniforms updated per frame without allocation, no new render targets, no quality tiers. No network skills fetched.

---

# (history) SKILL_APPLICATION

Only skills that were actually read and used are listed. Nothing here was fetched from the network.

## `webgpu-threejs-tsl` (local, `OR_ATOM_009/research/skills/webgpu-threejs-tsl`)

Applied, exactly:

- Import discipline: scene code imports three classes only from `three/webgpu` and TSL from `three/tsl`. No `three` mixing
  inside the scene graph. Pure `scene/*.ts` model modules stay three-free (unit tested).
- `WebGPURenderer` with `await renderer.init()`, WebGL2 backend as fallback (`scene/rt/rendererFactory.ts`). R3F gets the
  renderer through an async `gl` factory (`scene/AtomicScene.tsx`).
- Node materials (`MeshBasicNodeMaterial`) with `positionNode` and `fragmentNode`; `Fn`, `Loop`, `If`, `select`, `varying`.
- `RenderPipeline` post chain with `pass()`, `bloom`, `rgbShift`, custom grade `Fn` (`createRtPost`).
- Uniform buffers via `buffer(...).setGroup(renderGroup)` for the batched per-atom fields and per-link fields (one
  upload per frame), with `addUpdateRange` so only the rows in use are written.
- `InstancedBufferGeometry` plus `instanceIndex` for the batched strands, wires, bolts, flares, links and motes.

Decisions that differ from, or go beyond, the skill text (found by measurement):

- Large indexed uniform buffers in the nucleon ray-trace loops were about 30 % slower at close range than small
  per-object uniforms, so the impostor keeps per-atom uniforms (`scene/rt/impostorSlot.ts`) while everything else is batched.
- A bare `.toVar()` is declared where it is first used. For per-pixel loops the field reads are assigned at the top of the
  calling `Fn` (`atomFields(..., eager)`), otherwise they land inside the march loop.
- Re-listing instanced draws per flicker (uploading an instance attribute) stalled about 40 ms, so bolts are one
  fixed-count draw that collapses unused slots.

## Environment / HDRI decision

Procedural neon studio environment and procedural room. No HDRI asset was fetched or committed. Reason: the palette match
and zero asset cost. The Gate A scorecard did not show glass reflections lacking detail, so the optional Poly Haven
HDRI was not adopted.

## Other skills

`interaction-design`, `performance`, `accessibility` (local corpus) informed the reduced-motion behaviour (static frame
per update, no strobing; failure shown as a steady red state instead of a flash) and the "one render per frame, no
per-frame React state" rule. No separate output was produced from them.

## Round 2

No new skills were applied. Review findings were handled with the measurement approach already used (headed Chrome on the M5 Max, uncapped probes,
side-by-side against `idea5.jpeg`), plus a viewport/atom-count/bloom sweep to narrow the stress-case stall.

## Round 3-4 (no new skills fetched)

Same `webgpu-threejs-tsl` skill. Additional TSL patterns used, all from `three/tsl` / `three/webgpu` as installed (three 0.186.1): `fwidth` for analytic anti-aliasing of the PCB artwork;
`texture()` of an R8 `DataTexture` for the haze field; `normalGeometry` / `normalWorld` / `positionGeometry` in `MeshBasicNodeMaterial.colorNode` for the instanced 3D parts;
`InstancedMesh` + `InstancedBufferAttribute` for per-instance variants; `mergeGeometries` from `three/addons/utils/BufferGeometryUtils.js`; `If`/`select` for branch-free strike gating.
Decisions found by measurement: dynamic branching by distance in the board shader was not added (fixed per-pixel cost; culling saved nothing measurable, see `PERFORMANCE.md`);
the haze texture is `UnsignedByteType` R8 (filterable without a float32-filterable feature).
No HDRI asset was added (procedural environment kept).
