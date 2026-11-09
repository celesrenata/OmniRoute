/**
 * Routed copper traces on the circuit-board floor (TSL, operator directive 37).
 *
 * The nets come from the deterministic router (`traceRouter.ts`). They are drawn as REAL
 * raised geometry: one instanced draw of bevelled copper bars (metallic copper with a
 * fresnel-weighted environment reflection and a sharp key specular, or glowing neon
 * cyan / orange channels), one of round joint caps so 45 degree bends stay solid, one
 * of terminal pads / drilled vias, and one additive draw of terminal flares.
 *
 * Pulses are a pure function of (arc length along the net, time) with per-net speed /
 * period / phase, so a bright HDR head with a trail races the FULL length of every net,
 * continues seamlessly into branches (they start at the parent's arc length with the
 * parent's pulse train), flares softly where it lands on a pad or via, and every few
 * pulses throws a tiny spark there. Decorative only (never telemetry, never a link or
 * failure discharge); static under reduced motion (`partLife` = 0 freezes time).
 */
import {
  Fn,
  abs,
  attribute,
  cameraPosition,
  dot,
  exp,
  float,
  floor,
  fract,
  length,
  max,
  mix,
  normalGeometry,
  normalWorld,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  reflect,
  select,
  sin,
  smoothstep,
  step,
  vec3,
  vec4,
} from "three/tsl";
import {
  AdditiveBlending,
  BoxGeometry,
  CylinderGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three/webgpu";
import type { Avoid, BoardExtent, PartPlacement } from "../boardComponents";
import { routeTraces } from "../traceRouter";
import { envTime } from "../rt/sharedUniforms";
import { partLife } from "./boardParts";

/** Copper height above the solder mask (world units). */
const TRACE_HEIGHT = 0.7;
const MAX_SEGMENTS = 5200;
const MAX_JOINTS = 5200;
const MAX_TERMINALS = 2400;

/** Pulse head / trail intensity at arc length `s` (shared by every trace material). */
const pulseAt = (s: any, speed: any, period: any, phase: any) => {
  const t = envTime.mul(partLife as any);
  const u = fract(t.mul(speed).sub(s).div(period).add(phase));
  const behind = u.mul(period); // distance behind the head
  const ahead = smoothstep(period, period.sub(3), behind); // fade right before the next head
  const head = exp(behind.div(2.2).negate());
  const trail = exp(behind.div(speed.mul(0.1).add(12)).negate());
  return head.mul(1.5).add(trail.mul(0.4)).mul(ahead);
};
const pulseColor = (kind: any) =>
  select(
    kind.lessThan(1.5),
    vec3(0.22, 0.85, 1.0), // copper + cyan channels: cyan-white packets (idea5)
    vec3(1.0, 0.66, 0.28) // orange channels: warm packets
  );
/** Aerial perspective toward the container's navy (same falloff as the board parts). */
const fog = (c: any) => {
  const dist = length(positionWorld.sub(cameraPosition));
  return mix(vec3(0.004, 0.009, 0.024), c, exp(dist.mul(-0.00022)));
};
/** Metallic copper: fresnel-weighted room reflection + sharp key specular + a little diffuse. */
const copperShade = (N: any) => {
  const V = normalize(cameraPosition.sub(positionWorld));
  const R = reflect(V.negate(), N);
  const env = mix(vec3(0.02, 0.04, 0.1), vec3(0.28, 0.55, 0.85), smoothstep(-0.25, 0.85, R.y))
    .add(vec3(0.9, 0.42, 0.14).mul(smoothstep(0.35, 0.95, abs(R.x)).mul(0.35)))
    .add(vec3(0.2, 0.75, 1.0).mul(smoothstep(0.55, 0.98, abs(R.z)).mul(0.25)));
  const ndv = max(dot(N, V), 0);
  const F0 = vec3(0.95, 0.52, 0.28);
  // Grazing fresnel kept partial: the low hero camera sees the floor at grazing angles,
  // where a full Schlick term turns every trace white.
  const F = F0.add(
    vec3(1)
      .sub(F0)
      .mul(pow(float(1).sub(ndv), 5))
      .mul(0.3)
  );
  const key = normalize(vec3(-0.35, 1.0, 0.5));
  const H = normalize(key.add(V));
  const ndh = max(dot(N, H), 0);
  const spec = pow(ndh, float(140))
    .mul(2.6)
    .add(pow(ndh, float(16)).mul(0.22));
  const diffuse = vec3(0.6, 0.3, 0.14).mul(max(dot(N, key), 0).mul(0.12).add(0.03));
  // Copper tints what it reflects: the reflected room's luminance carries the copper
  // colour (a blue room reflected raw reads as grey-silver), with a little hue kept.
  const envL = dot(env, vec3(0.2126, 0.7152, 0.0722));
  return F.mul(envL.mul(1.1))
    .add(F.mul(env).mul(0.12))
    .mul(0.75)
    .add(
      F.mul(vec3(1.0, 0.8, 0.6))
        .mul(spec)
        .mul(0.8)
    )
    .add(diffuse);
};

function traceMaterial(joint: boolean): MeshBasicNodeMaterial {
  const mat = new MeshBasicNodeMaterial();
  const A = attribute("aSegA", "vec4"); // s0 (joint: s), len, speed, period
  const B = attribute("aSegB", "vec4"); // phase, kind, across.x, across.z
  const P = positionGeometry;
  mat.colorNode = Fn(() => {
    const kind = B.y;
    const s = joint ? A.x : A.x.add(P.x.add(0.5).mul(A.y));
    // Across-trace coordinate (-1..1); joints are round caps.
    const across = joint ? length(P.xz).mul(2) : P.z.mul(2);
    const top = step(0.5, normalGeometry.y);
    const acrossDir = vec3(B.z, 0, B.w);
    // Bevelled raised edge: the top tilts toward its edges.
    const slope = smoothstep(0.5, 1.0, abs(across)).mul(1.25);
    const tilt = joint
      ? normalize(vec3(P.x, 0, P.z).add(vec3(1e-4, 0, 0))).mul(slope)
      : acrossDir.mul(slope).mul(select(across.lessThan(0), float(-1), float(1)));
    const Ntop = normalize(vec3(0, 1, 0).add(tilt));
    const N = select(top.greaterThan(0.5), Ntop, normalize(normalWorld));
    const pulse = pulseAt(s, A.z, A.w, B.x);
    const pc = pulseColor(kind);
    // Copper (kind 0): metal + hot packets.
    const cu = copperShade(N).add(pc.mul(pulse).mul(3.2));
    // Neon channels (kind 1 cyan / 2 orange): emissive core, brighter packets.
    const neonBase = select(kind.lessThan(1.5), vec3(0.1, 0.82, 1.0), vec3(1.0, 0.48, 0.12));
    const core = float(1).sub(abs(across).mul(0.55));
    const neon = neonBase.mul(core.mul(1.25)).add(pc.mul(pulse).mul(5.5));
    return vec4(fog(select(kind.lessThan(0.5), cu, neon)), 1);
  })();
  mat.depthWrite = true;
  mat.depthTest = true;
  return mat;
}
/** Terminal pads (component / atom pad ends) and drilled vias: gold, flashing as pulses land. */
function terminalMaterial(): MeshBasicNodeMaterial {
  const mat = new MeshBasicNodeMaterial();
  const T = attribute("aTermA", "vec4"); // s, speed, period, phase
  const U = attribute("aTermB", "vec4"); // kind, via, seed, -
  const P = positionGeometry;
  mat.colorNode = Fn(() => {
    const r = length(P.xz).mul(2); // 0 centre .. 1 rim
    const top = step(0.5, normalGeometry.y);
    const N = select(top.greaterThan(0.5), vec3(0, 1, 0), normalize(normalWorld));
    const gold = copperShade(N).mul(vec3(1.05, 0.95, 0.6));
    const hole = U.y.mul(step(r, 0.42)).mul(top);
    const t = envTime.mul(partLife as any);
    const u = fract(t.mul(T.y).sub(T.x).div(T.z).add(T.w));
    const age = u.mul(T.z).div(T.y.max(1));
    const flash = exp(age.mul(-5));
    const pc = pulseColor(U.x);
    const c = mix(gold, vec3(0.004, 0.006, 0.012), hole).add(pc.mul(flash.mul(2.2)));
    return vec4(fog(c), 1);
  })();
  return mat;
}
/** Additive flare + occasional tiny spark where a pulse lands. */
function flareMaterial(): MeshBasicNodeMaterial {
  const mat = new MeshBasicNodeMaterial();
  const T = attribute("aTermA", "vec4");
  const U = attribute("aTermB", "vec4");
  const P = positionGeometry; // plane in xz, -0.5..0.5
  mat.colorNode = Fn(() => {
    const t = envTime.mul(partLife as any);
    const k = t.mul(T.y).sub(T.x).div(T.z).add(T.w);
    const u = fract(k);
    const age = u.mul(T.z).div(T.y.max(1));
    const flash = exp(age.mul(-6));
    // Every few pulses (seeded per terminal and pulse index) throw a tiny spark.
    const idx = floor(k);
    const h = fract(sin(idx.mul(12.9898).add(U.z.mul(78.233))).mul(43758.5453));
    const spark = step(h, 0.3).mul(exp(age.mul(-14)));
    const x = abs(P.x).mul(2);
    const z = abs(P.z).mul(2);
    const r = length(P.xz).mul(2);
    const glow = exp(r.mul(-7)).mul(flash).mul(1.1);
    const star = exp(x.mul(-40))
      .mul(exp(z.mul(-3.5)))
      .add(exp(z.mul(-40)).mul(exp(x.mul(-3.5))))
      .mul(spark)
      .mul(2.4);
    const a = glow.add(star).mul(smoothstep(1.0, 0.7, r));
    return vec4(pulseColor(U.x).mul(a), 1);
  })();
  mat.transparent = true;
  mat.blending = AdditiveBlending;
  mat.depthWrite = false;
  mat.depthTest = true;
  return mat;
}

export interface BoardTraces {
  objects: InstancedMesh[];
  setLayout: (ext: BoardExtent, pads: readonly Avoid[], parts: readonly PartPlacement[]) => void;
  /** Counts from the last layout (dev evidence). */
  stats: { segments: number; joints: number; terminals: number; nets: number; length: number };
  dispose: () => void;
}
export function createBoardTraces(): BoardTraces {
  const barGeo = new BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const jointGeo = new CylinderGeometry(0.5, 0.5, 1, 14).translate(0, 0.5, 0);
  const padGeo = new CylinderGeometry(0.5, 0.5, 1, 20).translate(0, 0.5, 0);
  const flareGeo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const attach = (g: BoxGeometry | CylinderGeometry | PlaneGeometry, n: number, names: string[]) =>
    names.forEach((nm) =>
      g.setAttribute(nm, new InstancedBufferAttribute(new Float32Array(n * 4), 4))
    );
  attach(barGeo, MAX_SEGMENTS, ["aSegA", "aSegB"]);
  attach(jointGeo, MAX_JOINTS, ["aSegA", "aSegB"]);
  attach(padGeo, MAX_TERMINALS, ["aTermA", "aTermB"]);
  attach(flareGeo, MAX_TERMINALS, ["aTermA", "aTermB"]);
  const barMat = traceMaterial(false);
  const jointMat = traceMaterial(true);
  const padMat = terminalMaterial();
  const flareMat = flareMaterial();
  const mk = (g: any, m: MeshBasicNodeMaterial, n: number, name: string, order: number) => {
    const mesh = new InstancedMesh(g, m, n);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    mesh.name = name;
    return mesh;
  };
  const bars = mk(barGeo, barMat, MAX_SEGMENTS, "board-traces", -55);
  const joints = mk(jointGeo, jointMat, MAX_JOINTS, "board-trace-joints", -55);
  const pads = mk(padGeo, padMat, MAX_TERMINALS, "board-trace-pads", -54);
  const flares = mk(flareGeo, flareMat, MAX_TERMINALS, "board-trace-flares", 10);
  const stats = { segments: 0, joints: 0, terminals: 0, nets: 0, length: 0 };
  const m = new Matrix4();
  const q = new Quaternion();
  const pos = new Vector3();
  const scl = new Vector3();
  const UP = new Vector3(0, 1, 0);
  const setLayout = (
    ext: BoardExtent,
    padList: readonly Avoid[],
    parts: readonly PartPlacement[]
  ): void => {
    const L = routeTraces(ext, padList, parts, { maxSegments: MAX_SEGMENTS });
    const y = ext.floorY + 0.05;
    const sa = barGeo.getAttribute("aSegA") as InstancedBufferAttribute;
    const sb = barGeo.getAttribute("aSegB") as InstancedBufferAttribute;
    let len = 0;
    const nb = Math.min(MAX_SEGMENTS, L.segments.length);
    for (let i = 0; i < nb; i += 1) {
      const s = L.segments[i];
      const th = Math.atan2(s.bz - s.az, s.bx - s.ax);
      q.setFromAxisAngle(UP, -th);
      pos.set((s.ax + s.bx) / 2, y, (s.az + s.bz) / 2);
      scl.set(s.len, TRACE_HEIGHT, s.width);
      bars.setMatrixAt(i, m.compose(pos, q, scl));
      (sa.array as Float32Array).set([s.s0, s.len, s.speed, s.period], i * 4);
      (sb.array as Float32Array).set([s.phase, s.kind, -Math.sin(th), Math.cos(th)], i * 4);
      len += s.len;
    }
    bars.count = nb;
    const ja = jointGeo.getAttribute("aSegA") as InstancedBufferAttribute;
    const jb = jointGeo.getAttribute("aSegB") as InstancedBufferAttribute;
    const nj = Math.min(MAX_JOINTS, L.joints.length);
    q.identity();
    for (let i = 0; i < nj; i += 1) {
      const j = L.joints[i];
      pos.set(j.x, y, j.z);
      // Slightly lower than the bars so the coplanar tops never z-fight.
      scl.set(j.width, TRACE_HEIGHT * 0.97, j.width);
      joints.setMatrixAt(i, m.compose(pos, q, scl));
      (ja.array as Float32Array).set([j.s, 0, j.speed, j.period], i * 4);
      (jb.array as Float32Array).set([j.phase, j.kind, 1, 0], i * 4);
    }
    joints.count = nj;
    const pa = padGeo.getAttribute("aTermA") as InstancedBufferAttribute;
    const pb = padGeo.getAttribute("aTermB") as InstancedBufferAttribute;
    const fa = flareGeo.getAttribute("aTermA") as InstancedBufferAttribute;
    const fb = flareGeo.getAttribute("aTermB") as InstancedBufferAttribute;
    const nt = Math.min(MAX_TERMINALS, L.terminals.length);
    for (let i = 0; i < nt; i += 1) {
      const t = L.terminals[i];
      const d = t.via ? 5.2 : 4.0;
      pos.set(t.x, y, t.z);
      scl.set(d, TRACE_HEIGHT * 0.6, d);
      pads.setMatrixAt(i, m.compose(pos, q, scl));
      pos.set(t.x, y + TRACE_HEIGHT + 0.4, t.z);
      scl.set(16, 1, 16);
      flares.setMatrixAt(i, m.compose(pos, q, scl));
      const A = [t.s, t.speed, t.period, t.phase];
      const Bv = [t.kind, t.via ? 1 : 0, (i * 0.6180339) % 1, 0];
      (pa.array as Float32Array).set(A, i * 4);
      (pb.array as Float32Array).set(Bv, i * 4);
      (fa.array as Float32Array).set(A, i * 4);
      (fb.array as Float32Array).set(Bv, i * 4);
    }
    pads.count = nt;
    flares.count = nt;
    for (const a of [sa, sb, ja, jb, pa, pb, fa, fb]) a.needsUpdate = true;
    for (const mesh of [bars, joints, pads, flares]) mesh.instanceMatrix.needsUpdate = true;
    Object.assign(stats, {
      segments: nb,
      joints: nj,
      terminals: nt,
      nets: L.nets,
      length: Math.round(len),
    });
  };
  return {
    objects: [bars, joints, pads, flares],
    setLayout,
    stats,
    dispose: () => {
      for (const g of [barGeo, jointGeo, padGeo, flareGeo]) g.dispose();
      for (const mt of [barMat, jointMat, padMat, flareMat]) mt.dispose();
    },
  };
}
