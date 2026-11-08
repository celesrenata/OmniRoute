# Gate A: golden ray-traced atom (isolated dev bench)

Branch `feat/atomic-raytraced-renderer`. Nothing is integrated into the production topology; the legacy renderer, camera, layout, labels, controls and 2D renderer are untouched (`git diff 689178516` over the frozen files is empty).

## How to see it

```
node scripts/dev/run-next.mjs dev            # PORT=20199
http://localhost:20199/dev/atomic-bench?atomic-fx=rt&golden=provider&models=3&energy=excited
```

Params: `golden=provider|gpu|hub`, `dist=default|close`, `models=1|3|unknown|stale`, `energy=idle|excited|both`, `az=<deg>`, `backend=webgpu|webgl`, `bloom=0|1`, `reduced=1`, `paused=1&t=<s>` (deterministic frame), `steps=<n>` (profiling), `count=<1..32>` (multi-atom load test on a grid), `badge=0`.
Capture (headed Chrome, real GPU, never headless): `scripts/ad-hoc/pw-atomic-gateA-all.sh`, live/FPS: `UNCAPPED=1 scripts/ad-hoc/pw-atomic-gateA-live.mjs <out> <name> <query>` (`UNCAPPED=1` adds `--disable-frame-rate-limit --disable-gpu-vsync`, so frame times are GPU headroom, not the 60 Hz cap).

## What was built

- Renderer: `three/webgpu` `WebGPURenderer` + TSL, built-in WebGL2 backend as fallback (`scene/rt/rendererFactory.ts`). `three` 0.186.1 and `@react-three/fiber` 9.8.1 pinned exactly (lockfile diff = specifier lines only). The bench uses raw three (no R3F), one three instance.
- Per-atom shader (`scene/shaders/atomImpostor.ts`): one camera-facing impostor quad. Per pixel it analytically ray-traces the glass shell (Fresnel, refraction) and up to 64 nucleon spheres (GGX-style gloss, one reflection bounce against the other nucleons, Quilez analytic sphere AO and soft shadows, procedural neon studio environment for reflections, faceted normals, inner glow), then ray-marches a volumetric electron cloud (orbital p/d lobe density x radial plasma filaments built as intersections of two noise zero-sheets, lane-hued violet interior grading to a sparkly cyan rim, embedded sparkle motes, equatorial flare, core flare) terminated analytically at the nucleus hit. A mirrored second impostor gives the floor reflection.
- Wires and electrons (`shaders/orbitWire.ts`): 14 thin lane-coloured HDR wires with travelling highlight, glowing electrons; hidden behind the nucleus by analytic occlusion.
- Lightning (`shaders/boltStrand.ts`, `scene/boltGeometry.ts`): seeded fractal midpoint-displacement bolts with branches and sparks, camera-facing ribbons, white-hot core plus lane-hued halo, only for measured/excited state.
- Environment (`shaders/environment.ts`): server-room corridor (racks, screens, LEDs, depth-softened), reflective tech floor (grid, circuit traces, orange streaks, ripple rings), glass pedestal dome, bokeh orbs and dust at three depths.
- Post (`rendererFactory.ts`): HDR scene pass, bloom (threshold 1.0), edge RGB shift, split-tone grade, vignette, grain, ACES + sRGB. Full retina DPR, no cap, hardware MSAA (`antialias: true`).
- Pure models, unit tested: `energyState.ts` (idle = lower energy state: brightness/saturation floor 0.35, tighter cloud 0.8x, slow decorative drift, no spin and no bolts unless measured), `shaderParams.ts` (bounds), `nucleonPack.ts` (packs the production `buildNucleusCluster` into 24+10 / 40+16 packed nucleons), `orbitalDensity.ts`, `boltGeometry.ts`, `rt/rtRegistry.ts` (disposal).

## Round 2: changes against every Gate A finding

| #   | Finding (gateA.md)                       | What changed                                                                                                                                                                                                                                                                                                                                                                                                                      | Evidence                                                                                                    |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | Cloud is faint haze, not volume          | New absorbing plasma body (`mediumSample` in `atomImpostor.ts`): a lobe-shaped extinction that absorbs only the room BEHIND the cloud (separate background transmittance), so the cloud reads as a deep violet volume while nucleus and strands stay crisp. Low-frequency petal voids mask the filaments into bundles with dark gaps; the sub-pixel third filament octave (freq 104) was removed because it averaged into a wash. | `gateA-provider-default-3c`, `sidebyside-idea5-default-3c`                                                  |
| 2   | Excited washes to pastel / near-white    | Bloom 0.4/0.6/1.0 -> 0.26/0.55/1.15 (strength/radius/threshold). Additive haze 0.0 -> lobe-shaped volume via absorption, not addition. Nucleon glow and core flare cut, hue-deepening `pow(c, 1.4)` grade on plasma and `pow(c, 1.25)` on wires, bolt cores only 30% toward white (was 85%), electrons 5.0 -> 2.6.                                                                                                                | `gateA-provider-close-1c`, `gateA-provider-close-3c`                                                        |
| 3   | Filaments/discharges too sparse          | Bolt slots 3 -> 8 (thresholds 0.25..0.92 excitation), lane-hued (green/blue/violet/cyan/magenta) instead of all white; wires 10 -> 14 (MAX_WIRES 8 -> 14), each lane-coloured with matching electrons.                                                                                                                                                                                                                            | `gateA-gpu-close-3c`, `gateA-hub-close`                                                                     |
| 4   | 3rd model colour not distinguishable     | Bench model ids chosen so production `modelColor()` hashes to green / blue / violet (unit test asserts >50 deg hue separation). Nucleon vivid grade 1.35 -> 1.6.                                                                                                                                                                                                                                                                  | `gateA-provider-close-3c` (green left, blue centre, magenta right), `gateA-provider-close-3c-idle`          |
| 5   | Hub close-up has no cloud                | Hub gets its own cloud palette (red/violet/cyan interior, cyan rim) instead of the provider lane mix that vanished against the red nucleus.                                                                                                                                                                                                                                                                                       | `gateA-hub-close`, `sidebyside-idea5-hub-close`                                                             |
| 6   | Close-up 34/51 ms, default vsync-capped  | Measured UNCAPPED. Filament noise baked into a shared 64^3 RGBA8 tileable 3D texture (hardware trilinear, explicit LOD) instead of 8 hashed lattice points per sample; chord-scaled march steps; bolt halo+core merged into one ribbon (half the additive overdraw, the single largest close-up cost: 16.3 -> 9.6 ms).                                                                                                            | table below                                                                                                 |
| 7   | Bokeh/dust flat discs                    | Hexagonal aperture blended with round, per-depth defocus (near layers wide soft edge, far crisp), interior gradient and per-orb intensity.                                                                                                                                                                                                                                                                                        | `gateA-provider-default-3c` background                                                                      |
| 8   | Legacy quality tiers                     | Unchanged in Gate A (as accepted); removal is a Gate B item. The RT path has no tiers: full retina DPR 2, MSAA, no caps.                                                                                                                                                                                                                                                                                                          | n/a                                                                                                         |
| 9   | unknown / gpu / az / WebGL2 not reviewed | All 19 conditions recaptured this round; previews of every one are tracked in `screenshots/gateA/preview/`.                                                                                                                                                                                                                                                                                                                       | `gateA-provider-{default,close}-unknown`, `gateA-gpu-*`, `gateA-3c-az{90,180,270}`, `gateA-webgl2-fallback` |

Also fixed: bench remount reused a canvas whose WebGL2 context had been lost by `dispose()` (StrictMode / param change); it now creates a fresh canvas per mount. Idle absorption scales with brightness^2 so the low-energy atom greys and calms instead of reading as a dark sooty ball.

## Evidence (real GPU)

Hardware: Apple M5 Max, Chrome (`channel: "chrome"`, headed), WebGPU adapter `apple / metal-3`. Viewport 1672x941 CSS at DPR 2 = 3344x1882 px. Full-resolution PNGs are on disk (git-ignored); tracked JPEG previews live in `screenshots/gateA/preview/`.

- Condition matrix (all 19 recaptured, all `state=ok`): `gateA-provider-{default,close}-{1c,3c,unknown,stale}`, `gateA-provider-{default,close}-3c-idle`, `gateA-gpu-{default,close}-3c`, `gateA-hub-{default,close}`, `gateA-idle-vs-excited`, `gateA-3c-az{90,180,270}`, `gateA-webgl2-fallback` (`data-backend=webgl`).
- Side-by-side with idea5: `sidebyside-idea5-{default-3c,close-3c,idle-vs-excited,hub-close,count20}`; with neon_gpu_atom: `sidebyside-neon_gpu_atom-{default,close}-3c`.
- Live, animated, uncapped frame pairs: `live/r2-*-{a,b}.png` (previews `preview/live_r2-*`).

### Measured frame times, UNCAPPED (rAF deltas over 5 s, 3344x1882 DPR 2, vsync and frame-rate limit disabled)

| Case                                              | p50     | p95     | p99     | ~fps (p50) |
| ------------------------------------------------- | ------- | ------- | ------- | ---------- |
| 1 atom excited, default distance, WebGPU          | 4.3 ms  | 4.8 ms  | 21.8 ms | 233        |
| 1 atom idle, default                              | 3.5 ms  | 3.8 ms  | 15.2 ms | 286        |
| idle + excited pair, default                      | 4.4 ms  | 4.7 ms  | 22.7 ms | 227        |
| 1 atom excited, default, forced WebGL2            | 5.8 ms  | 7.4 ms  | 11.6 ms | 172        |
| provider close-up (atom fills the frame), excited | 9.6 ms  | 10.0 ms | 44.6 ms | 104        |
| hub close-up, excited                             | 10.5 ms | 10.8 ms | 45.3 ms | 95         |
| 20 atoms excited (`count=20`, grid)               | 5.6 ms  | 6.6 ms  | 12.5 ms | 179        |
| 32 atoms excited (`count=32`, grid)               | 9.1 ms  | 10.0 ms | 10.5 ms | 110        |

Round 1 close-up was 34.2 / 51.1 ms (capped run). Targets (~120 fps at ~20 atoms, >=60 fps at 32) are met in the bench at full DPR + AA. Caveats, stated: the multi-atom grid camera sits farther back so each atom covers fewer pixels than in a close-up (it is a load test, not the production layout); atoms are not depth-sorted against each other yet (Gate B); p99 spikes in the single-atom runs coincide with the screenshot taken at the start of sampling. Profiling breakdown at close-up before the bolt merge: bloom ~4 ms, bolts ~4.5 ms, march steps 96 -> 12 saves only ~2 ms (fill/overdraw bound, not step bound).

## Scorecard (self-assessment; reviewer scores independently)

| Criterion                                            | Default | Close | Notes                                                                                                                                                            |
| ---------------------------------------------------- | ------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saturated distinguishable model-colored nucleons     | 4       | 4     | Green / blue / magenta separate in excited and idle; 1-model atom is a saturated blue, not near-white.                                                           |
| 3D luminous electron cloud and orbital trails        | 4       | 3     | Default now reads as a deep violet volume with darker petal gaps and a cyan rim. Close-up is still a lavender radial field; it lacks idea5's large swept petals. |
| Hairline electric filaments and transient discharges | 4       | 4     | 8 lane-hued branching bolts, 14 lane-coloured wires.                                                                                                             |
| Rich lighting, depth, bloom without washout          | 4       | 3     | Bloom and additive haze cut; close-up interior is still brighter than idea5's.                                                                                   |
| Overall resemblance to target                        | 3       | 3     | Structure matches; idea5's flower-petal plasma and small crystalline nucleus are not reproduced (our nucleus is larger relative to the cloud).                   |
| Immersion / sense of place                           | 4       | 4     | Corridor, reflective floor with mirrored atom, pedestal, hex bokeh; the 20/32-atom grid reads as a server hall.                                                  |

Not claimed as >= 4 everywhere: close-up cloud, close-up washout and overall resemblance remain 3.

## Deviations from the plan (stated, not hidden)

- One combined impostor draw instead of separate nucleus and cloud draws; no frag-depth write (single-atom bench). Depth correctness for multi-atom is a Gate B item.
- Environment is an analytic procedural neon studio function evaluated in the shader, not a PMREM/HDRI; no TAA yet; MSAA via renderer `antialias`.
- Filament noise is a baked 64^3 tileable value-noise 3D texture (round 2; was per-sample hashed lattice).
- Production quality tiers and sprite caps (`quality.ts`, `cloudShells.ts`, `cloudHaze.ts`) were NOT removed: the RT path has no tiers, and the legacy path stays until Gate B replaces it.
- Provider observed-model adapter (Part B) is not part of Gate A; the bench feeds model ids directly.
- Bugs found only by the live (unpaused) run and fixed: negative first-frame dt made the bolt-variant index negative (crash on WebGL2 live); bolt ribbons were offset by the atom position (pair case). Paused-only captures hid both.

## Commands run (round 2, from the worktree)

- `node --import tsx/esm --test tests/unit/atomic-topology/*.test.ts`: 432 tests, 431 pass, 0 fail, 1 skipped (adds `noiseBake.test.ts`: baked volume determinism/range/sharing, MAX_WIRES, 3-model hue separation, reduced motion, medium extinction bounds).
- `npm run typecheck:core`: 45 errors, all pre-existing, none in atomic files.
- `npm run lint`: 7 errors, all pre-existing scriptVault files (`open-sse/mcp-server/tools/scriptVaultTools.ts`, `src/lib/db/scripts.ts`, `src/lib/scripts/scriptVault.ts`). `npx eslint src/plugins/atomic-topology src/app/dev/atomic-bench tests/unit/atomic-topology`: 0 errors.
- Frozen files (`layout.ts`, `cameraFit.ts`, `SceneOrbitControls.tsx`, `AtomicLabels.tsx`, `AtomicControls.tsx`, 2D renderer): `git diff 689178516` empty.
- `zsh scripts/ad-hoc/pw-atomic-gateA-all.sh`: 19/19 `state=ok`, adapter `apple/metal-3`.
- `UNCAPPED=1 node scripts/ad-hoc/pw-atomic-gateA-live.mjs ...` for each row of the frame-time table.
