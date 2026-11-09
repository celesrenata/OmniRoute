/**
 * Circuit-board surface (TSL) for the enclosed topology container (operator
 * directives 14 + 23): FINE, CRISP, analytically anti-aliased PCB artwork whose
 * feature sizes are scaled to the atoms (a trace is ~1.4 units wide next to a
 * ~100 unit atom): 0/45/90/135 degree routed trace buses on a navy soldermask,
 * exposed copper pads and vias with drill holes, a ground-pour hatch, silkscreen
 * outlines and reference ticks. The 3D components (chokes, resistors, cans,
 * ICs, ...) are real instanced geometry in `boardParts.ts`; this shader only
 * paints the board beneath them.
 *
 * Every line is a signed-distance edge widened by the screen-space pixel
 * footprint (`fwidth`) so it stays crisp at any zoom and fades smoothly to its
 * average colour once it is sub-pixel (no moire, no streaks). Light "embers"
 * flow along the traces (decorative, seeded, static when `life` is 0). Nothing
 * here encodes telemetry.
 */
import {
  Fn,
  abs,
  clamp,
  exp,
  float,
  floor,
  fract,
  fwidth,
  length,
  max,
  min,
  mix,
  pow,
  sin,
  smoothstep,
  step,
  vec2,
  vec3,
} from "three/tsl";

const h21 = (p: any) => fract(sin(p.dot(vec2(127.1, 311.7))).mul(43758.5453));

/** Coverage of a line of half-width `hw` at signed distance `d`, widened by pixel footprint `pw`. */
const aaLine = (d: any, hw: any, pw: any) => {
  // Full coverage inside the line, linear edge across one pixel; a sub-pixel
  // line keeps only its area (hw*2/pw) so it dims instead of aliasing.
  const edge = smoothstep(hw.add(pw.mul(0.75)), hw.sub(pw.mul(0.75)).max(0), d);
  const area = clamp(hw.mul(2).div(pw.max(1e-5)), 0, 1);
  return edge.mul(mix(area, float(1), smoothstep(0.0, 1.0, hw.div(pw.max(1e-5)).sub(0.5))));
};

/**
 * @param u,v     surface coordinates (world units / pattern scale)
 * @param dist    view distance (only used for the coarse fog; detail is AA'd by fwidth)
 * @param tm      time (seconds; ignored when `life` is 0)
 * @param seed    per-face seed so faces do not tile identically
 * @param life    1 = animated embers, 0 = static board (reduced motion)
 * @param detail  1 = full artwork (floor), <1 = calmer walls / ceiling
 */
export const pcbBoard = Fn(
  ([u, v, dist, tm, seed, life, detail]: [any, any, any, any, any, any, any]) => {
    const p = vec2(u, v);
    const pw = max(fwidth(u), fwidth(v)).mul(1.0).add(1e-4);
    const col = vec3(0.014, 0.03, 0.07).toVar();

    // --- soldermask sheen: very low frequency, gives the surface a satin gradient ----
    const sheen = h21(floor(p.div(96)).add(seed))
      .mul(0.5)
      .add(h21(floor(p.div(23)).add(seed.mul(1.9))).mul(0.5));
    col.addAssign(vec3(0.006, 0.014, 0.03).mul(sheen));

    // --- 96-unit routing cells: one bus orientation per cell ----------------------
    const CELL = 96;
    const cell = floor(p.div(CELL));
    const cf = fract(p.div(CELL)).mul(CELL);
    const ch = h21(cell.add(seed.mul(3.1)));
    const mode = floor(ch.mul(6)); // 0 horiz, 1 vert, 2 diag45, 3 diag135, 4 ground pour, 5 via field
    const isMode = (k: number) => step(0.5, float(1).sub(abs(mode.sub(k)).min(1)));
    const isH = isMode(0);
    const isV = isMode(1);
    const isD1 = isMode(2);
    const isD2 = isMode(3);
    const isBus = isH.add(isV).add(isD1).add(isD2);
    // Across / along coordinates in the bus frame (45 degree buses rotate the frame).
    const r45 = vec2(cf.x.add(cf.y), cf.y.sub(cf.x)).mul(0.70710678);
    const across = isH.mul(cf.y).add(isV.mul(cf.x)).add(isD1.mul(r45.y)).add(isD2.mul(r45.x));
    const along = isH.mul(cf.x).add(isV.mul(cf.y)).add(isD1.mul(r45.x)).add(isD2.mul(r45.y));
    // Four parallel lanes, 3.4 pitch, centred (with a seeded offset) in the cell.
    const off = h21(cell.add(9.1)).sub(0.5).mul(40);
    const centre = isH
      .add(isV)
      .mul(CELL / 2)
      .add(isD2.mul(CELL * 0.70710678))
      .add(off);
    const laneF = across.sub(centre).add(float(2 * 3.4));
    const lane = floor(laneF.div(3.4));
    const laneC = fract(laneF.div(3.4)).sub(0.5).mul(3.4); // signed across-lane distance
    const laneD = abs(laneC);
    const inBand = step(0.0, lane).mul(step(lane, float(3)));
    const laneH = h21(vec2(lane, cell.x.mul(7.3).add(cell.y.mul(3.7)).add(seed)));
    // The floor (detail 1) gets real routed nets as geometry (`boardTraces.ts`, directive 37),
    // so these painted per-cell lane stubs ("loose rods") only remain on the walls / ceiling.
    const lanes = float(1).sub(step(0.99, detail));
    const laneOn = inBand.mul(step(0.12, laneH)).mul(isBus).mul(lanes);
    // Lane kinds: metallic copper (PBR-ish bevel + specular), glowing neon cyan, glowing neon orange.
    const kindH = h21(vec2(lane.add(cell.x.mul(5.1)), cell.y.add(seed)));
    const isNeonO = step(0.86, kindH);
    const isNeonC = step(0.55, kindH).mul(float(1).sub(isNeonO));
    const isCu = float(1).sub(isNeonO).sub(isNeonC);
    const hw = float(1.15);
    const traceCov = aaLine(laneD, hw, pw).mul(laneOn).mul(detail);
    // Copper: raised bevelled trace, light from the upper-left -> bright lit edge,
    // dark far edge, narrow specular streak, warm copper albedo.
    const bevel = clamp(laneC.div(hw), -1, 1);
    const lit = smoothstep(0.1, 0.95, bevel.negate()).mul(0.9).add(0.25);
    const spec = exp(pow(bevel.add(0.55).mul(5.2), 2).negate()).mul(1.3);
    const copper = vec3(0.95, 0.5, 0.22)
      .mul(lit.mul(0.62).add(0.12))
      .add(vec3(1.0, 0.82, 0.6).mul(spec).mul(0.65));
    // Neon channels: bright core + soft halo (HDR, feeds bloom).
    const neonCore = aaLine(laneD, float(0.42), pw);
    const neonHalo = aaLine(laneD, float(2.2), pw).mul(0.5);
    const neonC = vec3(0.1, 0.85, 1.0).mul(neonCore.mul(1.7).add(neonHalo));
    const neonO = vec3(1.0, 0.5, 0.12).mul(neonCore.mul(1.7).add(neonHalo));
    const traceRgb = copper.mul(isCu).add(neonC.mul(isNeonC)).add(neonO.mul(isNeonO));
    col.assign(mix(col, traceRgb, traceCov.mul(isCu).mul(0.95)));
    col.addAssign(neonC.mul(isNeonC).add(neonO.mul(isNeonO)).mul(laneOn).mul(detail));
    // Faint raised-edge sheen on the mask beside every trace.
    const rim = aaLine(laneD.sub(1.25).abs(), float(0.16), pw).mul(laneOn).mul(0.4).mul(detail);
    col.addAssign(vec3(0.15, 0.55, 0.75).mul(rim).mul(0.4));
    const accent = isNeonO;

    // Pulses: bright HDR packets with trails racing along the traces at varied speeds,
    // fastest on the neon channels (decorative; static when life = 0).
    const period = float(30).add(laneH.mul(52));
    const dirS = step(0.5, h21(vec2(lane.add(2.2), cell.x.add(cell.y))))
      .mul(2)
      .sub(1);
    const spd = float(26).add(laneH.mul(70)).mul(dirS);
    const q = fract(along.div(period).sub(tm.mul(spd).div(period).mul(life)).add(laneH.mul(9)));
    const head = exp(q.mul(-9.0)).mul(smoothstep(0.0, 0.012, q));
    const emberOn = step(0.18, h21(vec2(lane.add(3.3), cell.x.add(cell.y.mul(1.7)))));
    const pulseCol = mix(vec3(0.35, 1.0, 1.0), vec3(1.0, 0.68, 0.25), accent).mul(
      isCu.mul(0.0).add(1.0)
    );
    const pulseCov = aaLine(laneD, float(1.15), pw).mul(laneOn).mul(detail);
    col.addAssign(
      pulseCol.mul(head.mul(pulseCov).mul(emberOn).mul(3.4)).mul(float(0.3).add(life.mul(0.7)))
    );

    // --- ground pour hatch (45 degrees, 2.6 pitch) in pour cells ----------------------
    const isPour = isMode(4);
    const hatch = aaLine(abs(fract(r45.x.div(2.6)).sub(0.5)).mul(2.6), float(0.22), pw)
      .mul(isPour)
      .mul(detail);
    col.addAssign(vec3(0.03, 0.12, 0.2).mul(hatch).mul(0.55));

    // --- vias + pads on a 12-unit lattice (gold ring, drilled hole) -------------------
    const VG = 12;
    const vcell = floor(p.div(VG));
    const vc = fract(p.div(VG))
      .mul(VG)
      .sub(VG / 2);
    const vh = h21(vcell.add(seed.mul(2.7)));
    const viaOn = step(0.9, vh).add(
      step(0.5, vh)
        .mul(step(vh, 0.58))
        .mul(isPour.add(isMode(5)))
    );
    const vr = length(vc);
    const padCov = aaLine(vr.sub(1.9), float(1.0), pw).mul(viaOn.min(1));
    const holeCov = aaLine(vr, float(0.55), pw).mul(viaOn.min(1));
    col.assign(mix(col, vec3(0.5, 0.36, 0.14).mul(0.9), padCov.mul(0.85)));
    col.assign(mix(col, vec3(0.004, 0.006, 0.012), holeCov));

    // --- silkscreen: component outline boxes + dashed rules + ticks -------------------
    const sc = floor(p.div(96));
    const sf = fract(p.div(96)).mul(96);
    const sh = h21(sc.add(seed.mul(5.3)));
    const boxOn = step(0.7, sh);
    const bc = vec2(h21(sc.add(1.1)).mul(40).add(14), h21(sc.add(2.2)).mul(40).add(14));
    const bs = vec2(h21(sc.add(3.3)).mul(18).add(8), h21(sc.add(4.4)).mul(14).add(6));
    const bd = abs(sf.sub(bc)).sub(bs);
    const sdBox = max(bd.x, bd.y);
    const outline = aaLine(abs(sdBox), float(0.28), pw).mul(boxOn).mul(detail);
    const tick = aaLine(abs(fract(sf.x.div(3.2)).sub(0.5)).mul(3.2), float(0.25), pw)
      .mul(step(abs(sf.y.sub(bc.y.sub(bs.y).sub(3))), 1.0))
      .mul(boxOn)
      .mul(step(abs(sf.x.sub(bc.x)), bs.x));
    col.addAssign(
      vec3(0.5, 0.62, 0.75)
        .mul(outline.add(tick.mul(0.8)))
        .mul(0.16)
    );

    // Crisp detail fades to its mean colour with distance (and sub-pixel size) via aaLine's
    // area term; the extra gentle atmospheric falloff keeps the far wall calm.
    return col.mul(exp(dist.mul(-0.00012)).mul(0.5).add(0.5));
  }
);

/**
 * Lit server / board panel for the walls and ceiling (operator directive 27):
 * a grid of rack-unit panels with glowing orange and cyan bezels, lit "screens"
 * with scanlines, blinking LED rows and (when `inner` > 0) a calmer PCB layer
 * inside every panel. The ceiling (`strips` = 1) adds long emissive light bars
 * whose floor reflection streaks to the horizon (idea5).
 *
 * @param blur  extra edge softness in pattern units (floor reflections use it to
 *              roughen the mirrored panels with distance)
 */
export const pcbPanel = Fn(
  ([u, v, dist, tm, seed, life, strips, blur]: [any, any, any, any, any, any, any, any]) => {
    const p = vec2(u, v);
    const pw = max(fwidth(u), fwidth(v)).add(1e-4).add(blur);
    const PW = 150;
    const PH = 96;
    const cell = floor(vec2(p.x.div(PW), p.y.div(PH)));
    const f = vec2(fract(p.x.div(PW)).mul(PW), fract(p.y.div(PH)).mul(PH));
    const ch = h21(cell.add(seed.mul(1.7)));
    const ch2 = h21(cell.add(seed.mul(3.1)).add(7.7));
    const edge = min(min(f.x, float(PW).sub(f.x)), min(f.y, float(PH).sub(f.y)));
    const warm = step(0.5, ch2);
    const bezelCol = mix(vec3(0.1, 0.78, 1.0), vec3(1.0, 0.5, 0.14), warm);
    const col = vec3(0.012, 0.024, 0.055).toVar();
    // Panel body: deep navy gradient lighter toward the bezel.
    col.addAssign(vec3(0.015, 0.035, 0.08).mul(smoothstep(8.0, 0.0, edge)));
    // Bezel: bright thin neon frame + soft halo.
    const frame = aaLine(edge.sub(2.4), float(0.3), pw);
    const halo = aaLine(edge.sub(2.4), float(3.0), pw).mul(0.05);
    col.addAssign(bezelCol.mul(frame.mul(0.55).add(halo)));
    // Lit "screen" panels: scanlines + gradient glow.
    const screenOn = step(0.58, ch);
    const inside = smoothstep(6.0, 7.5, edge);
    const scan = fract(f.y.mul(0.9)).mul(2).sub(1).abs();
    const scanL = smoothstep(0.2, 0.9, scan).mul(0.5).add(0.5);
    const grad = f.y.div(PH).mul(0.7).add(0.3);
    col.addAssign(
      mix(vec3(0.05, 0.4, 0.62), vec3(0.62, 0.2, 0.7), ch2).mul(
        screenOn.mul(inside).mul(scanL).mul(grad).mul(0.42)
      )
    );
    const pcbOn = float(1).sub(screenOn);
    // LED rows: 3 rows of tiny blinking lamps.
    const ledPitch = 5.0;
    const lc = vec2(fract(f.x.div(ledPitch)).sub(0.5).mul(ledPitch), f.y.sub(PH - 9.0));
    const ledCell = floor(f.x.div(ledPitch));
    const ledH = h21(vec2(ledCell, ch.mul(31).add(seed)));
    const blink = sin(tm.mul(ledH.mul(2.5).add(0.6)).add(ledH.mul(40)))
      .mul(0.5)
      .add(0.5)
      .mul(life)
      .add(float(1).sub(life).mul(0.7));
    const ledOn = step(0.45, ledH)
      .mul(step(10.0, f.x))
      .mul(step(f.x, float(PW - 10)));
    const led = aaLine(length(lc), float(0.9), pw).mul(ledOn).mul(blink);
    const ledCol = mix(
      vec3(0.2, 1.0, 0.5),
      mix(vec3(1.0, 0.55, 0.15), vec3(0.2, 0.8, 1.0), step(0.5, fract(ledH.mul(7)))),
      step(0.3, fract(ledH.mul(3)))
    );
    col.addAssign(ledCol.mul(led).mul(1.0).mul(pcbOn.mul(0.6).add(0.4)));
    // Ceiling light bars: long emissive strips (orange / cyan), dashed along their length.
    const barPitch = 54.0;
    const barC = fract(p.x.div(barPitch)).sub(0.5).mul(barPitch);
    const barIdx = floor(p.x.div(barPitch));
    const barCol = mix(
      vec3(1.0, 0.48, 0.1),
      vec3(0.1, 0.8, 1.0),
      step(0.5, h21(vec2(barIdx, seed)))
    );
    const dash = smoothstep(
      0.0,
      0.08,
      fract(p.y.div(210).add(h21(vec2(barIdx, 3.0)))).sub(0.12)
    ).mul(smoothstep(0.0, 0.08, float(0.9).sub(fract(p.y.div(210).add(h21(vec2(barIdx, 3.0)))))));
    const bar = aaLine(barC.abs(), float(2.0), pw).mul(dash);
    col.addAssign(barCol.mul(bar.mul(2.6)).mul(strips));
    col.addAssign(barCol.mul(aaLine(barC.abs(), float(9.0), pw).mul(dash).mul(0.18)).mul(strips));
    return col.mul(exp(dist.mul(-0.00012)).mul(0.5).add(0.5));
  }
);
