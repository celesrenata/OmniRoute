# VISUAL_SCORECARD (Gate B)

Self-scored from the screenshots and 12 s videos named below. The reviewer scores independently. Same viewport (1600x1000 @2x),
same data (DEMO golden topology, labelled DEMO), same production camera. "Before" is the legacy renderer (`?atomic-fx=legacy`),
"After" is the default. Previews are under `screenshots/gateB/preview/` (full PNGs stay on disk, per the folder `.gitignore`).

Paired shots:

- Default zoom, 20 atoms: `preview/before-after-default.jpg` (left legacy, right ray-traced). Also `gateB-default-8/20/32.jpg`.
- Close-up on `provider:bench-primary` (3 model colours, production wheel zoom): `preview/before-after-close.jpg`, `gateB-close-primary.jpg`.
- Hub close-up: `gateB-close-hub.jpg`.
- idea5 side by side: `preview/sidebyside-idea5-default.jpg`, `sidebyside-idea5-close.jpg`, `sidebyside-idea5-close-hub.jpg`.
- Idle (nothing measured): `gateB-idle-20.jpg`. Failure: `gateB-failure-20.jpg`, `gateB-failure-burst-20.jpg`.
- WebGL2 backend: `gateB-webgl2-20.jpg`. Reduced motion: `gateB-reduced-20.jpg`.
- Videos (12 s, tracked): `screenshots/gateB/video/active-20.webm`, `idle-20.webm`, `failure-20.webm` (failure cycles error/recovered every 3 s).

| Criterion                                         | Before | After default | After close-up | Evidence and notes                                                                                                                                                                                                           |
| ------------------------------------------------- | -----: | ------------: | -------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saturated distinguishable model-coloured nucleons |      2 |             4 |              5 | Close: green, blue and magenta glossy glowing balls on `bench-primary`, hub red/violet. Default: nuclei are small (about 1/4 of the cloud); green/yellow/magenta cores read on the outer atoms, the dense centre hides some. |
| 3D luminous electron cloud and orbital trails     |      2 |             4 |              4 | Filled violet body, cyan sparkly rim, 11 orbit wires with electron heads. Default atoms are 30-60 px, so wires read as hairline loops.                                                                                       |
| Hairline filaments and transient discharges       |      2 |             4 |              4 | 2600 strands per atom, white-hot plasma links with packets, red branching bolt plus nucleus flash on failure (`gateB-failure-burst-20`).                                                                                     |
| Rich lighting, depth, bloom without washout       |      2 |             3 |              4 | Close-up keeps hues. At default with 20+ atoms the centre cluster (hub plus ring-1 atoms overlap in the 3D layout) goes pale pink-white. The crowd curve helps but does not fully remove it.                                 |
| Overall resemblance to target concept (idea5)     |      2 |             4 |              4 | Corridor, reflective grid floor with ripples and orange streaks, holographic domes, bokeh, cinematic grade, equatorial flare.                                                                                                |
| Immersion / sense of place                        |      1 |             4 |              4 | Camera-following room, per-atom pedestals, world-space bokeh motes with parallax. The room is mostly occluded at close range by design.                                                                                      |

Operational-truth row (idle vs measured distinguishable, nothing fabricated): **pass**. `gateB-idle-20` (`?idle=1`) shows every
atom in the lower energy state (dim, tight, greyer, no bolts, no packets, links dim and steady) next to `gateB-default-20` where
only atoms with measured tok/s / in-flight requests are excited. Tested in `rtTopologyScene.test.ts` (nothing measured -> `measured:false`).

## Honest defects (not hidden)

1. Default-zoom lighting scores 3: the overlapping centre cluster is washed toward pink-white at 20+ atoms. The layout is frozen, so
   the lever is the crowd curve. I tuned it once for idle atoms and stopped there.
2. Bokeh motes can be heavy near the camera in the 32-atom default view; I cut count (1400 to 900) and brightness once.
3. At default framing 20 atoms is small on screen, so the idea5 detail reads mainly at close range.
4. The failure bolt at default zoom is a thin red tendril; it is clearest in `gateB-failure-burst-20` and the video.
5. Labels (DOM, frozen) are drawn over the scene as before. Label legibility: contrast of the roster pills against the scene stays
   15.2-15.6:1 (legacy 14.9:1), sampled behind five pills on the 20-atom default (`gateB-default-20` vs `gateB-legacy-20`).
