# OR-ATOM-010 — cinematic atomic scene pass — completion report

Branch worktree: `.claude/worktrees/atomic-010-cinematic` (base
`origin/fix/atomic-0092-proven-routing` at `f24d25a8196a`). Date: 2026-10-31 (LA).

## What this task delivers

A cinematic upgrade of the Atomic Topology 3D scene (T10.2 → T10.5 + the
T10.5b exposure/luminance retune), plus a deterministic dev bench +
screenshot/perf harness (T10.1), perf + **real 20-minute** stability evidence
(T10.6/T10.7), and unit tests. Every change verified with real
headless-Chromium SwiftShader (WebGL2) renders of the production renderer —
no mockups, no faked demo.

## Changes

### Scene (production code)

- `sceneResources.ts` — shared `RoomEnvironment` env map for glossy nucleons (T10.2)
- `ElectronCloud.tsx` — luminous volumetric electron clouds + glowing orbital trails (T10.3)
- `plasmaShader.ts` — hairline plasma filament GLSL injection (narrow core, micro-warp,
  tapered envelope, shimmer) via `applyPlasmaInjection` + `customProgramCacheKey` (T10.4)
- `AtomicScene.tsx` — `ColorScience` renderer pass: ACES filmic tone mapping,
  exposure 1.1 → **1.65** (T10.5b retune), sRGB output; deep-navy fog depth (T10.5)
- `AtomNode.tsx` / `Nucleus.tsx` — per-state emissive + hub emissive lifted,
  glow halo sprite scale/opacity widened (T10.5b)
- `ElectronCloud.tsx` — orbital trail opacity/tube + electron sprite scale
  lifted (T10.5b)
- `EnergyLink.tsx` — hairline core width/opacity + plasma ribbon width lifted
  so the links read at fit framing (T10.5b)

### Dev bench + harness

- `src/app/dev/atomic-bench/` — `/dev/atomic-bench` page + deterministic golden DEMO
  snapshot (hub + 5 anchor providers + scalable `bench-perf-N` providers); URL-driven
  `?atoms=`, `?node=`, `?paused=`
- `scripts/ad-hoc/pw-atomic-bench-capture.mjs` — before/after screenshot capture
- `scripts/ad-hoc/pw-atomic-perf.mjs` — perf ladder + reduced-motion + soak
  (now honors `--soak=<ms>` / `ATOMIC_SOAK_MS` so the 20-min soak is reproducible)
- `scripts/ad-hoc/pw-atomic-motion-capture.mjs` — two-frame motion proof
- `scripts/ad-hoc/pw-webgl-probe.mjs` — SwiftShader WebGL2 feasibility probe

### Tests

- `tests/unit/atomic-topology/goldenSnapshotBench.test.ts` (7 tests)
- `tests/unit/atomic-topology/plasmaInjection.test.ts` (7 tests)

## Evidence

- **Visual scorecard** — `OR_ATOM_010/VISUAL_SCORECARD.md`: 5 criteria, before
  2/1/2/2/2 → after (independent audit) 3/3/2/3/3 at default framing, 4/4/3/3/4 at
  operator-closeup — **not all ≥4, so the ≥4-all-five gate is FAIL**. Protocol:
  identical 1600×1000 viewport, identical golden 6-atom DEMO snapshot, identical
  auto-fit camera, `paused=1`, same SwiftShader backend. Screenshots in
  `OR_ATOM_010/screenshots/` (`before_*` vs `after_default` / `after_t103` / `after_t104`
  / `after_t105` / `after_t105b`_*).
- **Performance** — `OR_ATOM_010/screenshots/perf_report.json` (SwiftShader CPU rasterizer —
  NOT a GPU figure): atoms 8/16/32 → avg frame 120.2 / 181.05 / 304.16 ms (linear),
  **heapΔ = 0 MB** at every scale, **0 page errors**. Reduced-motion: static frame, 0 errors.
- **Soak** — **real 20-minute soak** (`--soak=1200000`): 0 frozen frames, no WebGL context
  loss, heap stable (57.5 MB), **0 errors**.
- **Tests** — `OR_ATOM_010/TESTS.md`: atomic-topology 410 pass / 0 fail (+1 pre-existing
  skip); new files 14/14; vitest 493/493; typecheck clean for this diff (45 pre-existing
  base errors in `src/lib/db/scripts.ts` + `scriptVault.ts`, not in this diff);
  eslint 0 errors.

## Verification commands (run in the worktree)

```bash
node --import tsx/esm --test tests/unit/atomic-topology/*.test.ts   # 410 pass
node --import tsx/esm --test tests/unit/atomic-topology/goldenSnapshotBench.test.ts \
  tests/unit/atomic-topology/plasmaInjection.test.ts                # 14/14
npm run test:vitest                                                 # 493/493
npx eslint src/plugins/atomic-topology/scene/ tests/unit/atomic-topology/goldenSnapshotBench.test.ts \
  tests/unit/atomic-topology/plasmaInjection.test.ts                 # 0 errors
node scripts/ad-hoc/pw-atomic-perf.mjs                              # perf + soak (needs dev server)
node scripts/ad-hoc/pw-atomic-bench-capture.mjs --tag=after_t105b   # screenshots (needs dev server)
node scripts/ad-hoc/pw-atomic-motion-capture.mjs                     # two-frame motion proof
node scripts/ad-hoc/pw-atomic-perf.mjs --soak=1200000                # perf ladder + 20-min soak
```

## Known limitations / follow-ups

1. **Bloom** is approximated by additive glow + env-map speculars; the spec's
   no-postFX fallback is the default path (no second render target). A real GPU
   will render the same additive energy with ACES roll-off; a postFX bloom pass
   is a possible later opt-in.
2. **Real-GPU perf pass** — the `perf_report.json` numbers are SwiftShader
   CPU-rasterized (not a GPU figure). A run on the operator's GPU (or
   `pw-webgl-probe.mjs`) would confirm the real-GPU frame times. The **20-minute
   soak is now run** and recorded in `OR_ATOM_010/VISUAL_SCORECARD.md`
   (0 frozen frames, no context loss, heap stable, 0 errors).
3. `.bench-data/` (dev-server DATA_DIR: sqlite + server.env + logs) is a local
   runtime artifact and is **not** committed; consider adding it to `.gitignore`
   if the bench harness becomes a recurring local workflow.

## Not done (out of scope for this branch)

- No push, no PR (task scoped to local worktree; operator to review + push).
- No production-dashboard UI changes beyond the scene primitives.
