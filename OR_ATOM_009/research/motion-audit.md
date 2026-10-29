# OR-ATOM-009 — Step 8 Motion/Visual Value → Live Telemetry Binding Audit

Scope: prove, per source line, how every atomic-topology motion/visual value that is
influenced by telemetry is **held, frozen, neutralized, or derived** across the six
required states (stale, unavailable/missing, measured-zero, paused, reduced-motion,
WebGL context loss). Every fact below cites a file and line read in this session.
Confirmed facts, inferences, and unresolved questions are kept in separate sections
(§9, §10). No code was changed; this document is the only artifact produced.

Legend used throughout:

- **derived** — value is a pure function of a confirmed measured/observed telemetry fact.
- **neutralized** — telemetry-derived value is forced to its "no data" form (never a fake zero).
- **held** — value keeps its last computed frame because the shared scene clock stops advancing.
- **frozen** — value is forced to a static neutral form by an explicit non-telemetry gate
  (pause / reduced-motion / context loss).

---

## 1. How atomic-topology motion/visual values bind to telemetry

### 1.1 Data path (all confirmed)

```
GET /api/telemetry/fleet
  → src/app/api/telemetry/fleet/route.ts:51  fetchFleetTelemetrySnapshot(...)
  → src/app/api/telemetry/fleet/route.ts:55  reconcileSnapshot(snapshot)
  → response { snapshot, reconciliation }
  → src/shared/topology/telemetry/fleetTelemetryPoller.ts:239-254  applyResponse()
       (validates, computes `stale` from capturedAt age, keeps last-good on transient error)
  → src/shared/topology/telemetry/useFleetTelemetry.ts:69           useFleetTelemetry()
  → src/app/(dashboard)/home/ProviderTopology.tsx:64               (import)
  → src/app/(dashboard)/home/ProviderTopology.tsx:153-155          reconciliation only when
       `status === "available"`, else null
  → src/app/(dashboard)/home/ProviderTopology.tsx:171              folded into
       normalizeTopology({ …, reconciliation: fleetReconciliation })
  → src/shared/topology/domain/normalizeTopology.ts:391-392        carried onto
       `snapshot.fleetTelemetry` (absent → field stays absent)
  → src/plugins/atomic-topology/AtomicTopologyRenderer.tsx:291     `reconciliation =
       snapshot.fleetTelemetry ?? null`
```

### 1.2 Telemetry → motion bindings (all confirmed)

| Motion/visual value                                         | Source of the bound telemetry fact                                                                                | Binding site (confirmed)                                                                                                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider-atom spin speed (rad/s)                            | `ReconciledProviderNode.outputTokensPerSecond.value`                                                              | `AtomicTopologyRenderer.tsx:336-341` (join + stale guard) → `:346` `spinRadiansPerSecond(reconciliation ? joinedTps : null, SPIN_REFERENCE_TPS)` with `SPIN_REFERENCE_TPS = 24` at `:254` |
| Provider-atom queue vibration (amplitude/Hz)                | `ReconciledProviderNode.queuedJobs.value`                                                                         | `AtomicTopologyRenderer.tsx:342-345` → `:347` `queueVibration(reconciliation ? joinedQueued : null)`                                                                                      |
| Device-atom (GPU/runtime) spin speed                        | `gpu.outputTokensPerSecond.value ?? runtime.outputTokensPerSecond.value`                                          | `AtomicTopologyRenderer.tsx:394-402`                                                                                                                                                      |
| Device-atom queue vibration                                 | `runtime.queuedJobs.value`                                                                                        | `AtomicTopologyRenderer.tsx:403`                                                                                                                                                          |
| Device-facts tooltip numbers                                | `utilizationPercent`, `vramUsedBytes`, `vramTotalBytes`, `temperatureC`, `powerWatts`, `queuedJobs`, `activeJobs` | `AtomicTopologyRenderer.tsx:395-396` (`obsValue`) applied at `:423-429`                                                                                                                   |
| Feed-freshness badge (Live / Stale / Telemetry unavailable) | `snapshot.fleetTelemetry?.capturedAt ?? snapshot.capturedAt`                                                      | `AtomicTopologyRenderer.tsx:681-693`, `TELEMETRY_FRESH_WINDOW_MS = 5_000` at `:105`                                                                                                       |
| Tooltip "Fleet sample" timestamp                            | `reconciliation.capturedAt`                                                                                       | `AtomicTopologyRenderer.tsx:369` (providers), `:432` (devices)                                                                                                                            |

Downstream motion consumers of the bound values:

- `AtomNode.tsx:195-203` — `motionParams({ reducedMotion: false, spinValue: descriptor.spin.value, spinMode: descriptor.spin.mode })`; `spinActive`/`breathActive` are true only for `mode === "measured" && spinValue > 0` (`motion.ts:129-135`).
- `AtomNode.tsx:242-243` — `vibrating = !paused && mode === "measured" && amplitude > 0`.
- `AtomNode.tsx:288-289` — cluster spin `spinAngle.current += min(delta, MAX_FRAME_DELTA) * descriptor.spin.value` (only when `!frozen && motion.spinActive`).
- `AtomNode.tsx:296-308` — positional tremor driven by `sceneClock.now * frequencyHz * 2π`; base position otherwise.
- `AtomNode.tsx:337-343` — `ElectronCloud speed={descriptor.spin.value}`.
- `ElectronCloud.tsx:238-255` — shell rotation `(base * shell.speedMultiplier * t + phase) % 2π` from the shared clock; per-shell multipliers.
- `Nucleus.tsx:229-239` — hub breathing from `sceneClock.now`; the hub has **no** spin bound to any telemetry (`Nucleus.tsx:227-228` comment: "the hub has no measured rate to map").

### 1.3 Confirmed no-bindings

- **Route link animation** (`EnergyLink`) is driven by the snapshot's route traffic
  state (`isActive = state === "active" && style.animated`, `EnergyLink.tsx:136-138`),
  not by fleet telemetry. Its only time source is `sceneClock.now` (`EnergyLink.tsx:393`).
- **Hub nucleus motion** is telemetry-independent: breathing is state-driven
  (`BREATH_PERIOD` per state `Nucleus.tsx:74-80`, amplitude `0.02` at `:72`) and its
  single electron ring spins at a constant `staticSpeed={0.4}` rad/s
  (`Nucleus.tsx:274-276`, gated at `ElectronCloud.tsx:244-247`).
- **Nucleus cluster orientation is static** (seed-fixed; no spin at all) —
  `Nucleus.tsx:227-228`.
- **Model colors** come only from observed in-flight model ids
  (`AtomicTopologyRenderer.tsx:318-326`); absent ids → `UNKNOWN_ATOM_COLOR`, never a guess.

---

## 2. Stale telemetry coverage

Three **distinct** staleness mechanisms exist; each is confirmed and each has a
different binding effect:

### 2.1 Per-sample staleness (metric layer)

- `src/shared/topology/telemetry/providers/normalizeSample.ts:48-51` —
  `isStaleSample`: non-finite `sampledAt`/`capturedAt` ⇒ stale; else
  `capturedAt − sampledAt > freshnessMs` ⇒ stale.
- `normalizeSample.ts:61-81` — a present zero stays a real `{ value: 0 }`; missing/
  non-finite values become `{ value: null }`; stale samples **keep their value** at
  this stage but set `stale: true` (`:57-59`, `:77-79`).

### 2.2 Per-field merge staleness (gateway layer)

- `src/shared/topology/telemetry/mergeSnapshots.ts:21` — `STALE_FACTOR_DEFAULT = 3`.
- `mergeSnapshots.ts:78-88` — `isStale()`: `observed.stale` ⇒ true;
  `windowMs == null` ⇒ false (interval unknown → never stale here); non-finite
  `sampledAt`/`now` ⇒ false; else `age > factor * windowMs`.
- `mergeSnapshots.ts:232-234` — during merge, stale fields get `stale: true`
  (value retained in the merged snapshot).
- `mergeSnapshots.ts:96-113` — `neutralizeStale()`: stale fields become
  `{ …observed, value: null, stale: true }` ("decay-to-neutral").
  **Confirmed**: in `src/` no production call site invokes `neutralizeStale()` on the
  live request path — the only hits are the definition and the `gateway.ts` header
  comment (`gateway.ts:11-12`). The renderer therefore relies on the `stale` flag,
  not on pre-nulled values (see §2.4).
- `src/shared/topology/telemetry/reconcile.ts:102-103` — `isStaleObserved(o) =
o?.stale === true` (trusts the upstream flag; does **not** re-derive age; rationale
  in `reconcile.ts:97-100`).
- `reconcile.ts:141-147` (gpu), `:179-181` (runtime), `:199-201` (provider) —
  `node.stale = true` when the motion-relevant fields are stale:
  gpu: `utilizationPercent | vramUsedBytes | outputTokensPerSecond`;
  runtime/provider: `outputTokensPerSecond | queuedJobs`.

### 2.3 Feed-level staleness (poller)

- `src/shared/topology/telemetry/fleetTelemetryPoller.ts:96-97` —
  `DEFAULT_INTERVAL_MS = 3500`, `DEFAULT_STALE_WINDOW_MS = 10_000`.
- `fleetTelemetryPoller.ts:244-253` — `applyResponse` computes
  `stale = (Date.now() − reconciliation.capturedAt) > staleWindowMs` and keeps the
  stale reconciliation in state (comment `:18-20`: "A stale reconciliation is still
  carried").

### 2.4 Renderer binding under staleness (all confirmed)

- Provider join: `AtomicTopologyRenderer.tsx:338-345` —
  `joinedTps` / `joinedQueued` are `null` when `joinedProvider.stale` is true
  (i.e. `stale → null`), then `spinRadiansPerSecond(null, …)` ⇒ `unavailable`
  (`visualEncoding.ts:170-172`) and `queueVibration(null)` ⇒ `unavailable`
  (`visualEncoding.ts:217-219`). Values are **neutralized** — never animated from a
  decayed fact, never fabricated as zero (comment `:334-335`).
- Device band: `AtomicTopologyRenderer.tsx:394-396` —
  `deviceStale = Boolean(gpu?.stale ?? runtime?.stale)`; `obsValue()` returns `null`
  while stale (`:395-396`); spin input forced `null` at `:397-400`; vibration input
  forced `null` at `:403`. Same neutralization.
- Tooltip facts: `obsValue(gpu?.utilizationPercent)` etc. at
  `AtomicTopologyRenderer.tsx:423-429` → `null` (not rendered as a number) when stale.
- Badge: `AtomicTopologyRenderer.tsx:681-693` — badge state is `"stale"` iff
  `Date.now() − capturedAt > 5_000` at the moment the snapshot became observable
  (measured once, deferred in an effect; `capturedAt = fleetTelemetry?.capturedAt ??
snapshot.capturedAt`).
- **Confirmed boundary**: the renderer does **not** read the poller's top-level
  `state.stale` flag, and the reconciliation's `capturedAt` age is not consulted for
  motion binding — only per-node `stale` flags (which originate from per-field
  staleness above). A feed older than 10 s whose fields are not individually flagged
  stale still binds motion; the badge is the only place feed-level age is surfaced.

State classification for staleness:

| Value                           | Stale handling                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| Provider/device spin input      | **neutralized** → `unavailable` (0.10 rad/s neutral spin, provenance `unavailable`) |
| Provider/device vibration input | **neutralized** → `unavailable` (amplitude 0)                                       |
| Tooltip device facts            | **neutralized** → `null`                                                            |
| Badge                           | shows `"stale"` (display only; does not alter motion binding)                       |

---

## 3. Unavailable or missing telemetry coverage

Confirmed branches:

1. **No reconciliation at all** — `reconciliation` is `null` when the poller is
   disabled/awaiting/errored or the snapshot predates the block
   (`ProviderTopology.tsx:154-155` status must be `"available"`;
   `normalizeTopology.ts:391-392` absent → field stays absent;
   `AtomicTopologyRenderer.tsx:291` `?? null`).
   - Provider spin/vibration: `spinRadiansPerSecond(null, 24)` and
     `queueVibration(null)` because the ternary passes `null` when
     `reconciliation` is null — `AtomicTopologyRenderer.tsx:346-347`. The comment at
     `:328-335` confirms the intent: without reconciliation the snapshot carries only
     a request _count_; feeding a count would fabricate TPS.
   - Result: `SpinResult { value: 0.1, mode: "unavailable" }`
     (`visualEncoding.ts:170-172`) — a neutral slow value, _deliberately indistinguishable
     from observed-quiet_ (`visualEncoding.ts:158-161`). `VibrationResult { amplitude: 0,
frequencyHz: 0, mode: "unavailable" }` (`visualEncoding.ts:217-219`).
   - Device atoms: the entire device band is absent (`AtomicTopologyRenderer.tsx:377`).
   - Badge: `capturedAt` falls back to `snapshot.capturedAt`
     (`AtomicTopologyRenderer.tsx:681`); `"unavailable"` when that is absent/non-finite
     (`:688-689`, initial state `"unavailable"` at `:682`).
2. **Reconciliation present but field value is `null`/absent** — the join at
   `AtomicTopologyRenderer.tsx:338-345` / `:395-396` already coerces
   `value == null` to `null`, producing the same `unavailable` encoding. The
   upstream contract is that `Observed.value: null` means "observed as absent/unknown"
   and is kept distinct from a measured `0` (`types.ts`; see §4.1 for the zero rule).
3. **First-response / transient-error window** — `fleetTelemetryPoller.ts:213-219`:
   transient non-OK responses keep the waiting state or the **last good
   reconciliation** and keep polling; terminal auth failure nulls the reconciliation
   (`:200-211`) and stops polling (`:151-155`). So "missing" is either `null`
   (→ `unavailable` encoding, case 1) or a carried last-good (→ normal binding, now
   possibly stale — §2).
4. **Non-finite `capturedAt` in the snapshot** — the deterministic discharge clock
   falls back to `0` (`AtomicTopologyRenderer.tsx:661-663`), and the badge is
   `unavailable` (`:688-689`).

State classification for missing telemetry:

| Value                              | Missing-telemetry handling                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider/device spin               | **neutralized** → `unavailable`, value 0.10 rad/s (constant, not a measurement)                                                                                           |
| Provider/device vibration          | **neutralized** → `unavailable`, amplitude 0                                                                                                                              |
| Device atoms + device facts        | not rendered at all (no atom, no tooltip facts)                                                                                                                           |
| Badge                              | `"unavailable"`                                                                                                                                                           |
| Link animation, hub nucleus motion | unaffected by telemetry (no binding — §1.3); these are the only continuous motions that survive total telemetry loss, and they are fixed constants, not telemetry-derived |

---

## 4. Measured-zero telemetry coverage

### 4.1 Upstream zero vs unknown (confirmed)

- `normalizeSample.ts:56-59` contract (header): "a PRESENT zero is a real measurement
  (kept, with provenance); a MISSING sample is `null` (unknown) — never a fabricated
  zero".
- `normalizeSample.ts:72-81` — only `typeof value === "number"` and finite values
  survive; a present `0` is guarded by unit checks but retained as `0`.

### 4.2 Renderer/scene response to a measured zero

- **TPS `0` → spin**: `spinRadiansPerSecond(0, 24)` returns
  `{ value: 0.1, mode: "measured-zero" }` (`visualEncoding.ts:177-179`).
  This is a **derived** value: 0.10 is the fixed lower bound of the curve
  (`visualEncoding.ts:150-156`, `target = 0.1 + 1.65 * r`, `r = 0` when TPS = 0),
  and the mode tag records that the zero was observed, not assumed.
  Downstream, `spinActive` requires `spinMode === "measured" && spinValue > 0`
  (`motion.ts:130`) — so a measured-zero provider atom does **not** spin its cluster
  or breathe; only the slow 0.10 rad/s electron-shell drift applies
  (`ElectronCloud.tsx:238-255` via `speed={descriptor.spin.value}` at
  `AtomicTopologyRenderer.tsx` binding + `AtomNode.tsx:339`).
- **Queued jobs `0` → vibration**: `queueVibration(0)` returns
  `{ amplitude: 0, frequencyHz: 0, mode: "zero" }` (`visualEncoding.ts:220-223`) —
  no tremor, and `AtomNode.tsx:243` (`mode === "measured"`) independently keeps
  `vibrating` false. The provenance `"zero"` is preserved on the descriptor
  (`AtomNode.tsx:242`).
- **Zero vs stale**: a stale zero is _not_ a measured zero — stale fields pass through
  the same `null`-coercion as any stale value (§2.4) and land in `unavailable`, not
  `measured-zero`/`zero`.

State classification for measured zero:

| Value                     | Measured-zero handling                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Provider/device spin      | **derived** from the observed 0 → 0.10 rad/s, `measured-zero`; cluster spin + breathing OFF (`motion.ts:130`)              |
| Provider/device vibration | **neutralized** → amplitude 0, `zero` provenance                                                                           |
| Tooltip facts             | `0` rendered as a real measurement (`obsValue` returns the literal 0 when non-stale, `AtomicTopologyRenderer.tsx:395-396`) |
| Badge                     | unaffected by value (age only)                                                                                             |

---

## 5. Paused behavior

### 5.1 Confirmed pause sources

- Host pause: `AtomicTopologyRenderer.tsx:906-910` (`setPaused`) and the delegated
  `atomic:toggle-pause` listener (`:836-844`, wired at `:852`); the control chip
  dispatches it (`overlays/AtomicControls.tsx:56-58`).
- Document-hidden pause: `AtomicScene.tsx:79-95` —
  `effectivePaused = paused || documentHidden`, passed to `SceneClockDriver`
  (`:107`) and `SceneContent` (`:118`).

### 5.2 Confirmed pause mechanics (shared clock freeze)

- `src/plugins/atomic-topology/scene/motion.ts:33-37` —
  `advanceSceneTime(clock, delta, paused)`: when `paused` the clock is **unchanged**
  (accumulates exactly 0), so the frozen scene holds a static frame and resumes
  contiguously; otherwise `min(delta, MAX_FRAME_DELTA)` with `MAX_FRAME_DELTA = 0.1`
  (`motion.ts:21`).
- `src/plugins/atomic-topology/scene/sceneState.tsx:60-71` — `SceneClockDriver`
  (mounted first, `AtomicScene.tsx:105-107`) advances the shared clock once per
  frame with `pausedRef.current || sceneState.contextLost`.
- Because **every** time-driven motion in the scene is a pure function of
  `sceneClock.now` (absolute-angle/absolute-phase style), freezing the clock freezes
  all of it exactly, with no drift and no jump on resume:
  - electron shell rotation — `ElectronCloud.tsx:238-255`
    (`group.rotation.y = (w * t + phase) % 2π`, absolute from the frozen clock).
  - haze spin/breath — `ElectronCloud.tsx:256-268` (mutations skipped when frozen).
  - hub nucleus breathing — `Nucleus.tsx:229-239` (`frozen → scale 1`).
  - atom cluster spin — `AtomNode.tsx:288-289` (angle accumulation skipped when
    `frozen`).
  - atom breathing — `AtomNode.tsx:282-285` (`frozen || !motion.breathActive → 1`).
  - queue vibration position — `AtomNode.tsx:296-308` (frozen ⇒ base position
    restored).
  - route-link pulse packets — progress computed from
    `t = sceneClock.now` (`EnergyLink.tsx:393, 429`), held exactly while the clock
    is frozen.
  - One-shot completion flash / failure burst — booked with
    `startAt = sceneClock.now` (`EnergyLink.tsx:372-384`); intensity at scene time
    `t` is `oneShotIntensity(event, t)` (`EnergyLink.tsx:452, 472`;
    `oneShot.ts:76-85`), which returns full intensity (`1`) while `t <= startAt`
    (`oneShot.ts:77-78`). While the clock is frozen, an event booked during pause
    is therefore **held** at full intensity (flash stays on) until the clock
    resumes, then decays over its duration.
  - Note on the deferral branch: `EnergyLink.tsx:378-381` defers an event to
    `pendingRef` while `pausedRef.current` is truthy, and `:395-402` releases it
    on the first frame with `!pausedRef.current && !contextLost`. However, the
    component's sole mount site renders
    `<EnergyLink key={link.id} descriptor={link} atoms={ringAtoms} />` **without**
    the `paused` prop (`AtomicScene.tsx:268-270`), so `pausedRef.current` is
    always falsy at runtime and that branch is unreachable; the effective pause
    behavior is the hold described above, not a deferral (see §10.2, §10.3).
- **Held, not re-derived**: a paused scene does not re-map telemetry to new targets
  and does not decay; the next `update(snapshot)` after resume simply re-derives
  descriptors from the newest snapshot (`AtomicTopologyRenderer.tsx:895-900`).

State classification for pause:

| Value                                                                           | Paused handling                                                                                                                                 |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| All clock-driven motion (shells, haze, breathing, cluster spin, tremor, pulses) | **held** (last frame, exact, contiguous resume)                                                                                                 |
| One-shot completion/failure events booked while paused                          | **held** at full intensity until resume (`oneShot.ts:77-78`; deferral branch unreachable — `paused` prop not passed, `AtomicScene.tsx:268-270`) |
| Telemetry binding                                                               | unaffected while paused (binding happens at snapshot ingest, not per frame)                                                                     |
| User-driven orbit controls / focus slide                                        | still interactive (per-frame user input; not clock-driven) — confirmed scope, not motion                                                        |

---

## 6. Reduced-motion behavior

### 6.1 Confirmed wiring

- `src/plugins/atomic-topology/scene/sceneState.tsx:111-129` —
  `useReducedMotionSync()` mirrors `matchMedia("(prefers-reduced-motion: reduce)")`
  into `sceneState.reducedMotion` (SSR-safe; `false` without `window`). Called by
  `AtomicScene.tsx:86`.
- `sceneState.tsx:48-50` — `motionEnabled() = !contextLost && !reducedMotion`.
  **Confirmed**: `motionEnabled()` has no per-frame call sites in the scene; the
  per-frame gates use the flags directly (listed below).
- Renderer-side capability probe: `AtomicTopologyRenderer.tsx:597-613` resolves
  `caps.reducedMotion` into the scene context (`:657`); `capabilities.ts:37-39, 29-31`
  (SSR → `false`).

### 6.2 Confirmed per-value reduced-motion effects (all read this session)

| Surface                                | Source                                            | Effect under reduced motion                                                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron shells + haze (atoms)         | `ElectronCloud.tsx:239, 244-248, 252, 259`        | `frozen` includes `sceneState.reducedMotion` → shells hold angle (`w = 0`, absolute form), single shell skips mutation, haze skips mutation — **frozen (static last frame)**                                                                             |
| Hub nucleus breathing                  | `Nucleus.tsx:233-236`                             | `frozen → scale 1` — **frozen**                                                                                                                                                                                                                          |
| Atom cluster spin + breathing + tremor | `AtomNode.tsx:280, 282-285, 288-289, 296-308`     | `frozen` ⇒ no spin accumulation, breath 1, base position — **frozen**                                                                                                                                                                                    |
| Route-link pulse packets               | `EnergyLink.tsx:392, 419` + `filament.ts:147-155` | `packetPoolSize(MAX_PACKET_POOL, isActive, reduced)` returns `0` when `reducedMotion` → pool empty (static filament only) — **neutralized to zero pool**                                                                                                 |
| Completion flash                       | `EnergyLink.tsx:452-453`                          | `visible = intensity > 0.01 && !!curvePoints && !reduced` — **neutralized (hidden)**                                                                                                                                                                     |
| One-shot `pendingRef` release guard    | `EnergyLink.tsx:396`                              | checks `!contextLost` when releasing a deferred event — but that path requires the unreachable pause-time deferral branch (§5.2); under reduced motion the flash is independently hidden (`:453`) and the burst stays clock-driven (static while frozen) |
| `motionParams` gate                    | `motion.ts:129-135`                               | `!reducedMotion && spinMode === "measured" && spinValue > 0`; note `AtomNode.tsx:198` passes `reducedMotion: false` — reduced motion for atoms is enforced by the per-frame `frozen` flag, not by this gate (confirmed)                                  |
| Orbit controls settle                  | `SceneOrbitControls.tsx:98-100`                   | `k = reducedMotion ? 1 : 1 − exp(−12·min(delta, 0.1))` → focus slide becomes instant (no eased glide) — **frozen easing**                                                                                                                                |

Telemetry binding itself is **not** altered by reduced motion — the same
stale/unavailable/zero rules apply at descriptor build time; only the rendering of
the resulting motion is suppressed.

State classification for reduced motion:

| Value                               | Reduced-motion handling                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| All continuous scene motion         | **frozen** (static last frame) via `sceneState.reducedMotion` in each `useFrame` |
| Route pulse pool + completion flash | **neutralized** (pool 0 / hidden)                                                |
| Telemetry-derived descriptor values | unchanged (binding independent of the accessibility gate)                        |
| Badge                               | unchanged (pure DOM)                                                             |

---

## 7. WebGL context-loss behavior

### 7.1 Confirmed wiring

- `src/plugins/atomic-topology/scene/sceneState.tsx:78-92` — `CanvasContextGuard`:
  `webglcontextlost` ⇒ `event.preventDefault()` + `sceneState.contextLost = true`;
  `webglcontextrestored` ⇒ `sceneState.contextLost = false` (clock resumes from where
  it froze — no jump, comment `:90`).
- Mounted inside the Canvas: `AtomicScene.tsx:108-111` (`CanvasContextGuard` then
  `ContextGuard`).
- `src/plugins/atomic-topology/scene/ContextGuard.tsx:27-43` — complementary guard:
  `preventDefault()` on `webglcontextlost` (browser restores instead of killing) and
  `invalidate()` on `webglcontextrestored` so the R3F frameloop repaints the moment
  the context is back.
- `sceneState.tsx:67-69` — the clock driver itself also treats
  `sceneState.contextLost` as `paused` (`advanceSceneTime(sceneClock, delta,
pausedRef.current || sceneState.contextLost)`).

### 7.2 Confirmed per-value behavior during context loss

- Every clock-driven value is **held** exactly as in pause (§5.2), because the shared
  clock stops advancing and each `useFrame` gate includes `sceneState.contextLost` in
  `frozen` (`AtomNode.tsx:280`, `ElectronCloud.tsx:239`, `Nucleus.tsx:233`).
- Route-link one-shots: the release guard at `EnergyLink.tsx:396` checks
  `!sceneState.contextLost`, but it only applies to events sitting in
  `pendingRef`, which requires the pause-time deferral branch — unreachable at
  runtime because `AtomicScene.tsx:268-270` does not pass `paused`. Effective
  behavior under context loss: one-shots are **held** at their frozen intensity
  (as under pause).
- Telemetry binding is unaffected (descriptor build time, not per frame); the badge is
  DOM and unaffected.
- **Unresolved (out of source scope)**: R3F/three.js internal canvas behavior while
  the context is actually lost (e.g. whether `useFrame` callbacks still fire while the
  context is down) is not visible in this codebase's sources; what is confirmed here
  is the flag-based freeze/resume contract, which is independent of that detail
  (either the loop halts — canvas blank — or it runs with the clock frozen — held
  frame; both are consistent with "no motion, no jump on restore").

State classification for context loss:

| Value                     | Context-loss handling                                                           |
| ------------------------- | ------------------------------------------------------------------------------- |
| All clock-driven motion   | **held** (clock frozen; `frozen` gates also active)                             |
| One-shot link events      | **held** at frozen intensity (deferral path unreachable — see §7.2)             |
| On restore                | contiguous resume (clock picks up; `ContextGuard` re-invalidates the frameloop) |
| Telemetry binding / badge | unaffected                                                                      |

---

## 8. Per-case held/frozen/neutralized/derived classification (matrix)

Rows = every telemetry-influenced motion/visual value confirmed in §1;
columns = the six states. "n/a" = the value does not change in that state (last
derived value stands, subject to the global gates below).

Global rows first (they dominate every value):

| Gate                                    | Stale                                   | Missing         | Measured-zero   | Paused            | Reduced-motion                           | Context loss      |
| --------------------------------------- | --------------------------------------- | --------------- | --------------- | ----------------- | ---------------------------------------- | ----------------- |
| Shared scene clock (`advanceSceneTime`) | n/a                                     | n/a             | n/a             | **held** (frozen) | n/a (clock runs; per-value gates freeze) | **held** (frozen) |
| Badge state                             | `"stale"` when age > 5 s (display only) | `"unavailable"` | n/a (age-based) | n/a               | n/a                                      | n/a               |

Per value:

| Value                                                              | Stale telemetry                                                                                          | Unavailable/missing                                 | Measured zero                                                          | Paused                                                                 | Reduced-motion                                                      | Context loss              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------- |
| Provider spin input                                                | **neutralized** → `null` → `unavailable` 0.10 rad/s (`:338-341, 346`)                                    | **neutralized** → `unavailable` 0.10 rad/s (`:346`) | **derived** → `measured-zero` 0.10 rad/s (`visualEncoding.ts:177-179`) | **held** (clock frozen)                                                | **frozen** (shell mutation skipped)                                 | **held**                  |
| Provider vibration input                                           | **neutralized** → `unavailable` amp 0 (`:342-345, 347`)                                                  | **neutralized** → `unavailable` amp 0               | **neutralized** → `zero` amp 0 (`visualEncoding.ts:220-223`)           | **held** (position reset to base while frozen, `AtomNode.tsx:306-308`) | **frozen**                                                          | **held**                  |
| Device spin / vibration                                            | **neutralized** (`deviceStale`, `:394-403`)                                                              | not rendered (no device atoms)                      | **derived** / **neutralized** as above                                 | **held**                                                               | **frozen**                                                          | **held**                  |
| Device tooltip facts                                               | **neutralized** → `null` (`obsValue`, `:395-396, 423-429`)                                               | n/a                                                 | **derived** (literal 0 shown)                                          | n/a (DOM)                                                              | n/a (DOM)                                                           | n/a (DOM)                 |
| Provider cluster spin + breathing (active only for `measured` > 0) | off (input neutralized ⇒ `unavailable` ⇒ gate false)                                                     | off                                                 | off (`motion.ts:130`)                                                  | **held**                                                               | **frozen**                                                          | **held**                  |
| Electron shell spin (provider: `speed = spin.value`)               | **held** at the neutral 0.10 rad/s value (slow constant drift — a fixed encoding, not a telemetry claim) | same as stale (same 0.10 value)                     | **held** at 0.10 rad/s                                                 | **held** (exact, `ElectronCloud.tsx:238-255`)                          | **frozen**                                                          | **held**                  |
| Hub nucleus breathing (state-driven, NOT telemetry)                | n/a                                                                                                      | n/a                                                 | n/a                                                                    | **held** → scale 1 (`Nucleus.tsx:233-236`)                             | **frozen** → scale 1                                                | **held**                  |
| Hub electron ring spin (constant 0.4 rad/s, NOT telemetry)         | n/a                                                                                                      | n/a                                                 | n/a                                                                    | **held** (`ElectronCloud.tsx:244-248`)                                 | **frozen**                                                          | **held**                  |
| Nucleus cluster spin                                               | n/a (never set — no measured rate for the hub, `Nucleus.tsx:227-228`)                                    | same                                                | same                                                                   | **held** (static)                                                      | **held** (static)                                                   | **held** (static)         |
| Route-link pulses / flash / burst                                  | n/a (no telemetry binding — route state driven)                                                          | n/a                                                 | n/a                                                                    | **held** (one-shots held at full intensity until resume)               | pool **neutralized** to 0, flash hidden (`EnergyLink.tsx:419, 453`) | **held** (one-shots held) |
| Model color sectors                                                | n/a (in-flight model ids are a separate snapshot fact, not fleet telemetry)                              | neutral `UNKNOWN_ATOM_COLOR` (`:326`)               | n/a                                                                    | n/a                                                                    | n/a                                                                 | n/a                       |

Reading the matrix: in every cell the value is either (a) derived from a confirmed
telemetry fact, (b) neutralized to a fixed no-data encoding with explicit
provenance (`unavailable` / `zero` / `null`), (c) held because the shared clock
stopped, or (d) frozen by a confirmed accessibility/context gate. No cell relies on
an extrapolated, defaulted-to-zero, or attributed-without-evidence value.

---

## 9. No-fabrication proof

1. **TPS is never invented from a count.** Without a reconciliation the snapshot
   carries only request counts; the renderer passes `null` (not the count) to
   `spinRadiansPerSecond` — `AtomicTopologyRenderer.tsx:328-347`, with the explicit
   comment "feeding a count into `spinRadiansPerSecond` would fabricate TPS".
2. **Zero is never substituted for missing.** `normalizeSample.ts:56-59` keeps a
   present zero as a real measurement and maps missing/non-finite to `value: null`;
   the renderer's join coerces `null` to the `unavailable` encoding
   (`AtomicTopologyRenderer.tsx:338-345, 395-396`), never to `0`.
3. **Stale is never animated.** Stale provider/device nodes force the spin and
   vibration inputs to `null` (`AtomicTopologyRenderer.tsx:339, 343, 397-403`); stale
   tooltip facts are `null` (`obsValue`, `:395-396`). The `unavailable` encoding is
   deliberately visually indistinguishable from quiet and is labeled as such in
   source (`visualEncoding.ts:158-161`) — provenance is carried on `mode`, not
   hidden.
4. **Attribution is source-established only.** Reconciliation builds canonical ids
   and relationship edges only from explicit facts (runtime per-device
   `deviceUuid` attribution; "If no reliable source establishes a relationship →
   the edge is absent, never guessed" — `reconcile.ts:11-27`); runtime TPS goes to a
   GPU only with per-device attribution, never an even split (`reconcile.ts:22-24`).
5. **No telemetry value reaches motion except via the two encoders.**
   `spinRadiansPerSecond` (`visualEncoding.ts:166-181`) and `queueVibration`
   (`visualEncoding.ts:216-227`) are the only numeric telemetry→motion mappings
   consumed by the scene; both are pure, deterministic, and bounded
   (spin floor 0.10 rad/s, `VIBRATION_MAX_AMPLITUDE = 0.035`,
   `VIBRATION_MAX_FREQUENCY_HZ = 9` — `visualEncoding.ts:198-200`).
6. **Model identity colors** come only from observed in-flight model ids
   (`AtomicTopologyRenderer.tsx:318-326`); the hub never receives model colors
   (`Nucleus.tsx:190-194`).
7. **The `stale` flag, not re-derived age, is trusted at the reconciliation level**
   (`reconcile.ts:97-103`), so no motion value is attributed to a freshness judgment
   made downstream of the source.

---

## 10. Confirmed facts vs assumptions vs unresolved questions

### 10.1 Confirmed facts (verified against source this session)

All items in §1–§8 are confirmed; the load-bearing citations are:

- `AtomicTopologyRenderer.tsx:105, 254, 291, 328-347, 394-403, 423-429, 681-693, 836-844, 906-910`
- `visualEncoding.ts:136-144, 146-181, 187-227, 198-200`
- `sceneState.tsx:37-50, 60-71, 78-92, 111-129`
- `motion.ts:21, 33-37, 75-83, 96-135`
- `AtomicScene.tsx:79-95, 104-122, 225-270`
- `ElectronCloud.tsx:231-255, 259-268`
- `AtomNode.tsx:193-203, 242-243, 280-308, 337-343`
- `Nucleus.tsx:71-80, 190-194, 225-239, 274-276`
- `EnergyLink.tsx:126-138, 364-384, 390-402, 417-438, 451-464, 468-476`
- `ContextGuard.tsx:27-47`, `filament.ts:138-155`, `SceneOrbitControls.tsx:98-100`
- `mergeSnapshots.ts:21, 78-88, 96-113, 232-234`
- `normalizeSample.ts:48-51, 56-60, 72-81`
- `reconcile.ts:11-27, 97-103, 141-147, 179-181, 199-201`
- `fleetTelemetryPoller.ts:96-97, 124-133, 151-158, 200-219, 239-254`
- `useFleetTelemetry.ts:32-58, 69-75` (the hook used by the panel)
- `ProviderTopology.tsx:64, 152-171`, `normalizeTopology.ts:391-392`,
  `src/app/api/telemetry/fleet/route.ts:51-56`

### 10.2 Inferences (labeled; not asserted as source facts)

- The renderer never consults the poller's top-level `stale` flag for motion
  binding — inferred from a full read of the binding code (only per-node `stale`
  flags and `capturedAt` appear); the absence is confirmed by inspection, and the
  consequence (a >10 s-old reconciliation with un-flagged fields still animates,
  surfaced only by the badge) follows mechanically from the confirmed code.
- `motionEnabled()` (`sceneState.tsx:48-50`) is dead code in the per-frame path —
  confirmed by search (no call sites); its existence does not change behavior.
- Reduced motion for atom motion is enforced by the per-frame `frozen` flags rather
  than by `motionParams` (which is called with `reducedMotion: false` at
  `AtomNode.tsx:198`) — confirmed by reading both call sites; the net effect (static
  frame under reduced motion) is identical either way.
- A stale-but-carried reconciliation "still animates if its fields are not
  individually stale" — mechanical consequence of §10.2 item 1 plus
  `fleetTelemetryPoller.ts:18-20` ("A stale reconciliation is still carried").
- The one-shot pause-time deferral branch (`EnergyLink.tsx:378-381, 395-402`) is
  unreachable at runtime: the sole mount site `AtomicScene.tsx:268-270` does not
  pass the `paused` prop, so `pausedRef.current` is always falsy. Mechanical
  consequence (confirmed wiring + `oneShot.ts:77-78`): a one-shot booked while
  paused is held at full intensity until resume rather than deferred. The
  source's own comment (`EnergyLink.tsx:365-366`, "A transition observed while
  paused is deferred to the first unpaused frame") describes the branch's intent,
  not the mounted behavior.

### 10.3 Unresolved questions (explicitly NOT resolved by source reading alone)

1. **Does R3F keep calling `useFrame` while the WebGL context is actually down?**
   The flag-based freeze/resume contract is confirmed (`sceneState.tsx:78-92`,
   `ContextGuard.tsx:27-43`), but three.js/R3F internal canvas behavior under
   `webglcontextlost` is outside this codebase's source and was not tested.
2. **Is `neutralizeStale()` invoked anywhere outside `src/`** (e.g., tests or a
   script) such that the served snapshot's stale fields are pre-nulled before the
   poller? No call site exists in `src/` (confirmed); the renderer's behavior is
   identical either way because it nulls on the `stale` flag itself.
3. **Browser-observed behavior** (whether the frozen frame actually renders during
   context loss, and the resume UX) has not been verified in a browser in this
   session — only the source contract was audited.
4. **Live telemetry end-to-end** (an actual fleet metrics backend feeding the
   pipeline) was not exercised; the audit covers the code paths, not a running
   deployment.
5. **Doc/comment contradiction in `oneShotIntensity`** (`oneShot.ts:73-78`): the
   doc comment says it "Returns 0 when `t` is before `startAt`" but the code
   returns `1` for `elapsed <= 0`. The code is taken as authoritative for this
   audit (held-at-full-intensity behavior); the comment's intent (no re-play
   before booking) is unresolvable from source alone.

---

_Method: read-only source audit. No build, test, or typecheck was run (prohibited by
the task constraints). Every cited line was read directly; line numbers refer to the
working tree at the time of the audit._
