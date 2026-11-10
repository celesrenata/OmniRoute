#!/usr/bin/env node
/** Triangle / instance inventory per mesh (bench handle). */
import { chromium } from "playwright";
const BASE = process.env.BENCH_BASE ?? "http://localhost:20199";
const query = process.argv[2] ?? "atoms=20&paused=0";
const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--window-size=1700,1100",
  ],
});
const page = await (
  await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
).newPage();
await page.goto(`${BASE}/dev/atomic-bench?${query}`);
await page.waitForSelector('[data-ready="true"]', { timeout: 120000 });
await page.waitForTimeout(3000);
const r = await page.evaluate(() => {
  const d = window.__atomicGpuDbg;
  const out = [];
  const add = (o) =>
    o.traverse((m) => {
      if (!m.isMesh) return;
      const g = m.geometry;
      const idx = g.index ? g.index.count : g.attributes.position.count;
      const inst = m.isInstancedMesh ? m.count : 1;
      out.push({
        name: m.name || m.type,
        instances: inst,
        trisPerInst: Math.round(idx / 3),
        tris: Math.round((idx / 3) * inst),
        vis: m.visible,
        order: m.renderOrder,
      });
    });
  d.env.objects.forEach(add);
  add(d.atoms.group);
  const t = d.gl.info.render;
  return {
    out: out.sort((a, b) => b.tris - a.tris),
    total: out.reduce((s, x) => s + x.tris, 0),
    infoTris: t.triangles,
    calls: t.calls,
    frame: t.frame,
  };
});
console.log(JSON.stringify(r, null, 0).replace(/},/g, "},\n"));
await browser.close();
