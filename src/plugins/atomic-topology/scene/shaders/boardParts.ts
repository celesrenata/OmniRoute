/**
 * Real 3D circuit-board components (TSL, directive 23): wound toroid and boxed
 * chokes, SMD chip and axial colour-banded resistors, solid-capped polymer /
 * electrolytic cans with scored tops, MLCC chips, ICs with pins, connectors,
 * finned heatsinks and seeded, faintly blinking LEDs.
 *
 * Each kind is ONE instanced draw (merged geometry, per-instance variant
 * attribute), lit analytically by the scene's key / fill / bounce lights with
 * height-based occlusion, and grounded by a single instanced soft contact-shadow
 * decal draw. Placement is deterministic (`boardComponents.ts`); the floor is
 * densest, walls and ceiling sparser. LED blinking and the magnetic-part haze
 * are decorative (static when `life` is 0 / reduced motion) and never encode
 * telemetry. Imports `three` only via three/webgpu (+ addons for the merge).
 */
import {
  Fn,
  abs,
  atan,
  attribute,
  cameraPosition,
  dot,
  exp,
  float,
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
  select,
  sin,
  smoothstep,
  step,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import {
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  CylinderGeometry,
  DataTexture,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  Quaternion,
  RedFormat,
  TorusGeometry,
  UnsignedByteType,
  Vector3,
} from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  PART_FOOTPRINT,
  PART_KINDS,
  buildHazeField,
  groupByKind,
  placeBoardParts,
  type Avoid,
  type BoardExtent,
  type PartKind,
  type PartPlacement,
  type Surface,
} from "../boardComponents";
import { envTime } from "../rt/sharedUniforms";

/** 1 = LEDs blink; 0 = static LEDs (reduced motion). Shared by every part material. */
export const partLife = uniform(1);

const strip = (g: BufferGeometry): BufferGeometry => {
  g.deleteAttribute("uv");
  return g;
};
const box = (w: number, h: number, d: number, x: number, y: number, z: number): BufferGeometry =>
  strip(new BoxGeometry(w, h, d).translate(x, y, z));

/** Approximate part height (world units) for the height-based occlusion term. */
const HEIGHT: Record<PartKind, number> = {
  ic: 7,
  can: 16,
  mlcc: 3.4,
  smd: 1.8,
  axial: 7,
  toroid: 11,
  boxChoke: 9,
  connector: 10,
  heatsink: 19,
  led: 2,
};

export function partGeometry(kind: PartKind): BufferGeometry {
  switch (kind) {
    case "ic": {
      const parts = [box(40, 5, 28, 0, 2.5 + 1, 0)];
      for (let i = 0; i < 8; i += 1) {
        const x = -17.5 + i * 5;
        parts.push(box(2.2, 1.2, 5, x, 0.6, 15.5), box(2.2, 1.2, 5, x, 0.6, -15.5));
      }
      return mergeGeometries(parts)!;
    }
    case "can": {
      const body = strip(new CylinderGeometry(9, 9, 14, 24).translate(0, 8, 0));
      const base = strip(new CylinderGeometry(9.8, 9.8, 2, 24).translate(0, 1, 0));
      return mergeGeometries([body, base])!;
    }
    case "mlcc":
      return box(6.5, 3.2, 3.4, 0, 1.6, 0);
    case "smd":
      return box(5.2, 1.6, 2.6, 0, 0.8, 0);
    case "axial": {
      const body = strip(
        new CylinderGeometry(3, 3, 14, 14).rotateZ(Math.PI / 2).translate(0, 4.2, 0)
      );
      const legs: BufferGeometry[] = [];
      for (const s of [-1, 1]) {
        legs.push(
          strip(
            new CylinderGeometry(0.55, 0.55, 5, 6).rotateZ(Math.PI / 2).translate(s * 9.5, 4.2, 0)
          ),
          strip(new CylinderGeometry(0.55, 0.55, 4.2, 6).translate(s * 12, 2.1, 0))
        );
      }
      return mergeGeometries([body, ...legs])!;
    }
    case "toroid": {
      const t = strip(
        new TorusGeometry(10.5, 5.2, 14, 40).rotateX(Math.PI / 2).translate(0, 5.2, 0)
      );
      const legs = [
        strip(new CylinderGeometry(0.6, 0.6, 4, 6).translate(-9, 2, 7)),
        strip(new CylinderGeometry(0.6, 0.6, 4, 6).translate(9, 2, 7)),
      ];
      return mergeGeometries([t, ...legs])!;
    }
    case "boxChoke":
      return mergeGeometries([
        box(18, 9, 18, 0, 4.5 + 0.6, 0),
        box(3, 1.2, 20, -9.2, 0.6, 0),
        box(3, 1.2, 20, 9.2, 0.6, 0),
      ])!;
    case "connector": {
      const parts = [box(78, 10, 13, 0, 5, 0)];
      for (let i = 0; i < 10; i += 1) parts.push(box(1.6, 1.4, 1.6, -33 + i * 7.3, 10.5, 0));
      return mergeGeometries(parts)!;
    }
    case "heatsink": {
      const parts = [box(34, 3, 28, 0, 1.5, 0)];
      for (let i = 0; i < 7; i += 1) parts.push(box(2, 16, 26, -13.8 + i * 4.6, 3 + 8, 0));
      return mergeGeometries(parts)!;
    }
    case "led":
      return box(4.4, 1.6, 2.6, 0, 0.8, 0);
  }
}

/** Resistor colour code palette (linear-ish sRGB-ish values). */
const BAND_COLOURS = [
  [0.02, 0.02, 0.02],
  [0.32, 0.12, 0.04],
  [0.85, 0.08, 0.05],
  [0.95, 0.4, 0.04],
  [0.95, 0.85, 0.1],
  [0.1, 0.6, 0.12],
  [0.1, 0.25, 0.85],
  [0.5, 0.15, 0.7],
  [0.5, 0.5, 0.5],
] as const;

/** Analytic lighting shared by every part (key / warm fill / cool bounce + occlusion). */
function lit(base: any, N: any, h01: any, shin: number, specAmt: number, emissive: any): any {
  const V = normalize(cameraPosition.sub(positionWorld));
  const key = normalize(vec3(-0.35, 1.0, 0.5));
  const fill = normalize(vec3(0.85, 0.25, -0.45));
  const up = vec3(0, 1, 0);
  const ndl = max(dot(N, key), 0);
  const ndf = max(dot(N, fill), 0);
  const ndb = max(dot(N, up.negate()), 0);
  const hemi = mix(vec3(0.03, 0.05, 0.1), vec3(0.09, 0.15, 0.26), N.y.mul(0.5).add(0.5));
  const ao = mix(float(0.3), float(1), smoothstep(0.0, 0.55, h01));
  const H = normalize(key.add(V));
  const spec = pow(max(dot(N, H), 0), float(shin)).mul(specAmt);
  const rim = pow(float(1).sub(max(dot(N, V), 0)), 3).mul(0.2);
  const lightC = vec3(0.62, 0.82, 1.0)
    .mul(ndl)
    .mul(0.95)
    .add(vec3(1.0, 0.55, 0.25).mul(ndf).mul(0.38))
    .add(vec3(0.05, 0.35, 0.55).mul(ndb).mul(0.18))
    .add(hemi);
  const c = base
    .mul(lightC)
    .mul(ao)
    .add(vec3(0.62, 0.82, 1.0).mul(spec).mul(ao))
    .add(vec3(0.0, 0.3, 0.45).mul(rim).mul(ao))
    .add(emissive);
  // Aerial perspective toward the container's own navy.
  const dist = length(positionWorld.sub(cameraPosition));
  return mix(vec3(0.004, 0.009, 0.024), c.mul(0.85), exp(dist.mul(-0.00022)));
}

function partMaterial(kind: PartKind): MeshBasicNodeMaterial {
  const mat = new MeshBasicNodeMaterial();
  const vr = attribute("aVar", "float");
  const P = positionGeometry;
  const Ng = normalGeometry;
  const top = step(0.85, Ng.y);
  const h01 = P.y.div(HEIGHT[kind]);
  const N = normalize(normalWorld);
  mat.colorNode = Fn(() => {
    let base: any = vec3(0.05, 0.05, 0.06);
    let shin = 24;
    let spec = 0.25;
    let emissive: any = vec3(0);
    switch (kind) {
      case "ic": {
        const body = vec3(0.022, 0.025, 0.034);
        const pins = step(P.y, 1.35).mul(step(14, abs(P.z)));
        // Pin-1 dot + two printed marking lines on the top face.
        const dotP = step(length(P.xz.sub(vec3(-16, 0, -9.5).xz)), 1.7);
        const lines = step(0.5, fract(P.x.mul(0.3).add(vr.mul(9))))
          .mul(step(abs(P.z.add(2)), 1.0).add(step(abs(P.z.sub(3)), 0.7)))
          .mul(step(abs(P.x), 17));
        base = mix(
          body.add(vec3(0.1, 0.11, 0.13).mul(top.mul(dotP.add(lines.mul(0.55))))),
          vec3(0.5, 0.5, 0.55),
          pins
        );
        spec = 0.45;
        shin = 40;
        break;
      }
      case "can": {
        const ang = atan(P.z, P.x);
        const poly = step(0.5, vr);
        const sideStripe = step(abs(ang), 0.5).mul(step(P.y, 15).mul(step(2.2, P.y)));
        const bodyC = mix(vec3(0.015, 0.025, 0.07), vec3(0.03, 0.03, 0.035), poly);
        const stripeC = mix(vec3(0.5, 0.52, 0.56), vec3(0.85, 0.42, 0.08), poly);
        const rad = length(P.xz);
        // Aluminium top with a scored cross (K-vent) and a raised rim.
        const score = max(step(abs(P.x), 0.45), step(abs(P.z), 0.45)).mul(step(rad, 6.6));
        const topC = vec3(0.52, 0.54, 0.58)
          .mul(float(1).sub(score.mul(0.55)))
          .mul(float(1).sub(step(7.0, rad).mul(step(rad, 7.7)).mul(0.4)));
        const baseRing = step(P.y, 2.0);
        base = mix(mix(bodyC, stripeC, sideStripe), topC, top.mul(step(13, P.y)));
        base = mix(base, vec3(0.025, 0.02, 0.02), baseRing);
        spec = 0.55;
        shin = 36;
        break;
      }
      case "mlcc": {
        const cap = step(2.2, abs(P.x));
        base = mix(vec3(0.36, 0.27, 0.15), vec3(0.55, 0.55, 0.58), cap);
        spec = 0.3;
        break;
      }
      case "smd": {
        const cap = step(1.9, abs(P.x));
        const mark = top
          .mul(step(abs(P.x), 1.3))
          .mul(step(abs(P.z), 0.4))
          .mul(step(0.4, vr));
        base = mix(
          vec3(0.014, 0.014, 0.017).add(vec3(0.18).mul(mark)),
          vec3(0.55, 0.55, 0.58),
          cap
        );
        spec = 0.35;
        break;
      }
      case "axial": {
        const inBody = step(abs(P.x), 7.1).mul(step(2.2, P.y));
        // Four colour bands whose colours are picked per instance.
        const bandAt = (cx: number, k: number) => {
          const hit = step(abs(P.x.sub(cx)), 0.7);
          const idx = vr
            .mul(31.7)
            .add(k * 3.1)
            .fract()
            .mul(9)
            .floor();
          let col: any = vec3(BAND_COLOURS[0][0], BAND_COLOURS[0][1], BAND_COLOURS[0][2]);
          for (let i = 1; i < BAND_COLOURS.length; i += 1) {
            col = select(
              idx.greaterThan(i - 0.5),
              vec3(BAND_COLOURS[i][0], BAND_COLOURS[i][1], BAND_COLOURS[i][2]),
              col
            );
          }
          return { hit, col };
        };
        const b0 = bandAt(-4.2, 0);
        const b1 = bandAt(-2.1, 1);
        const b2 = bandAt(0.0, 2);
        const b3 = { hit: step(abs(P.x.sub(4.4)), 0.7), col: vec3(0.78, 0.6, 0.18) };
        const bodyC = mix(
          vec3(0.62, 0.5, 0.3),
          vec3(0.2, 0.42, 0.62),
          step(0.5, vr.mul(7.3).fract())
        );
        let c: any = bodyC;
        for (const b of [b0, b1, b2, b3]) c = mix(c, b.col, b.hit);
        base = mix(vec3(0.58, 0.58, 0.6), c, inBody);
        spec = 0.35;
        break;
      }
      case "toroid": {
        const ang = atan(P.z, P.x);
        const turns = fract(ang.mul(27 / (2 * Math.PI)));
        const wire = smoothstep(0.08, 0.2, turns).mul(smoothstep(0.98, 0.84, turns));
        const enamel = mix(vec3(0.62, 0.3, 0.1), vec3(0.55, 0.12, 0.08), step(0.66, vr));
        const enamel2 = mix(enamel, vec3(0.1, 0.45, 0.3), step(0.85, vr));
        const body = enamel2.mul(float(0.4).add(wire.mul(0.75)));
        const legs = step(P.y, 4.1).mul(step(5.5, abs(P.z)));
        base = mix(body, vec3(0.6, 0.6, 0.62), legs);
        spec = 0.7;
        shin = 22;
        break;
      }
      case "boxChoke": {
        const term = step(P.y, 1.8).mul(step(8.7, abs(P.x)));
        const printed = top
          .mul(step(0.5, fract(P.z.mul(0.28).add(vr.mul(5)))))
          .mul(step(abs(P.x), 5.5))
          .mul(step(abs(P.z), 6.5));
        base = mix(
          vec3(0.035, 0.04, 0.055).add(vec3(0.09, 0.1, 0.12).mul(printed)),
          vec3(0.62, 0.62, 0.65),
          term
        );
        spec = 0.4;
        shin = 30;
        break;
      }
      case "connector": {
        const pin = step(10.4, P.y).mul(0.55);
        const slot = step(0.5, fract(P.x.mul(0.137)))
          .mul(step(6.5, P.y))
          .mul(float(1).sub(top));
        base = mix(
          vec3(0.016, 0.016, 0.022).mul(float(1).sub(slot.mul(0.45))),
          vec3(0.85, 0.65, 0.22),
          pin
        );
        spec = 0.3;
        break;
      }
      case "heatsink": {
        const brushed = float(0.9).add(sin(P.z.mul(7).add(P.x.mul(2))).mul(0.06));
        base = vec3(0.3, 0.32, 0.36)
          .mul(brushed)
          .mul(float(0.8).add(top.mul(0.4)));
        spec = 0.9;
        shin = 14;
        break;
      }
      case "led": {
        const hue = vr.mul(3).floor();
        const c = select(
          hue.lessThan(0.5),
          vec3(0.1, 0.85, 1.0),
          select(hue.lessThan(1.5), vec3(1.0, 0.55, 0.1), vec3(0.25, 1.0, 0.45))
        );
        const rate = float(0.35).add(vr.mul(7.7).fract().mul(1.4));
        const phase = vr.mul(53.1);
        const blink = float(0.5).add(float(0.5).mul(sin(envTime.mul(rate).mul(6.2831).add(phase))));
        const level = mix(float(0.8), blink, partLife as any);
        base = c.mul(0.12);
        // Faint (never bright): well under the atoms' emission.
        emissive = c.mul(level.mul(0.55).add(0.1)).mul(top.mul(0.5).add(0.5));
        spec = 0.5;
        break;
      }
    }
    return vec4(lit(base, N, h01, shin, spec, emissive), 1);
  })();
  mat.depthWrite = true;
  mat.depthTest = true;
  return mat;
}

/** Soft contact-shadow decal: a dark radial blot hugging the surface under each part. */
function decalMaterial(): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  m.colorNode = Fn(() => {
    const r = length(positionGeometry.xz);
    const a = smoothstep(1.0, 0.1, r).pow(2).mul(0.7);
    return vec4(vec3(0, 0, 0), a);
  })();
  m.transparent = true;
  m.depthWrite = false;
  m.depthTest = true;
  m.side = 2;
  return m;
}

const NORMAL: Record<Surface, [number, number, number]> = {
  floor: [0, 1, 0],
  ceiling: [0, -1, 0],
  wallL: [1, 0, 0],
  wallR: [-1, 0, 0],
  wallFar: [0, 0, 1],
};

const UP = new Vector3(0, 1, 0);
const tmpQ = new Quaternion();
const spinQ = new Quaternion();
const tmpV = new Vector3();
const tmpS = new Vector3();
const tmpM = new Matrix4();

function partMatrix(p: PartPlacement, lift: number, scale: number, out: Matrix4): Matrix4 {
  const n = NORMAL[p.surface];
  tmpQ.setFromUnitVectors(UP, tmpV.set(n[0], n[1], n[2]));
  spinQ.setFromAxisAngle(UP, p.spin);
  tmpQ.multiply(spinQ);
  return out.compose(
    tmpS.set(p.x + n[0] * lift, p.y + n[1] * lift, p.z + n[2] * lift),
    tmpQ,
    new Vector3(scale, scale, scale)
  );
}

export interface BoardParts {
  objects: Mesh[];
  /** Re-place the parts and haze field for a new container / atom footprint. */
  setLayout: (ext: BoardExtent, avoid: readonly Avoid[]) => void;
  /** Haze field texture (floor, row-major) + its world rectangle. */
  haze: { texture: DataTexture; rect: { value: [number, number, number, number] } };
  setLife: (life: number) => void;
  dispose: () => void;
}

export function createBoardParts(): BoardParts {
  const geos = new Map<PartKind, BufferGeometry>();
  const mats = new Map<PartKind, MeshBasicNodeMaterial>();
  const meshes = new Map<PartKind, InstancedMesh>();
  const MAXI = 1024;
  for (const k of PART_KINDS) {
    const g = partGeometry(k);
    g.setAttribute("aVar", new InstancedBufferAttribute(new Float32Array(MAXI), 1));
    const m = partMaterial(k);
    const mesh = new InstancedMesh(g, m, MAXI);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = -50;
    mesh.name = `board-${k}`;
    geos.set(k, g);
    mats.set(k, m);
    meshes.set(k, mesh);
  }
  const decalGeo = new CircleGeometry(1, 20);
  decalGeo.rotateX(-Math.PI / 2);
  // CircleGeometry lies in XY; after rotateX it faces +Y with xz as the plane.
  const decalMat = decalMaterial();
  const DECAL_MAX = 4096;
  const decals = new InstancedMesh(decalGeo, decalMat, DECAL_MAX);
  decals.count = 0;
  decals.frustumCulled = false;
  decals.renderOrder = -60;
  decals.name = "board-contact-shadows";

  const HZ = 128;
  const hazeData = new Uint8Array(HZ * HZ);
  const hazeTex = new DataTexture(hazeData, HZ, HZ, RedFormat, UnsignedByteType);
  hazeTex.minFilter = LinearFilter;
  hazeTex.magFilter = LinearFilter;
  hazeTex.needsUpdate = true;
  const rect = { value: [-1000, -1000, 2000, 2000] as [number, number, number, number] };

  const setLayout = (ext: BoardExtent, avoid: readonly Avoid[]): void => {
    const parts = placeBoardParts(ext, avoid);
    const by = groupByKind(parts);
    let di = 0;
    for (const k of PART_KINDS) {
      const list = by[k].slice(0, MAXI);
      const mesh = meshes.get(k)!;
      const attr = geos.get(k)!.getAttribute("aVar") as InstancedBufferAttribute;
      list.forEach((p, i) => {
        const sc = 0.92 + 0.2 * ((p.variant * 7.13) % 1);
        mesh.setMatrixAt(i, partMatrix(p, 0, sc, tmpM));
        (attr.array as Float32Array)[i] = p.variant;
        if (di < DECAL_MAX && k !== "led") {
          const fp = PART_FOOTPRINT[k] * sc * 1.25;
          const n = NORMAL[p.surface];
          tmpQ.setFromUnitVectors(UP, tmpV.set(n[0], n[1], n[2]));
          spinQ.setFromAxisAngle(UP, p.spin);
          tmpQ.multiply(spinQ);
          decals.setMatrixAt(
            di,
            tmpM.compose(
              tmpS.set(p.x + n[0] * 0.25, p.y + n[1] * 0.25, p.z + n[2] * 0.25),
              tmpQ,
              new Vector3(fp, 1, fp * (k === "ic" || k === "connector" ? 0.7 : 1))
            )
          );
          di += 1;
        }
      });
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      attr.needsUpdate = true;
    }
    decals.count = di;
    decals.instanceMatrix.needsUpdate = true;
    const field = buildHazeField(parts, ext, HZ);
    for (let i = 0; i < field.length; i += 1) hazeData[i] = Math.round(Math.min(1, field[i]) * 255);
    hazeTex.needsUpdate = true;
    rect.value = [-ext.wallX, ext.farZ, ext.wallX * 2, ext.nearZ - ext.farZ];
  };

  return {
    objects: [decals, ...PART_KINDS.map((k) => meshes.get(k)!)],
    setLayout,
    haze: { texture: hazeTex, rect },
    setLife: (life) => {
      (partLife as { value: number }).value = life;
    },
    dispose: () => {
      for (const g of geos.values()) g.dispose();
      for (const m of mats.values()) m.dispose();
      decalGeo.dispose();
      decalMat.dispose();
      hazeTex.dispose();
    },
  };
}
