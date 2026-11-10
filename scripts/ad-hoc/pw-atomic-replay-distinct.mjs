#!/usr/bin/env node
/**
 * Directive 43: replayed "in flight" must read visibly different from "quiet". Real /home,
 * Atomic, the OpenAI-independent real history (requests recorded by this dev server). The
 * replay is opened, the playhead scanned for an in-flight moment and a quiet moment of PROVIDER,
 * and at each: the replay panel moment, the provider's link packet state, its feeder level, and
 * a card still (paused).
 *   node scripts/ad-hoc/pw-atomic-replay-distinct.mjs <outDir> [provider=llama-cpp]
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BENCH_BASE ?? "http://localhost:20199";
const out = process.argv[2] ?? "/tmp/replay-distinct";
const provider = process.argv[3] ?? "llama-cpp";
const atomId = `provider:${provider}`;
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--window-position=0,0",
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
await page.waitForTimeout(6000);
await page.evaluate(
  (w) => window.__atomicReplay.open(w),
  Number(process.env.WINDOW_MS ?? 60 * 60_000)
);
await page.waitForFunction(() => window.__atomicReplay.view()?.phase === "ready", null, {
  timeout: 60000,
});
await page.evaluate(() => window.__atomicReplay.pause());
const span = await page.evaluate(() => window.__atomicReplay.view());
// The replay clock is absolute (epoch ms): seek between startMs and endMs.
const total = { start: span.clock.startMs, end: span.clock.endMs };
// Scan the playhead (newest first, 2 s steps) for the PROVIDER's own replayed state: its route
// link "active" (a recorded request in flight) and, separately, a quiet moment (no request).
const found = await page.evaluate(
  async ({ total, atomId }) => {
    const r = { inflight: null, quiet: null };
    for (
      let p = total.end;
      p >= total.start && (r.inflight == null || r.quiet == null);
      p -= 2000
    ) {
      window.__atomicReplay.seek(p);
      await new Promise((res) => setTimeout(res, 120));
      const link = window.__atomicLinkDbg?.[atomId];
      const st = window.__atomicReplay.view().moment?.state;
      if (link?.state === "active" && r.inflight == null) r.inflight = p;
      if (st === "quiet" && link?.state !== "active" && r.quiet == null) r.quiet = p;
    }
    return r;
  },
  { total, atomId }
);
const results = {};
for (const [name, pos] of Object.entries(found)) {
  if (pos == null) {
    results[name] = null;
    continue;
  }
  await page.evaluate((p) => window.__atomicReplay.seek(p), pos);
  // Feeders, link heat and the atom's energy ease on the scene clock: let them settle.
  await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 7000));
  const rec = await page.evaluate(
    (id) => ({
      moment: window.__atomicReplay.view().moment,
      clock: document.querySelector("[data-atomic-replay-time]")?.textContent ?? null,
      link: window.__atomicLinkDbg?.[id] ?? null,
      feeder: (() => {
        const f = window.__atomicFeeders?.[id];
        return f ? { basis: f.basis, value: f.value, target: f.target, level: f.level } : null;
      })(),
      hubFeeder: (() => {
        const f = window.__atomicFeeders?.hub;
        return f ? { basis: f.basis, value: f.value, level: f.level } : null;
      })(),
    }),
    atomId
  );
  rec.positionMs = pos;
  results[name] = rec;
  await page
    .locator(".atomic-scene-canvas")
    .first()
    .screenshot({ path: path.join(out, `replay-${name}.png`) });
  console.log(name, JSON.stringify(rec));
}
fs.writeFileSync(
  path.join(out, "replay-distinct.json"),
  JSON.stringify({ provider, total, results }, null, 2)
);
await browser.close();
