#!/usr/bin/env node
/**
 * Directive 19 quantification (profile phase, review item 1): GPU time (timestamp queries) spent on work
 * the viewer cannot see. Interleaved A/B rounds, same build, real M5 Max GPU, uncapped, via
 * pw-atomic-profile.mjs (`?gputime=1`).
 *
 *   node scripts/ad-hoc/pw-atomic-nonvisible.mjs [outJson]
 * env: ROUNDS (default 3), WINDOW_MS (default 6000), WAIT_QUIET (default 1)
 *
 * Variants per scene:
 *   default   : shipped build (frustum cull + projected-size march steps on)
 *   cull0     : `?cull=0` (savings off) -> default vs cull0 = what the visibility savings buy
 *   noBoard   : every board part hidden (`hideLayers`) -> upper bound of board-part cost in that view
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const PARTS = [
  "ic",
  "can",
  "mlcc",
  "smd",
  "axial",
  "toroid",
  "boxChoke",
  "connector",
  "heatsink",
  "led",
]
  .map((k) => `board-${k}`)
  .concat("board-contact-shadows");
const scenes = [
  { name: "topo20-default", query: "atoms=20&paused=0", zoom: 0 },
  { name: "topo32-default", query: "atoms=32&paused=0", zoom: 0 },
  { name: "topo32-close(z7)", query: "atoms=32&paused=0", zoom: 7 },
  { name: "topo32-closer(z11)", query: "atoms=32&paused=0", zoom: 11 },
];
const variants = {
  default: "",
  cull0: "cull=0",
  noBoard: `hideLayers=${PARTS.join(",")}`,
};
const run = (scene, extra) => {
  const out = execFileSync("node", ["scripts/ad-hoc/pw-atomic-profile.mjs", "probe", scene.query], {
    encoding: "utf8",
    env: {
      ...process.env,
      EXTRA: extra,
      ZOOM: String(scene.zoom),
      WINDOW_MS: process.env.WINDOW_MS ?? "6000",
      WAIT_QUIET: process.env.WAIT_QUIET ?? "1",
      QUIET_MAX: process.env.QUIET_MAX ?? "12",
      WINPOS: process.env.WINPOS ?? "0,0",
    },
  });
  const line = out
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .pop();
  const j = JSON.parse(line);
  return {
    gpuMs: j.gpuMsPerFrame.mean,
    fps: j.fps,
    p95: j.dt.p95,
    utilAfter: j.utilAfter,
    quietWaitMs: j.quietWaitMs,
    calls: j.calls,
    tris: j.tris,
  };
};
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const results = [];
for (const scene of scenes) {
  const rows = Object.fromEntries(Object.keys(variants).map((k) => [k, []]));
  for (let r = 0; r < ROUNDS; r += 1)
    for (const [v, extra] of Object.entries(variants)) rows[v].push(run(scene, extra));
  const summary = Object.fromEntries(
    Object.entries(rows).map(([v, list]) => [
      v,
      {
        gpuMsMedian: +med(list.map((x) => x.gpuMs)).toFixed(2),
        gpuMs: list.map((x) => x.gpuMs),
        fpsMedian: med(list.map((x) => x.fps)),
        utilAfter: list.map((x) => x.utilAfter),
        calls: list[0].calls,
        tris: list[0].tris,
      },
    ])
  );
  const rec = { scene: scene.name, ...summary };
  results.push(rec);
  console.log(JSON.stringify(rec));
}
const outPath = process.argv[2];
if (outPath) fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
