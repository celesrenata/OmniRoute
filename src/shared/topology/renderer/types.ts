/**
 * Renderer plugin contract for the home topology panel (OR-ATOM-001 v2, T004 / M1).
 *
 * The core (dashboard) owns the *data*: it normalizes live inputs into a
 * {@link TopologySceneSnapshot} and hands it to a renderer. A renderer plugin
 * owns only the *presentation*: it mounts into a plain container element, then
 * receives snapshots through `update` for the lifetime of its
 * {@link TopologyRendererInstance}.
 *
 * The plugin boundary is deliberately DOM-agnostic (no React, no xyflow types
 * here) so a future 3D/Atomic renderer can plug in beside the built-in 2D
 * ReactFlow renderer without the core caring how the graph is drawn.
 */
import type { TopologySceneSnapshot } from "../domain/types";

/**
 * Options the core passes to a renderer at mount time. M1 defines the two
 * fields the built-in 2D renderer uses; future renderers may ignore them.
 */
export interface TopologyRendererOptions {
  /**
   * Optional empty-state label override (already localized by the caller).
   * Absent → the renderer uses its own default.
   */
  emptyStateLabel?: string;
  /**
   * Delegated click handler for provider atoms. When present, the renderer
   * must call it instead of navigating on its own. Absent → the renderer uses
   * its own navigation (the built-in 2D renderer pushes to
   * `/dashboard/providers/<id>`).
   */
  onProviderClick?: (providerId: string) => void;
}

/**
 * A mounted renderer. The core drives its whole lifecycle: `update` on new
 * snapshots, `resize` when the container changes, `setPaused` when the panel
 * should stop animating, `focusNode` when a node should be centered, and
 * `dispose` exactly once when the panel unmounts (or falls back).
 */
export interface TopologyRendererInstance {
  /** Apply a new snapshot. Must be idempotent for the same snapshot. */
  update(snapshot: TopologySceneSnapshot): void;
  /** Container size changed (CSS pixels). May be a no-op for self-sizing renderers. */
  resize(width: number, height: number): void;
  /** Pause/resume continuous animation (pulses, camera drift…). */
  setPaused(paused: boolean): void;
  /** Center the view on the given canonical atom id (see layoutIdentity). */
  focusNode(nodeId: string): void;
  /** Tear down the renderer and release all resources (DOM, observers, roots). */
  dispose(): void;
}

/**
 * A topology renderer plugin. Registered in the registry
 * (`registerTopologyRenderer`); selected by the host via its `id`.
 */
export interface TopologyRendererPlugin {
  /** Stable registry id, e.g. `"reactflow-2d"`. */
  id: string;
  /** Human-readable name for UIs that list renderers. */
  name: string;
  /** Contract version; M1 plugins are version 1. */
  version: 1;
  /**
   * Whether this renderer can run in the current environment. May be async
   * (e.g. probing WebGL). A rejected/false result must be treated by the host
   * as "fall back to the default renderer".
   */
  supported(): boolean | Promise<boolean>;
  /**
   * Mount the renderer into `container` and draw `initial`. Must return the
   * controlling instance. Throwing here (or during a later `update`) signals
   * the host to fall back to the default 2D renderer.
   */
  mount(
    container: HTMLElement,
    initial: TopologySceneSnapshot,
    options: TopologyRendererOptions
  ): TopologyRendererInstance;
}
