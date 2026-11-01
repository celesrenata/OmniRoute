#!/usr/bin/env node
/**
 * OR-ATOM-010 — link / scene pixel measurement (iteration-d evidence).
 *
 * Measures luminance + saturated-color coverage in the scene canvas region of
 * the atomic-bench screenshots. The scene occupies the full 1600×1000 host
 * element minus the side/telemetry panels: the scene canvas is roughly the
 * center block x∈[300,1150], y∈[180,760] (the 3D viewport between the left
 * panel and the right telemetry panel, below the header). We report:
 *
 *  - mean luminance of the whole frame and of the scene region
 *  - max luminance in the scene region (filament/atom peaks)
 *  - saturated (chroma) pixel count + mean chroma in the scene region — the
 *    "electric" content that should grow when links read as neon
 *  - a 1-D brightness profile sampled along a horizontal strip through the
 *    middle of the scene (y=420) to show whether the filaments form
 *    high-contrast thin spikes vs a broad wash
 *
 * Usage: node scripts/ad-hoc/measure-pixels.mjs <png> [...]
 */
import sharp from "sharp";

async function analyze(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const channels = info.channels;
  const px = (x, y) => {
    const o = (y * width + x) * channels;
    return [data[o], data[o + 1], data[o + 2]];
  };
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const chroma = (r, g, b) => {
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    return mx - mn;
  };

  // Scene region: between the left panel (~x=290) and the right telemetry
  // panel (~x=1150), vertically between the header (~y=175) and the bottom
  // panel (~y=770).
  const sx0 = Math.round(width * 0.19);
  const sx1 = Math.round(width * 0.72);
  const sy0 = Math.round(height * 0.18);
  const sy1 = Math.round(height * 0.77);

  let sceneLumSum = 0,
    sceneCount = 0,
    sceneMax = 0;
  let satCount = 0,
    satLumSum = 0,
    satChromaSum = 0;
  for (let y = sy0; y < sy1; y += 2) {
    for (let x = sx0; x < sx1; x += 2) {
      const [r, g, b] = px(x, y);
      const l = lum(r, g, b);
      sceneLumSum += l;
      sceneCount += 1;
      if (l > sceneMax) sceneMax = l;
      const c = chroma(r, g, b);
      if (c > 30 && l > 40) {
        satCount += 1;
        satLumSum += l;
        satChromaSum += c;
      }
    }
  }

  // 1-D brightness profile along a horizontal strip through the scene middle.
  const yStrip = Math.round((sy0 + sy1) / 2);
  const profile = [];
  for (let x = sx0; x < sx1; x += 4) {
    const [r, g, b] = px(x, yStrip);
    profile.push(lum(r, g, b));
  }
  const profileMax = Math.max(...profile);
  const profileMin = Math.min(...profile);
  const brightSamples = profile.filter((v) => v > 80).length;

  // Whole-frame mean luminance (quick check that we're on a dark bg).
  let frameLumSum = 0,
    frameCount = 0;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const [r, g, b] = px(x, y);
      frameLumSum += lum(r, g, b);
      frameCount += 1;
    }
  }

  const mean = (s, c) => (c ? s / c : 0);
  const r2 = (v) => v.toFixed(2);
  console.log(`\n== ${file} ==`);
  console.log(`  frame ${width}x${height}  meanLum=${r2(mean(frameLumSum, frameCount))}`);
  console.log(`  scene region [${sx0},${sy0}]-[${sx1},${sy1}]`);
  console.log(`  scene meanLum=${r2(mean(sceneLumSum, sceneCount))}  maxLum=${r2(sceneMax)}`);
  console.log(
    `  saturated pixels (chroma>30,lum>40): ${satCount} (${r2(
      (100 * satCount) / sceneCount
    )}% of scene)  meanLum=${r2(mean(satLumSum, satCount))}  meanChroma=${r2(
      mean(satChromaSum, satCount)
    )}`
  );
  console.log(
    `  strip y=${yStrip}: min=${r2(profileMin)} max=${r2(profileMax)} bright(>80) samples=${brightSamples}/${profile.length}`
  );
  // Show the top spikes in the strip (where filaments sit) so we can see
  // whether they're thin high peaks or broad washes.
  const sorted = profile
    .map((v, i) => [v, sx0 + i * 4])
    .sort((a, b) => b[0] - a[0])
    .slice(0, 12);
  console.log(`  top strip spikes: ${sorted.map(([v, x]) => `x${x}:${v.toFixed(0)}`).join(" ")}`);
}

for (const file of process.argv.slice(2)) {
  try {
    await analyze(file);
  } catch (err) {
    console.error(`FAIL ${file}: ${err.message}`);
  }
}
