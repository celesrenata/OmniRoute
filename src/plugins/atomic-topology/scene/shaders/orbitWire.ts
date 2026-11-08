/**
 * Orbital wires + electrons (TSL, Gate A r6). Each wire is a screen-space
 * hairline ribbon (not a world-space tube, which read as thick pale ellipses at
 * close range): ~0.6 px at the far side of the orbit, tapering up to ~1.8 px on
 * the near side, and attenuated with depth. Electrons are not separate meshes:
 * they are small, sharp HDR heads (with short fading trails) evaluated inside
 * the wire shader from a per-wire angle uniform. Occlusion by the nucleus is
 * analytic (`sphereVisibility`), so no depth buffer dependency.
 */
import {
  Fn,
  attribute,
  cameraPosition,
  cross,
  dot,
  exp,
  float,
  fract,
  length,
  max,
  min,
  mix,
  normalize,
  positionWorld,
  pow,
  sin,
  smoothstep,
  uniform,
  varying,
  vec3,
  vec4,
} from "three/tsl";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  Vector2,
  Vector3,
} from "three/webgpu";
import type { OrbitWire } from "../orbitalDensity";
import { sphereVisibility } from "./raySphere";

export interface WireUniforms {
  time: ReturnType<typeof uniform>;
  /** x brightness, y saturation */
  energy: ReturnType<typeof uniform>;
  tint: ReturnType<typeof uniform>;
  occluderCenter: ReturnType<typeof uniform>;
  occluderRadius: ReturnType<typeof uniform>;
  /** Wire radius scale (cloud radius / bound radius). */
  scale: ReturnType<typeof uniform>;
  /** World size of one device pixel at unit distance. */
  pxScale: ReturnType<typeof uniform>;
}

export function createWireUniforms(): WireUniforms {
  return {
    time: uniform(0),
    energy: uniform(new Vector3(1, 1, 0)),
    tint: uniform(new Vector3(0.3, 0.9, 1.0)),
    occluderCenter: uniform(new Vector3()),
    occluderRadius: uniform(18),
    scale: uniform(1),
    pxScale: uniform(0.0003),
  };
}

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

/** Closed ribbon geometry along a wire (centre line + tangent + side). */
export function wireRibbonGeometry(wire: OrbitWire, segments = 384): BufferGeometry {
  const n = segments;
  const pos = new Float32Array((n + 1) * 2 * 3);
  const tan = new Float32Array((n + 1) * 2 * 3);
  const prm = new Float32Array((n + 1) * 2 * 2);
  const idx = new Uint32Array(n * 6);
  const p = new Vector3();
  const q = new Vector3();
  for (let i = 0; i <= n; i += 1) {
    const th = (i / n) * Math.PI * 2;
    wirePoint(wire, th, p);
    wirePoint(wire, th + 0.002, q)
      .sub(p)
      .normalize();
    for (let s = 0; s < 2; s += 1) {
      const v = i * 2 + s;
      pos.set([p.x, p.y, p.z], v * 3);
      tan.set([q.x, q.y, q.z], v * 3);
      prm.set([i / n, s === 0 ? -1 : 1], v * 2);
    }
  }
  for (let i = 0; i < n; i += 1) {
    const a = i * 2;
    idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("aTan", new BufferAttribute(tan, 3));
  g.setAttribute("aWire", new BufferAttribute(prm, 2));
  g.setIndex(new BufferAttribute(idx, 1));
  return g;
}

export interface WireMesh {
  mesh: Mesh;
  /** Electron angles on this wire (radians); x/y, a value < -50 disables. */
  electrons: ReturnType<typeof uniform>;
}

export function createWireMesh(
  wire: OrbitWire,
  index: number,
  u: WireUniforms,
  widthPx: number,
  laneColor: readonly [number, number, number],
  electronHot: readonly [number, number, number]
): WireMesh {
  const geometry = wireRibbonGeometry(wire);
  const electrons = uniform(new Vector2(-100, -100));
  const scale = u.scale as any;
  const center = u.occluderCenter as any;
  const pL = attribute("position", "vec3").mul(scale);
  const tanL = attribute("aTan", "vec3");
  const aw = attribute("aWire", "vec2");
  const camL = cameraPosition.sub(center);
  const toCam = camL.sub(pL);
  const dist = length(toCam);
  const perp = normalize(cross(tanL, toCam.div(dist)));
  // Near side of the orbit (between atom and viewer) is wider and brighter.
  const front = dot(normalize(pL), normalize(camL));
  const nearK = smoothstep(-0.6, 0.9, front);
  const theta = aw.x.mul(6.2831853);
  const dir = Math.sign(wire.speed) || 1;
  const e = electrons as any;
  // Angular distance behind each electron (trail) and to its head.
  const behind = (eth: any) => fract(eth.sub(theta).mul(dir).div(6.2831853)).mul(6.2831853);
  const headD = (eth: any) => {
    const b = behind(eth);
    return min(b, float(6.2831853).sub(b));
  };
  const h1 = headD(e.x);
  const h2 = headD(e.y);
  const headV = exp(h1.mul(h1).mul(-1800)).add(exp(h2.mul(h2).mul(-1800)));
  const w = mix(float(widthPx * 0.45), float(widthPx), nearK).add(headV.mul(2.2));
  const drawPx = max(w, 1.0);
  const material = new MeshBasicNodeMaterial();
  material.positionNode = pL.add(
    perp.mul(
      aw.y
        .mul(0.5)
        .mul(drawPx)
        .mul(dist)
        .mul(u.pxScale as any)
    )
  );
  const coverV = varying(w.div(drawPx));
  const sideV = varying(aw.y);
  const thetaV = varying(theta);
  const nearV = varying(nearK);
  const phase = float(index * 1.7);
  material.fragmentNode = Fn(() => {
    const prof = exp(sideV.mul(sideV).mul(-1.6));
    const pulse = pow(
      sin(
        thetaV
          .mul(2)
          .sub((u.time as any).mul(Math.abs(wire.speed) * 1.4))
          .add(phase)
      )
        .mul(0.5)
        .add(0.5),
      8
    );
    const vis = sphereVisibility(cameraPosition, positionWorld, center, u.occluderRadius as any);
    const tintCol = mix(vec3(...laneColor), u.tint as any, 0.35);
    const luma = dot(tintCol, vec3(0.2126, 0.7152, 0.0722));
    const graded = pow(max(mix(vec3(luma), tintCol, (u.energy as any).y), 0.0001), vec3(1.25));
    // Attenuate with depth: far side of the orbit fades into the cloud.
    const k = float(0.35)
      .add(pulse.mul(0.9))
      .mul(mix(float(0.18), float(1.0), nearV))
      .mul((u.energy as any).x)
      .mul(1.5);
    // Electron heads: small sharp HDR points with short fading trails.
    const tb1 = behind(e.x);
    const tb2 = behind(e.y);
    const trail = exp(tb1.mul(-9))
      .mul(smoothstep(0.0, 0.02, tb1))
      .add(exp(tb2.mul(-9)).mul(smoothstep(0.0, 0.02, tb2)));
    const hd1 = min(tb1, float(6.2831853).sub(tb1));
    const hd2 = min(tb2, float(6.2831853).sub(tb2));
    const head = exp(hd1.mul(hd1).mul(-2600)).add(exp(hd2.mul(hd2).mul(-2600)));
    const hot = vec3(...electronHot);
    const eK = head
      .mul(16)
      .add(trail.mul(1.6))
      .mul((u.energy as any).x)
      .mul(mix(float(0.45), float(1), nearV));
    const col = graded.mul(k).add(hot.mul(eK));
    return vec4(col.mul(prof).mul(coverV).mul(vis), 1);
  })();
  material.transparent = true;
  material.blending = AdditiveBlending;
  material.depthWrite = false;
  material.depthTest = false;
  material.side = 2; // DoubleSide
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  return { mesh, electrons };
}
