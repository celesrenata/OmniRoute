/**
 * Solid circuit-board surface (TSL) for the enclosed topology container
 * (operator directive 14): dense copper trace busses with flowing light
 * embers, vias and pads, ICs with pin rows, capacitors, inductors/coils,
 * transformers and connectors, in idea5's dark navy palette with cyan and warm
 * orange accents.
 *
 * Pure function of the surface coordinate (u, v in world units), the view
 * distance and a time uniform: no CPU work per frame. Embers are DECORATIVE
 * ambience (seeded, deterministic) and never encode telemetry. Magnetic /
 * high-voltage parts (inductors, transformers, large caps) get an extremely
 * faint static shimmer (a hint only; far below any link discharge).
 */
import {
  Fn,
  abs,
  exp,
  float,
  floor,
  fract,
  length,
  max,
  mix,
  sin,
  smoothstep,
  step,
  vec2,
  vec3,
} from "three/tsl";

const h21 = (p: any) => fract(sin(p.dot(vec2(127.1, 311.7))).mul(43758.5453));

/** Distance (signed) to an axis-aligned box of half size `hs` centred at the origin. */
const sdBox = (q: any, hs: any) => {
  const d = abs(q).sub(hs);
  return max(d.x, d.y)
    .min(0)
    .add(length(max(d, vec2(0, 0))));
};

/**
 * @param u,v     surface coordinates (world units / pattern scale)
 * @param dist    view distance (blur / LOD)
 * @param tm      time (seconds; 0 under reduced motion -> embers and static off)
 * @param seed    per-face seed so faces do not tile identically
 * @param life    1 = animated embers/static, 0 = static board (reduced motion)
 */
export const pcbBoard = Fn(([u, v, dist, tm, seed, life]: [any, any, any, any, any, any]) => {
  const blur = float(1).add(dist.mul(0.0035));
  const p = vec2(u, v);
  const col = vec3(0.012, 0.026, 0.062).toVar();

  // --- substrate: soldermask sheen + faint copper hatch -------------------------
  const sheen = h21(floor(p.div(7)).add(seed)).mul(0.012);
  col.addAssign(vec3(0.01, 0.025, 0.05).mul(sheen.mul(20)));

  // --- trace busses ---------------------------------------------------------------
  // Orientation per 256-block, lanes per 64-cell: parallel busses of 4 lanes.
  const blk = floor(p.div(256));
  const orient = step(0.5, h21(blk.add(seed.mul(3.1))));
  const cell = floor(p.div(64));
  const cf = fract(p.div(64)).mul(64);
  const across = mix(cf.x, cf.y, orient);
  const alongAbs = mix(p.y, p.x, orient);
  const lane = floor(across.div(10));
  const laneH = h21(vec2(lane, cell.x.mul(7.3).add(cell.y).add(seed)));
  const dLane = abs(fract(across.div(10)).sub(0.5)).mul(10);
  const on = step(0.3, laneH);
  const trace = on.mul(exp(dLane.negate().div(blur.mul(1.1))));
  const glowT = on.mul(exp(dLane.negate().div(blur.mul(4.5)))).mul(0.05);
  const accent = step(0.9, h21(vec2(lane.add(blk.x.mul(5.1)), blk.y.add(seed))));
  const traceCol = mix(vec3(0.05, 0.5, 0.78), vec3(1.0, 0.46, 0.12), accent);
  col.addAssign(traceCol.mul(trace.mul(0.42).add(glowT)));

  // Embers: light packets flowing along each lane (varied speed / direction / density).
  const period = float(70).add(laneH.mul(90));
  const spd = float(0.25)
    .add(laneH.mul(0.9))
    .mul(
      step(0.5, h21(vec2(lane, blk.x.add(blk.y))))
        .mul(2)
        .sub(1)
    );
  const q = fract(alongAbs.div(period).sub(tm.mul(spd).mul(life)).add(laneH.mul(9)));
  const ember = exp(q.mul(-26)).mul(smoothstep(0.0, 0.012, q));
  const emberOn = step(0.5, h21(vec2(lane.add(3.3), cell.x.add(cell.y.mul(1.7)))));
  col.addAssign(
    mix(vec3(0.35, 0.95, 1.0), vec3(1.0, 0.6, 0.22), accent)
      .mul(ember.mul(trace).mul(emberOn).mul(3.0))
      .mul(float(0.35).add(life.mul(0.65)))
  );

  // --- vias / pads at cell centres ------------------------------------------------
  const pc = cf.sub(32);
  const padH = h21(cell.add(seed.mul(1.7)));
  const pr = length(pc);
  const pad = step(0.72, padH).mul(smoothstep(6.5, 5.0, pr.div(blur.mul(0.7).add(0.3))));
  const hole = smoothstep(2.4, 1.6, pr);
  col.addAssign(vec3(0.5, 0.38, 0.18).mul(pad.mul(0.55)).mul(float(1).sub(hole)));
  col.addAssign(vec3(0.0, 0.0, 0.0).mul(hole));

  // --- components on a 192 grid ---------------------------------------------------
  const cc = floor(p.div(192));
  const cq = fract(p.div(192)).mul(192).sub(96);
  const ch = h21(cc.add(seed.mul(2.3)));
  const ct = h21(cc.add(19.7).add(seed));
  const present = step(0.42, ch);
  // 0 IC, 1 capacitor, 2 inductor, 3 transformer, 4 connector
  const isIC = step(ct, 0.38);
  const isCap = step(0.38, ct).mul(step(ct, 0.55));
  const isInd = step(0.55, ct).mul(step(ct, 0.72));
  const isTr = step(0.72, ct).mul(step(ct, 0.84));
  const isCon = step(0.84, ct);
  // Bodies
  const dIC = sdBox(cq, vec2(46, 34));
  const dCon = sdBox(cq, vec2(80, 12));
  const dTr = sdBox(cq, vec2(44, 32));
  const dCap = length(cq).sub(22);
  const dInd = length(cq).sub(34);
  const body = float(0).toVar();
  body.addAssign(isIC.mul(smoothstep(1.2, -1.2, dIC)));
  body.addAssign(isCon.mul(smoothstep(1.2, -1.2, dCon)));
  body.addAssign(isTr.mul(smoothstep(1.2, -1.2, dTr)));
  body.addAssign(isCap.mul(smoothstep(1.2, -1.2, dCap)));
  body.addAssign(isInd.mul(smoothstep(1.2, -1.2, dInd)));
  const bodyM = body.mul(present).clamp(0, 1);
  const bodyCol = mix(vec3(0.016, 0.022, 0.045), vec3(0.035, 0.045, 0.08), h21(cc.add(4.4)));
  col.assign(mix(col, bodyCol, bodyM));
  // Edge bevel highlight.
  const dAny = isIC
    .mul(dIC)
    .add(isCon.mul(dCon))
    .add(isTr.mul(dTr))
    .add(isCap.mul(dCap))
    .add(isInd.mul(dInd));
  const edge = exp(abs(dAny).negate().div(blur.mul(1.3))).mul(present);
  col.addAssign(vec3(0.08, 0.45, 0.7).mul(edge.mul(0.55)));
  // IC pins: light dashes along the long sides + pin-1 notch + marking glow.
  const pinPitch = float(10);
  const pinF = abs(fract(cq.x.div(pinPitch)).sub(0.5)).mul(pinPitch);
  const pinBand = step(abs(abs(cq.y).sub(38)), 4.5).mul(step(abs(cq.x), 44));
  const pin = isIC
    .mul(pinBand)
    .mul(smoothstep(2.6, 1.6, pinF))
    .mul(present);
  col.addAssign(vec3(0.55, 0.42, 0.2).mul(pin).mul(0.7));
  const mark = isIC
    .mul(step(abs(cq.y.add(6)), 1.4))
    .mul(step(abs(cq.x), 24))
    .mul(step(0.5, fract(cq.x.mul(0.11).add(ch.mul(8)))))
    .mul(present);
  col.addAssign(vec3(0.2, 0.7, 0.95).mul(mark).mul(0.35));
  // Connector pins.
  const conPin = isCon
    .mul(step(abs(cq.y), 6))
    .mul(smoothstep(2.4, 1.4, abs(fract(cq.x.div(8)).sub(0.5)).mul(8)))
    .mul(step(abs(cq.x), 74))
    .mul(present);
  col.addAssign(vec3(0.9, 0.7, 0.3).mul(conPin).mul(0.5));
  // Capacitor: concentric ring + polarity stripe.
  const capRing = isCap.mul(exp(abs(dCap.add(8)).negate().div(blur.mul(1.2)))).mul(present);
  col.addAssign(vec3(0.7, 0.55, 0.25).mul(capRing).mul(0.35));
  // Inductor: spiral coil rings.
  const coil = isInd
    .mul(smoothstep(1.0, -1.0, dInd.add(3)))
    .mul(exp(abs(fract(length(cq).div(5.5)).sub(0.5)).mul(-14)))
    .mul(present);
  col.addAssign(vec3(0.9, 0.5, 0.18).mul(coil).mul(0.45));
  // Transformer: two winding discs.
  const w1 = length(cq.sub(vec2(-18, 0))).sub(16);
  const w2 = length(cq.sub(vec2(18, 0))).sub(16);
  const wind = isTr
    .mul(
      exp(abs(fract(length(cq.sub(vec2(-18, 0))).div(4.5)).sub(0.5)).mul(-12))
        .mul(smoothstep(1.0, -1.0, w1))
        .add(
          exp(abs(fract(length(cq.sub(vec2(18, 0))).div(4.5)).sub(0.5)).mul(-12)).mul(
            smoothstep(1.0, -1.0, w2)
          )
        )
    )
    .mul(present);
  col.addAssign(vec3(0.2, 0.65, 0.95).mul(wind).mul(0.4));

  // --- magnetic / high-voltage static: a faint hint (never an event effect) -------
  const hv = present.mul(
    isInd
      .add(isTr)
      .add(isCap.mul(step(0.5, ch.mul(2).fract())))
      .clamp(0, 1)
  );
  const halo = exp(max(dAny, float(0)).negate().div(blur.mul(14)));
  const stat = h21(
    floor(p.mul(0.45))
      .add(floor(tm.mul(11)).mul(life))
      .add(seed)
  );
  const flick = step(0.82, stat).mul(float(0.5).add(sin(tm.mul(37).add(ch.mul(40))).mul(0.5)));
  col.addAssign(
    vec3(0.45, 0.7, 1.0)
      .mul(hv)
      .mul(halo)
      .mul(flick)
      .mul(0.045)
      .mul(float(0.3).add(life.mul(0.7)))
  );
  // Soft, distance-faded fine detail so the far field stays solid, not noisy.
  return col.mul(float(0.55).add(float(0.45).div(blur)));
});
