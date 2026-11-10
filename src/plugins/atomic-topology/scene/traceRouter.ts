/**
 * Deterministic copper-trace router for the circuit-board floor (operator directive 37).
 * Pure and three-free so it is unit-testable.
 *
 * The old board painted short, isolated 4-lane stubs per 96-unit cell ("loose floating
 * rods"). This router builds REAL nets instead: every trace starts and ends somewhere
 * meaningful (an IC / connector pin row, a component pad, a via, an atom pad, the hub
 * platform, a board-edge connector) and is routed with 0/45/90 degree legs only:
 *
 *  - pin-row buses fan out of ICs / connectors and run to the atom pads and the hub;
 *  - long trunks run from the board edges (walls) to the hub platform;
 *  - IC-to-IC buses tie the board together;
 *  - small parts (caps, chokes, resistors) get single traces that either branch off a
 *    nearby net at a junction or drop to a via.
 *
 * Every point carries its arc length `s` from the net's source, and a branch starts at its
 * parent's `s` at the junction with the parent's pulse parameters, so a decorative pulse
 * that races down a trunk continues seamlessly into its branches. Nothing encodes telemetry.
 */
import {
  PART_FOOTPRINT,
  type Avoid,
  type BoardExtent,
  type PartPlacement,
} from "./boardComponents";

/** 0 = copper, 1 = neon cyan channel, 2 = neon orange channel. */
export type TraceKind = 0 | 1 | 2;
/** Decorative pulse train shared by a net and its branches (world units, seconds). */
export interface PulseParams {
  speed: number;
  period: number;
  phase: number;
  /**
   * Index (into `pads`) of the atom pad this net feeds, or -1 (decorative only). Feeder
   * nets are the one telemetry-bound part of the board (directive 40); branches inherit it.
   */
  feed: number;
}
export interface TraceSegment extends PulseParams {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Arc length at `a` from the net source, and the segment length. */
  s0: number;
  len: number;
  kind: TraceKind;
  width: number;
}
export interface TraceJoint extends PulseParams {
  x: number;
  z: number;
  s: number;
  kind: TraceKind;
  width: number;
}
/** A net end point: a via (drilled ring) or a component / atom pad. Flares when a pulse lands. */
export interface TraceTerminal extends PulseParams {
  x: number;
  z: number;
  s: number;
  kind: TraceKind;
  via: boolean;
}
export interface TraceLayout {
  segments: TraceSegment[];
  joints: TraceJoint[];
  terminals: TraceTerminal[];
  nets: number;
}
export interface TraceOptions {
  seed?: number;
  maxSegments?: number;
}
type P2 = [number, number];

export const TRACE_WIDTH = 2.2;
export const NEON_WIDTH = 1.3;
export const TRACE_PITCH = 4.6;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Snap a direction to the nearest multiple of 45 degrees (unit vector). */
export function snapDir45(dx: number, dz: number): P2 {
  const a = Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [Math.abs(c) < 1e-9 ? 0 : c, Math.abs(s) < 1e-9 ? 0 : s];
}
/**
 * Octilinear route from `a` to `b`: a stub out of `a` along `exitA`, a dog-leg of one
 * straight and one 45 degree leg, and a stub into `b` against `exitB` (the direction
 * pointing OUT of `b`'s terminal). Collinear / duplicate points are removed.
 */
export function octilinearRoute(
  a: P2,
  b: P2,
  exitA: P2,
  exitB: P2,
  stub: number,
  split: number
): P2[] {
  const sa: P2 = [a[0] + exitA[0] * stub, a[1] + exitA[1] * stub];
  const sb: P2 = [b[0] + exitB[0] * stub, b[1] + exitB[1] * stub];
  const dx = sb[0] - sa[0];
  const dz = sb[1] - sa[1];
  const adx = Math.abs(dx);
  const adz = Math.abs(dz);
  const f = Math.min(0.85, Math.max(0.15, split));
  const pts: P2[] = [a, sa];
  if (adx >= adz) {
    const straight = (adx - adz) * Math.sign(dx);
    const p1: P2 = [sa[0] + straight * f, sa[1]];
    const p2: P2 = [p1[0] + adz * Math.sign(dx), sb[1]];
    pts.push(p1, p2);
  } else {
    const straight = (adz - adx) * Math.sign(dz);
    const p1: P2 = [sa[0], sa[1] + straight * f];
    const p2: P2 = [sb[0], p1[1] + adx * Math.sign(dz)];
    pts.push(p1, p2);
  }
  pts.push(sb, b);
  return simplify(pts);
}
/** True when no turn along the route is sharper than 90 degrees (parallel offsets stay clean). */
export function gentleTurns(pts: readonly P2[]): boolean {
  for (let i = 1; i < pts.length - 1; i += 1) {
    const ux = pts[i][0] - pts[i - 1][0];
    const uz = pts[i][1] - pts[i - 1][1];
    const vx = pts[i + 1][0] - pts[i][0];
    const vz = pts[i + 1][1] - pts[i][1];
    if (ux * vx + uz * vz < -1e-6) return false;
  }
  return true;
}
function simplify(pts: P2[]): P2[] {
  const out: P2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 1e-6) continue;
    out.push(p);
  }
  // Drop interior points that are collinear with their neighbours.
  for (let i = out.length - 2; i >= 1; i -= 1) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
    if (Math.abs(cross) < 1e-6 && dot > 0) out.splice(i, 1);
  }
  return out;
}
/** Mitred parallel offset of a polyline by `d` (left of travel is positive). */
export function offsetPolyline(pts: readonly P2[], d: number): P2[] {
  if (pts.length < 2 || d === 0) return pts.map((p) => [p[0], p[1]] as P2);
  const nrm = (a: P2, b: P2): P2 => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
  };
  return pts.map((p, i) => {
    if (i === 0) {
      const n = nrm(pts[0], pts[1]);
      return [p[0] + n[0] * d, p[1] + n[1] * d];
    }
    if (i === pts.length - 1) {
      const n = nrm(pts[i - 1], pts[i]);
      return [p[0] + n[0] * d, p[1] + n[1] * d];
    }
    const n1 = nrm(pts[i - 1], pts[i]);
    const n2 = nrm(pts[i], pts[i + 1]);
    let mx = n1[0] + n2[0];
    let mz = n1[1] + n2[1];
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml;
    mz /= ml;
    const k = d / Math.max(0.35, mx * n1[0] + mz * n1[1]);
    return [p[0] + mx * k, p[1] + mz * k];
  });
}

interface Terminal {
  p: P2;
  /** Direction pointing OUT of the terminal (the trace leaves along it). */
  out: P2;
}
/** A pin row on `part`'s side facing `toward` (ICs: long sides; connectors: the pin edge). */
function pinRow(part: PartPlacement, toward: P2): Terminal {
  const fp = PART_FOOTPRINT[part.kind];
  // Local +z / -z sides (pins), rotated by the part spin about +Y (three: x->(cos,-sin)).
  const c = Math.cos(part.spin);
  const s = Math.sin(part.spin);
  const sideA: P2 = [s, c]; // local +z in world (x, z)
  const vx = toward[0] - part.x;
  const vz = toward[1] - part.z;
  const sign = sideA[0] * vx + sideA[1] * vz >= 0 ? 1 : -1;
  const out = snapDir45(sideA[0] * sign, sideA[1] * sign);
  const reach = part.kind === "connector" ? fp * 0.35 : fp * 0.72;
  return { p: [part.x + out[0] * reach, part.z + out[1] * reach], out };
}
/** The point of a round pad (atom pad / hub platform) facing `from`. */
function padEdge(pad: Avoid, from: P2, margin: number): Terminal {
  const out = snapDir45(from[0] - pad.x, from[1] - pad.z);
  const r = pad.r * margin;
  return { p: [pad.x + out[0] * r, pad.z + out[1] * r], out };
}

/**
 * Route the floor's nets. `pads` are the atom pads (the hub is the largest); `parts` are
 * the floor's placed 3D components (only `surface === "floor"` are used).
 */
export function routeTraces(
  ext: BoardExtent,
  pads: readonly Avoid[],
  parts: readonly PartPlacement[],
  opts: TraceOptions = {}
): TraceLayout {
  const seed = (opts.seed ?? 0x7ace5) >>> 0;
  const maxSegments = opts.maxSegments ?? 5200;
  const r = rng(seed);
  const segments: TraceSegment[] = [];
  const joints: TraceJoint[] = [];
  const terminals: TraceTerminal[] = [];
  let nets = 0;
  const floor = parts.filter((p) => p.surface === "floor");
  const hubs = floor.filter((p) => p.kind === "ic" || p.kind === "connector");
  const small = floor.filter(
    (p) =>
      p.kind === "can" ||
      p.kind === "toroid" ||
      p.kind === "boxChoke" ||
      p.kind === "axial" ||
      p.kind === "smd" ||
      p.kind === "mlcc"
  );
  const inside = (p: P2): boolean =>
    Math.abs(p[0]) <= ext.wallX - 4 && p[1] >= ext.farZ + 4 && p[1] <= ext.nearZ - 4;
  /** Junction candidates for branches: interior points of copper traces with their arc length. */
  const junctions: { p: P2; s: number; pulse: PulseParams }[] = [];
  const pulseFor = (feed = -1): PulseParams => ({
    speed: 70 + r() * 120,
    period: 240 + r() * 360,
    phase: r(),
    feed,
  });
  const emit = (
    pts: readonly P2[],
    kind: TraceKind,
    pulse: PulseParams,
    s0: number,
    endVia: boolean,
    startVia: boolean,
    collectJunctions: boolean
  ): number => {
    if (pts.length < 2 || segments.length >= maxSegments) return s0;
    if (!pts.every(inside) || !gentleTurns(pts)) return s0;
    const width = kind === 0 ? TRACE_WIDTH : NEON_WIDTH;
    let s = s0;
    if (startVia) terminals.push({ x: pts[0][0], z: pts[0][1], s, kind, via: true, ...pulse });
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-6) continue;
      segments.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], s0: s, len, kind, width, ...pulse });
      s += len;
      if (i < pts.length - 2) {
        joints.push({ x: b[0], z: b[1], s, kind, width, ...pulse });
        if (collectJunctions && kind === 0) junctions.push({ p: b, s, pulse });
      }
    }
    const e = pts[pts.length - 1];
    terminals.push({ x: e[0], z: e[1], s, kind, via: endVia, ...pulse });
    return s;
  };
  /** A bus of `n` parallel traces along a centre route, optionally with a neon channel. */
  const bus = (
    from: Terminal,
    to: Terminal,
    n: number,
    endVia: boolean,
    neonChance: number,
    feed = -1
  ): void => {
    const centre = octilinearRoute(from.p, to.p, from.out, to.out, 14 + r() * 26, 0.2 + r() * 0.6);
    // A bus whose centre doubles back cannot be offset cleanly: skip it (no kinks).
    if (!gentleTurns(centre)) return;
    const pulse = pulseFor(feed);
    const neon = r() < neonChance ? (r() < 0.72 ? 1 : 2) : 0;
    const total = n + (neon ? 1 : 0);
    nets += 1;
    for (let i = 0; i < total; i += 1) {
      const isNeon = neon && i === total - 1;
      const off = (i - (total - 1) / 2) * TRACE_PITCH + (isNeon ? TRACE_PITCH * 0.6 : 0);
      const pts = offsetPolyline(centre, off);
      // Each trace's pulses are slightly staggered so a bus shimmers rather than strobes.
      const p = { ...pulse, phase: (pulse.phase + i * 0.083) % 1 };
      emit(pts, (isNeon ? neon : 0) as TraceKind, p, 0, endVia, false, !isNeon);
    }
  };
  const near = <T extends { x: number; z: number }>(list: readonly T[], x: number, z: number) =>
    [...list].sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
  const use = new Map<PartPlacement, number>();
  // 1) Pin-row buses into every atom pad (the hub gets more), and board-edge trunks into the hub.
  const hub = pads.reduce<Avoid | null>((m, p) => (!m || p.r > m.r ? p : m), null);
  pads.forEach((pad, padIndex) => {
    const isHub = pad === hub;
    const want = isHub ? 4 : 2;
    let got = 0;
    for (const src of near(hubs, pad.x, pad.z)) {
      if (got >= want) break;
      if ((use.get(src) ?? 0) >= 2) continue;
      const d = Math.hypot(src.x - pad.x, src.z - pad.z);
      if (d > (isHub ? 1400 : 900)) break;
      const from = pinRow(src, [pad.x, pad.z]);
      const to = padEdge(pad, from.p, 1.04);
      bus(from, to, src.kind === "connector" ? 7 : 4 + Math.floor(r() * 3), false, 0.5, padIndex);
      use.set(src, (use.get(src) ?? 0) + 1);
      got += 1;
    }
  });
  // 1b) Every atom pad must be fed (directive 40): a pad whose buses were all dropped
  //     (pin rows used up, or a route that would kink) gets a trunk from the hub platform
  //     along its link direction, else a bus from any nearby IC / connector.
  const fedPads = (): Set<number> => new Set(segments.map((s) => s.feed).filter((f) => f >= 0));
  let fedNow = fedPads();
  pads.forEach((pad, padIndex) => {
    if (fedNow.has(padIndex) || segments.length >= maxSegments) return;
    const tries: (() => void)[] = [];
    if (hub && pad !== hub) {
      tries.push(() => {
        const from = padEdge(hub, [pad.x, pad.z], 1.08);
        const to = padEdge(pad, [hub.x, hub.z], 1.04);
        bus(from, to, 3, false, 0.5, padIndex);
      });
    }
    for (const src of near(hubs, pad.x, pad.z).slice(0, 6)) {
      tries.push(() => {
        const from = pinRow(src, [pad.x, pad.z]);
        bus(from, padEdge(pad, from.p, 1.04), 4, false, 0.5, padIndex);
      });
    }
    for (const t of tries) {
      t();
      fedNow = fedPads();
      if (fedNow.has(padIndex)) break;
    }
  });
  if (hub) {
    const edges: Terminal[] = [];
    const k = 3;
    for (let i = 0; i < k; i += 1) {
      const t = (i + 0.5 + (r() - 0.5) * 0.6) / k;
      edges.push({ p: [-ext.wallX + 6, ext.farZ + (ext.nearZ - ext.farZ) * t], out: [1, 0] });
      edges.push({ p: [ext.wallX - 6, ext.farZ + (ext.nearZ - ext.farZ) * t], out: [-1, 0] });
      edges.push({ p: [-ext.wallX + ext.wallX * 2 * t, ext.farZ + 6], out: [0, 1] });
    }
    for (const e of edges) {
      const to = padEdge(hub, e.p, 1.08);
      bus(e, to, 6, false, 0.75, pads.indexOf(hub));
    }
  }
  // 2) IC <-> IC / connector buses (each part to its nearest unlinked neighbour).
  const linked = new Set<string>();
  for (const a of hubs) {
    const b = near(
      hubs.filter((q) => q !== a),
      a.x,
      a.z
    )[0];
    if (!b) continue;
    const key = [a.x, a.z, b.x, b.z].map((v) => v.toFixed(1)).join(",");
    const rev = [b.x, b.z, a.x, a.z].map((v) => v.toFixed(1)).join(",");
    if (linked.has(key) || linked.has(rev)) continue;
    if (Math.hypot(a.x - b.x, a.z - b.z) > 700) continue;
    linked.add(key);
    const from = pinRow(a, [b.x, b.z]);
    const to = pinRow(b, [a.x, a.z]);
    bus(from, to, 3 + Math.floor(r() * 3), false, 0.25);
  }
  // 3) Small parts: a pad trace that branches off a nearby net (pulses flow into the part),
  //    or drops to a via.
  for (const part of small) {
    if (segments.length >= maxSegments) break;
    const fp = PART_FOOTPRINT[part.kind];
    const c = Math.cos(part.spin);
    const s = Math.sin(part.spin);
    const ax: P2 = snapDir45(c, -s); // local +x in world
    const side = r() < 0.5 ? 1 : -1;
    const term: Terminal = {
      p: [part.x + ax[0] * fp * 0.85 * side, part.z + ax[1] * fp * 0.85 * side],
      out: [ax[0] * side, ax[1] * side],
    };
    const j = near(
      junctions.map((q) => ({ x: q.p[0], z: q.p[1], q })),
      term.p[0],
      term.p[1]
    )[0];
    if (j && Math.hypot(j.x - term.p[0], j.z - term.p[1]) < 260 && r() < 0.7) {
      // Branch: leave the junction along a 45 degree diagonal toward the part.
      const out = snapDir45(term.p[0] - j.x, term.p[1] - j.z);
      const pts = octilinearRoute([j.x, j.z], term.p, out, term.out, 6, 0.5);
      nets += 1;
      emit(pts, 0, j.q.pulse, j.q.s, false, false, false);
    } else {
      const d = 40 + r() * 110;
      const dir = snapDir45(term.out[0] + (r() - 0.5), term.out[1] + (r() - 0.5));
      const via: P2 = [term.p[0] + dir[0] * d, term.p[1] + dir[1] * d];
      const pts = octilinearRoute(via, term.p, [-dir[0], -dir[1]], term.out, 5, 0.5);
      nets += 1;
      emit(pts, 0, pulseFor(), 0, false, true, false);
    }
  }
  return { segments, joints, terminals, nets };
}
