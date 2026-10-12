/**
 * Atomic topology — SSR-safe capability detection
 * (OR-ATOM-001 v2, T006a / M3 Phase A).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { detectTopologyCapabilities } from "@/plugins/atomic-topology/capabilities";

test("detectTopologyCapabilities returns false/false/false in node (no browser globals)", () => {
  assert.equal(typeof window, "undefined");
  assert.equal(typeof document, "undefined");

  const caps = detectTopologyCapabilities();

  assert.deepEqual(caps, { webgl2: false, webgpu: false, reducedMotion: false });
});

test("detectTopologyCapabilities returns plain booleans (no partial/undefined fields)", () => {
  const caps = detectTopologyCapabilities();
  for (const [key, value] of Object.entries(caps)) {
    assert.equal(typeof value, "boolean", `capability ${key} must be a boolean`);
  }
});

test("detectTopologyCapabilities is stable across repeated calls (pure, no state)", () => {
  const a = detectTopologyCapabilities();
  const b = detectTopologyCapabilities();
  assert.deepEqual(a, b);
});
