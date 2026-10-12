/**
 * Atomic topology renderer plugin — entry point
 * (OR-ATOM-001 v2, M3 Phase A → Phase B).
 *
 * Phase A shipped the *pure* side of the plugin: manifest, SSR-safe capability
 * detection, visual-encoding rules, deterministic layout, and the event-pool
 * contract. Phase B ships the WebGL2 scene — the real `mount()`
 * ({@link mountAtomicTopologyRenderer}) — behind a client-only dynamic import.
 *
 * Import graph of THIS phase (enforced by review + the grep gate):
 *   index.ts → manifest / capabilities / visualEncoding / layout / eventPool
 *   + the renderer boundary (`@/shared/topology/renderer/*`)
 * None of these modules import `three` or `@react-three/fiber` at top level —
 * the heavy imports are deferred to the Phase B scene module so server and
 * jsdom contexts can load this plugin cheaply.
 */
import { registerTopologyRenderer } from "@/shared/topology/renderer/registry";
import type {
  TopologyRendererInstance,
  TopologyRendererOptions,
  TopologyRendererPlugin,
} from "@/shared/topology/renderer/types";
import type { TopologySceneSnapshot } from "@/shared/topology/domain/types";

import { atomicManifest } from "./manifest";
import { detectTopologyCapabilities } from "./capabilities";

export { atomicManifest } from "./manifest";
export type { AtomicCapability, AtomicManifest } from "./manifest";
export { detectTopologyCapabilities } from "./capabilities";
export type { TopologyCapabilities } from "./capabilities";
export {
  LANE_HUES,
  laneHue,
  modelColor,
  spinRadiansPerSecond,
  queueVibration,
  easeRate,
  resolveVisualState,
  VISUAL_STATE_STYLE,
  VIBRATION_MAX_AMPLITUDE,
  VIBRATION_MAX_FREQUENCY_HZ,
  UNKNOWN_MODEL_COLOR,
} from "./visualEncoding";
export type {
  AtomicVisualState,
  AtomicVisualStateInput,
  JobLane,
  SpinResult,
  VibrationResult,
} from "./visualEncoding";
export {
  computeAtomicLayout,
  atomicMembershipSignature,
  RING_CAPACITIES,
  RING_RADII,
  EXTRA_RING_CAPACITY,
  EXTRA_RING_RADIUS_STEP,
} from "./layout";
export type {
  AtomicLayout,
  AtomicLayoutNode,
  AtomicLayoutOptions,
  AtomicLayoutPlacement,
} from "./layout";
export {
  ATOMIC_EVENT_POOL_CAPACITY,
  ATOMIC_EVENT_HIGH_WATERMARK,
  ATOMIC_EVENT_MAX_AGE_MS,
} from "./eventPool";
export type { AtomicEvent, AtomicEventKind } from "./eventPool";

// Phase B lifecycle adapter — the safe host contract + pure descriptor bridge.
// (Static-import safe: the adapter's static graph is three-free; the 3D scene is
// client-only dynamic-imported inside it. See AtomicTopologyRenderer.tsx.)
import { mountAtomicTopologyRenderer } from "./AtomicTopologyRenderer";
export {
  mountAtomicTopologyRenderer,
  createAtomicTopologyInstance,
  resolveAtomDescriptors,
  resolveLinkDescriptors,
  AtomicWebGLUnsupportedError,
} from "./AtomicTopologyRenderer";
export type {
  AtomVisualDescriptor,
  LinkVisualDescriptor,
  AtomicSceneProps,
  AtomicTopologyRendererProps,
} from "./AtomicTopologyRenderer";

/**
 * Typed error the Phase A `mount()` placeholder threw. Kept exported for
 * backward-compat / tests. The Phase B mount throws
 * {@link AtomicWebGLUnsupportedError} instead when WebGL2 is unavailable.
 *
 * The host contract (see `TopologyRendererPlugin.mount`) treats a throw as
 * "fall back to the default 2D renderer", so the host can safely register the
 * plugin as soon as it is imported — mounting it before Phase B lands simply
 * falls back. `code` is stable so host code / tests can match on it.
 */
export class AtomicMountNotImplementedError extends Error {
  /** Stable error code: `ATOMIC_MOUNT_NOT_IMPLEMENTED_PHASE_A`. */
  readonly code = "ATOMIC_MOUNT_NOT_IMPLEMENTED_PHASE_A" as const;

  constructor() {
    super(
      "Atomic topology renderer: mount() is not implemented in Phase A " +
        "(OR-ATOM-001 v2, T006a). The WebGL2 scene lands in Phase B; the host " +
        "must fall back to the default renderer on this error."
    );
    this.name = "AtomicMountNotImplementedError";
  }
}

/**
 * The no-op placeholder instance — a test/telemetry stand-in. `mount()` no
 * longer returns it (Phase B mounts the real scene); it stays for tests that
 * need a disposable, contract-shaped instance without a live host. Every method
 * is a no-op; `dispose()` releases nothing.
 */
const placeholderInstance: TopologyRendererInstance = {
  update: (_snapshot: TopologySceneSnapshot): void => {},
  resize: (_width: number, _height: number): void => {},
  setPaused: (_paused: boolean): void => {},
  focusNode: (_nodeId: string): void => {},
  dispose: (): void => {},
};

/**
 * Build the Atomic renderer plugin.
 *
 * - `supported()` is evaluated live through {@link detectTopologyCapabilities}
 *   (SSR-safe): true iff the environment exposes WebGL2 — the capability
 *   declared in the manifest. In node/jsdom/SSR it returns `false`, which the
 *   host reads as "fall back to the default renderer".
 * - `mount()` is the real Phase B WebGL2 scene mount
 *   ({@link mountAtomicTopologyRenderer}). In an environment without WebGL2 it
 *   throws {@link AtomicWebGLUnsupportedError}; the host contract turns that
 *   throw into a fallback to the default 2D renderer, so registering the
 *   plugin is always safe.
 */
export function buildAtomicTopologyPlugin(): TopologyRendererPlugin {
  return {
    id: atomicManifest.id,
    name: atomicManifest.name,
    version: atomicManifest.version,
    supported(): boolean {
      const { webgl2 } = detectTopologyCapabilities();
      return webgl2;
    },
    mount(
      container: HTMLElement,
      initial: TopologySceneSnapshot,
      options: TopologyRendererOptions
    ): TopologyRendererInstance {
      // Phase B: the real WebGL2 scene mount. Throws
      // AtomicWebGLUnsupportedError when the environment lacks WebGL2, which the
      // host contract turns into a fallback to the default 2D renderer.
      return mountAtomicTopologyRenderer(container, initial, options);
    },
  };
}

/**
 * Register the Atomic renderer in the topology renderer registry and return
 * the plugin. Idempotent: re-registering replaces the entry under
 * `id: "atomic"` (the registry is a keyed map).
 *
 * Registration is effective from Phase B (now that `mount()` is real). The host
 * is free to call this at startup; the plugin only takes effect where
 * `supported()` is true (WebGL2 present) — elsewhere the host falls back. It
 * also keeps the plugin lifecycle (register → supported() → mount) fully
 * testable end-to-end.
 */
export function registerAtomicTopologyRenderer(): TopologyRendererPlugin {
  const plugin = buildAtomicTopologyPlugin();
  registerTopologyRenderer(plugin);
  return plugin;
}

/** Test/telemetry surface: a no-op instance matching the contract shape. */
export const placeholderAtomicInstance = placeholderInstance;
