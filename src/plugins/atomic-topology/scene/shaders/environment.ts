/**
 * Procedural "place" for the golden atom (TSL): a reflective dark tech floor
 * with perspective grid, circuit traces, orange light streaks and ripple
 * rings; server-room corridor walls with racks, panels and warm/cyan LEDs
 * receding into depth (depth-softened, i.e. fake-DOF); floating bokeh orbs
 * and dust at three depths; a glass holographic pedestal dome under the atom.
 *
 * Everything is a pure function of the view ray / world position and a time
 * uniform, so there is no per-frame CPU work besides one uniform write.
 */
import {
  Fn,
  If,
  abs,
  atan,
  cameraPosition,
  clamp,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  length,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  saturate,
  select,
  sin,
  smoothstep,
  step,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import {
  AdditiveBlending,
  BackSide,
  InstancedMesh,
  Matrix4,
  Vector4,
  CylinderGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  SphereGeometry,
  DoubleSide,
  CircleGeometry,
  type Object3D,
} from "three/webgpu";
import { floorY as sharedFloorY } from "../rt/sharedUniforms";

/** Bench floor height (world units); the topology host derives its own from layout bounds. */
export const FLOOR_Y = -66;
const WALL_X = 420;
const CEIL_Y = 300;
const FAR_Z = -1700;
const ROOM_RADIUS = 2500;
/** Max pedestals (instanced; one per atom). */
export const MAX_PEDESTALS = 256;

/** Room/pedestal placement. All optional; defaults reproduce the Gate A bench room. */
export interface EnvironmentLayout {
  /** Pedestal centres (x, z) on the floor, with optional scale (hub = larger). */
  pedestals: { x: number; z: number; y?: number; scale?: number }[];
  /** Corridor half-width (world units). */
  wallX?: number;
  /** Ceiling height (world units). */
  ceilY?: number;
  /** Z of the far (vanishing) end of the corridor. */
  farZ?: number;
  /** Pattern scale: grid/rack/LED sizes and depth falloffs multiply by this. */
  scale?: number;
  /** Floor height (world units). */
  floorY?: number;
}

export interface Environment {
  objects: Object3D[];
  time: { value: number };
  /** Re-place the room + pedestals (layout change); no shader rebuild. */
  setLayout: (layout: EnvironmentLayout) => void;
  /** Keep the room shell centred on the camera and inside its far plane. */
  follow: (camera: { position: { x: number; y: number; z: number }; far: number }) => void;
  dispose: () => void;
}

const h21 = (p: any) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));

/** Server-rack wall: a (across) and b (along the corridor) in world units. */
const wallPattern = Fn(([a, b, dist, tm]: [any, any, any, any]) => {
  const blur = float(1).add(dist.mul(0.006));
  const cs = vec2(60, 140);
  const g = vec2(a, b).div(cs);
  const cell = floor(g);
  const f = fract(g);
  const h = h21(cell);
  const h2 = h21(cell.add(7.7));
  const dEdge = min(min(f.x, float(1).sub(f.x)).mul(cs.x), min(f.y, float(1).sub(f.y)).mul(cs.y));
  const base = vec3(0.012, 0.02, 0.05).mul(float(0.6).add(h.mul(0.9)));
  const edgeCol = mix(vec3(0.05, 0.55, 0.8), vec3(1.0, 0.45, 0.1), step(0.42, h2));
  const edge = exp(dEdge.negate().div(blur.mul(0.9)))
    .mul(edgeCol)
    .mul(float(0.25).add(h.mul(0.55)));
  // Screens: lit panels with scanlines.
  const inner = smoothstep(0.08, 0.16, f.x)
    .mul(smoothstep(0.92, 0.84, f.x))
    .mul(smoothstep(0.1, 0.18, f.y))
    .mul(smoothstep(0.9, 0.82, f.y));
  const screen = step(0.78, h)
    .mul(inner)
    .mul(vec3(0.05, 0.4, 0.55))
    .mul(
      float(0.5).add(
        sin(b.mul(0.9).add(tm.mul(1.5)).add(h.mul(30)))
          .mul(0.25)
          .add(0.25)
      )
    );
  // LEDs.
  const lg = vec2(a, b).div(vec2(15, 19));
  const lcell = floor(lg);
  const ljit = vec2(h21(lcell.add(2.2)), h21(lcell.add(5.9)))
    .sub(0.5)
    .mul(0.24);
  const lf = fract(lg).sub(0.5).sub(ljit);
  const lh = h21(lcell.add(13.1));
  const ledOn = step(0.86, lh);
  const lsel = h21(lcell.add(3.3));
  const ledCol = mix(
    mix(vec3(1.0, 0.5, 0.12), vec3(1.0, 0.2, 0.65), step(0.82, lsel)),
    vec3(0.15, 0.85, 1.0),
    step(0.6, lsel)
  );
  const blink = float(0.7).add(sin(tm.mul(2.0).add(lh.mul(60))).mul(0.3));
  const led = ledOn
    .mul(
      exp(
        dot(lf, lf)
          .mul(-200)
          .div(min(blur, float(2.2)).pow(2))
      )
    )
    .mul(ledCol)
    .mul(blink)
    .mul(2.6);
  // Long warm light bars running down the corridor (receding orange lines).
  const bf = fract(a.div(170)).sub(0.5);
  const bar = exp(bf.abs().mul(170).negate().div(blur.mul(1.4)))
    .mul(vec3(1.0, 0.5, 0.16))
    .mul(step(0.35, h21(vec2(floor(a.div(170)), 4.4))))
    .mul(2.2);
  // Dimensional rack: dark recessed bevel, horizontal vent slats, lit shelf lip.
  const bevel = smoothstep(0.0, 9.0, dEdge).mul(0.6).add(0.4);
  const slats = sin(b.mul(0.7)).mul(0.5).add(0.5).mul(step(h, 0.55)).mul(0.035);
  const lip = exp(f.y.sub(0.5).abs().mul(-0.0).sub(float(1).sub(f.y).mul(60)))
    .mul(vec3(0.05, 0.3, 0.45))
    .mul(0.6);
  return base
    .mul(bevel)
    .add(vec3(0.02, 0.05, 0.09).mul(slats))
    .add(edge.mul(0.8))
    .add(lip)
    .add(screen)
    .add(led.mul(1.1))
    .add(bar);
});

/** Reflective tech floor: x,z in world units. */
const floorPattern = Fn(([x, z, dist, tm]: [any, any, any, any]) => {
  const blur = float(1).add(dist.mul(0.004));
  const p = vec2(x, z);
  const gsm = vec2(20, 20);
  const gm = fract(p.div(gsm));
  const dMinor = min(min(gm.x, float(1).sub(gm.x)).mul(20), min(gm.y, float(1).sub(gm.y)).mul(20));
  const gl = vec2(100, 100);
  const gM = fract(p.div(gl));
  const dMajor = min(
    min(gM.x, float(1).sub(gM.x)).mul(100),
    min(gM.y, float(1).sub(gM.y)).mul(100)
  );
  const minor = exp(dMinor.negate().div(blur.mul(0.5)))
    .mul(vec3(0.02, 0.22, 0.35))
    .mul(0.28);
  const major = exp(dMajor.negate().div(blur.mul(0.9)))
    .mul(vec3(0.05, 0.6, 0.9))
    .mul(0.3);
  // Circuit traces: thin lines along x / z that turn on per cell.
  const tc = floor(p.div(40));
  const th = h21(tc);
  const tf = fract(p.div(40));
  const trace = step(0.5, th)
    .mul(exp(abs(tf.y.sub(0.5)).mul(-40).mul(40).div(blur.mul(14))))
    .mul(step(tf.x, 0.8))
    .mul(mix(vec3(0.0, 0.6, 0.85), vec3(1.0, 0.5, 0.15), step(0.78, th)))
    .mul(1.0);
  // Orange streaks running down the corridor (along z), animated.
  const sx = floor(x.div(55));
  const sh = h21(vec2(sx, 3.3));
  const sf = fract(x.div(55)).sub(0.5);
  const run = fract(
    z
      .mul(-0.004)
      .add(tm.mul(0.05).mul(sh.add(0.4)))
      .add(sh.mul(9))
  );
  const streak = step(0.55, sh)
    .mul(exp(sf.mul(sf).mul(-700).div(blur)))
    .mul(smoothstep(0.0, 0.1, run).mul(smoothstep(0.8, 0.2, run)))
    .mul(vec3(1.0, 0.48, 0.12))
    .mul(4.2);
  // Ripple rings around the pedestal.
  const rad = length(vec2(x, z));
  let rings = vec3(0).toVar();
  for (let k = 0; k < 5; k += 1) {
    const rk = float(66 + k * 26).add(sin(tm.mul(0.6).add(k)).mul(2.0));
    const w = exp(pow(rad.sub(rk).div(blur.mul(0.9).add(0.6)), 2).negate());
    rings = rings.add(
      mix(vec3(0.1, 0.8, 1.0), vec3(1.0, 0.5, 0.2), float(k / 6))
        .mul(w)
        .mul(0.9)
    );
  }
  const under = exp(rad.mul(rad).mul(-0.00035))
    .mul(vec3(0.0, 0.55, 0.85))
    .mul(0.22);
  const fade = exp(dist.mul(-0.0011));
  return minor.add(major).add(trace).add(streak).add(rings).mul(fade).add(under);
});

/** Floating bokeh discs at three depths (screen-direction space). */
const bokeh = Fn(([d, tm]: [any, any]) => {
  const az = atan(d.x, d.z.negate());
  const el = d.y;
  const acc = vec3(0).toVar();
  const params = [
    { s: 9.0, r: 0.3, i: 0.55 },
    { s: 16.0, r: 0.22, i: 0.38 },
    { s: 30.0, r: 0.12, i: 0.7 },
  ];
  params.forEach((pr, li) => {
    const uv = vec2(
      az.mul(pr.s).add(tm.mul(0.01 * (li + 1))),
      el.mul(pr.s * 2.2).add(sin(tm.mul(0.07).add(li)).mul(0.1))
    );
    const c = floor(uv);
    const f = fract(uv).sub(0.5);
    const h = h21(c.add(li * 17.3));
    const h2 = h21(c.add(li * 5.1 + 2.0));
    const off = vec2(h21(c.add(1.7)), h21(c.add(8.3)))
      .sub(0.5)
      .mul(0.5);
    const fo = f.sub(off);
    // Hexagonal aperture; near layers are heavily defocused (wide soft edge),
    // far layers crisp. Interior carries a gentle gradient (not a flat disc).
    const hx = max(abs(fo.x).mul(0.866).add(abs(fo.y).mul(0.5)), abs(fo.y));
    const soft = [0.55, 0.3, 0.1][li];
    const dd = mix(length(fo), hx.mul(1.12), 0.65);
    const disc = smoothstep(pr.r, pr.r * (1 - soft), dd)
      .mul(
        float(0.5).add(
          smoothstep(pr.r * 0.4, pr.r, dd)
            .mul(0.7)
            .mul(1 - soft)
        )
      )
      .mul(float(0.55).add(h2.mul(0.9)))
      .mul(float(1.0 + 0.5 * (1 - soft)));
    const on = step(0.82, h);
    const col = mix(vec3(1.0, 0.5, 0.15), vec3(0.15, 0.8, 1.0), step(0.58, h2)).mul(
      mix(float(1), float(0.5), step(0.85, h2))
    );
    acc.addAssign(col.mul(disc).mul(on).mul(pr.i));
  });
  return acc;
});

export function createEnvironment(
  layoutIn: EnvironmentLayout | [number, number][] = [[0, 0]]
): Environment {
  const time = uniform(0);
  // x wallX, y ceilY, z farZ, w pattern scale.
  const dims = uniform(new Vector4(WALL_X, CEIL_Y, FAR_Z, 1));
  const floorU = sharedFloorY;
  const disposables: { dispose: () => void }[] = [];

  // --- room sphere ------------------------------------------------------
  const room = Fn(() => {
    const ro = cameraPosition;
    const rd = normalize(positionWorld.sub(cameraPosition));
    const fy = floorU as any;
    const D = dims as any;
    const sc = D.w;
    const col = vec3(0.004, 0.007, 0.02).toVar();
    const tFloor = select(rd.y.lessThan(-0.0005), fy.sub(ro.y).div(rd.y), float(1e9));
    const tCeil = select(rd.y.greaterThan(0.0005), D.y.sub(ro.y).div(rd.y), float(1e9));
    const tWallR = select(rd.x.greaterThan(0.0005), D.x.sub(ro.x).div(rd.x), float(1e9));
    const tWallL = select(rd.x.lessThan(-0.0005), D.x.negate().sub(ro.x).div(rd.x), float(1e9));
    const tWall = min(tWallR, tWallL);
    const tHit = min(min(tFloor, tCeil), tWall);
    const p = ro.add(rd.mul(tHit));
    const far = p.z.lessThan(D.z);
    const hitFloor = tFloor.lessThanEqual(tHit).and(far.not());
    const hitCeil = tCeil.lessThanEqual(tHit).and(tFloor.greaterThan(tHit)).and(far.not());
    const hitWall = tWall
      .lessThanEqual(tHit)
      .and(tFloor.greaterThan(tHit))
      .and(tCeil.greaterThan(tHit))
      .and(far.not());
    If(hitFloor, () => {
      const f = floorPattern(p.x.div(sc), p.z.div(sc), tHit.div(sc), time);
      // Grazing-angle gloss: reflective sheen toward the horizon.
      const gl = pow(float(1).sub(abs(rd.y)), 3);
      col.assign(
        vec3(0.005, 0.01, 0.028)
          .add(f)
          .add(vec3(0.05, 0.2, 0.35).mul(gl).mul(0.3))
      );
    });
    If(hitCeil, () => {
      const w = wallPattern(p.x.div(sc), p.z.div(sc), tHit.div(sc), time).mul(0.5);
      col.assign(vec3(0.004, 0.008, 0.02).add(w));
    });
    If(hitWall, () => {
      const w = wallPattern(p.y.div(sc), p.z.div(sc), tHit.div(sc), time);
      // Receding structural ribs (lit orange edges) so the corridor has depth.
      const rz = fract(p.z.div(sc.mul(260)));
      const rib = exp(abs(rz.sub(0.5)).sub(0.5).abs().mul(-0.0).sub(rz.mul(55)))
        .mul(vec3(1.0, 0.5, 0.15))
        .mul(1.4);
      const ribDark = smoothstep(0.0, 0.08, rz).mul(0.35).add(0.65);
      col.assign(
        w
          .mul(ribDark)
          .add(rib)
          .mul(exp(tHit.div(sc).mul(-0.0009)))
      );
    });
    // Far end of the corridor: luminous vanishing glow.
    If(far, () => {
      const g = exp(dot(rd.xy, rd.xy).mul(-120));
      // Receding rectangular gantry frames toward the vanishing point (depth cue).
      const fxy = rd.xy.div(rd.z.negate().max(0.05));
      const fd = max(abs(fxy.x.mul(0.55)), abs(fxy.y)).max(0.004);
      const fk = fract(float(1).div(fd.add(0.06)).mul(1.6));
      const frame = exp(fk.mul(-14)).mul(smoothstep(0.0, 0.12, fd));
      const frameCol = mix(vec3(0.1, 0.45, 0.9), vec3(1.0, 0.5, 0.15), smoothstep(0.1, 0.6, fd));
      col.assign(
        vec3(0.012, 0.03, 0.09)
          .add(frameCol.mul(frame).mul(4.5))
          .add(vec3(0.5, 0.85, 1.0).mul(g).mul(0.6))
      );
    });
    // Volumetric haze: cyan toward the vanishing point + warm low haze.
    const vp = saturate(dot(rd, vec3(0, 0, -1)));
    const haze = pow(vp, 24)
      .mul(vec3(0.1, 0.35, 0.6))
      .mul(0.5)
      .add(
        exp(abs(rd.y).mul(-14))
          .mul(vec3(0.38, 0.17, 0.12))
          .mul(0.4)
      );
    col.addAssign(haze);
    col.addAssign(bokeh(rd, time).mul(1.4));
    return vec4(col.mul(0.2), 1);
  });

  const roomMat = new MeshBasicNodeMaterial();
  roomMat.fragmentNode = room();
  roomMat.side = BackSide;
  roomMat.depthWrite = false;
  roomMat.depthTest = false;
  roomMat.fog = false;
  const roomGeo = new SphereGeometry(ROOM_RADIUS, 32, 16);
  const roomMesh = new Mesh(roomGeo, roomMat);
  roomMesh.renderOrder = -100;
  roomMesh.frustumCulled = false;
  disposables.push(roomMat, roomGeo);

  // --- glass pedestal dome ------------------------------------------------
  const domeRadius = 46;
  const domeGeo = new SphereGeometry(domeRadius, 96, 32, 0, Math.PI * 2, 0, Math.PI / 2);
  const domeMat = new MeshBasicNodeMaterial();
  domeMat.fragmentNode = Fn(() => {
    const n = normalize(positionGeometry);
    const lat = n.y;
    const lon = atan(n.z, n.x);
    const latLine = exp(abs(fract(lat.mul(9)).sub(0.5).sub(0.5)).mul(-70)).add(
      exp(abs(fract(lat.mul(9))).mul(-70))
    );
    const lonLine = exp(
      abs(
        fract(lon.mul(8.5 / Math.PI))
          .sub(0.5)
          .sub(0.5)
      ).mul(-80)
    ).add(exp(abs(fract(lon.mul(8.5 / Math.PI))).mul(-80)));
    const grid = max(latLine, lonLine)
      .mul(vec3(0.15, 0.85, 1.0))
      .mul(mix(float(0.3), float(0.65), lat));
    const view = normalize(cameraPosition.sub(positionWorld));
    const wn = normalize(
      vec3(positionGeometry.x, positionGeometry.y.div(0.47), positionGeometry.z)
    );
    const fres = pow(float(1).sub(saturate(dot(wn, view))), 3);
    const rim = fres.mul(vec3(0.2, 0.7, 1.0)).mul(0.3);
    const fade = smoothstep(0.0, 0.18, lat);
    const col = grid.add(rim).mul(fade);
    return vec4(col, 1);
  })();
  domeMat.transparent = true;
  domeMat.blending = AdditiveBlending;
  domeMat.depthWrite = false;
  domeMat.side = DoubleSide;
  disposables.push(domeGeo, domeMat);

  // Pedestal base: glass cylinder wall + glowing under-disc.
  const baseGeo = new CylinderGeometry(50, 58, 7, 96, 1, true);
  const baseMat = new MeshBasicNodeMaterial();
  baseMat.fragmentNode = Fn(() => {
    const y = positionGeometry.y.add(3.5).div(7);
    const lines = exp(
      abs(fract(y.mul(3)).sub(0.5))
        .mul(-1)
        .mul(30)
        .add(-0.0)
    ).mul(0.0);
    void lines;
    const view = normalize(cameraPosition.sub(positionWorld));
    const fres = pow(
      float(1).sub(abs(dot(normalize(vec3(positionGeometry.x, 0, positionGeometry.z)), view))),
      2
    );
    const ring = exp(abs(y.sub(0.5)).mul(-6));
    return vec4(vec3(0.2, 0.8, 1.0).mul(fres.mul(0.6).add(0.08)).mul(ring.mul(0.6).add(0.15)), 1);
  })();
  baseMat.transparent = true;
  baseMat.blending = AdditiveBlending;
  baseMat.depthWrite = false;
  baseMat.side = DoubleSide;
  disposables.push(baseGeo, baseMat);

  const discGeo = new CircleGeometry(50, 96);
  discGeo.rotateX(-Math.PI / 2);
  const discMat = new MeshBasicNodeMaterial();
  discMat.fragmentNode = Fn(() => {
    const p = vec2(positionGeometry.x, positionGeometry.z);
    const r = length(p).div(50);
    const gx = exp(
      abs(fract(p.x.div(7)).sub(0.5))
        .mul(-1)
        .add(0.5)
        .mul(-60)
        .sub(0.0)
    ).mul(0.0);
    void gx;
    const gridX = exp(min(fract(p.x.div(6.5)), float(1).sub(fract(p.x.div(6.5)))).mul(-9));
    const gridZ = exp(min(fract(p.y.div(6.5)), float(1).sub(fract(p.y.div(6.5)))).mul(-9));
    const grid = max(gridX, gridZ).mul(0.45);
    const glow = exp(r.mul(r).mul(-2.5)).mul(0.6);
    const ringEdge = exp(abs(r.sub(0.97)).mul(-60)).mul(1.6);
    const col = vec3(0.1, 0.75, 1.0).mul(
      grid.mul(float(1).sub(r).mul(0.9).add(0.15)).add(glow).add(ringEdge)
    );
    return vec4(col.mul(1.0), 1);
  })();
  discMat.transparent = true;
  discMat.blending = AdditiveBlending;
  discMat.depthWrite = false;
  disposables.push(discGeo, discMat);
  void clamp;
  void cos;

  // Instanced pedestals (disc + base + dome): three draws for any atom count.
  const parts = [
    { geo: discGeo, mat: discMat, y: 0.4, order: 3 },
    { geo: baseGeo, mat: baseMat, y: 3.5, order: 4 },
    { geo: domeGeo, mat: domeMat, y: 0, order: 5 },
  ].map((p) => {
    const m = new InstancedMesh(p.geo, p.mat, MAX_PEDESTALS);
    m.frustumCulled = false;
    m.renderOrder = p.order;
    m.count = 0;
    return { mesh: m, y: p.y };
  });
  const mtx = new Matrix4();
  const setLayout = (l: EnvironmentLayout): void => {
    (dims.value as Vector4).set(
      l.wallX ?? WALL_X,
      l.ceilY ?? CEIL_Y,
      l.farZ ?? FAR_Z,
      l.scale ?? 1
    );
    const fy = l.floorY ?? FLOOR_Y;
    (floorU as { value: number }).value = fy;
    const n = Math.min(l.pedestals.length, MAX_PEDESTALS);
    for (const part of parts) {
      for (let i = 0; i < n; i += 1) {
        const ped = l.pedestals[i];
        const k = ped.scale ?? 1;
        mtx.makeScale(k, k * (part.mesh.geometry === domeGeo ? 0.95 : 1), k);
        mtx.setPosition(ped.x, (ped.y ?? fy) + part.y * k, ped.z);
        part.mesh.setMatrixAt(i, mtx);
      }
      part.mesh.count = n;
      part.mesh.instanceMatrix.needsUpdate = true;
    }
  };
  setLayout(
    Array.isArray(layoutIn) ? { pedestals: layoutIn.map(([x, z]) => ({ x, z })) } : layoutIn
  );
  return {
    objects: [roomMesh, ...parts.map((p) => p.mesh)],
    time,
    setLayout,
    follow(camera) {
      roomMesh.position.set(camera.position.x, camera.position.y, camera.position.z);
      roomMesh.scale.setScalar(Math.max(0.01, (camera.far * 0.8) / ROOM_RADIUS));
    },
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}
