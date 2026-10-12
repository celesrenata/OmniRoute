/**
 * Renderer registry for the home topology panel (OR-ATOM-001 v2, T004 / M1).
 *
 * The core owns data; renderers are plugins. This module is the single place
 * where renderers are registered and looked up. It is pure TS (no React, no
 * DOM at module scope) so it is safe to import from SSR and from unit tests.
 *
 * The built-in 2D renderer (`reactflow-2d`) is the default: unknown ids,
 * unsupported environments, and renderer mount/update failures all fall back
 * to it (see `ProviderTopology` host and `BuiltinReactFlowRenderer`).
 *
 * The renderer *preference* the user picks is persisted in browser-local
 * storage. All storage access goes through the `Storage` parameter here — the
 * host is responsible for passing `window.localStorage` only when a browser
 * exists — so this module never touches `window` at top level (AC4).
 */
import type { TopologyRendererPlugin } from "./types";

/** Registry id of the built-in 2D ReactFlow renderer (also the default). */
export const DEFAULT_TOPOLOGY_RENDERER_ID = "reactflow-2d";

/** Browser-local storage key for the user's renderer preference. */
export const TOPOLOGY_RENDERER_PREF_KEY = "omniroute.topology.renderer";

const renderers = new Map<string, TopologyRendererPlugin>();

/**
 * Register (or replace) a renderer under its `id`. Idempotent for repeated
 * registrations of the same plugin object.
 */
export function registerTopologyRenderer(plugin: TopologyRendererPlugin): void {
  renderers.set(plugin.id, plugin);
}

/** Look up a renderer by id. Returns `null` for unknown ids (host falls back). */
export function getTopologyRenderer(id: string): TopologyRendererPlugin | null {
  return renderers.get(id) ?? null;
}

/** The default renderer instance, or `null` if it has not been registered yet. */
export function getDefaultTopologyRenderer(): TopologyRendererPlugin | null {
  return renderers.get(DEFAULT_TOPOLOGY_RENDERER_ID) ?? null;
}

/** All registered renderers, in registration order. */
export function listTopologyRenderers(): TopologyRendererPlugin[] {
  return [...renderers.values()];
}

/**
 * Remove a renderer by id. Exported for tests / plugin teardown; the host
 * never calls this.
 */
export function unregisterTopologyRenderer(id: string): void {
  renderers.delete(id);
}

/**
 * Clear the registry (test helper). The built-in re-registers itself when its
 * module is (re)imported, so a cleared registry is re-seeded on demand.
 */
export function resetTopologyRendererRegistry(): void {
  renderers.clear();
}

/**
 * Read the persisted renderer preference. SSR-safe: with no storage available
 * (e.g. during server rendering) it returns the default id, and any corrupt
 * value falls back to the default instead of throwing.
 */
export function readTopologyRendererPreference(storage: Storage | null | undefined): string {
  if (!storage) return DEFAULT_TOPOLOGY_RENDERER_ID;
  try {
    const value = storage.getItem(TOPOLOGY_RENDERER_PREF_KEY);
    return value && value.length > 0 ? value : DEFAULT_TOPOLOGY_RENDERER_ID;
  } catch {
    return DEFAULT_TOPOLOGY_RENDERER_ID;
  }
}

/**
 * Persist the renderer preference. SSR-safe no-op when no storage exists.
 * Never throws (quota / private-mode failures are swallowed by design).
 */
export function writeTopologyRendererPreference(
  storage: Storage | null | undefined,
  id: string
): void {
  if (!storage) return;
  try {
    storage.setItem(TOPOLOGY_RENDERER_PREF_KEY, id);
  } catch {
    // Non-throwing by contract: a failed preference write must never break the panel.
  }
}

/**
 * Resolve which renderer to use for the given preference: the preferred
 * plugin when it is registered, otherwise the default (2D) plugin. Returns
 * `null` only if even the default is unregistered (host renders nothing and
 * stays blank — it must never crash).
 */
export function resolveTopologyRenderer(preferredId: string): TopologyRendererPlugin | null {
  if (preferredId && preferredId !== DEFAULT_TOPOLOGY_RENDERER_ID) {
    const preferred = renderers.get(preferredId);
    if (preferred) return preferred;
  }
  return renderers.get(DEFAULT_TOPOLOGY_RENDERER_ID) ?? null;
}
