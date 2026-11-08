/**
 * Thin emissive orbital wires + electron motes (TSL). Wires are real tube
 * geometry (HDR emissive => bloom) with a travelling highlight; electrons are
 * small emissive spheres with additive glow sprites. Occlusion by the nucleus
 * is analytic (`sphereVisibility`), so no depth buffer dependency.
 */
import {
  Fn,
  abs,
  cameraPosition,
  dot,
  exp,
  float,
  mix,
  normalize,
  normalWorld,
  positionWorld,
  pow,
  saturate,
  sin,
  uniform,
  uv,
  vec3,
  vec4,
} from "three/tsl";
import {
  AdditiveBlending,
  CatmullRomCurve3,
  Mesh,
  MeshBasicNodeMaterial,
  SphereGeometry,
  Sprite,
  SpriteNodeMaterial,
  TubeGeometry,
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
}

export function createWireUniforms(): WireUniforms {
  return {
    time: uniform(0),
    energy: uniform(new Vector3(1, 1, 0)),
    tint: uniform(new Vector3(0.3, 0.9, 1.0)),
    occluderCenter: uniform(new Vector3()),
    occluderRadius: uniform(18),
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

export function createWireMesh(
  wire: OrbitWire,
  index: number,
  u: WireUniforms,
  radius: number
): Mesh {
  const pts: Vector3[] = [];
  const n = 160;
  for (let i = 0; i < n; i += 1) pts.push(wirePoint(wire, (i / n) * Math.PI * 2, new Vector3()));
  const curve = new CatmullRomCurve3(pts, true, "centripetal");
  const geometry = new TubeGeometry(curve, 360, radius, 5, true);
  const material = new MeshBasicNodeMaterial();
  const phase = float(index * 1.7);
  material.fragmentNode = Fn(() => {
    const along = uv().x;
    const pulse = pow(
      sin(
        along
          .mul(6.2831853 * 2)
          .sub((u.time as any).mul(wire.speed * 1.4))
          .add(phase)
      )
        .mul(0.5)
        .add(0.5),
      8
    );
    const view = normalize(cameraPosition.sub(positionWorld));
    const edge = pow(float(1).sub(abs(dot(normalize(normalWorld), view))), 1.5);
    const vis = sphereVisibility(
      cameraPosition,
      positionWorld,
      u.occluderCenter as any,
      u.occluderRadius as any
    );
    const col = mix(vec3(0.12, 0.8, 1.0), vec3(0.6, 0.35, 1.0), float((index % 3) / 3));
    const tintCol = mix(col, u.tint as any, 0.35);
    const bright = float(0.9).add(pulse.mul(2.6)).add(edge.mul(0.4));
    const k = bright.mul((u.energy as any).x).mul(vis);
    const luma = dot(tintCol, vec3(0.2126, 0.7152, 0.0722));
    const graded = mix(vec3(luma), tintCol, (u.energy as any).y);
    return vec4(graded.mul(k).mul(0.4), 1);
  })();
  material.transparent = true;
  material.blending = AdditiveBlending;
  material.depthWrite = false;
  material.depthTest = false;
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  return mesh;
}

export interface ElectronVisual {
  core: Mesh;
  glow: Sprite;
  dispose: () => void;
}

export function createElectron(u: WireUniforms, hot: [number, number, number]): ElectronVisual {
  const geo = new SphereGeometry(1, 20, 14);
  const coreMat = new MeshBasicNodeMaterial();
  coreMat.fragmentNode = Fn(() => {
    const vis = sphereVisibility(
      cameraPosition,
      positionWorld,
      u.occluderCenter as any,
      u.occluderRadius as any
    );
    return vec4(
      vec3(...hot)
        .mul(5.0)
        .mul((u.energy as any).x)
        .mul(vis),
      1
    );
  })();
  coreMat.transparent = true;
  coreMat.blending = AdditiveBlending;
  coreMat.depthWrite = false;
  coreMat.depthTest = false;
  const core = new Mesh(geo, coreMat);
  core.frustumCulled = false;
  core.renderOrder = 11;
  const glowMat = new SpriteNodeMaterial();
  glowMat.colorNode = Fn(() => {
    const p = uv().sub(0.5).mul(2);
    const r2 = dot(p, p);
    const g = exp(r2.mul(-7))
      .mul(0.9)
      .add(exp(r2.mul(-28)).mul(1.8));
    const vis = sphereVisibility(
      cameraPosition,
      positionWorld,
      u.occluderCenter as any,
      u.occluderRadius as any
    );
    return vec4(
      vec3(...hot)
        .mul(g)
        .mul((u.energy as any).x)
        .mul(vis)
        .mul(1.2),
      1
    );
  })();
  glowMat.transparent = true;
  glowMat.blending = AdditiveBlending;
  glowMat.depthWrite = false;
  glowMat.depthTest = false;
  const glow = new Sprite(glowMat);
  glow.renderOrder = 11;
  void saturate;
  return {
    core,
    glow,
    dispose: () => {
      geo.dispose();
      coreMat.dispose();
      glowMat.dispose();
    },
  };
}
