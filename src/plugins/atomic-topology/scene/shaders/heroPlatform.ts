/**
 * Hero holographic platform under the hub (operator directive 28, idea5):
 *  - a floor decal of concentric glowing rings, ripples, dashed arcs, tick
 *    marks and an orange outer ring on the circuit board;
 *  - a chrome / machined tiered base: brushed metal side with engraved rings,
 *    bolts and segment lights, environment-reflective (neon studio probe);
 *  - a holographic glass top with grid lines, glowing segment arcs, emitter
 *    nodes and twinkling specular sparkles;
 *  - an under-glow light column projecting up into the hub's cloud.
 * The chrome base and the column are mirrored below the floor so the platform
 * reflects in the glossy board. Everything is procedural (no textures), driven
 * by the shared time/life uniforms; decorative only (never encodes telemetry).
 */
import {
  Fn,
  abs,
  atan,
  cameraPosition,
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
  reflect,
  saturate,
  select,
  sin,
  smoothstep,
  step,
  vec2,
  vec3,
  vec4,
  uniform,
} from "three/tsl";
import {
  AdditiveBlending,
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  Vector4,
} from "three/webgpu";
import { neonEnvironment } from "./atomImpostor";

const TAU = 6.2831853;
const h11 = (x: any) => fract(sin(x.mul(127.1).add(311.7)).mul(43758.5453));

/** Platform radii (world units, at scale 1; the hub scale multiplies them). */
export const PLATFORM = { decal: 330, tier: 128, top: 112 } as const;

export interface HeroPlatform {
  group: Group;
  /** Place under the hub (floor-level position) and scale. */
  place: (x: number, y: number, z: number, scale: number) => void;
  dispose: () => void;
}

export function createHeroPlatform(
  time: { value: number } | any,
  life: any,
  floorU: any
): HeroPlatform {
  const disposables: { dispose: () => void }[] = [];
  const group = new Group();
  group.name = "hero-platform";
  const R = PLATFORM;
  // x, z = hub position, w = platform scale (the light column fades out when the camera is inside it).
  const hubU = uniform(new Vector4(0, 0, 0, 1));

  // ---- floor decal: rings, ripples, dashed arcs, ticks ------------------------------
  const decalGeo = new CircleGeometry(R.decal, 192);
  decalGeo.rotateX(-Math.PI / 2);
  const decalMat = new MeshBasicNodeMaterial();
  decalMat.fragmentNode = Fn(() => {
    const p = vec2(positionGeometry.x, positionGeometry.z);
    const r = length(p);
    const a = atan(p.y, p.x).add(3.14159);
    const t = time as any;
    // Thin concentric rings at irregular radii, fading outward.
    let rings: any = float(0);
    const radii = [136, 150, 171, 196, 224, 256, 290];
    radii.forEach((rad, i) => {
      const w = i % 3 === 0 ? 1.7 : 0.9;
      const k = exp(abs(r.sub(rad)).div(w).mul(-1.0));
      rings = rings.add(k.mul(0.9 - i * 0.08));
    });
    // Outward ripples (animated; frozen when life = 0).
    const rip = exp(
      abs(
        fract(r.div(46).sub(t.mul(0.12).mul(life)))
          .sub(0.5)
          .sub(0.0)
      ).mul(-0.0)
    ).mul(0.0);
    void rip;
    const ripPhase = fract(r.div(52).sub(t.mul(0.22).mul(life)));
    const ripple = exp(ripPhase.mul(-7))
      .mul(smoothstep(R.tier * 1.0, R.tier * 1.4, r))
      .mul(float(1).sub(smoothstep(R.decal * 0.7, R.decal * 0.98, r)));
    // Dashed arcs (counter-rotating) on two rings.
    const dashA = step(0.5, fract(a.mul(18 / TAU).add(t.mul(0.03).mul(life)))).mul(
      exp(abs(r.sub(208)).mul(-1.3))
    );
    const dashB = step(0.35, fract(a.mul(40 / TAU).sub(t.mul(0.05).mul(life)))).mul(
      exp(abs(r.sub(240)).mul(-2.2))
    );
    // Tick marks on the outer ring.
    const ticks = step(0.86, fract(a.mul(96 / TAU)))
      .mul(exp(abs(r.sub(300)).mul(-0.9)))
      .mul(step(r, 306));
    // Orange outer ring with segment gaps.
    const orange = exp(abs(r.sub(318)).mul(-0.75)).mul(step(0.18, fract(a.mul(12 / TAU))));
    const fade = float(1).sub(smoothstep(R.decal * 0.78, R.decal, r));
    const cyan = vec3(0.1, 0.85, 1.0);
    const warm = vec3(1.0, 0.5, 0.12);
    const inner = exp(r.mul(r).mul(-0.00006)).mul(0.22);
    const col = cyan
      .mul(
        rings
          .mul(0.26)
          .add(ripple.mul(0.28))
          .add(dashA.mul(0.4))
          .add(dashB.mul(0.3))
          .add(inner.mul(0.3))
      )
      .add(warm.mul(orange.mul(1.7).add(ticks.mul(1.2))))
      .mul(fade)
      .mul(
        step(R.tier * 0.95, r)
          .mul(0.85)
          .add(0.15)
      );
    return vec4(col, 1);
  })();
  decalMat.transparent = true;
  decalMat.blending = AdditiveBlending;
  decalMat.depthWrite = false;
  disposables.push(decalGeo, decalMat);
  const decal = new Mesh(decalGeo, decalMat);
  decal.position.y = 0.6;
  decal.renderOrder = 2;
  decal.frustumCulled = false;

  // ---- chrome tiered base (machined side + holographic glass top) ------------------
  // Two stacked cylinders: lower tier r=128 (h 7), upper tier r=112 (h 6).
  const mirrorK = select(positionWorld.y.lessThan((floorU as any).sub(0.2)), float(0.34), float(1));
  const makeTier = (rad0: number, rad1: number, h: number, yBase: number, top: boolean) => {
    // CylinderGeometry groups: 0 = torso, 1 = top cap, 2 = bottom cap.
    const geo = new CylinderGeometry(rad0, rad1, h, 160, 1, false);
    geo.translate(0, yBase + h / 2, 0);
    const buildMat = (isTopFace: boolean) => {
      const mat = new MeshBasicNodeMaterial();
      mat.fragmentNode = Fn(() => {
        const t = time as any;
        const p = vec2(positionGeometry.x, positionGeometry.z);
        const r = length(p);
        const isTop = float(isTopFace ? 1 : 0);
        const a = atan(p.y, p.x).add(3.14159);
        const view = normalize(cameraPosition.sub(positionWorld));

        // --- machined chrome side: reflective brushed metal with engraved bands ---
        const n = normalize(vec3(positionGeometry.x, 0, positionGeometry.z));
        const refl = reflect(view.negate(), n);
        const env = neonEnvironment(refl, float(0.3));
        const band = abs(fract(positionGeometry.y.sub(yBase).div(h).mul(3)).sub(0.5));
        const engrave = smoothstep(0.46, 0.5, band).mul(0.55).add(0.45);
        const brushed = sin(a.mul(220)).mul(0.5).add(0.5).mul(0.12).add(0.88);
        const fres = pow(float(1).sub(saturate(dot(n, view))), 3);
        const chrome = env
          .mul(0.9)
          .mul(engrave)
          .mul(brushed)
          .add(vec3(0.05, 0.1, 0.16))
          .add(vec3(0.2, 0.7, 1.0).mul(fres).mul(0.5));
        // Segment lights set into the side (24 slots, alternating warm / cyan).
        const slot = step(0.62, fract(a.mul(24 / TAU))).mul(step(fract(a.mul(24 / TAU)), 0.9));
        const slotY = smoothstep(0.38, 0.42, band.sub(0.0))
          .mul(0)
          .add(float(1).sub(smoothstep(0.1, 0.2, band)));
        const sidx = a.mul(24 / TAU).floor();
        const slotCol = mix(
          vec3(1.0, 0.5, 0.12),
          vec3(0.1, 0.85, 1.0),
          step(0.5, fract(sidx.mul(0.5)))
        );
        const pulse = sin(t.mul(1.1).mul(life).add(sidx.mul(0.9)))
          .mul(0.25)
          .add(0.75);
        const sideCol = chrome.add(slotCol.mul(slot.mul(slotY).mul(2.0).mul(pulse)));

        // --- holographic glass top ---
        const g1 = exp(min(fract(p.x.div(7)), float(1).sub(fract(p.x.div(7)))).mul(-9));
        const g2 = exp(min(fract(p.y.div(7)), float(1).sub(fract(p.y.div(7)))).mul(-9));
        const grid = max(g1, g2).mul(0.16);
        const rr = r.div(rad1);
        const ringL = exp(abs(rr.sub(0.93)).mul(-70))
          .mul(0.7)
          .add(exp(abs(rr.sub(0.62)).mul(-60)).mul(0.3))
          .add(exp(abs(rr.sub(0.33)).mul(-60)).mul(0.25));
        // Rotating glowing segment arcs.
        const seg = step(0.4, fract(a.mul(16 / TAU).add(t.mul(0.08).mul(life))))
          .mul(exp(abs(rr.sub(0.8)).mul(-110)))
          .mul(1.1);
        // Bolts (24) and emitter nodes (6) with hot specular centres.
        const ba = fract(a.mul(24 / TAU))
          .sub(0.5)
          .mul(TAU / 24)
          .mul(r);
        const bolt = exp(length(vec2(ba, r.sub(rad1 * 0.97))).mul(-0.9)).mul(1.6);
        const ea = fract(a.mul(6 / TAU).add(0.5))
          .sub(0.5)
          .mul(TAU / 6)
          .mul(r);
        const node = exp(length(vec2(ea, r.sub(rad1 * 0.52))).mul(-1.1)).mul(1.8);
        // Twinkling specular sparkles scattered on the glass.
        const sc = vec2(p.x.div(5.5).floor(), p.y.div(5.5).floor());
        const sh = h11(sc.x.mul(7.13).add(sc.y.mul(3.77)));
        const spark = step(0.975, sh)
          .mul(
            pow(
              sin(t.mul(sh.mul(3).add(1.5)).mul(life).add(sh.mul(60)))
                .mul(0.5)
                .add(0.5),
              4
            )
          )
          .mul(exp(length(fract(p.div(5.5)).sub(0.5)).mul(-26)).mul(2.4));
        const glow = exp(rr.mul(rr).mul(-2.2)).mul(0.12);
        const topCol = vec3(0.012, 0.03, 0.05)
          .add(vec3(0.1, 0.85, 1.0).mul(grid.add(ringL).add(glow).add(node.mul(0.0))))
          .add(vec3(1.0, 0.5, 0.12).mul(seg))
          .add(vec3(0.3, 0.9, 1.0).mul(bolt.add(node)))
          .add(vec3(1.0, 0.9, 1.0).mul(spark));
        const out = select(isTop.greaterThan(0.5), topCol, sideCol);
        return vec4(out.mul(mirrorK), 1);
      })();
      mat.side = DoubleSide;
      mat.depthWrite = false;
      disposables.push(mat);
      return mat;
    };
    const sideMat = buildMat(false);
    const topMat = buildMat(true);
    const mat = [sideMat, topMat, topMat];
    disposables.push(geo);
    const mesh = new Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = top ? 4 : 3;
    return { mesh, geo, mat };
  };
  const tierLow = makeTier(R.tier, R.tier + 8, 7, 0, false);
  const tierHigh = makeTier(R.top, R.top + 4, 6, 7, true);

  // ---- under-glow column rising into the hub's cloud --------------------------------
  const colGeo = new CylinderGeometry(R.top * 0.82, R.top * 0.95, 300, 96, 1, true);
  colGeo.translate(0, 13 + 150, 0);
  const colMat = new MeshBasicNodeMaterial();
  colMat.fragmentNode = Fn(() => {
    const t = time as any;
    const h = saturate(positionGeometry.y.sub(13).div(300));
    const a = atan(positionGeometry.z, positionGeometry.x);
    const streak = pow(
      sin(a.mul(46).add(t.mul(0.6).mul(life)))
        .mul(0.5)
        .add(0.5),
      6
    )
      .mul(0.7)
      .add(0.3);
    const view = normalize(cameraPosition.sub(positionWorld));
    const n = normalize(vec3(positionGeometry.x, 0, positionGeometry.z));
    const edge = pow(float(1).sub(abs(dot(n, view))), 3.0);
    const fall = exp(h.mul(-3.2)).mul(float(1).sub(h.mul(h)));
    const hv = hubU as any;
    const camD = length(vec2(cameraPosition.x.sub(hv.x), cameraPosition.z.sub(hv.y)));
    const outside = smoothstep(R.top * 1.05, R.top * 1.9, camD.div(hv.w));
    const col = vec3(0.1, 0.75, 1.0).mul(
      streak.mul(edge.mul(0.9).add(0.05)).mul(fall).mul(0.03).mul(outside)
    );
    return vec4(col.mul(mirrorK), 1);
  })();
  colMat.transparent = true;
  colMat.blending = AdditiveBlending;
  colMat.depthWrite = false;
  colMat.side = DoubleSide;
  disposables.push(colGeo, colMat);
  const column = new Mesh(colGeo, colMat);
  column.frustumCulled = false;
  column.renderOrder = 5;

  // Mirror copies (reflect in the glossy board): scale.y = -1 about the floor plane.
  const mirrorGroup = new Group();
  const mirrorParts = [
    new Mesh(tierLow.geo, tierLow.mat),
    new Mesh(tierHigh.geo, tierHigh.mat),
    new Mesh(colGeo, colMat),
  ];
  mirrorParts.forEach((m, i) => {
    m.frustumCulled = false;
    m.renderOrder = i === 2 ? 5 : 3;
    mirrorGroup.add(m);
  });
  mirrorGroup.scale.y = -1;

  group.add(decal, tierLow.mesh, tierHigh.mesh, column, mirrorGroup);
  group.traverse((o) => {
    (o as { raycast?: unknown }).raycast = () => {};
  });
  void cos;
  void max;
  return {
    group,
    place(x, y, z, scale) {
      group.position.set(x, y, z);
      group.scale.setScalar(scale);
      (hubU.value as Vector4).set(x, z, 0, scale);
      // scale.y of the mirror group must stay -1 relative to the platform.
      mirrorGroup.scale.y = -1;
      if (typeof window !== "undefined") {
        const m = Number(new URLSearchParams(window.location.search).get("pdbg") ?? 31);
        decal.visible = (m & 1) !== 0;
        tierLow.mesh.visible = (m & 2) !== 0;
        tierHigh.mesh.visible = (m & 4) !== 0;
        column.visible = (m & 8) !== 0;
        mirrorGroup.visible = (m & 16) !== 0;
      }
    },
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}
