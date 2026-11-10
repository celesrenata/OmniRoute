#!/usr/bin/env node
/**
 * Pixel diff for the profile phase: before vs after captures at identical camera.
 * For every <scene>.r1.png in both dirs it reports max / mean absolute channel difference,
 * the share of pixels differing by more than 2 and 8 levels (of 255), PSNR, and a global SSIM
 * over 8x8 luma windows. It also reports the same numbers for before.r1 vs before.r2 (the
 * determinism floor of the build itself), and writes side-by-side + amplified-diff PNGs.
 *
 *   node scripts/ad-hoc/atomic-perf-diff.mjs <beforeDir> <afterDir> <outDir>
 */
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const [beforeDir, afterDir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });

async function load(p) {
  const { data, info } = await sharp(p).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

function compare(a, b) {
  if (a.w !== b.w || a.h !== b.h) throw new Error("size mismatch");
  const n = a.w * a.h;
  let max = 0;
  let sum = 0;
  let sq = 0;
  let over2 = 0;
  let over8 = 0;
  for (let i = 0; i < n; i += 1) {
    let pm = 0;
    for (let c = 0; c < 3; c += 1) {
      const d = Math.abs(a.data[i * 3 + c] - b.data[i * 3 + c]);
      sum += d;
      sq += d * d;
      if (d > pm) pm = d;
    }
    if (pm > max) max = pm;
    if (pm > 2) over2 += 1;
    if (pm > 8) over8 += 1;
  }
  const mse = sq / (n * 3);
  // Global SSIM on luma, 8x8 non-overlapping windows.
  const L = (img, i) =>
    0.299 * img.data[i * 3] + 0.587 * img.data[i * 3 + 1] + 0.114 * img.data[i * 3 + 2];
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let ssimSum = 0;
  let wins = 0;
  for (let y = 0; y + 8 <= a.h; y += 8) {
    for (let x = 0; x + 8 <= a.w; x += 8) {
      let ma = 0;
      let mb = 0;
      for (let yy = 0; yy < 8; yy += 1)
        for (let xx = 0; xx < 8; xx += 1) {
          const i = (y + yy) * a.w + x + xx;
          ma += L(a, i);
          mb += L(b, i);
        }
      ma /= 64;
      mb /= 64;
      let va = 0;
      let vb = 0;
      let cov = 0;
      for (let yy = 0; yy < 8; yy += 1)
        for (let xx = 0; xx < 8; xx += 1) {
          const i = (y + yy) * a.w + x + xx;
          const da = L(a, i) - ma;
          const db = L(b, i) - mb;
          va += da * da;
          vb += db * db;
          cov += da * db;
        }
      va /= 63;
      vb /= 63;
      cov /= 63;
      ssimSum +=
        ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      wins += 1;
    }
  }
  return {
    maxAbs: max,
    meanAbs: +(sum / (n * 3)).toFixed(4),
    pctOver2: +((100 * over2) / n).toFixed(3),
    pctOver8: +((100 * over8) / n).toFixed(4),
    psnr: mse === 0 ? Infinity : +(10 * Math.log10((255 * 255) / mse)).toFixed(2),
    ssim: +(ssimSum / wins).toFixed(5),
  };
}

const rows = [];
for (const f of fs
  .readdirSync(beforeDir)
  .filter((x) => x.endsWith(".r1.png"))
  .sort()) {
  const scene = f.replace(".r1.png", "");
  const afterP = path.join(afterDir, f);
  if (!fs.existsSync(afterP)) continue;
  const b1 = await load(path.join(beforeDir, f));
  const b2p = path.join(beforeDir, `${scene}.r2.png`);
  const floor = fs.existsSync(b2p) ? compare(b1, await load(b2p)) : null;
  const a1 = await load(afterP);
  const res = compare(b1, a1);
  rows.push({ scene, beforeVsAfter: res, beforeR1vsR2: floor });
  // Side-by-side (before | after) and the diff amplified x16 (pure black = identical).
  const amp = Buffer.alloc(b1.data.length);
  for (let i = 0; i < amp.length; i += 1)
    amp[i] = Math.min(255, Math.abs(b1.data[i] - a1.data[i]) * 16);
  const raw = (d) =>
    sharp(d, { raw: { width: b1.w, height: b1.h, channels: 3 } })
      .png()
      .toBuffer();
  await sharp({
    create: { width: b1.w * 2 + 16, height: b1.h, channels: 3, background: "#ffffff" },
  })
    .composite([
      { input: await raw(b1.data), left: 0, top: 0 },
      { input: await raw(a1.data), left: b1.w + 16, top: 0 },
    ])
    .png()
    .toFile(path.join(outDir, `${scene}-before-after.png`));
  await sharp(amp, { raw: { width: b1.w, height: b1.h, channels: 3 } })
    .png()
    .toFile(path.join(outDir, `${scene}-diff-x16.png`));
  // Worst region: the CW x CH window (stride 40 px) with the largest summed abs difference,
  // cropped from before | after | diff x16 side by side (1:1 device pixels).
  const CW = Math.min(640, b1.w);
  const CH = Math.min(400, b1.h);
  let best = { x: 0, y: 0, v: -1 };
  // Column-strided integral over 8x8 cells keeps this fast on 3200x2000 captures.
  const cw = Math.ceil(b1.w / 8);
  const chh = Math.ceil(b1.h / 8);
  const cell = new Float64Array(cw * chh);
  for (let y = 0; y < b1.h; y += 1)
    for (let x = 0; x < b1.w; x += 1) {
      const i = (y * b1.w + x) * 3;
      cell[(y >> 3) * cw + (x >> 3)] +=
        Math.abs(b1.data[i] - a1.data[i]) +
        Math.abs(b1.data[i + 1] - a1.data[i + 1]) +
        Math.abs(b1.data[i + 2] - a1.data[i + 2]);
    }
  for (let cy = 0; cy + CH / 8 <= chh; cy += 5)
    for (let cx = 0; cx + CW / 8 <= cw; cx += 5) {
      let v = 0;
      for (let yy = cy; yy < cy + CH / 8; yy += 1)
        for (let xx = cx; xx < cx + CW / 8; xx += 1) v += cell[yy * cw + xx];
      if (v > best.v) best = { x: cx * 8, y: cy * 8, v };
    }
  const crop = (buf) =>
    sharp(buf, { raw: { width: b1.w, height: b1.h, channels: 3 } })
      .extract({ left: best.x, top: best.y, width: CW, height: CH })
      .png()
      .toBuffer();
  await sharp({ create: { width: CW * 3 + 32, height: CH, channels: 3, background: "#ffffff" } })
    .composite([
      { input: await crop(b1.data), left: 0, top: 0 },
      { input: await crop(a1.data), left: CW + 16, top: 0 },
      { input: await crop(amp), left: 2 * CW + 32, top: 0 },
    ])
    .png()
    .toFile(path.join(outDir, `${scene}-worst-crop.png`));
  rows[rows.length - 1].worstCrop = { x: best.x, y: best.y, w: CW, h: CH };
}
for (const r of rows) console.log(JSON.stringify(r));
fs.writeFileSync(path.join(outDir, "diff.json"), JSON.stringify(rows, null, 2));
