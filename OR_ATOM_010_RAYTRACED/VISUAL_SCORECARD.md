# VISUAL_SCORECARD (Gate B, round 2)

Self-scored from the screenshots and 12 s videos named below, then compared with the reviewer's `gateB.md` scores. The reviewer scores independently.
Code SHA `9368b50a1d67b35919da82d1be4cf1c49051f854`. Same viewport (1600x1000 @2x), same data (DEMO golden topology, labelled DEMO), same production camera.
"Before" is the legacy renderer (`?atomic-fx=legacy`), "After" the default. Previews: `screenshots/gateB/preview/` (full PNGs stay on disk).
Paired shots:

- Default zoom: `preview/before-after-default.jpg`, `gateB-default-8/20/32.jpg`, **idea5 side by side** `sidebyside-idea5-default.jpg`.
- Close-up on `provider:bench-primary` (production wheel zoom): `preview/before-after-close.jpg`, `gateB-close-primary.jpg`, **idea5 side by side** `sidebyside-idea5-close.jpg`.
- Hub close-up: `gateB-close-hub.jpg`, `sidebyside-idea5-close-hub.jpg`.
- Idle: `gateB-idle-20.jpg`. Failure: `gateB-failure-20.jpg`, `gateB-failure-burst-20.jpg`. WebGL2: `gateB-webgl2-20.jpg`. Reduced motion: `gateB-reduced-20.jpg`.
- Videos (12 s): `screenshots/gateB/video/active-20.webm`, `idle-20.webm`, `failure-20.webm`.
  | Criterion                                                                                                                                                | Before | After default | After close-up | Evidence and notes                                                                                                                                                                                                                                                   |
  | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: | ------------: | -------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Saturated distinguishable model-coloured nucleons                                                                                                        |      2 |             4 |              4 | Close: green, blue and magenta glowing balls survive on the focused atom and its neighbours; hub magenta ball is clear. Default: nuclei are small, green/magenta cores read on outer atoms, the dense centre hides some.                                             |
  | 3D luminous electron cloud and orbital trails                                                                                                            |      2 |         **3** |              4 | Close: violet body with dark petal voids, pink/orange motes, cyan rim, orbit wires. Default: atoms are 40-90 px, so the cloud reads as a glowing orb, not idea5's flower; orbit wires are hairlines. Fixing it needs a bigger on-screen atom (camera/layout frozen). |
  | Hairline filaments and transient discharges                                                                                                              |      2 |             4 |              4 | 2600 strands per atom, white-hot links with packets, red branching bolt plus nucleus flash on failure.                                                                                                                                                               |
  | Rich lighting, depth, bloom without washout                                                                                                              |      2 |         **4** |          **4** | Was 3 / 2 in the review. The overlap subdue removes the pink-white blob in both the 32-atom centre cluster and the focus view. Cost: centre atoms are deliberately darker.                                                                                           |
  | Overall resemblance to target concept (idea5)                                                                                                            |      2 |         **3** |          **3** | Platform domes, reflective floor with orange streaks, rack-wall corridor, bokeh and grade are present. The atom itself is not yet idea5's dense dark-violet radial flower at this scale, and in the focus view neighbours clutter the frame.                         |
  | Immersion / sense of place                                                                                                                               |      1 |             4 |          **3** | Default: rack/panel/LED walls, floor streaks, pedestals, bokeh with parallax read as a room. Close-up: the room is mostly occluded by design, and the far wall is still a hazy procedural shader.                                                                    |
  | Rows below the 4/5 bar: cloud at default (3), resemblance (3 / 3), immersion at close-up (3). I am not claiming the visual bar is fully met.             |
  | Operational-truth row (idle vs measured distinguishable, nothing fabricated): **pass**. `gateB-idle-20` (`?idle=1`) shows every atom in the lower-energy |
  | state next to `gateB-default-20` where only atoms with measured tok/s / in-flight requests are excited. Tested in `rtTopologyScene.test.ts`.             |

## Honest defects

1. Default framing keeps atoms small, so cloud/orbit detail reads mainly at close range. Not fixable without touching the frozen camera/layout.
2. The overlap subdue darkens the crowded centre by design; the very centre of 32 atoms is a dim violet clump rather than a bright hub.
3. The far wall is hazy; racks are procedural patterns, not geometry.
4. The failure bolt at default zoom is a thin red tendril; clearest in `gateB-failure-burst-20` and the video.
5. Labels (DOM, frozen) overlay the scene as before; contrast was 15.2-15.6:1 in round 1 and the room was only made brighter at the side walls this round (not re-sampled).
