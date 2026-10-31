#!/usr/bin/env node
/**
 * OR-ATOM-010 — line-body luminance probe.
 *
 * The band MAX probe catches packet sprites (lum 255), which is not the line
 * body itself. This measures the line body directly: the 90th percentile of
 * luminance across the hub→atom axis band (excluding the top 2% which are
 * sprites/halos), reported per link.
 *
 * Usage: node scripts/ad-hoc/measure-linebody.mjs <png> [hubX] [hubY]
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

// atom detection (same as measure-links.mjs)
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

function lineBody(ax, ay) {
  const vals = [];
  for (let s = 0.15; s < 0.85; s += 0.004) {
    const cx = Math.round(hx + (ax - hx) * s);
    const cy = Math.round(hy + (ay - hy) * s);
    let mx = 0;
    for (let dy = -5; dy <= 5; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const l = lum(cx + dx, cy + dy);
        if (l > mx) mx = l;
      }
    }
    vals.push(mx);
  }
  vals.sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)];
  const p90v = vals[Math.floor(vals.length * 0.9)];
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { median, p90: p90v, mean };
}

console.log(`image ${width}x${height} hub=(${hx},${hy}) atoms=${picked.length}`);
let worst = Infinity;
for (const a of picked) {
  const { median, p90, mean } = lineBody(a.x, a.y);
  worst = Math.min(worst, p90);
  console.log(
    `atom(~${a.x.toFixed(0)},${a.y.toFixed(0)}) lineBody p50=${median.toFixed(1)} p90=${p90.toFixed(1)} mean=${mean.toFixed(1)}`
  );
}
console.log(`worst-link p90 = ${worst.toFixed(1)}`);
