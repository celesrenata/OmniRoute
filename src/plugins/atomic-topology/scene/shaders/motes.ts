/**
 * Floating bokeh orbs and dust in world space (Gate B C3b / ART_DIRECTION 10):
 * instanced soft discs scattered through the volume around the topology, with
 * a depth-of-field circle of confusion from the camera focus distance (the
 * orbit target): motes far from the focus plane grow into large, dim,
 * hexagon-tinted bokeh; motes near it stay small, crisp dust. Real parallax
 * with orbit because they live in world space. Very slow deterministic drift
 * (frozen when the env time is frozen under reduced motion).
 *
 * Two draws share one geometry: `near` (nearer than the focus, drawn over the
 * atoms) and `far` (behind the focus, drawn before the atoms). Purely
 * decorative; no per-frame CPU work besides a few uniforms.
 */
import {
  Fn,
  abs,
  attribute,
  cameraPosition,
  exp,
  float,
  fract,
  length,
  max,
  mix,
  positionGeometry,
  select,
  sin,
  smoothstep,
  step,
  uniform,
  varying,
  vec3,
  vec4,
} from "three/tsl";
import {
  AdditiveBlending,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Vector3,
  type Camera,
} from "three/webgpu";
import { mulberry32 } from "../strandField";
import { envTime, pxScale } from "../rt/sharedUniforms";

export const MOTE_COUNT = 900;

export interface MoteLayer {
  near: Mesh;
  far: Mesh;
  /** Volume (centre + half extents) and the camera focus distance. */
  update: (camera: Camera, focus: Vector3) => void;
  setBounds: (center: Vector3, half: Vector3) => void;
  dispose: () => void;
}

export function createMotes(count = MOTE_COUNT, seed = 0x0b0c3): MoteLayer {
  const rnd = mulberry32(seed);
  const plane = new PlaneGeometry(2, 2);
  const g = new InstancedBufferGeometry();
  g.index = plane.index;
  g.setAttribute("position", plane.getAttribute("position"));
  const rand = new Float32Array(count * 4);
  for (let i = 0; i < count * 4; i += 1) rand[i] = rnd();
  g.setAttribute("aRand", new InstancedBufferAttribute(rand, 4));
  g.instanceCount = count;

  const boundsC = uniform(new Vector3());
  const boundsH = uniform(new Vector3(600, 300, 600));
  const focusDist = uniform(800);
  const camRight = uniform(new Vector3(1, 0, 0));
  const camUp = uniform(new Vector3(0, 1, 0));

  const make = (nearSide: boolean): MeshBasicNodeMaterial => {
    const r = attribute("aRand", "vec4");
    const t = envTime as any;
    const drift = vec3(
      sin(t.mul(0.05).add(r.w.mul(40))),
      sin(t.mul(0.037).add(r.x.mul(31))),
      sin(t.mul(0.043).add(r.y.mul(23)))
    ).mul(30);
    const c = (boundsC as any)
      .add(
        r.xyz
          .mul(2)
          .sub(1)
          .mul(boundsH as any)
      )
      .add(drift);
    const d = length(c.sub(cameraPosition));
    const fd = focusDist as any;
    // Circle of confusion (0 at the focus plane, saturating far away).
    const coc = smoothstep(0, 1, abs(d.sub(fd)).div(fd.mul(0.8)));
    const kind = fract(r.w.mul(7.31));
    // Polish (directive 33): the large defocused orbs crowded the upper half of the default
    // /home frame. High in the volume, big orbs shrink and two in five fade out entirely; the
    // dust and the lower / nearer orbs are unchanged.
    const high = smoothstep(0.1, 0.8, c.y.sub((boundsC as any).y).div((boundsH as any).y));
    const big = coc.mul(mix(float(10), float(28), r.x)).mul(float(1).sub(high.mul(0.45)));
    const sizePx = mix(float(1.6), float(3.2), kind).add(big);
    const thin = float(1).sub(
      high.mul(step(fract(r.z.mul(13.7)), 0.4)).mul(smoothstep(0.15, 0.4, coc))
    );
    const world = sizePx.mul(d).mul(pxScale as any);
    const material = new MeshBasicNodeMaterial();
    material.positionNode = c
      .add((camRight as any).mul(positionGeometry.x.mul(world)))
      .add((camUp as any).mul(positionGeometry.y.mul(world)));
    const pV = varying(positionGeometry.xy);
    const cocV = varying(coc);
    const kindV = varying(kind);
    const thinV = varying(thin);
    const sideV = varying(d.sub(fd));
    material.fragmentNode = Fn(() => {
      const p = pV;
      // Hexagonal aperture blended with a disc; defocused orbs get a brighter rim.
      const hx = max(abs(p.x).mul(0.866).add(abs(p.y).mul(0.5)), abs(p.y));
      const rr = mix(length(p), hx.mul(1.08), cocV.mul(0.7));
      const edge = mix(float(0.06), float(0.22), cocV);
      const disc = smoothstep(float(1), float(1).sub(edge), rr);
      const rim = smoothstep(0.55, 0.95, rr).mul(cocV).mul(0.6).add(0.55);
      const dust = exp(rr.mul(rr).mul(-6));
      const shape = mix(dust, disc.mul(rim), smoothstep(0.05, 0.3, cocV));
      // Energy-conserving: big defocused orbs are dimmer per pixel.
      // (Gate B r5: lifted so floating orbs read at several depths at default zoom.)
      const k = float(1)
        .div(cocV.mul(4.5).add(1))
        .mul(mix(float(1.8), float(1.2), cocV));
      const col = select(
        kindV.lessThan(0.45),
        vec3(1.0, 0.52, 0.16),
        select(kindV.lessThan(0.85), vec3(0.15, 0.78, 1.0), vec3(0.95, 0.3, 0.75))
      );
      const sideMask = nearSide ? step(sideV, 0) : step(0, sideV);
      return vec4(col.mul(shape).mul(k).mul(0.3).mul(sideMask).mul(thinV), 1);
    })();
    material.transparent = true;
    material.blending = AdditiveBlending;
    material.depthWrite = false;
    material.depthTest = false;
    return material;
  };
  const nearMat = make(true);
  const farMat = make(false);
  const near = new Mesh(g, nearMat);
  const far = new Mesh(g, farMat);
  near.name = "motesNear";
  far.name = "motesFar";
  near.renderOrder = 20;
  far.renderOrder = -50;
  near.frustumCulled = false;
  far.frustumCulled = false;
  const tmp = new Vector3();
  const tmp2 = new Vector3();
  const tmp3 = new Vector3();
  return {
    near,
    far,
    update(camera, focus) {
      camera.matrixWorld.extractBasis(tmp, tmp2, tmp3);
      (camRight.value as Vector3).copy(tmp);
      (camUp.value as Vector3).copy(tmp2);
      focusDist.value = Math.max(50, camera.position.distanceTo(focus));
    },
    setBounds(center, half) {
      (boundsC.value as Vector3).copy(center);
      (boundsH.value as Vector3).copy(half);
    },
    dispose() {
      g.dispose();
      plane.dispose();
      nearMat.dispose();
      farMat.dispose();
    },
  };
}
