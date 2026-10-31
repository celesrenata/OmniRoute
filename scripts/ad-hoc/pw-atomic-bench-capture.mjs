#!/usr/bin/env node
/**
 * OR-ATOM-010 — Atomic material bench capture (T10.1b).
 *
 * Deterministic before/after screenshot capture for the Atomic scene bench at
 * `http://<host>/dev/atomic-bench`. Launches headless Chromium with
 * SwiftShader (software WebGL2 — the path proven in `pw-webgl-probe.mjs`),
 * waits for the scene canvas + `data-ready="true"`, settles a fixed number of
 * frames (shaders compiled, first draw present), then screenshots the fixed
 * 1600×1000 host element.
 *
 * The bench renders `paused=1` by default → the scene clock is frozen, so the
 * camera + spin angle are constant: captures are stable across runs.
 *
 * Usage:
 *   node scripts/ad-hoc/pw-atomic-bench-capture.mjs \
 *     [--base-url=http://127.0.0.1:21128] [--tag=baseline] \
 *     [--out=OR_ATOM_010/screenshots] [--nodes=default,provider:bench-primary,provider:bench-error,gpu:...]
 *
 * `--nodes` entries: `default` (base fit, no focus) or a canonical atom id
 * (e.g. `provider:bench-primary`) → camera focus close-up. Output PNG per
 * node: `<out>/<tag>_<node>.png`.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const hit = args.find((a) => a.startsWith(`--${flag}=`));
    return hit ? hit.slice(flag.length + 3) : fallback;
  };
  return {
    baseUrl: get("base-url", "http://127.0.0.1:21128"),
    tag: get("tag", "baseline"),
    out: get("out", "OR_ATOM_010/screenshots"),
    nodes: get(
      "nodes",
      "default,provider:bench-primary,provider:bench-error,gpu:bench-host:bench-gpu-a"
    ),
  };
}

const { baseUrl, tag, out, nodes } = parseArgs();
mkdirSync(path.resolve(out), { recursive: true });

const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

const shots = [];
for (const node of nodes
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)) {
  const focus = node === "default" ? null : node;
  const url = `${baseUrl}/dev/atomic-bench?paused=1&badge=0${
    focus ? `&node=${encodeURIComponent(focus)}` : ""
  }`;
  await page.goto(url, { waitUntil: "networkidle" });

  // Wait for the scene host to report ready (canvas present + renderer mounted).
  await page.waitForFunction(
    () =>
      document.querySelector('[data-ready="true"]') !== null ||
      document.querySelector("canvas") !== null,
    { timeout: 45_000 }
  );
  // Settle: let SwiftShader compile shaders + draw a few frozen frames so the
  // first capture is not an empty/clear-color frame.
  await page.waitForTimeout(900);

  const host = page.locator('[data-atomic-bench="true"]');
  await host.waitFor({ timeout: 10_000 });
  const file = path.resolve(out, `${tag}_${node.replace(/[^a-zA-Z0-9_-]/g, "_")}.png`);
  await host.screenshot({ path: file });
  shots.push(file);
  console.log(`captured ${file} (focus=${focus ?? "default"})`);
}

await page.close();
await browser.close();

if (errors.length > 0) {
  console.error(`\n${errors.length} console/page errors during capture:`);
  for (const e of errors.slice(0, 20)) console.error(`  ${e}`);
}
console.log(`\ndone: ${shots.length} shot(s) → ${path.resolve(out)}`);
