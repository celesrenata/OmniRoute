#!/usr/bin/env node
/**
 * OR-ATOM-010 — bloom blow-out meter (iteration-e evidence).
 *
 * `measure-pixels.mjs` reports mean luminance, which cannot distinguish a
 * healthy cinematic glow from a washed-out frame. This meter adds the
 * distribution metrics that matter for a bloom pass:
 *
 *   - share of scene-region pixels at luminance > 200 / 230 / 250 / ≥ 255
 *     (a proper bloom is a small halo — large shares of near-white mean the
 *     whole frame is blooming)
 *   - saturated-color coverage (the "electric" content)
 *
 * Usage: node scripts/ad-hoc/measure-bloom.mjs <png> [...]
 */
import sharp from "sharp";

async function analyze(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const ch = info.channels;
  const sx0 = Math.round(width * 0.19);
  const sx1 = Math.round(width * 0.72);
  const sy0 = 180;
  const sy1 = 770;
  let sum = 0;
  let n = 0;
  let g200 = 0;
  let g230 = 0;
  let g250 = 0;
  let g255 = 0;
  let mx = 0;
  let sat = 0;
  for (let y = sy0; y < sy1; y++) {
    for (let x = sx0; x < sx1; x++) {
      const o = (y * width + x) * ch;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += L;
      n++;
      if (L > mx) mx = L;
      if (L > 200) g200++;
      if (L > 230) g230++;
      if (L > 250) g250++;
      if (L >= 254) g255++;
      const c = Math.max(r, g, b) - Math.min(r, g, b);
      if (c > 30 && L > 40) sat++;
    }
  }
  const pct = (k) => ((100 * k) / n).toFixed(2) + "%";
  console.log(
    `${file.split("/").pop()}: mean=${(sum / n).toFixed(1)} max=${mx} ` +
      `>200=${pct(g200)} >230=${pct(g230)} >250=${pct(g250)} ≥255=${pct(g255)} sat=${pct(sat)}`
  );
}

const files = process.argv.slice(2);
for (const f of files) await analyze(f);
