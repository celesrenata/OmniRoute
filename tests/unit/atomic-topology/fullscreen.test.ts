/**
 * Step 11 revision (directive 35): fullscreen helpers (pure DOM, faked document).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  fullscreenSupported,
  isHostFullscreen,
  toggleHostFullscreen,
} from "../../../src/plugins/atomic-topology/overlays/fullscreen.ts";
import {
  DETAIL_ELEVATION_RAD,
  DETAIL_FOV_DEG,
  DETAIL_HERO_DISTANCE,
} from "../../../src/plugins/atomic-topology/scene/detailFlight.ts";
const g = globalThis as unknown as { document?: unknown };
function withDoc<T>(doc: Record<string, unknown>, fn: () => T): T {
  const prev = g.document;
  g.document = doc;
  try {
    return fn();
  } finally {
    g.document = prev;
  }
}
test("unsupported without a host or without requestFullscreen", () => {
  assert.equal(fullscreenSupported(null), false);
  withDoc({ fullscreenEnabled: true }, () => {
    assert.equal(fullscreenSupported({} as HTMLElement), false);
    assert.equal(
      fullscreenSupported({ requestFullscreen: () => {} } as unknown as HTMLElement),
      true
    );
  });
  withDoc({ fullscreenEnabled: false }, () => {
    assert.equal(
      fullscreenSupported({ requestFullscreen: () => {} } as unknown as HTMLElement),
      false
    );
  });
});
test("toggle enters, then exits, and swallows rejected requests", async () => {
  const doc: Record<string, unknown> = { fullscreenEnabled: true, fullscreenElement: null };
  const host = {
    requestFullscreen: async () => {
      doc.fullscreenElement = host;
    },
  } as unknown as HTMLElement;
  doc.exitFullscreen = async () => {
    doc.fullscreenElement = null;
  };
  await withDocAsync(doc, async () => {
    assert.equal(isHostFullscreen(host), false);
    assert.equal(await toggleHostFullscreen(host), true);
    assert.equal(isHostFullscreen(host), true);
    assert.equal(await toggleHostFullscreen(host), false);
    const bad = {
      requestFullscreen: async () => {
        throw new Error("denied");
      },
    } as unknown as HTMLElement;
    assert.equal(await toggleHostFullscreen(bad), false);
  });
});
async function withDocAsync(doc: Record<string, unknown>, fn: () => Promise<void>): Promise<void> {
  const prev = g.document;
  g.document = doc;
  try {
    await fn();
  } finally {
    g.document = prev;
  }
}
test("detail framing: the whole cloud (radius ~81) fits 55-70% of the frame height", () => {
  const visibleH = 2 * DETAIL_HERO_DISTANCE * Math.tan((DETAIL_FOV_DEG * Math.PI) / 360);
  const frac = (2 * 81 * 0.8) / visibleH; // cloud bound radius x cloudRadiusMul
  assert.ok(frac >= 0.55 && frac <= 0.72, `fraction ${frac}`);
  assert.ok(DETAIL_ELEVATION_RAD >= 0.12, "high enough to see the pad and floor");
});
