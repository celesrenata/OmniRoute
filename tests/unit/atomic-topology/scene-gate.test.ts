/**
 * Atomic topology — pure 3D-scene render gate (P0 regression fix).
 *
 * `shouldRenderScene` is a tiny, dependency-free pure function extracted so
 * the gate's full truth table can be verified with no side effects and no
 * React/DOM import. The renderer uses it (with a per-component-lifetime
 * `webgl2Ok` memo) in place of the old per-render `canCreateWebGL2AtRender()`
 * call, so the rendered outcome is unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { shouldRenderScene } from "@/plugins/atomic-topology/sceneGate";

test("shouldRenderScene: all 8 truth combinations", () => {
  const cases: Array<[boolean, number, boolean, boolean]> = [
    // [sceneModuleLoaded, descriptorCount, webgl2Ok, expected]
    [false, 0, false, false],
    [false, 0, true, false],
    [false, 2, false, false],
    [false, 2, true, false],
    [true, 0, false, false],
    [true, 0, true, false],
    [true, 2, false, false],
    [true, 2, true, true],
  ];
  for (const [moduleLoaded, count, webgl2Ok, expected] of cases) {
    assert.equal(
      shouldRenderScene(moduleLoaded, count, webgl2Ok),
      expected,
      `shouldRenderScene(${moduleLoaded}, ${count}, ${webgl2Ok})`
    );
  }
});

test("shouldRenderScene: requires MORE than one descriptor (1 and 0 → no scene)", () => {
  assert.equal(shouldRenderScene(true, 1, true), false);
  assert.equal(shouldRenderScene(true, 0, true), false);
  assert.equal(shouldRenderScene(true, 2, true), true);
});

test("shouldRenderScene: no side effects — repeated identical calls are stable", () => {
  for (let i = 0; i < 10; i += 1) {
    assert.equal(shouldRenderScene(true, 3, true), true);
    assert.equal(shouldRenderScene(false, 3, true), false);
  }
});
