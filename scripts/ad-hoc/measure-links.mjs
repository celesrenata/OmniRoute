#!/usr/bin/env node
/**
 * OR-ATOM-010 — link-line luminance probe (iteration-d evidence).
 *
 * The aggregate "saturated pixel %" undercounts link brightness: a thin line
 * contributes little area. This measures what the eye reads instead:
 *  - atom cores: local brightness maxima in the scene region
 *  - link peak: max luminance in a band along each hub→atom axis
 *  - hub core peak
 *
 * Usage: node scripts/ad-hoc/measure-links.mjs <png> [hubX] [hubY]
 */
import sharp from "sharp";

const [file, hubXs = "800", hubYs = "475"] = process.argv.slice(2);
const hx = Number(hubXs);
const hy = Number(hubYs);
const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
const { width, height } = info;
const channels = info.channels;
const px = (x, y) => {
  const o = (y * width + x) * channels;
  return [data[o], data[o + 1], data[o + 2]];
};
const lum = (x, y) => {
  const [r, g, b] = px(x, y);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const chroma = (x, y) => {
  const [r, g, b] = px(x, y);
  return Math.max(r, g, b) - Math.min(r, g, b);
};

// --- detect atom cores: bright saturated clusters in the scene region ------
const candidates = [];
for (let y = 210; y < 790; y += 2) {
  for (let x = 350; x < 1150; x += 2) {
    const l = lum(x, y);
    if (l > 55 && chroma(x, y) > 18) candidates.push({ x, y, l });
  }
}
candidates.sort((a, b) => b.l - a.l);
const picked = [];
for (const c of candidates) {
  if (picked.every((p) => Math.hypot(p.x - c.x, p.y - c.y) > 80)) {
    if (Math.hypot(c.x - hx, c.y - hy) > 130) picked.push(c);
    if (picked.length >= 8) break;
  }
}

// --- link peak: max luminance in an 11px-tall band along the axis -----------
function bandMax(ax, ay) {
  let maxL = 0;
  let maxAt = null;
  for (let s = 0.12; s < 0.92; s += 0.004) {
    const cx = Math.round(hx + (ax - hx) * s);
    const cy = Math.round(hy + (ay - hy) * s);
    for (let dy = -5; dy <= 5; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const x2 = cx + dx;
        const y2 = cy + dy;
        if (x2 < 0 || y2 < 0 || x2 >= width || y2 >= height) continue;
        const l = lum(x2, y2);
        if (l > maxL) {
          maxL = l;
          maxAt = [x2, y2];
        }
      }
    }
  }
  return { maxL, maxAt };
}

console.log(`image ${width}x${height}  hub=(${hx},${hy})  atoms=${picked.length}`);
const hubCore = Math.max(
  lum(hx, hy),
  lum(hx - 4, hy),
  lum(hx + 4, hy),
  lum(hx, hy - 4),
  lum(hx, hy + 4)
);
console.log(`hub core lum=${hubCore.toFixed(1)}`);
for (const a of picked) {
  const { maxL, maxAt } = bandMax(a.x, a.y);
  const [r, g, b] = maxAt ? px(maxAt[0], maxAt[1]) : [0, 0, 0];
  console.log(
    `atom(~${a.x.toFixed(0)},${a.y.toFixed(0)}) coreLum=${a.l.toFixed(1)}  linkPeakLum=${maxL.toFixed(1)} @(${maxAt?.[0]},${maxAt?.[1]}) rgb(${r},${g},${b})`
  );
}
