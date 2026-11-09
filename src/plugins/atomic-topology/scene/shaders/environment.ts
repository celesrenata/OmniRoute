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
  texture,
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
import { pcbBoard } from "./pcbBoard";
import { createBoardParts } from "./boardParts";

/** Bench floor height (world units); the topology host derives its own from layout bounds. */
export const FLOOR_Y = -66;
const WALL_X = 420;
const CEIL_Y = 300;
const FAR_Z = -1700;
const NEAR_Z = 2600;
const ROOM_RADIUS = 2500;
/** Max pedestals (instanced; one per atom). */
export const MAX_PEDESTALS = 256;

/** Room/pedestal placement. All optional; defaults reproduce the Gate A bench room. */
export interface EnvironmentLayout {
  /** Pedestal centres (x, z) on the floor, with optional scale (hub = larger). */
  pedestals: { x: number; z: number; y?: number; scale?: number; hub?: boolean }[];
  /** Z of the near wall behind the default camera (container encloses the fit pose). */
  nearZ?: number;
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
  /** 1 = animated embers/static, 0 = static board (reduced motion). */
  setLife: (life: number) => void;
  /** Re-place the room + pedestals (layout change); no shader rebuild. */
  setLayout: (layout: EnvironmentLayout) => void;
  /** Keep the room shell centred on the camera and inside its far plane. */
  follow: (camera: { position: { x: number; y: number; z: number }; far: number }) => void;
  dispose: () => void;
}

export function createEnvironment(
  layoutIn: EnvironmentLayout | [number, number][] = [[0, 0]]
): Environment {
  const time = uniform(0);
  // x wallX, y ceilY, z farZ, w pattern scale.
  const dims = uniform(new Vector4(WALL_X, CEIL_Y, FAR_Z, 1));
  // x near wall z, y ember/static life (0 under reduced motion).
  const dims2 = uniform(new Vector4(NEAR_Z, 1, 0, 0));
  const floorU = sharedFloorY;
  const disposables: { dispose: () => void }[] = [];
  const boardParts = createBoardParts();
  disposables.push(boardParts);
  // Floor haze field (magnetic / high-voltage parts): world rect + R8 texture.
  const hazeRect = uniform(new Vector4(...boardParts.haze.rect.value));

  // --- solid circuit-board container (ray-box from the camera) ------------------
  const room = Fn(() => {
    const ro = cameraPosition;
    const rd = normalize(positionWorld.sub(cameraPosition));
    const fy = floorU as any;
    const D = dims as any;
    const E = dims2 as any;
    const sc = D.w;
    const big = float(1e9);
    const tx = select(
      rd.x.abs().greaterThan(1e-5),
      select(rd.x.greaterThan(0), D.x.sub(ro.x), D.x.negate().sub(ro.x)).div(rd.x),
      big
    );
    const ty = select(
      rd.y.abs().greaterThan(1e-5),
      select(rd.y.greaterThan(0), D.y.sub(ro.y), fy.sub(ro.y)).div(rd.y),
      big
    );
    const tz = select(
      rd.z.abs().greaterThan(1e-5),
      select(rd.z.greaterThan(0), E.x.sub(ro.z), D.z.sub(ro.z)).div(rd.z),
      big
    );
    const tHit = min(min(tx, ty), tz).max(0);
    const p = ro.add(rd.mul(tHit));
    const life = E.y;
    const col = vec3(0.01, 0.02, 0.05).toVar();
    const hitY = ty.lessThanEqual(tx).and(ty.lessThanEqual(tz));
    const hitX = tx.lessThan(ty).and(tx.lessThanEqual(tz));
    const dd = tHit.div(sc);
    If(hitY, () => {
      const isFloor = rd.y.lessThan(0);
      // Magnetic / high-voltage haze (floor only): a barely-visible refraction of the
      // board behind those parts plus the faintest cool glow. Off when life is 0.
      const HR = hazeRect as any;
      const huv = vec2(p.x.sub(HR.x).div(HR.z), p.z.sub(HR.y).div(HR.w));
      const hz = texture(boardParts.haze.texture, huv)
        .r.mul(select(isFloor, float(1), float(0)))
        .mul(life);
      const warp = vec2(
        sin(p.z.mul(0.31).add(time.mul(1.7))).add(sin(p.x.mul(0.57).sub(time.mul(1.1)))),
        cos(p.x.mul(0.27).sub(time.mul(1.3))).add(sin(p.z.mul(0.49).add(time.mul(0.9))))
      ).mul(hz.mul(1.6));
      const b = pcbBoard(
        p.x.add(warp.x).div(sc),
        p.z.add(warp.y).div(sc),
        dd,
        time,
        select(isFloor, float(1), float(2)),
        life,
        select(isFloor, float(1), float(0.12))
      );
      // Floor: glossy solder-mask sheen at grazing angles; ceiling: dimmer.
      const gl = pow(float(1).sub(abs(rd.y)), 3);
      const floorC = b
        .add(vec3(0.05, 0.2, 0.35).mul(gl).mul(0.28))
        .add(vec3(0.05, 0.16, 0.3).mul(hz.mul(hz)).mul(0.1));
      col.assign(select(isFloor, floorC, b.mul(0.9)));
    });
    If(hitX, () => {
      col.assign(
        pcbBoard(
          p.z.div(sc),
          p.y.div(sc),
          dd,
          time,
          float(3).add(rd.x.greaterThan(0).select(1, 0)),
          life,
          float(0.16)
        ).mul(1.5)
      );
    });
    If(tz.lessThan(min(tx, ty)), () => {
      col.assign(
        pcbBoard(
          p.x.div(sc),
          p.y.div(sc),
          dd,
          time,
          float(5).add(rd.z.greaterThan(0).select(1, 0)),
          life,
          float(0.16)
        ).mul(1.5)
      );
    });
    // Aerial perspective: cool navy toward distance, so the box reads as a space.
    const fogK = exp(dd.mul(-0.0002));
    col.assign(mix(vec3(0.01, 0.022, 0.06), col, fogK));
    return vec4(col.mul(0.5), 1);
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

  // Small glowing floor pad for every non-hub atom (the full dome is hub-only).
  const padGeo = new CircleGeometry(50, 64);
  padGeo.rotateX(-Math.PI / 2);
  const padMat = new MeshBasicNodeMaterial();
  padMat.fragmentNode = Fn(() => {
    const r = length(vec2(positionGeometry.x, positionGeometry.z)).div(50);
    const glow = exp(r.mul(r).mul(-3.2)).mul(0.32);
    const ring = exp(abs(r.sub(0.94)).mul(-48)).mul(0.9);
    const ring2 = exp(abs(r.sub(0.62)).mul(-60)).mul(0.28);
    return vec4(vec3(0.1, 0.7, 1.0).mul(glow.add(ring).add(ring2)), 1);
  })();
  padMat.transparent = true;
  padMat.blending = AdditiveBlending;
  padMat.depthWrite = false;
  disposables.push(padGeo, padMat);

  // Instanced hub pedestal (disc + base + dome) and per-atom pads.
  const parts = [
    { geo: discGeo, mat: discMat, y: 0.4, order: 3, hubOnly: true },
    { geo: baseGeo, mat: baseMat, y: 3.5, order: 4, hubOnly: true },
    { geo: domeGeo, mat: domeMat, y: 0, order: 5, hubOnly: true },
    { geo: padGeo, mat: padMat, y: 0.4, order: 3, hubOnly: false },
  ].map((p) => {
    const m = new InstancedMesh(p.geo, p.mat, MAX_PEDESTALS);
    m.frustumCulled = false;
    m.renderOrder = p.order;
    m.count = 0;
    return { mesh: m, y: p.y, hubOnly: p.hubOnly };
  });
  const mtx = new Matrix4();
  const setLayout = (l: EnvironmentLayout): void => {
    (dims.value as Vector4).set(
      l.wallX ?? WALL_X,
      l.ceilY ?? CEIL_Y,
      l.farZ ?? FAR_Z,
      l.scale ?? 1
    );
    (dims2.value as Vector4).x = l.nearZ ?? NEAR_Z;
    const fy = l.floorY ?? FLOOR_Y;
    (floorU as { value: number }).value = fy;
    const peds = l.pedestals.slice(0, MAX_PEDESTALS);
    // Real 3D board components: deterministic placement around the atom pads.
    boardParts.setLayout(
      {
        wallX: l.wallX ?? WALL_X,
        ceilY: l.ceilY ?? CEIL_Y,
        nearZ: l.nearZ ?? NEAR_Z,
        farZ: l.farZ ?? FAR_Z,
        floorY: fy,
      },
      peds.map((q) => ({ x: q.x, z: q.z, r: 62 * (q.scale ?? 1) }))
    );
    (hazeRect.value as Vector4).set(...boardParts.haze.rect.value);
    for (const part of parts) {
      let n = 0;
      for (const ped of peds) {
        const isHub = ped.hub ?? true;
        if (part.hubOnly !== isHub) continue;
        const k = ped.scale ?? 1;
        mtx.makeScale(k, k * (part.mesh.geometry === domeGeo ? 0.95 : 1), k);
        mtx.setPosition(ped.x, (ped.y ?? fy) + part.y * k, ped.z);
        part.mesh.setMatrixAt(n, mtx);
        n += 1;
      }
      part.mesh.count = n;
      part.mesh.instanceMatrix.needsUpdate = true;
    }
  };
  setLayout(
    Array.isArray(layoutIn) ? { pedestals: layoutIn.map(([x, z]) => ({ x, z })) } : layoutIn
  );
  return {
    objects: [roomMesh, ...boardParts.objects, ...parts.map((p) => p.mesh)],
    time,
    setLife: (life: number) => {
      (dims2.value as Vector4).y = life;
      boardParts.setLife(life);
    },
    setLayout,
    follow(camera) {
      roomMesh.position.set(camera.position.x, camera.position.y, camera.position.z);
      roomMesh.scale.setScalar(Math.max(0.01, (camera.far * 0.8) / ROOM_RADIUS));
    },
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}
