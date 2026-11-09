#!/usr/bin/env node
/**
 * CONTROL for the uncapped tail: a trivial WebGPU page (clear + N tiny draws, no three.js, no atoms)
 * under the same flags/viewport/DPR. If it shows the same periodic ~20 ms frames, the tail is the
 * browser/compositor presentation path, not our render cost.
 */
import { chromium } from "playwright";
const BASE = process.env.BENCH_BASE ?? "http://localhost:20199";
const draws = Number(process.argv[2] ?? 1);
// argv[3]: fragment loop iterations per pixel (synthetic GPU cost per frame, no three.js).
const iters = Number(process.argv[3] ?? 0);
const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--window-size=1700,1100",
    "--disable-frame-rate-limit",
    "--disable-gpu-vsync",
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.addInitScript(
  ([a, it]) => {
    window.__ALPHA = a;
    window.__IT = it;
  },
  [process.env.ALPHA ?? "premultiplied", iters]
);
await page.goto(`${BASE}/dev/atomic-bench?atomic-fx=rt&count=1&paused=1`);
await page.waitForTimeout(3000);
const r = await page.evaluate(async (N) => {
  document.body.innerHTML = "";
  const c = document.createElement("canvas");
  c.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh";
  c.width = innerWidth * devicePixelRatio;
  c.height = innerHeight * devicePixelRatio;
  document.body.appendChild(c);
  const ad = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  const dev = await ad.requestDevice();
  const ctx = c.getContext("webgpu");
  const fmt = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device: dev, format: fmt, alphaMode: window.__ALPHA ?? "premultiplied" });
  const m = dev.createShaderModule({
    code: `@vertex fn v(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{ var p=array(vec2f(-1,-1),vec2f(1,-1),vec2f(0,1)); return vec4f(p[i]*3.0,0,1);} @fragment fn f(@builtin(position) q:vec4f)->@location(0) vec4f{ var a=q.x*0.001; for(var k=0u;k<${window.__IT}u;k++){ a=fract(sin(a*12.9898+f32(k))*43758.5); } return vec4f(a*0.02,0.0,0.05,1);}`,
  });
  const pl = dev.createRenderPipeline({
    layout: "auto",
    vertex: { module: m, entryPoint: "v" },
    fragment: { module: m, entryPoint: "f", targets: [{ format: fmt }] },
  });
  const dt = [];
  let last = performance.now();
  const t0 = last;
  return await new Promise((res) => {
    const tick = (now) => {
      dt.push(now - last);
      last = now;
      const e = dev.createCommandEncoder();
      const p = e.beginRenderPass({
        colorAttachments: [
          {
            view: ctx.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0.1, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      p.setPipeline(pl);
      for (let i = 0; i < N; i++) p.draw(3);
      p.end();
      dev.queue.submit([e.finish()]);
      if (now - t0 < 6000) requestAnimationFrame(tick);
      else {
        dt.shift();
        const s = [...dt].sort((a, b) => a - b);
        const q = (x) => +s[Math.min(s.length - 1, Math.floor(s.length * x))].toFixed(2);
        res({
          draws: N,
          iters: window.__IT,
          frames: dt.length,
          fps: +(dt.length / (dt.reduce((a, b) => a + b, 0) / 1000)).toFixed(1),
          p50: q(0.5),
          p95: q(0.95),
          p99: q(0.99),
          slow: dt.filter((x) => x > 12).length,
        });
      }
    };
    requestAnimationFrame(tick);
  });
}, draws);
console.log(JSON.stringify(r));
await browser.close();
