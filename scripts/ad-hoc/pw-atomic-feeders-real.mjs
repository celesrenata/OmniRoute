#!/usr/bin/env node
/**
 * Directive 41 / 40: usage-driven feeder traces verified on REAL data.
 * Real requests go through the dev server's own /v1 (a local llama-cpp model, $0), which
 * writes real call-log rows. /home (Atomic) is sampled before, during and after: the dev-only
 * `window.__atomicFeeders` (signal basis/value, target, eased level per atom) plus screenshots.
 *
 *   node scripts/ad-hoc/pw-atomic-feeders-real.mjs <outDir> [model] [requests=12]
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BENCH_BASE ?? "http://localhost:20199";
const out = process.argv[2] ?? "/tmp/feeders-real";
const model = process.argv[3] ?? "llama-cpp/deepseek-v4.1-flash-1017";
const N = Number(process.argv[4] ?? 12);
fs.mkdirSync(out, { recursive: true });

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
  await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
).newPage();
await page.goto(`${BASE}/home`);
const group = page.locator('[role="group"][aria-label="Topology view mode"]');
await group.waitFor({ timeout: 120000 });
await group.getByRole("button", { name: "Atomic" }).click();
await page.waitForSelector(".atomic-scene-canvas canvas", { timeout: 60000 });
await page.waitForTimeout(9000);

const card = page.locator(".atomic-scene-canvas").first();
const samples = [];
const sample = async (label) => {
  const f = await page.evaluate(() => window.__atomicFeeders ?? null);
  // Only the fields that matter (the debug record also carries raw timestamps).
  const slim = (v) => ({ basis: v.basis, value: v.value, target: v.target, level: v.level });
  const lit = f
    ? Object.fromEntries(
        Object.entries(f)
          .filter(([, v]) => (v.target ?? 0) > 0 || (v.level ?? 0) > 0.001)
          .map(([k, v]) => [k, slim(v)])
      )
    : null;
  const rec = { t: new Date().toISOString(), label, lit, all: f };
  samples.push(rec);
  console.log(label, JSON.stringify(lit));
  return rec;
};

await sample("before");
await card.screenshot({ path: path.join(out, "01-before.png") });

const results = [];
const send = async (i) => {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: `Count to ${3 + (i % 4)}.` }],
        max_tokens: 48,
        stream: false,
      }),
    });
    const j = await r.json();
    results.push({
      i,
      status: r.status,
      ms: Date.now() - t0,
      tokens: j.usage?.completion_tokens ?? null,
      err: j.error?.message?.slice(0, 120) ?? null,
    });
  } catch (e) {
    results.push({ i, status: "fetch-error", ms: Date.now() - t0, err: String(e).slice(0, 120) });
  }
};
// Requests spaced ~4 s apart (sequential, real latency), sampling the scene in between.
for (let i = 0; i < N; i += 1) {
  await send(i);
  if (i === Math.floor(N / 2)) await card.screenshot({ path: path.join(out, "02-during.png") });
  await sample(`after-request-${i + 1}`);
  await page.waitForTimeout(2000);
}
await page.waitForTimeout(3000);
await sample("burst-end");
await card.screenshot({ path: path.join(out, "03-burst-end.png") });
// Decay: no new requests; the call-rate window (60 s) empties and feeders return to zero.
await page.waitForTimeout(30000);
await sample("idle+30s");
await page.waitForTimeout(45000);
await sample("idle+75s");
await card.screenshot({ path: path.join(out, "04-idle-75s.png") });
fs.writeFileSync(
  path.join(out, "feeders-real.json"),
  JSON.stringify({ model, requests: results, samples }, null, 2)
);
console.log("requests", JSON.stringify(results));
await browser.close();
