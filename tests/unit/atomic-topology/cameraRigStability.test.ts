/**
 * Focus-view camera stability: descriptors (and `focusTarget`) are rebuilt on
 * every telemetry snapshot, so CameraRig must re-fit only when the focus
 * coordinates change, never on object identity. Otherwise each poll snaps the
 * camera back over the viewer's own orbit / zoom / pan.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DETAIL_DRIFT_AMPLITUDE_RAD,
  DETAIL_DRIFT_PERIOD_MS,
} from "../../../src/plugins/atomic-topology/scene/detailFlight";

const src = readFileSync(
  new URL("../../../src/plugins/atomic-topology/scene/AtomicScene.tsx", import.meta.url),
  "utf8"
);
const rig = src.slice(src.indexOf("function CameraRig"), src.indexOf("function CameraStateWriter"));

test("CameraRig effect is keyed on focus coordinates, not the focusTarget object", () => {
  const deps = rig.match(/\}, \[([^\]]*)\]\);\s*\n\s*return null;/);
  assert.ok(deps, "CameraRig effect dependency list found");
  const list = deps[1].split(",").map((s) => s.trim());
  for (const k of ["fx", "fy", "fz"]) assert.ok(list.includes(k), `deps include ${k}`);
  assert.ok(!list.includes("focusPosition"), "deps must not include the focusTarget object");
  assert.ok(!list.some((d) => /focusTarget/.test(d)), "deps must not include focusTarget");
});

test("detail-view cinematic drift is a gentle hint", () => {
  assert.ok(DETAIL_DRIFT_AMPLITUDE_RAD <= 0.08, "amplitude ≤ ~4.6°");
  assert.ok(DETAIL_DRIFT_PERIOD_MS >= 45_000, "period ≥ 45 s");
});

test("any viewer input (pointer, wheel, key) hands the camera to the viewer", () => {
  const flight = src.slice(src.indexOf("function DetailFlight"));
  for (const ev of ['"pointerdown"', '"wheel"', '"keydown"']) {
    assert.ok(flight.includes(`addEventListener(${ev}, stop`), `stops drift on ${ev}`);
  }
});
