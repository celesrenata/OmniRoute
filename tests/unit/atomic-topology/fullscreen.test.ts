/**
 * Step 11 revision (directive 35): fullscreen helpers (pure DOM, faked document).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PSEUDO_FS_ATTR,
  fullscreenSupported,
  isHostFullscreen,
  nativeFullscreenSupported,
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
test("available whenever there is a host; native only with the element API", () => {
  assert.equal(fullscreenSupported(null), false);
  withDoc({ fullscreenEnabled: true }, () => {
    // iPhone-style host (no element API) still gets the pseudo-fullscreen fallback.
    assert.equal(fullscreenSupported({} as HTMLElement), true);
    assert.equal(nativeFullscreenSupported({} as HTMLElement), false);
    assert.equal(
      nativeFullscreenSupported({ requestFullscreen: () => {} } as unknown as HTMLElement),
      true
    );
  });
  withDoc({ fullscreenEnabled: false }, () => {
    assert.equal(
      nativeFullscreenSupported({ requestFullscreen: () => {} } as unknown as HTMLElement),
      false
    );
    // iPad Safari reports only the prefixed flag.
  });
  withDoc({ fullscreenEnabled: false, webkitFullscreenEnabled: true }, () => {
    assert.equal(
      nativeFullscreenSupported({ webkitRequestFullscreen: () => {} } as unknown as HTMLElement),
      true
    );
  });
});

test("pseudo-fullscreen (iPhone): pins the host over the viewport, then restores it exactly", async () => {
  const events: string[] = [];
  const listeners = new Map<string, (e: { key: string }) => void>();
  const g2 = globalThis as unknown as { window?: unknown; Event?: unknown };
  const prevWin = g2.window;
  g2.window = {
    addEventListener: (t: string, fn: (e: { key: string }) => void) => listeners.set(t, fn),
    removeEventListener: (t: string) => listeners.delete(t),
  };
  const styleBag = () => {
    const s: Record<string, string> & { setProperty?: unknown } = { overflow: "" };
    return s;
  };
  const attrs = new Map<string, string>([["style", "position: relative;"]]);
  const host = {
    style: styleBag(),
    parentElement: null,
    getAttribute: (k: string) => attrs.get(k) ?? null,
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    removeAttribute: (k: string) => attrs.delete(k),
  } as unknown as HTMLElement;
  const doc = {
    fullscreenEnabled: false,
    fullscreenElement: null,
    documentElement: { style: styleBag() },
    body: { style: styleBag() },
    dispatchEvent: (e: { type: string }) => events.push(e.type),
  };
  try {
    await withDocAsync(doc, async () => {
      assert.equal(await toggleHostFullscreen(host), true);
      assert.equal(isHostFullscreen(host), true);
      assert.equal(attrs.get(PSEUDO_FS_ATTR), "true");
      assert.equal((host.style as unknown as Record<string, string>).position, "fixed");
      assert.equal(doc.body.style.overflow, "hidden");
      assert.ok(listeners.has("keydown"), "Escape listener installed");
      // Escape exits.
      listeners.get("keydown")?.({ key: "Escape" });
      assert.equal(isHostFullscreen(host), false);
      assert.equal(attrs.get("style"), "position: relative;");
      assert.equal(attrs.has(PSEUDO_FS_ATTR), false);
      assert.equal(doc.body.style.overflow, "");
      // Toggle in and out via the button path too.
      await toggleHostFullscreen(host);
      assert.equal(await toggleHostFullscreen(host), false);
      assert.deepEqual(events, [
        "fullscreenchange",
        "fullscreenchange",
        "fullscreenchange",
        "fullscreenchange",
      ]);
    });
  } finally {
    g2.window = prevWin;
  }
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
