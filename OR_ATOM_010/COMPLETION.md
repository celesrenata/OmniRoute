# OR-ATOM-010 — cinematic atomic scene pass — completion report

Branch worktree: `.claude/worktrees/atomic-010-cinematic` (base
`origin/release/v3.8.52`). Date: 2026-10-31 (LA).

## What this task delivers

A cinematic upgrade of the Atomic Topology 3D scene (T10.2 → T10.5), plus a
deterministic dev bench + screenshot/perf harness (T10.1), perf + stability
evidence (T10.6/T10.7), and unit tests. Every change verified with real
headless-Chromium SwiftShader (WebGL2) renders of the production renderer —
no mockups, no faked demo.

## Changes

### Scene (production code)

- `sceneResources.ts` — shared `RoomEnvironment` env map for glossy nucleons (T10.2)
- `ElectronCloud.tsx` — luminous volumetric electron clouds + glowing orbital trails (T10.3)
- `plasmaShader.ts` — hairline plasma filament GLSL injection (narrow core, micro-warp,
  tapered envelope, shimmer) via `applyPlasmaInjection` + `customProgramCacheKey` (T10.4)
- `AtomicScene.tsx` — `ColorScience` renderer pass: ACES filmic tone mapping,
  exposure 1.1, sRGB output; deep-navy fog depth (T10.5)

### Dev bench + harness

- `src/app/dev/atomic-bench/` — `/dev/atomic-bench` page + deterministic golden DEMO
  snapshot (hub + 5 anchor providers + scalable `bench-perf-N` providers); URL-driven
  `?atoms=`, `?node=`, `?paused=`
- `scripts/ad-hoc/pw-atomic-bench-capture.mjs` — before/after screenshot capture
- `scripts/ad-hoc/pw-atomic-perf.mjs` — perf ladder + reduced-motion + soak
- `scripts/ad-hoc/pw-webgl-probe.mjs` — SwiftShader WebGL2 feasibility probe

### Tests

- `tests/unit/atomic-topology/goldenSnapshotBench.test.ts` (7 tests)
- `tests/unit/atomic-topology/plasmaInjection.test.ts` (7 tests)

## Evidence

- **Visual scorecard** — `OR_ATOM_010/VISUAL_SCORECARD.md`: 5/5 criteria, before → after
  scores 2/1/2/2/2 → 5/4/4/4/4 (all ≥ 4). Protocol: identical 1600×1000 viewport,
  identical golden 6-atom DEMO snapshot, identical auto-fit camera, `paused=1`,
  same SwiftShader backend. Screenshots in `OR_ATOM_010/screenshots/`
  (`before_*` vs `after_t102/3/4/5_*`).
- **Performance** — `OR_ATOM_010/screenshots/perf_report.json`:
  atoms 8/16/32 → avg frame 123.4 / 193.3 / 327.3 ms (linear), **heapΔ = 0 MB** at
  every scale, **0 page errors**. Reduced-motion: static frame, 0 errors.
- **Soak** — 3 min: 0 frozen frames, no WebGL context loss, heap stable (51 MB), 0 errors.
  (20-minute soak documented as follow-up — metrics are flat; command recorded in
  `OR_ATOM_010/TESTS.md`.)
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
node scripts/ad-hoc/pw-atomic-bench-capture.mjs --tag=after_t105    # screenshots (needs dev server)
```

## Known limitations / follow-ups

1. **Bloom** is approximated by additive glow + env-map speculars; the spec's
   no-postFX fallback is the default path (no second render target). A real GPU
   will render the same additive energy with ACES roll-off; a postFX bloom pass
   is a possible later opt-in.
2. **20-minute soak** not run in this session (3 min run is flat: 0 frozen,
   0 context loss, zero heap growth). Run
   `node scripts/ad-hoc/pw-atomic-perf.mjs --soak=1200000` on an idle machine.
3. `.bench-data/` (dev-server DATA_DIR: sqlite + server.env + logs) is a local
   runtime artifact and is **not** committed; consider adding it to `.gitignore`
   if the bench harness becomes a recurring local workflow.

## Not done (out of scope for this branch)

- No push, no PR (task scoped to local worktree; operator to review + push).
- No production-dashboard UI changes beyond the scene primitives.
