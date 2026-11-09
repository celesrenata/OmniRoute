/**
 * Camera fly-in for the opt-in detail view (OR-ATOM Step 11, directive 34). Pure math.
 *
 * The default view's camera is frozen; only when the viewer explicitly opens
 * the detail view does the camera travel. It eases from wherever it is to a
 * LOW, near eye-level pose close to the inspected atom (idea5's "being there"
 * hero shot): the atom fills most of the frame, the board recedes to a visible
 * horizon behind it. The pose is interpolated in spherical coordinates around
 * the atom (distance, elevation, azimuth with a short yaw sweep), then control
 * returns to the unchanged orbit controls; a slow cinematic drift (a bounded
 * yaw sway) keeps the shot alive until the viewer grabs the camera. This module
 * only computes poses; `AtomicScene.tsx` applies them. `cameraFit.ts` is never
 * altered.
 */
/** Hero camera distance from the atom (world units); outside OrbitControls' minimum (200); with the 38 deg fov the whole cloud, rim and orbit wires fit. */
export const DETAIL_HERO_DISTANCE = 300;
/** Kept for the legacy fit-relative helper: never closer than the orbit minimum plus a margin. */
export const DETAIL_MIN_DISTANCE = 205;
/** Near eye-level elevation (radians above the horizontal plane through the atom). */
export const DETAIL_ELEVATION_RAD = 0.2;
/** Telephoto field of view of the settled hero shot (the scene default is 50). */
export const DETAIL_FOV_DEG = 38;
/** Field of view at eased flight progress `e` (lerp from the scene fov to the goal fov). */
export function detailFov(
  baseFovDeg: number,
  e: number,
  goalFovDeg: number = DETAIL_FOV_DEG
): number {
  const p = Math.min(1, Math.max(0, Number.isFinite(e) ? e : 1));
  return baseFovDeg + (goalFovDeg - baseFovDeg) * p;
}
/** Narrowest / widest hero field of view the composition may choose. */
export const DETAIL_MIN_FOV_DEG = 18;
export const DETAIL_MAX_FOV_DEG = 55;
/** Farthest hero distance (world units). */
export const DETAIL_MAX_DISTANCE = 460;
/** Fraction of the safe area the atom + pad span fills (vertical and horizontal). */
export const DETAIL_SAFE_FILL = 0.88;
/** Clearance kept around each DOM overlay when carving the safe area (CSS px). */
export const DETAIL_OVERLAY_PAD_PX = 8;
/** Orbit wires reach 0.98 x 1.18 of the drawn cloud radius (`orbitWires` x wire scale). */
export const DETAIL_WIRE_REACH = 1.16;

/** A CSS-pixel rectangle in canvas space (0,0 = the canvas' top-left corner). */
export interface DetailRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/**
 * The part of the canvas not covered by DOM overlays (legend, detail panel,
 * controls, view toggle, status badge). Greedy: each overlay (largest first) that
 * still intersects the free rectangle removes the side that keeps the most area
 * (above / below / left / right of it). Falls back to the whole canvas when the
 * remainder would be degenerate (under 30% of a side).
 */
export function detailSafeArea(
  width: number,
  height: number,
  overlays: readonly DetailRect[],
  padPx: number = DETAIL_OVERLAY_PAD_PX
): DetailRect {
  const W = Number.isFinite(width) && width > 0 ? width : 1;
  const H = Number.isFinite(height) && height > 0 ? height : 1;
  let safe: DetailRect = { x: 0, y: 0, w: W, h: H };
  const list = overlays
    .filter((r) => [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0)
    .map((r) => ({ x: r.x - padPx, y: r.y - padPx, w: r.w + 2 * padPx, h: r.h + 2 * padPx }))
    .sort((a, b) => b.w * b.h - a.w * a.h);
  for (const o of list) {
    const ix0 = Math.max(safe.x, o.x);
    const iy0 = Math.max(safe.y, o.y);
    const ix1 = Math.min(safe.x + safe.w, o.x + o.w);
    const iy1 = Math.min(safe.y + safe.h, o.y + o.h);
    if (ix1 <= ix0 || iy1 <= iy0) continue;
    const cands: DetailRect[] = [
      { x: safe.x, y: safe.y, w: safe.w, h: iy0 - safe.y },
      { x: safe.x, y: iy1, w: safe.w, h: safe.y + safe.h - iy1 },
      { x: safe.x, y: safe.y, w: ix0 - safe.x, h: safe.h },
      { x: ix1, y: safe.y, w: safe.x + safe.w - ix1, h: safe.h },
    ].filter((c) => c.w >= W * 0.3 && c.h >= H * 0.3);
    if (cands.length === 0) continue;
    safe = cands.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  }
  return safe;
}

/** What the composition needs to know about the inspected atom (world units). */
export interface DetailAtomGeometry {
  /** Drawn visual centre (the idle seat drop already applied). */
  center: [number, number, number];
  /** Outer envelope radius: cloud and orbit wires. */
  envelope: number;
  /** Height of the emitter pad / platform under the atom, and its radius. */
  padY: number;
  padR: number;
}
/**
 * Per-atom detail geometry as the renderer draws it: cloud radius = bounded
 * energy multiplier x bound radius x scale, the orbit wires reach
 * {@link DETAIL_WIRE_REACH} of it, the drawn centre sits `seatDrop` below the
 * layout position, and the pad lies `floorOffset` below the layout position.
 */
export function detailAtomGeometry(
  position: readonly [number, number, number],
  boundRadius: number,
  cloudRadiusMul: number,
  scale: number,
  seatDrop: number,
  floorOffset: number,
  padRadius: number
): DetailAtomGeometry {
  const mul = Number.isFinite(cloudRadiusMul) ? Math.min(1, Math.max(0.5, cloudRadiusMul)) : 0.8;
  const sc = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const drop = Number.isFinite(seatDrop) ? Math.max(0, seatDrop) : 0;
  return {
    center: [position[0], position[1] - drop, position[2]],
    envelope: boundRadius * mul * sc * DETAIL_WIRE_REACH,
    padY: position[1] + floorOffset,
    padR: padRadius,
  };
}
/** Latest detail geometry per atom id, written by the scene each frame, read by the flight. */
export const detailAtomGeometries: Map<string, DetailAtomGeometry> = new Map();

/** Settled hero shot: camera distance, vertical fov and the lens shift (NDC) that centres it. */
export interface DetailComposition {
  distance: number;
  fovDeg: number;
  /** Principal-point shift in NDC (x right, y up), applied with `camera.setViewOffset`. */
  shift: [number, number];
}
/**
 * Compose the low hero shot inside the safe area. The camera orbits `target`
 * (the layout position the orbit controls pivot on) at `elevation`; the span
 * from the top of the atom's envelope down to the front and back of its pad is
 * fitted to {@link DETAIL_SAFE_FILL} of the safe area's height (and the envelope
 * to its width), then a lens shift moves that span's centre onto the safe area's
 * centre. The field of view also keeps the board horizon inside the frame.
 * With `fixedDistance` the distance is kept (re-composition after a resize).
 */
export function detailComposition(
  geo: DetailAtomGeometry,
  target: readonly [number, number, number],
  canvas: { width: number; height: number },
  safe: DetailRect,
  elevation: number = DETAIL_ELEVATION_RAD,
  fixedDistance?: number
): DetailComposition {
  const W = Number.isFinite(canvas.width) && canvas.width > 0 ? canvas.width : 1;
  const H = Number.isFinite(canvas.height) && canvas.height > 0 ? canvas.height : 1;
  const aspect = W / H;
  const E = Number.isFinite(geo.envelope) && geo.envelope > 0 ? geo.envelope : 60;
  const el = Number.isFinite(elevation) ? elevation : DETAIL_ELEVATION_RAD;
  const ce = Math.cos(el);
  const se = Math.sin(el);
  const cy = geo.center[1] - target[1];
  const py = (Number.isFinite(geo.padY) ? geo.padY : geo.center[1] - E) - target[1];
  const pr = Number.isFinite(geo.padR) && geo.padR > 0 ? geo.padR : E;
  const safeHn = (2 * Math.max(1, safe.h)) / H;
  const safeWn = (2 * Math.max(1, safe.w)) / W;
  const safeCx = ((safe.x + safe.w / 2) / W) * 2 - 1;
  const safeCy = 1 - ((safe.y + safe.h / 2) / H) * 2;
  // Angular (tan) coordinates of the key points seen from distance D (vertical plane).
  const measure = (D: number) => {
    const camS = D * ce;
    const camY = D * se;
    const ang = (s: number, y: number): number => {
      const rs = s - camS;
      const ry = y - camY;
      const depth = rs * -ce + ry * -se;
      const up = rs * -se + ry * ce;
      return up / Math.max(1e-3, depth);
    };
    const pts = [ang(0, cy + E), ang(0, cy - E), ang(pr, py), ang(-pr, py)];
    const hi = Math.max(...pts);
    const lo = Math.min(...pts);
    const depthC = D - cy * se;
    let tanHalf = Math.max(
      (hi - lo) / (DETAIL_SAFE_FILL * safeHn),
      (2 * E) / Math.max(1e-3, depthC) / (aspect * DETAIL_SAFE_FILL * safeWn)
    );
    const mid = (hi + lo) / 2;
    // Board horizon (the direction of zero elevation) stays inside the frame.
    const room = 0.94 - safeCy;
    if (room > 0.05) tanHalf = Math.max(tanHalf, (Math.tan(el) - mid) / room);
    return { tanHalf, mid };
  };
  const tanOf = (deg: number) => Math.tan((deg * Math.PI) / 360);
  let D: number;
  if (fixedDistance != null && Number.isFinite(fixedDistance) && fixedDistance > 0) {
    D = fixedDistance;
  } else {
    D = DETAIL_HERO_DISTANCE;
    for (let i = 0; i < 3; i += 1) {
      const m = measure(D);
      D = Math.min(
        DETAIL_MAX_DISTANCE,
        Math.max(DETAIL_MIN_DISTANCE, (D * m.tanHalf) / tanOf(DETAIL_FOV_DEG))
      );
    }
  }
  const m = measure(D);
  const fovDeg = Math.min(
    DETAIL_MAX_FOV_DEG,
    Math.max(DETAIL_MIN_FOV_DEG, (2 * Math.atan(m.tanHalf) * 180) / Math.PI)
  );
  const tanHalf = tanOf(fovDeg);
  return { distance: D, fovDeg, shift: [safeCx, safeCy - m.mid / tanHalf] };
}
/** An obstacle for the hero camera: another atom's drawn centre and envelope radius. */
export interface DetailObstacle {
  center: readonly [number, number, number];
  radius: number;
}
/** Squared distance from point `p` to the segment a-b (3D). */
function segDist2(p: readonly number[], a: readonly number[], b: readonly number[]): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1e-9;
  const t = Math.min(1, Math.max(0, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2));
  const d = [ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t];
  return d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
}
/**
 * Yaw sweep (radians, added to the start azimuth) that ends the fly-in with a clear
 * line of sight: no other atom between the camera and the inspected atom, and the
 * camera never sits inside (or right beside) another atom's cloud, over the whole drift
 * sway. Among
 * clear candidates the one closest to the default sweep wins; if none is fully clear,
 * the least-obstructed one.
 */
export function clearDetailSweep(
  target: readonly [number, number, number],
  focusCenter: readonly [number, number, number],
  startAzimuth: number,
  distance: number,
  others: readonly DetailObstacle[],
  elevation: number = DETAIL_ELEVATION_RAD,
  defaultSweep: number = DETAIL_SWEEP_RAD
): number {
  const az0 = Number.isFinite(startAzimuth) ? startAzimuth : 0;
  if (others.length === 0) return defaultSweep;
  const ce = Math.cos(elevation);
  const se = Math.sin(elevation);
  const blockage = (az: number): number => {
    let worst = 0;
    for (const sway of [-DETAIL_DRIFT_AMPLITUDE_RAD, 0, DETAIL_DRIFT_AMPLITUDE_RAD]) {
      const a = az + sway;
      const cam = [
        target[0] + Math.sin(a) * ce * distance,
        target[1] + se * distance,
        target[2] + Math.cos(a) * ce * distance,
      ];
      for (const o of others) {
        const r = Math.max(1, o.radius) * 1.15;
        const d = Math.sqrt(segDist2(o.center, cam, focusCenter));
        worst = Math.max(worst, Math.max(0, r - d) / r);
        // A neighbour right beside the lens crowds the shot even when it does not block it.
        const near = r * 2.4;
        const dc = Math.hypot(o.center[0] - cam[0], o.center[1] - cam[1], o.center[2] - cam[2]);
        worst = Math.max(worst, (0.5 * Math.max(0, near - dc)) / near);
      }
    }
    return worst;
  };
  let best = defaultSweep;
  let bestScore = Infinity;
  const STEPS = 48;
  for (let i = 0; i < STEPS; i += 1) {
    // Candidates ordered by distance from the default sweep (0, +k, -k, ...).
    const k = Math.ceil(i / 2) * (i % 2 === 1 ? 1 : -1);
    const sweep = defaultSweep + (k * 2 * Math.PI) / STEPS;
    const b = blockage(az0 + sweep);
    // Prefer clear views; within 1% blockage keep the earlier (closer) candidate.
    if (b < bestScore - 0.01) {
      bestScore = b;
      best = sweep;
      if (b === 0) break;
    }
  }
  return best;
}
/** Pixel window for `camera.setViewOffset(W, H, x, y, W, H)` that realises an NDC shift. */
export function viewOffsetPx(
  shift: readonly [number, number],
  width: number,
  height: number
): { x: number; y: number } {
  return { x: (-shift[0] * width) / 2, y: (shift[1] * height) / 2 };
}
/** Fly-in duration (ms). */
export const DETAIL_FLIGHT_MS = 1700;
/** Total yaw swing (radians) accumulated over the flight. */
export const DETAIL_SWEEP_RAD = 0.55;
/** Peak yaw sway of the settled cinematic drift (radians, each side). */
export const DETAIL_DRIFT_AMPLITUDE_RAD = 0.2;
/** Drift period (ms): slow, one full sway every ~38 s. */
export const DETAIL_DRIFT_PERIOD_MS = 38_000;
/** Goal camera distance from the inspected atom for a given base fit distance. */
export function detailGoalDistance(fitDistance: number): number {
  if (!Number.isFinite(fitDistance) || fitDistance <= 0) return DETAIL_MIN_DISTANCE;
  return Math.max(DETAIL_MIN_DISTANCE, Math.min(DETAIL_HERO_DISTANCE, fitDistance * 0.5));
}
/** Smooth ease in/out, clamped to [0, 1]. */
export function easeInOutCubic(t: number): number {
  const x = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 1;
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** Eased flight progress for `elapsedMs`; reduced motion jumps straight to the end. */
export function flightProgress(elapsedMs: number, reducedMotion: boolean): number {
  if (reducedMotion) return 1;
  return easeInOutCubic(elapsedMs / DETAIL_FLIGHT_MS);
}

/**
 * The camera offset (camera - target) at eased progress `e`: distance, elevation
 * and azimuth are interpolated from the start offset `o0` to (`goalDistance`,
 * `goalElevation`, azimuth + `sweep`). Degenerate (zero-length / non-finite)
 * starts fall back to the default +Z viewing direction.
 */
export function flightOffset(
  o0: readonly [number, number, number],
  goalDistance: number,
  e: number,
  sweep: number = DETAIL_SWEEP_RAD,
  goalElevation: number = DETAIL_ELEVATION_RAD
): [number, number, number] {
  const len = Math.hypot(o0[0], o0[1], o0[2]);
  const ok = Number.isFinite(len) && len > 1e-6;
  const d0 = ok ? len : goalDistance;
  const el0 = ok ? Math.asin(Math.max(-1, Math.min(1, o0[1] / len))) : 0.24;
  const az0 = ok && Math.hypot(o0[0], o0[2]) > 1e-9 ? Math.atan2(o0[0], o0[2]) : 0;
  const p = Math.min(1, Math.max(0, Number.isFinite(e) ? e : 1));
  const dist = d0 + (goalDistance - d0) * p;
  const el = el0 + (goalElevation - el0) * p;
  const az = az0 + sweep * p;
  const ce = Math.cos(el);
  return [Math.sin(az) * ce * dist, Math.sin(el) * dist, Math.cos(az) * ce * dist];
}
/**
 * Yaw angular velocity (rad/s) of the settled cinematic drift at `tMs` since the
 * flight ended: the derivative of `A * sin(2*pi*t/T)`, so the sway is bounded
 * (never leaves the framing) and smooth. Zero in reduced motion.
 */
export function driftYawRate(tMs: number, reducedMotion: boolean): number {
  if (reducedMotion || !Number.isFinite(tMs) || tMs < 0) return 0;
  const w = (2 * Math.PI) / (DETAIL_DRIFT_PERIOD_MS / 1000);
  return DETAIL_DRIFT_AMPLITUDE_RAD * w * Math.cos((w * tMs) / 1000);
}
