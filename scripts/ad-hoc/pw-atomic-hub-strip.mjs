#!/usr/bin/env node
/** OR-ATOM-010 — montage the 4 saved hub-crop frames into one strip. */
import sharp from "sharp";
import { writeFileSync } from "node:fs";

const OUT = "OR_ATOM_010/screenshots";
// Re-crop the 4 frames already captured (hub_motion_0/3/6/9).
const crop = { left: 600, top: 330, width: 400, height: 340 };
const pick = [0, 3, 6, 9];
const files = await Promise.all(
  pick.map(async (i) => {
    const f = `${OUT}/hub_motion_${i}.png`;
    const buf = await sharp(f).extract(crop).resize(200).png().toBuffer();
    const tmp = `/tmp/hb_${i}.png`;
    writeFileSync(tmp, buf);
    return tmp;
  })
);
await sharp({
  create: { width: 200 * pick.length, height: 170, channels: 3, background: "#000" },
})
  .composite(files.map((f, k) => ({ input: f, left: k * 200, top: 0 })))
  .jpeg({ quality: 92 })
  .toFile(`${OUT}/hub_motion_strip.jpg`);
console.log("strip written", `${OUT}/hub_motion_strip.jpg`);
