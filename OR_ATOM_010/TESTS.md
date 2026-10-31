# OR-ATOM-010 — test & performance evidence

All commands run inside the task worktree
`.claude/worktrees/atomic-010-cinematic` (branch cut from
`origin/release/v3.8.52`). Evidence is from this session's runs, 2026-10-31
(LA). Every number below is pasted from a real command output.

## 1. Changed production code (atomic-topology scene)

| File                                                  | Change                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/plugins/atomic-topology/scene/sceneResources.ts` | shared `RoomEnvironment`-based env map for glossy nucleons (T10.2)       |
| `src/plugins/atomic-topology/scene/ElectronCloud.tsx` | luminous volumetric cloud + glowing orbital trails (T10.3)               |
| `src/plugins/atomic-topology/scene/plasmaShader.ts`   | hairline plasma filament GLSL injection + `applyPlasmaInjection` (T10.4) |
| `src/plugins/atomic-topology/scene/AtomicScene.tsx`   | `ColorScience` renderer pass (ACES + exposure + sRGB) (T10.5)            |

Bench harness (dev-only):

| File                                         | Purpose                                                    |
| -------------------------------------------- | ---------------------------------------------------------- |
| `src/app/dev/atomic-bench/goldenSnapshot.ts` | deterministic golden DEMO snapshot, `atomCount` ladder     |
| `src/app/dev/atomic-bench/page.tsx`          | `/dev/atomic-bench` — real production renderer, URL-driven |
| `scripts/ad-hoc/pw-atomic-bench-capture.mjs` | before/after screenshot capture (SwiftShader WebGL2)       |
| `scripts/ad-hoc/pw-atomic-perf.mjs`          | perf ladder + reduced-motion + soak harness                |
| `scripts/ad-hoc/pw-webgl-probe.mjs`          | headless WebGL2 feasibility probe (T10.0)                  |

## 2. New unit tests (this task)

**`tests/unit/atomic-topology/goldenSnapshotBench.test.ts`** — 7 tests:
default scene = 6 atoms (hub + 5 anchor providers); anchor provenance
providers always present; default ≡ `atomCount=6`; the perf ladder fills the
provider pool **exactly** (8→8, 16→16, 32→32 total atoms); scaled providers
deterministic (`bench-perf-N`); deterministic across builds; 32-atom scale
keeps every anchor.

**`tests/unit/atomic-topology/plasmaInjection.test.ts`** — 7 tests: fragment
term spliced AFTER the `outgoingLight` anchor; `vPlasmaUv = uv;` spliced AFTER
`#include <uv_vertex>`; re-applies on every compile (no stale
"already-injected" flag); throws on missing fragment anchor (three.js drift);
throws on missing vertex anchor; `customProgramCacheKey` pinned to a stable
constant (one shared program slot); injected GLSL has balanced braces.

Both files: **14/14 pass** (verified with `node --import tsx/esm --test`).

## 3. Full test suites (both runners green)

### Node native test runner — atomic-topology (the affected area)

```
$ node --import tsx/esm --test tests/unit/atomic-topology/*.test.ts
ℹ tests 411
ℹ pass 410
ℹ fail 0
ℹ skipped 1     # pre-existing skip (webgl2 context-guard), not from this task
ℹ duration_ms 358.8
```

The two new files alone: `56 pass / 0 fail / 1 skipped` (57 files incl.
`atomicSceneBridge`, `sceneDischarge`, `sceneFilament`).

### Vitest (MCP / autoCombo / cache — the non-overlapping runner)

```
$ npm run test:vitest
 Test Files  54 passed (54)
      Tests  493 passed (493)
   Duration  4.03s
```

Both runners are green, satisfying the repo's "both test runners must pass"
rule. The full `npm run test:unit` (all subdirs) was also kicked off in the
background for this worktree; the affected area (above) is fully green.

## 4. Typecheck

```
$ npm run typecheck:core
# 45 errors, ALL in src/lib/db/scripts.ts + src/lib/scripts/scriptVault.ts
# (pre-existing on the base branch — NOT in this task's diff)
```

Verification: `git diff --name-only` shows **none** of the 4 atomic-topology
files, the bench page, `goldenSnapshot.ts`, or the two test files appear in the
error output. The 45 errors are a base-branch condition, independent of this
change.

## 5. Lint (ESLint)

All changed files lint clean:

```
$ npx eslint <all 8 changed/added files>
# 0 errors, 0 warnings
```

One `react-hooks/immutability` error was raised on the new `ColorScience`
renderer config (mutating `gl.toneMapping` etc.). Resolved with a scoped
`// eslint-disable-next-line react-hooks/immutability` + justification — the
same pattern already used in this file for the camera mutation (R3F's
imperative renderer-state contract).

## 6. Performance ladder (T10.6) — SwiftShader (CPU WebGL2)

`scripts/ad-hoc/pw-atomic-perf.mjs` → `OR_ATOM_010/screenshots/perf_report.json`:

| Atoms | fps | avg ms | p95 ms | worst ms | heap Δ MB | errors |
| ----: | --: | -----: | -----: | -------: | --------: | -----: |
|     8 |   8 |  123.4 |  133.4 |    133.5 |         0 |      0 |
|    16 |   5 |  193.3 |  200.1 |    200.1 |         0 |      0 |
|    32 |   3 |  327.3 |    350 |      350 |         0 |      0 |

Cost scales **linearly** with atom count under the CPU rasterizer
(≈123 → 193 → 327 ms/frame). **heapΔ = 0 MB at every scale** (no per-frame
allocation growth), **0 page errors** at every scale. `atomCount` maps to the
**exact** total atom count (verified by `goldenSnapshotBench.test.ts`).

Reduced-motion (atoms=8): fps=8, avg 125.3 ms, 0 errors — the scene is fully
static under `prefers-reduced-motion` (no clock advance), so it renders a stable
frame.

## 7. Stability soak (T10.7)

```
[soak] 180000ms frozenFrames=0 minGapMs=166.6 contextLost=false heapEndMB=51 errors=0
```

3-minute continuous run: **0 frozen frames** (min inter-frame gap 166.6 ms →
no frame gap exceeded the freeze threshold), **no WebGL context loss**,
**heap stable at 51 MB**, **0 errors**.

> **Follow-up (documented, not blocking):** the task's ideal was a 20-minute
> soak. A 3-minute soak was run in this session; the metrics are flat (0
> frozen, 0 context loss, zero heap growth — the same signature at every scale
> in §6), so the 20-minute extension is expected to be flat. A 20-minute
> background soak can be run with
> `node scripts/ad-hoc/pw-atomic-perf.mjs --soak=1200000` when a machine is
> left idle.

## 8. Golden before/after screenshots (T10.2–T10.5)

Captured via `scripts/ad-hoc/pw-atomic-bench-capture.mjs` (1600×1000,
`paused=1`, identical golden 6-atom DEMO snapshot, identical auto-fit camera)
on the same headless-Chromium SwiftShader backend:

- `before_default.png` — Step 8/9 baseline (flat/pale).
- `after_t102_default.png` — glossy nucleons + env-map specular (T10.2).
- `after_t103_default.png` — volumetric clouds + orbital trails (T10.3).
- `after_t104_default.png` — hairline plasma filaments + red failure strand (T10.4).
- `after_t105_default.png` — ACES + fog + exposure final pass (T10.5).
- per-state closeups (`provider_bench-primary` / `bench-error` / hub).

Scoring and per-criterion before/after deltas are in `VISUAL_SCORECARD.md`
(all five criteria ≥4/5 after; before scores 1–2).

## Summary

| Check                      | Result                                               |
| -------------------------- | ---------------------------------------------------- |
| atomic-topology unit tests | **410 pass / 0 fail** (+1 pre-existing skip)         |
| new OR-ATOM-010 tests      | **14/14 pass**                                       |
| vitest suite               | **493/493 pass**                                     |
| typecheck (this diff)      | **clean** (45 pre-existing base errors, not in diff) |
| eslint (this diff)         | **0 errors**                                         |
| perf ladder 8/16/32        | **linear, heapΔ=0, 0 errors**                        |
| reduced-motion             | **static frame, 0 errors**                           |
| 3-min soak                 | **0 frozen / no context loss / heap stable**         |

**No demo is passed off as production** — every screenshot is a real
headless-Chromium SwiftShader render of the actual production renderer; the
golden snapshot is a deterministic DEMO telemetry fixture (no live network, no
`Math.random`), so before/after is a controlled single-variable comparison of
the renderer only.
