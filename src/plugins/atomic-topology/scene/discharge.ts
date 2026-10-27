/**
 * Pure failure-discharge (lightning bolt) + impulse math for the Atomic scene
 * (OR-ATOM-007).
 *
 * No `three`, no DOM, no `Math.random`, no clock. The jagged red failure
 * discharge is a deterministic polyline generated from a seeded PRNG
 * (mulberry32 over FNV-1a of a stable id + state), so the same atom in the
 * same state always renders the same bolt — no fabricated motion.
 *
 * The bolt's perpendicular jitter **decays outward from the hub**: near the
 * nucleus the segments are jagged (high amplitude), and the amplitude shrinks
 * toward the atom so the discharge reads as arcing energy that settles into
 * the target. This is pure geometry + a decay envelope; the scene applies it.
 */
import { fnv1a } from "./cloudShells";

/**
 * Mulberry32 — a tiny fast deterministic 32-bit PRNG. Returns a function that
 * yields the next pseudo-random float in `[0, 1)` on each call. Same seed →
 * same sequence, every time, on every platform.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A single 3D point on a bolt (unit space: hub = origin, target = (1,0,0)). */
export interface BoltPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Deterministic jagged discharge path from the hub (origin) to the target
 * (the unit +x axis in bolt-local space; the scene scales/rotates it into
 * world space toward the atom).
 *
 * - `segments` (9–14 by spec) internal kinks → `segments + 1` points.
 * - Each interior point gets a **perpendicular** jitter (in the plane spanned
 *   by the two perpendicular basis vectors, y and z) whose amplitude **decays
 *   outward** from the hub via {@link boltAmplitudeAt}. The endpoints are
 *   pinned exactly at (0,0,0) and (1,0,0) so the bolt always connects.
 * - `seed` → `mulberry32(fnv1a(seedString))`.
 *
 * Pure: same arguments → identical points (determinism pin).
 */
export function boltPoints(segments: number, seedString: string, amplitude = 0.12): BoltPoint[] {
  const segs = Math.max(1, Math.floor(segments));
  const rand = mulberry32(fnv1a(seedString));
  const points: BoltPoint[] = [];
  for (let i = 0; i <= segs; i += 1) {
    const t = i / segs;
    if (i === 0 || i === segs) {
      // Pinned endpoints — the bolt always connects hub → atom.
      points.push({ x: t, y: 0, z: 0 });
      continue;
    }
    // Perpendicular jitter in (y, z), decaying outward from the hub.
    const amp = amplitude * boltAmplitudeAt(t);
    const jy = (rand() * 2 - 1) * amp;
    const jz = (rand() * 2 - 1) * amp;
    points.push({ x: t, y: jy, z: jz });
  }
  return points;
}

/**
 * Perpendicular-jitter amplitude envelope along the bolt, 0→1→0:
 *
 * - 0 at the endpoints (bolt must connect).
 * - peaks near the middle, then **decays outward** toward the target.
 *
 * Monotone-decay in the outward half is pinned by tests: for t in [0.5, 1],
 * the amplitude is non-increasing. Bounded to [0, 1].
 */
export function boltAmplitudeAt(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  // Exact endpoints: the bolt must connect at both atoms (snap out of float
  // noise — cos(π/2)² is ~4e-33, not exactly 0).
  if (x === 0 || x === 1) return 0;
  // Envelope: 0 at both endpoints (the bolt must connect hub → atom),
  // rises from the hub, peaks at the middle, then decays **monotonically**
  // outward toward the target. Both halves are cos² ramps — each is bounded
  // to [0, 1] and non-decreasing/non-increasing by construction, so the
  // peak is exactly at t = 0.5 with amplitude 1.
  if (x <= 0.5) {
    // Rising half: 0 → 1 over t ∈ [0, 0.5] (sin(πx) is monotone here).
    return Math.sin(Math.PI * x);
  }
  // Outward half: 1 → 0 over t ∈ [0.5, 1] (monotone decay toward the atom).
  return Math.pow(Math.cos(Math.PI * (x - 0.5)), 2);
}

/**
 * Exponential-decay envelope for a one-shot burst (the failure flash and the
 * completion flash use it). Maps elapsed `t` seconds into an intensity in
 * `[0, 1]` that starts at 1 and decays exponentially to 0 over `duration`.
 *
 * - `t <= 0` → 1 (burst just started).
 * - `t >= duration` → 0 (burst over).
 * - otherwise → `exp(-decay * t)`, normalized so the value at `t=0` is 1.
 *
 * Pure + bounded; pinned by tests (monotone-decreasing, → 0 at duration).
 */
export function decayEnvelope(tSeconds: number, durationSeconds: number, decay = 6): number {
  if (durationSeconds <= 0) return 0;
  if (tSeconds <= 0) return 1;
  if (tSeconds >= durationSeconds) return 0;
  return Math.exp(-decay * tSeconds);
}

/**
 * Deterministic segment count (9–14) for a bolt from a seed — so the same
 * atom always renders the same number of kinks.
 */
export function boltSegmentCount(seedString: string): number {
  const h = fnv1a(seedString);
  return 9 + (h % 6); // 9..14 inclusive
}
