/**
 * Analytic ray / sphere helpers shared by every ray-traced atom shader (TSL).
 * Imports `three` classes only through `three/webgpu` + `three/tsl`.
 */
import {
  Fn,
  If,
  dot,
  float,
  length,
  max,
  normalize,
  select,
  smoothstep,
  sqrt,
  vec2,
  type Node,
} from "three/tsl";

/** Ray vs sphere: returns vec2(tNear, tFar), or vec2(-1) on a miss. */
export const raySphere = Fn(([ro, rd, c, r]: [any, any, any, any]) => {
  const oc = ro.sub(c);
  const b = dot(oc, rd);
  const cc = dot(oc, oc).sub(r.mul(r));
  const h = b.mul(b).sub(cc);
  const res = vec2(-1, -1).toVar();
  If(h.greaterThan(0), () => {
    const s = sqrt(h);
    res.assign(vec2(b.negate().sub(s), b.negate().add(s)));
  });
  return res;
});

/**
 * Quilez sphere ambient occlusion contribution at point p with normal n from a
 * sphere (centre c, radius r).
 */
export const sphereOcclusion = Fn(([p, n, c, r]: [any, any, any, any]) => {
  const d = c.sub(p);
  const l = length(d);
  const nl = dot(n, d).div(l);
  const h = l.div(r);
  return max(nl, 0).div(h.mul(h));
});

/** Quilez analytic soft shadow of a sphere along direction rd from point ro. */
export const sphereSoftShadow = Fn(([ro, rd, c, r, k]: [any, any, any, any, any]) => {
  const oc = ro.sub(c);
  const b = dot(oc, rd);
  const cc = dot(oc, oc).sub(r.mul(r));
  const h = b.mul(b).sub(cc);
  const d = sqrt(max(float(0), r.mul(r).sub(h))).sub(r);
  const t = b.negate().sub(sqrt(max(h, 0)));
  return select(t.lessThan(0), float(1), smoothstep(0, 1, float(2.5).mul(k).mul(d).div(t)));
});

/**
 * 0..1 visibility of a world point from the camera with respect to an opaque
 * bounding sphere (used to hide wires / bolts / electrons behind the nucleus).
 */
export const sphereVisibility = Fn(([cam, p, c, r]: [any, any, any, any]) => {
  const dir = p.sub(cam);
  const dist = length(dir);
  const rd = normalize(dir);
  const hit = raySphere(cam, rd, c, r);
  const blocked = hit.x.greaterThan(0).and(hit.x.lessThan(dist.sub(0.5)));
  return select(blocked, float(0), float(1));
});

export type { Node };
