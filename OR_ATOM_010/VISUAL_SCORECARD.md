# OR-ATOM-010 visual scorecard

Comparison protocol: **identical viewport (1600×1000), identical golden DEMO
snapshot (6 atoms — 1 hub + 5 anchor providers), identical default camera pose
(auto-fit, `fitRadius`), identical provenance (`DEMO`, `source=bench`),
`paused=1`** — so the only variable is the renderer. `before_*` = the Step 8/9
baseline; `after_t105*` = this OR-ATOM-010 cinematic pass. Screenshots were
captured in the same run family (`scripts/ad-hoc/pw-atomic-bench-capture.mjs`)
on the same headless-Chromium SwiftShader (WebGL2) backend.

**Two cinematic passes:** `after_t105*` (T10.2→T10.5: fresnel rim injection,
luminous haze, hairline filament profile, ACES color science at exposure 1.1)
and `after_t105b*` (T10.5 retune: renderer exposure lifted 1.1 → 1.65,
per-state emissive lifted, glow/halo/trail/hairline opacities and widths
lifted — **material/color-science only**, no layout/camera/label/controls
change). This scorecard is updated against the `after_t105b` run, which is the
current renderer state.

| Criterion                                            | Before / 5 | After / 5 | Screenshot evidence / notes                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ---------: | --------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saturated distinguishable model-colored nucleons     |          2 |     **4** | `after_t105b_provider_bench-primary` / `_gpu_bench-host_bench-gpu-a` closeup: the anchor orb now reads as a **luminous saturated nucleus** (bright core + additive halo) instead of a pale grey-blue ball; the error atom stays **red** (`after_t105b_provider_bench-error`) so per-state color truth is preserved, and the hub/other anchors stay blue — color truth intact.                                                                                                |
| 3D luminous electron cloud and orbital trails        |          1 |     **4** | `after_t105b_*` closeups: the orbital trails now read as **neon rings** (opacity 0.18 → 0.3, tube 0.25 → 0.35, electron sprite scale 0.13 → 0.22 per `ELECTRON_SPRITE_SCALE`) on the deep-navy field — the cloud reads as a luminous 3D volume around the nucleus, not a flat dim disc.                                                                                                                                                                                      |
| Hairline electric filaments and transient discharges |          2 |     **2** | `after_t105b_default` full topology: the links now read as **visible neon hairlines** (core width 0.75 → 1.1 world units per `FILAMENT_CORE_WIDTH`; ribbon half-width 0.5 per `RIBBON_HALF_WIDTH`) — the links are now a visible neon hairline at fit framing (vs near-invisible before), but still faint at default zoom, and the _transient discharge_ motion is not evidenced in a `paused=1` frame (a running-scene capture would be needed to judge it on motion).      |
| Rich lighting, depth, bloom without washout          |          2 |     **3** | `after_t105b_default`: ACES filmic tone mapping with **exposure 1.65** lifts the whole low-radiance scene out of the desaturated dark-mid band — the orbs read as neon light sources on near-black with the exponential fog (`#05060f`) keeping the outer rings in depth. Scored **3**: the renderer is SwiftShader CPU-rasterized, so there is no real GPU bloom/energy accumulation — the "bloom" is the ACES roll-off + additive sprite halos only.                       |
| Overall immediate resemblance to target concept      |          2 |     **3** | `after_t105b_default` full topology vs `before_default`: the scene now reads as a **luminous atomic topology** — a bright hub, glowing ring atoms, neon orbital trails, hairline links, deep-navy atmosphere — matching the `neon_gpu_atom_dashboard.png` concept family. Scored **3** because SwiftShader still cannot reproduce the true GPU-bloom saturation/atmosphere of the references; on a real GPU with a bloom pass the same materials should close that last gap. |

**Independent audit (this pass) — operator's ≥4-all-five gate: NOT MET (FAIL).**
Scored against the fresh `after_t105b` pixels (not the prior internal retune
self-assessment), per criterion and framing:

| Scope (evidence)                                                            | Nucleons | Clouds | Filaments | Lighting/bloom | Resemblance |
| --------------------------------------------------------------------------- | -------: | -----: | --------: | -------------: | ----------: |
| **Default framing** (`after_t105b_default` vs `before_default` + refs)      |        3 |      3 |         2 |              3 |           3 |
| **Operator closeup** (`after_t105b_provider_bench-primary`/`_gpu`/`_error`) |        4 |      4 |         3 |              3 |           4 |

Neither framing clears **4 on all five**, so the blocking acceptance (≥4 on all
five) is **FAIL**. The two persistently-marginal criteria:

- **Hairline filaments & transient discharges** (2 default / 3 closeup): the links
  read as faint neon hairlines, but the _transient discharge_ motion is not
  evidenced in a `paused=1` frame — a running-scene (`paused=0`) capture is needed
  to judge it on motion.
- **Rich lighting / depth / bloom** (3 both): the scene is clearly more luminous
  and deeper (ACES + exposure 1.65 + deep-navy fog), but there is **no real GPU
  bloom** — SwiftShader CPU rasterizer, no postprocessing pass; the glow is ACES
  roll-off + additive sprite halos only. This is the main gap vs the reference
  concept's bloom density/atmosphere.

Remaining source work to reach the references: (1) a real GPU-bloom / postprocessing
pass (or much denser energy-accumulation) to match reference saturation +
atmosphere; (2) a motion capture evidencing the transient link discharges. The
T10.5b exposure/luminance retune is a real, verified improvement over `before_*`
(the scene now reads as a luminous atomic topology rather than a dim network
diagram) — but it does not clear the ≥4-all-five bar at default framing.

### Evidence (this run)

- **Default zoom — baseline:** `screenshots/before_default.png`
- **Default zoom — after (T10.5 retune):** `screenshots/after_t105b_default.png`
- **Closeup — provider (active, cyan):** `screenshots/after_t105b_provider_bench-primary.png`
- **Closeup — GPU host (cyan hub):** `screenshots/after_t105b_gpu_bench-host_bench-gpu-a.png`
- **Closeup — error (red, color-truth preserved):** `screenshots/after_t105b_provider_bench-error.png`
- **Motion (running scene, `paused=0`):** `screenshots/motion_a.png` + `screenshots/motion_b.png`
  (two frames 4 s apart — orbital phase + link pulse differ; captured by
  `scripts/ad-hoc/pw-atomic-motion-capture.mjs`, byte-diff confirms the scene is animating)
- **32-atom scale:** `screenshots/perf_32.png` (dense field, no washout)
- **Performance:** `screenshots/perf_report.json` + `screenshots/perf_run_*.log`

### T10.5 retune — material/color-science only (what changed, what didn't)

| Knob                          | File                           |                                                                                                                           Before → After |
| ----------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------: |
| Renderer exposure             | `scene/AtomicScene.tsx` (ACES) |                                                                                                                           1.1 → **1.65** |
| Per-state emissive            | `scene/AtomNode.tsx`           | idle 0.25/healthy 0.35/last 0.5/active 0.75/error 0.9 → idle **0.4** / healthy **0.6** / last **0.75** / active **1.0** / error **1.15** |
| Hub base emissive             | `scene/Nucleus.tsx`            |                                                                                                                           0.4 → **0.62** |
| Glow sprite scale (atom)      | `scene/AtomNode.tsx`           |                                                                                                                            2.4 → **2.8** |
| Glow sprite scale (hub)       | `scene/Nucleus.tsx`            |                                                                                                                            2.6 → **3.0** |
| Glow sprite opacity (hub)     | `scene/Nucleus.tsx`            |                                                                                                                          0.22 → **0.30** |
| Electron sprite scale         | `scene/ElectronCloud.tsx`      |                                                                                                                          0.18 → **0.22** |
| Orbital trail opacity / tube  | `scene/ElectronCloud.tsx`      |                                                                                                                0.18/0.25 → **0.30/0.35** |
| Filament core width / opacity | `scene/EnergyLink.tsx`         |                                                                                                                 0.75/0.15 → **1.1/0.32** |
| Plasma ribbon half-width      | `scene/EnergyLink.tsx`         |                                                                                                                            0.3 → **0.5** |

**Untouched (per `task.json` `do_not_modify`):** camera, zoom, framing, topology
layout, atom/link positions, labels, orbit controls, routing, telemetry
semantics, the 2D fallback. The scene's exponential fog and the additive
halos are renderer/material state, not post-FX — no second render target, no
bloom pass. Per-state _ordering_ is preserved (error > active > last > healthy

> idle), so the error red / active cyan encoding is unchanged.

### T10.7 — stability soak

**Real 20-minute soak** (the acceptance criterion; previously only a 3-min run
existed): `node scripts/ad-hoc/pw-atomic-perf.mjs --soak=1200000`

```
[soak] 1200000ms frozenFrames=0 minGapMs=166.5 contextLost=false heapEndMB=57.5 errors=0
```

- **0 frozen frames, no WebGL context loss, heap stable (~57 MB), 0 errors**
  across the full 20 min on the running scene (`paused=0`, atoms=16).
- The perf harness previously hardcoded a 3-min soak and ignored the documented
  `--soak=` flag; it now honors `--soak=<ms>` / `ATOMIC_SOAK_MS` so the 20-min
  acceptance soak is reproducible from the command line.

**Performance ladder (headless Chromium + SwiftShader CPU rasterizer — NOT a
GPU figure):**

|              Atoms | FPS | avg ms | p95 ms | worst ms | heap ΔMB | errors |
| -----------------: | --: | -----: | -----: | -------: | -------: | -----: |
|                  8 |   8 |  120.2 |  133.4 |    133.4 |        0 |      0 |
|                 16 |   6 | 181.05 |  183.4 |    200.0 |        0 |      0 |
|                 32 |   3 | 304.16 |  316.7 |    316.7 |        0 |      0 |
| 8 (reduced motion) |   8 | 119.69 |  133.4 |        — |        0 |      0 |

These are **CPU-rasterized SwiftShader** numbers — the renderer, not the
scene, is the bottleneck. On a real GPU the same scene renders at a
fraction of this cost; the material changes added no per-frame allocation
(the trail/filament geometry is static, the glow sprites and haze are
uniform-driven). The 20-min soak confirms no leak or frame-freeze at scale.
