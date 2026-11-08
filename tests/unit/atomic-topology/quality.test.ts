/**
 * Atomic scene render profile (Gate B C4): there are NO quality tiers. The
 * scene always renders at the device's full retina pixel ratio with
 * antialiasing and bloom; the only fallbacks are capability-based (reduced
 * motion, WebGPU -> WebGL2, loss recovery, 2D when no GPU rendering).
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as quality from "@/plugins/atomic-topology/quality";
import { RENDER_PROFILE, resolveRenderDpr } from "@/plugins/atomic-topology/quality";

test("render profile: no tier ladder or hardware probe is exported", () => {
  const exported = Object.keys(quality);
  for (const gone of ["resolveSceneQuality", "QUALITY_BUDGETS"]) {
    assert.ok(!exported.includes(gone), `${gone} must not exist (no quality tiers)`);
  }
});

test("render profile: full fidelity (antialias + bloom)", () => {
  assert.equal(RENDER_PROFILE.antialias, true);
  assert.equal(RENDER_PROFILE.bloom, true);
});

test("resolveRenderDpr: full retina, never capped", () => {
  assert.equal(resolveRenderDpr(1), 1);
  assert.equal(resolveRenderDpr(2), 2);
  assert.equal(resolveRenderDpr(3), 3);
  assert.equal(resolveRenderDpr(4), 4, "a very high DPR is not downgraded");
});

test("resolveRenderDpr: garbage is 1, never 0 / NaN", () => {
  for (const v of [0, -2, Number.NaN, Number.POSITIVE_INFINITY, undefined, null]) {
    assert.equal(resolveRenderDpr(v as number), 1);
  }
});
