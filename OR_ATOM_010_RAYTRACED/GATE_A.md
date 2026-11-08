# Gate A: golden ray-traced atom (isolated dev bench)

Branch `feat/atomic-raytraced-renderer`. Nothing is integrated into the production topology; the legacy renderer, camera, layout, labels, controls and 2D renderer are untouched (`git diff 689178516` over the frozen files is empty).

## How to see it

```
node scripts/dev/run-next.mjs dev            # PORT=20199
http://localhost:20199/dev/atomic-bench?atomic-fx=rt&golden=provider&models=3&energy=excited
```

Params: `golden=provider|gpu|hub`, `dist=default|close`, `models=1|3|unknown|stale`, `energy=idle|excited|both`, `az=<deg>`, `backend=webgpu|webgl`, `bloom=0|1`, `reduced=1`, `paused=1&t=<s>` (deterministic frame), `steps=<n>` (profiling), `badge=0`.
Capture (headed Chrome, real GPU, never headless): `scripts/ad-hoc/pw-atomic-gateA-all.sh`, live/FPS: `scripts/ad-hoc/pw-atomic-gateA-live.mjs`.

## What was built

- Renderer: `three/webgpu` `WebGPURenderer` + TSL, built-in WebGL2 backend as fallback (`scene/rt/rendererFactory.ts`). `three` 0.186.1 and `@react-three/fiber` 9.8.1 pinned exactly (lockfile diff = specifier lines only). The bench uses raw three (no R3F), one three instance.
- Per-atom shader (`scene/shaders/atomImpostor.ts`): one camera-facing impostor quad. Per pixel it analytically ray-traces the glass shell (Fresnel, refraction) and up to 64 nucleon spheres (GGX-style gloss, one reflection bounce against the other nucleons, Quilez analytic sphere AO and soft shadows, procedural neon studio environment for reflections, faceted normals, inner glow), then ray-marches a volumetric electron cloud (orbital p/d lobe density x radial plasma filaments built as intersections of two noise zero-sheets, lane-hued violet interior grading to a sparkly cyan rim, embedded sparkle motes, equatorial flare, core flare) terminated analytically at the nucleus hit. A mirrored second impostor gives the floor reflection.
- Wires and electrons (`shaders/orbitWire.ts`): 10 thin HDR wires with travelling highlight, glowing electrons; hidden behind the nucleus by analytic occlusion.
- Lightning (`shaders/boltStrand.ts`, `scene/boltGeometry.ts`): seeded fractal midpoint-displacement bolts with branches and sparks, camera-facing ribbons, white-hot core plus lane-hued halo, only for measured/excited state.
- Environment (`shaders/environment.ts`): server-room corridor (racks, screens, LEDs, depth-softened), reflective tech floor (grid, circuit traces, orange streaks, ripple rings), glass pedestal dome, bokeh orbs and dust at three depths.
- Post (`rendererFactory.ts`): HDR scene pass, bloom (threshold 1.0), edge RGB shift, split-tone grade, vignette, grain, ACES + sRGB. Full retina DPR, no cap, hardware MSAA (`antialias: true`).
- Pure models, unit tested: `energyState.ts` (idle = lower energy state: brightness/saturation floor 0.35, tighter cloud 0.8x, slow decorative drift, no spin and no bolts unless measured), `shaderParams.ts` (bounds), `nucleonPack.ts` (packs the production `buildNucleusCluster` into 24+10 / 40+16 packed nucleons), `orbitalDensity.ts`, `boltGeometry.ts`, `rt/rtRegistry.ts` (disposal).

## Evidence (real GPU)

Hardware: Apple M5 Max, Chrome (`channel: "chrome"`, headed), WebGPU adapter `apple / metal-3`. Viewport 1672x941 CSS at DPR 2 = 3344x1882 px. Full-resolution PNGs are on disk (git-ignored); tracked JPEG previews live in `screenshots/gateA/preview/`.

- Condition matrix (all captured): `gateA-provider-{default,close}-{1c,3c,unknown,stale}`, `gateA-provider-{default,close}-3c-idle`, `gateA-gpu-{default,close}-3c`, `gateA-hub-{default,close}`, `gateA-idle-vs-excited`, `gateA-3c-az{90,180,270}`, `gateA-webgl2-fallback`.
- Side-by-side: `sidebyside-neon_gpu_atom-{default,close}-3c`, `sidebyside-idea5-{default,close}-3c`, `sidebyside-idea5-idle-vs-excited`.
- Live (animated, unpaused) frame pairs ~6.5 s apart: `live/`. Mean abs pixel difference between the two live frames: 9.3/255 (animating). With `reduced=1`: exactly 0.0 (bit-identical frames, no motion or strobing).
- WebGPU and forced WebGL2 backends both render (`data-backend` = `webgpu` / `webgl`).

### Measured frame times (requestAnimationFrame deltas over 5 s, 3344x1882, one atom unless noted)

| Case                                     | p50     | p95     | p99     |
| ---------------------------------------- | ------- | ------- | ------- |
| excited, default distance, WebGPU        | 16.7 ms | 17.3 ms | 17.6 ms |
| idle, default distance, WebGPU           | 16.7 ms | 18.0 ms | 18.4 ms |
| idle + excited pair, default             | 16.7 ms | 18.3 ms | 18.6 ms |
| excited, default, forced WebGL2          | 16.7 ms | 17.4 ms | 17.6 ms |
| excited, close-up (atom fills the frame) | 34.2 ms | 51.1 ms | 51.9 ms |

Default distance runs at the 60 Hz vsync cap, so true headroom is not measured. Close-up is about 29 fps and is below target (60). The 120 fps / 20-atom target from the plan is NOT demonstrated; per-step cost of the filament noise dominates (the march step count was measured: 48 steps ~58 fps, 88 steps ~20 fps, before the cheaper noise). The fix for Gate B is baking the filament field to a texture and coverage-scaled steps.

## Scorecard (self-assessment; reviewer scores independently)

| Criterion                                            | Default | Close | Notes                                                                                                                                 |
| ---------------------------------------------------- | ------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Saturated distinguishable model-colored nucleons     | 3       | 3     | Idle is saturated and clearly 3-hued; the excited state washes toward pastel under the cloud and bloom.                               |
| 3D luminous electron cloud and orbital trails        | 4       | 4     | True volume, dense radial filaments, defined cyan rim, sparkle motes, 10 wires. Interior contrast is still lower than idea5.          |
| Hairline electric filaments and transient discharges | 4       | 4     | Fractal branching bolts with sparks, filaments as above.                                                                              |
| Rich lighting, depth, bloom without washout          | 3       | 3     | Reflections, AO, refraction work. Excited cloud carries a lavender haze, not idea5's deep violet.                                     |
| Overall resemblance to target                        | 3       | 3     | Structure matches (faceted refractive nucleus, flare, filaments, rim, wires, motes). Idea5's deep-contrast look is only approximated. |
| Immersion / sense of place                           | 4       | 4     | Corridor, reflective floor with mirrored atom, pedestal dome, bokeh. Corridor end is a plain glow, not idea5's deep racks.            |

Not claimed as >= 4 everywhere: rows 1, 4, 5 are honestly 3 for the excited state.

## Deviations from the plan (stated, not hidden)

- One combined impostor draw instead of separate nucleus and cloud draws; no frag-depth write (single-atom bench). Depth correctness for multi-atom is a Gate B item.
- Environment is an analytic procedural neon studio function evaluated in the shader, not a PMREM/HDRI; no TAA yet; MSAA via renderer `antialias`.
- Filament noise is a hashed value noise (the MaterialX perlin was ~2x slower).
- Production quality tiers and sprite caps (`quality.ts`, `cloudShells.ts`, `cloudHaze.ts`) were NOT removed: the RT path has no tiers, and the legacy path stays until Gate B replaces it.
- Provider observed-model adapter (Part B) is not part of Gate A; the bench feeds model ids directly.
- Bugs found only by the live (unpaused) run and fixed: negative first-frame dt made the bolt-variant index negative (crash on WebGL2 live); bolt ribbons were offset by the atom position (pair case). Paused-only captures hid both.

## Commands run

- `node --import tsx/esm --test tests/unit/atomic-topology/*.test.ts`: 426 tests, 425 pass, 0 fail (1 skipped); includes new `energyState.test.ts` (8) and `shaderParams.test.ts` (7).
- `npm run typecheck:core`: 45 errors, all pre-existing and outside this work (none reference `atomic`).
- `npx eslint src/plugins/atomic-topology src/app/dev/atomic-bench tests/unit/atomic-topology`: 0 errors. `npm run lint`: 7 errors, all in pre-existing scriptVault files (`open-sse/mcp-server/tools/scriptVaultTools.ts`, `src/lib/db/scripts.ts`, `src/lib/scripts/scriptVault.ts`).
