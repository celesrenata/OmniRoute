/**
 * Orbital wires + electrons (TSL, Gate A r6; batched across atoms in Gate B C7a).
 * Each wire is a screen-space hairline ribbon (not a world-space tube, which read
 * as thick pale ellipses at close range): ~0.6 px at the far side of the orbit,
 * tapering up to ~1.8 px on the near side, and attenuated with depth. Electrons
 * are not separate meshes: they are small, sharp HDR heads (with short fading
 * trails) evaluated inside the wire shader from a per-wire angle. Occlusion by
 * the nucleus is analytic (`sphereVisibility`), so no depth buffer dependency.
 *
 * ONE instanced draw renders every wire of every atom. Instance `i` is wire
 * `i % WIRES_PER_ATOM` of atom row `floor(i / WIRES_PER_ATOM)`; the ellipse
 * (basis, semi-axes), colour, width and electron angles come from the shared
 * data textures, so the ribbon geometry is one canonical closed curve.
 */
import {
  Fn,
  attribute,
  cameraPosition,
  cos,
  cross,
  dot,
  exp,
  float,
  fract,
  instanceIndex,
  int,
  length,
  max,
  min,
  mix,
  normalize,
  positionWorld,
  pow,
  select,
  sin,
  smoothstep,
  varying,
  vec3,
  vec4,
} from "three/tsl";
import {
  AdditiveBlending,
  BufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  Vector3,
} from "three/webgpu";
import type { OrbitWire } from "../orbitalDensity";
import { atomFields, type AtomData } from "../rt/atomData";
import { WIRES_PER_ATOM } from "../rt/atomLayout";
import { sphereVisibility } from "./raySphere";

/** Point on a wire at angle theta (atom-local, world units). */
export function wirePoint(w: OrbitWire, theta: number, out: Vector3): Vector3 {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return out.set(
    w.u[0] * w.a * c + w.v[0] * w.b * s,
    w.u[1] * w.a * c + w.v[1] * w.b * s,
    w.u[2] * w.a * c + w.v[2] * w.b * s
  );
}

export const WIRE_SEGMENTS = 384;

/** Canonical closed ribbon (parameter t along the curve + side), shared by every wire. */
export function wireRibbonGeometry(segments = WIRE_SEGMENTS): InstancedBufferGeometry {
  const n = segments;
  const pos = new Float32Array((n + 1) * 2 * 3);
  const prm = new Float32Array((n + 1) * 2 * 2);
  const idx = new Uint32Array(n * 6);
  for (let i = 0; i <= n; i += 1) {
    for (let s = 0; s < 2; s += 1) {
      const v = i * 2 + s;
      prm.set([i / n, s === 0 ? -1 : 1], v * 2);
    }
  }
  for (let i = 0; i < n; i += 1) {
    const a = i * 2;
    idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
  }
  const g = new InstancedBufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("aWire", new BufferAttribute(prm, 2));
  g.setIndex(new BufferAttribute(idx, 1));
  g.instanceCount = 0;
  return g;
}

const TAU = 6.2831853;

export function createWireMaterial(data: AtomData): MeshBasicNodeMaterial {
  const inst = int(instanceIndex);
  const row = inst.div(WIRES_PER_ATOM);
  const w = inst.sub(row.mul(WIRES_PER_ATOM));
  const U = atomFields(data, row, false);
  const d0 = U.wireDef(w, 0); // u.xyz, a
  const d1 = U.wireDef(w, 1); // v.xyz, b
  const d2 = U.wireDef(w, 2); // lane colour, widthPx
  const d3 = U.wireDef(w, 3); // electron hot colour, speed
  const e = U.electrons(w);
  const aw = attribute("aWire", "vec2");
  const theta = aw.x.mul(TAU);
  const cs = cos(theta);
  const sn = sin(theta);
  const pRaw = d0.xyz.mul(d0.w.mul(cs)).add(d1.xyz.mul(d1.w.mul(sn)));
  const tanL = normalize(d0.xyz.mul(d0.w.mul(sn).negate()).add(d1.xyz.mul(d1.w.mul(cs))));
  const pL = pRaw.mul(U.wireScale);
  const center = U.center;
  const camL = cameraPosition.sub(center);
  const toCam = camL.sub(pL);
  const dist = length(toCam);
  const perp = normalize(cross(tanL, toCam.div(dist)));
  // Near side of the orbit (between atom and viewer) is wider and brighter.
  const front = dot(normalize(pL), normalize(camL));
  const nearK = smoothstep(-0.6, 0.9, front);
  const speed = d3.w;
  const dir = select(speed.lessThan(0), float(-1), float(1));
  // Angular distance behind each electron (trail) and to its head.
  const behind = (eth: any) => fract(eth.sub(theta).mul(dir).div(TAU)).mul(TAU);
  const headD = (eth: any) => {
    const b = behind(eth);
    return min(b, float(TAU).sub(b));
  };
  const h1 = headD(e.x);
  const h2 = headD(e.y);
  const headV = exp(h1.mul(h1).mul(-1800)).add(exp(h2.mul(h2).mul(-1800)));
  const widthPx = d2.w;
  const wd = mix(widthPx.mul(0.7), widthPx, nearK).add(headV.mul(2.2));
  const drawPx = max(wd, 1.0);
  const material = new MeshBasicNodeMaterial();
  material.positionNode = center.add(
    pL.add(perp.mul(aw.y.mul(0.5).mul(drawPx).mul(dist).mul(U.pxScale)))
  );
  const coverV = varying(wd.div(drawPx));
  const sideV = varying(aw.y);
  const thetaV = varying(theta);
  const nearV = varying(nearK);
  const phase = float(w).mul(1.7);
  material.fragmentNode = Fn(() => {
    const prof = exp(sideV.mul(sideV).mul(-1.6));
    const pulse = pow(
      sin(
        thetaV
          .mul(2)
          .sub(U.wireTime.mul(speed.abs().mul(1.4)))
          .add(phase)
      )
        .mul(0.5)
        .add(0.5),
      8
    );
    const vis = sphereVisibility(cameraPosition, positionWorld, center, U.occluderR);
    const tintCol = mix(d2.xyz, U.rim, 0.6);
    const luma = dot(tintCol, vec3(0.2126, 0.7152, 0.0722));
    const graded = pow(max(mix(vec3(luma), tintCol, U.saturation), 0.0001), vec3(1.25));
    // Attenuate with depth: far side of the orbit fades into the cloud.
    const k = float(0.9)
      .add(pulse.mul(1.2))
      .mul(mix(float(0.55), float(1.0), nearV))
      .mul(U.wireEnergy)
      .mul(3.2);
    // Electron heads: small sharp HDR points with short fading trails.
    const tb1 = behind(e.x);
    const tb2 = behind(e.y);
    const trail = exp(tb1.mul(-9))
      .mul(smoothstep(0.0, 0.02, tb1))
      .add(exp(tb2.mul(-9)).mul(smoothstep(0.0, 0.02, tb2)));
    const hd1 = min(tb1, float(TAU).sub(tb1));
    const hd2 = min(tb2, float(TAU).sub(tb2));
    const head = exp(hd1.mul(hd1).mul(-2600)).add(exp(hd2.mul(hd2).mul(-2600)));
    const eK = head
      .mul(16)
      .add(trail.mul(1.6))
      .mul(U.wireEnergy)
      .mul(mix(float(0.45), float(1), nearV));
    const col = graded.mul(k).add(d3.xyz.mul(eK));
    return vec4(col.mul(prof).mul(coverV).mul(vis), 1);
  })();
  material.transparent = true;
  material.blending = AdditiveBlending;
  material.depthWrite = false;
  material.depthTest = false;
  material.side = 2; // DoubleSide
  return material;
}

export interface WireLayer {
  mesh: Mesh;
  material: MeshBasicNodeMaterial;
  setCount: (atoms: number) => void;
}

export function createWireLayer(data: AtomData): WireLayer {
  const geometry = wireRibbonGeometry();
  const material = createWireMaterial(data);
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  return {
    mesh,
    material,
    setCount: (atoms: number) => {
      geometry.instanceCount = atoms * WIRES_PER_ATOM;
    },
  };
}
