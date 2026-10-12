// #T011 (OR-ATOM-001 v2 / M4) — interactive orbit/zoom/pan presence.
//
// Verifies the M4 camera interaction wiring WITHOUT needing WebGL (the real
// camera math runs only inside an R3F <Canvas> in the browser):
//   - `SceneOrbitControls` is exported as a component function.
//   - It wraps `three`'s `OrbitControls` (NOT drei's) and renders `null`
//     (no R3F primitive) — the SSR-safe no-op contract.
//   - `AtomicScene` actually mounts `<SceneOrbitControls />` inside the
//     `<Canvas>` (the user-facing orbit/zoom/pan is wired end to end).
//
// A full interaction test (drag the camera) would require a WebGL2 context
// and lives in the live/Playwright verification, not the node:test run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import { SceneOrbitControls } from "@/plugins/atomic-topology/scene/SceneOrbitControls";

const HERE = dirname(fileURLToPath(import.meta.url));
function readSrc(rel: string): string {
  return readFileSync(join(HERE, "../../../src", rel), "utf8");
}

test("SceneOrbitControls: exported as a component function", () => {
  assert.equal(typeof SceneOrbitControls, "function");
});

test("SceneOrbitControls: wraps three OrbitControls (not drei) and renders null (SSR-safe)", () => {
  const src = readSrc("plugins/atomic-topology/scene/SceneOrbitControls.tsx");
  assert.ok(
    src.includes('from "three/addons/controls/OrbitControls.js"'),
    "must import OrbitControls from three addons, not drei"
  );
  // Must not import from @react-three/drei (an actual import statement — the
  // doc comment legitimately mentions the package, so we match an import, not
  // a bare substring).
  assert.ok(
    !/from\s+"@react-three\/drei"/.test(src) && !/import\(.*"@react-three\/drei"/.test(src),
    "must not pull in @react-three/drei (keeps the 3D surface minimal)"
  );
  // SSR-safe: the component returns null (no R3F primitive in the tree).
  assert.ok(
    /return\s+null;/.test(src),
    "must render null so it is a no-op in the server render / tree diff"
  );
  // The imperative OrbitControls is constructed in a useEffect (client-only),
  // guarded on gl.domElement — never during server render.
  assert.ok(src.includes("useEffect"), "OrbitControls must be wired in useEffect");
  assert.ok(src.includes("gl.domElement"), "must guard on gl.domElement presence");
  assert.ok(src.includes("controls.dispose()"), "must dispose the controls on unmount");
});

test("AtomicScene: mounts <SceneOrbitControls /> so the camera is orbitable", () => {
  const src = readSrc("plugins/atomic-topology/scene/AtomicScene.tsx");
  assert.ok(src.includes('from "./SceneOrbitControls"'), "AtomicScene must import the controls");
  assert.ok(
    /<SceneOrbitControls\s*\/>/.test(src),
    "AtomicScene must mount <SceneOrbitControls /> inside the <Canvas>"
  );
});
