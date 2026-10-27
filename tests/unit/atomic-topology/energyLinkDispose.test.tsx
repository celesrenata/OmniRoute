/**
 * Atomic topology — `EnergyLink` TubeGeometry disposal (P0 WebGL context leak).
 *
 * The link's tube geometry is built imperatively in a `useMemo`
 * (`new THREE.TubeGeometry(...)`); without an explicit dispose it leaks WebGL
 * buffers on every dependency change and on unmount — the leak that, across
 * the host's ~3.5 s telemetry re-renders, can exhaust the browser's ~16
 * active-WebGL-context limit and blank the scene. This test renders the real
 * component (with `useFrame` — its only R3F import — stubbed) and asserts the
 * geometry's `dispose` runs on dependency change AND unmount.
 *
 * The two `<meshStandardMaterial>` refs are R3F JSX (auto-disposed by R3F in a
 * real scene), so they are out of scope here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import * as THREE from "three";

// The ONLY R3F import EnergyLink uses at render time is `useFrame` (the
// per-frame discharge read). Stub it as a no-op so the component renders
// outside a R3F <Canvas> with zero R3F reconciler involvement.
vi.mock("@react-three/fiber", () => ({
  useFrame: () => {},
}));

import { EnergyLink } from "@/plugins/atomic-topology/scene/EnergyLink";
import type {
  AtomVisualDescriptor,
  LinkVisualDescriptor,
} from "@/plugins/atomic-topology/AtomicTopologyRenderer";

function makeAtom(id: string, x: number): AtomVisualDescriptor {
  return {
    id,
    kind: "provider",
    label: id,
    providerId: id,
    position: { x, y: 1, z: 1 },
    color: "#888888",
    modelColors: [],
    lane: "unknown",
    laneHue: "#888888",
    spin: { value: 0, mode: "unavailable" },
    vibration: { amplitude: 0, frequencyHz: 0, mode: "unavailable" },
    visualState: { state: "idle", style: { width: 1, opacity: 0.4, animated: false } },
    activeRequests: null,
    ringIndex: 0,
  };
}

function makeLink(targetId: string): LinkVisualDescriptor {
  return {
    id: `route:${targetId}`,
    source: "hub",
    target: targetId,
    lane: "unknown",
    laneHue: "#888888",
    visualState: { state: "idle", style: { width: 1, opacity: 0.4, animated: false } },
  };
}

describe("EnergyLink TubeGeometry disposal", () => {
  let disposeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // TubeGeometry inherits dispose() from BufferGeometry.prototype — spy there.
    disposeSpy = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disposes the tube geometry on unmount", () => {
    const link = makeLink("atom-a");
    const atoms = [makeAtom("hub", 0), makeAtom("atom-a", 4)];

    const { unmount } = render(<EnergyLink descriptor={link} atoms={atoms} />);

    expect(disposeSpy).not.toHaveBeenCalled();

    unmount();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("disposes the previous geometry when its dependencies change", () => {
    const link = makeLink("atom-a");
    // The hub + the target atom at x=4 → geometry #1.
    const atomsA = [makeAtom("hub", 0), makeAtom("atom-a", 4)];
    // Same target id, different world position → new memo deps → geometry #2.
    const atomsB = [makeAtom("hub", 0), makeAtom("atom-a", 6)];

    const { rerender, unmount } = render(<EnergyLink descriptor={link} atoms={atomsA} />);
    expect(disposeSpy).not.toHaveBeenCalled();

    rerender(<EnergyLink descriptor={link} atoms={atomsB} />);
    // Dependency change disposes the stale geometry (the new one stays live).
    expect(disposeSpy).toHaveBeenCalledTimes(1);

    unmount();
    // Unmount disposes the current geometry too.
    expect(disposeSpy).toHaveBeenCalledTimes(2);
  });
});
