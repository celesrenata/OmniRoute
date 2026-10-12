/**
 * Built-in 2D ReactFlow topology renderer (OR-ATOM-001 v2, T004 / M1).
 *
 * This is the default renderer plugin (`id: "reactflow-2d"`). It bridges the
 * renderer-neutral plugin contract ({@link TopologyRendererPlugin}) to the
 * existing React component implementation
 * (`src/app/(dashboard)/home/ProviderTopology2D.tsx`) by mounting a separate
 * React root into the host-owned container element.
 *
 * Core-owns-data / plugin-owns-rendering split (AC2):
 * - The host (`ProviderTopology`) normalizes inputs into a
 *   `TopologySceneSnapshot` and drives this plugin through `mount` /
 *   `update` / `dispose` only. It never touches ReactFlow, node types,
 *   layout math, or navigation details.
 * - This plugin renders exactly what the snapshot says. It does not fabricate
 *   telemetry, add state, or re-derive data.
 *
 * SSR / lifecycle notes:
 * - No `window` / DOM access at module scope: the `createRoot` call happens
 *   inside `mount()`, which the host only invokes from a browser `useEffect`.
 * - Importing this module self-registers the plugin in the registry (side
 *   effect), which is why the host imports it. Registration is idempotent.
 * - `resize` / `setPaused` / `focusNode` are no-ops in M1: the underlying
 *   ReactFlow canvas already self-sizes via its ResizeObserver
 *   (see `FlowCanvas`), and node focus is not a requirement of the home panel.
 *   The methods exist to satisfy the contract for future renderers.
 */
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

import { ProviderTopology2D } from "@/app/(dashboard)/home/ProviderTopology2D";

import { DEFAULT_TOPOLOGY_RENDERER_ID, registerTopologyRenderer } from "./registry";
import type {
  TopologyRendererInstance,
  TopologyRendererOptions,
  TopologyRendererPlugin,
} from "./types";
import type { TopologySceneSnapshot } from "../domain/types";

/** Symbol key so the per-container host handle never collides with DOM props. */
const CONTAINER_HOST_KEY = Symbol.for("omniroute.topology.renderer2d.host");

type HostedContainer = HTMLElement & { [CONTAINER_HOST_KEY]?: Builtin2DHost | null };

class Builtin2DHost {
  private root: Root | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly options: TopologyRendererOptions
  ) {
    this.root = createRoot(container);
  }

  render(snapshot: TopologySceneSnapshot): void {
    if (!this.root) return;
    this.root.render(
      <ProviderTopology2D
        snapshot={snapshot}
        emptyStateLabel={this.options.emptyStateLabel}
        onProviderClick={this.options.onProviderClick}
      />
    );
  }

  dispose(): void {
    if (!this.root) return;
    this.root.unmount();
    this.root = null;
  }
}

function mount(
  container: HTMLElement,
  snapshot: TopologySceneSnapshot,
  options: TopologyRendererOptions
): TopologyRendererInstance {
  // The host disposes before re-mounting, but defensively unmount any prior
  // root on the same container so a double-mount never leaks a React root.
  const hosted = container as HostedContainer;
  if (hosted[CONTAINER_HOST_KEY]) hosted[CONTAINER_HOST_KEY].dispose();

  const host = new Builtin2DHost(container, options);
  hosted[CONTAINER_HOST_KEY] = host;
  host.render(snapshot);

  return {
    update(next: TopologySceneSnapshot): void {
      host.render(next);
    },
    resize(_width: number, _height: number): void {
      // No-op in M1: ReactFlow self-sizes via its ResizeObserver (FlowCanvas).
    },
    setPaused(_paused: boolean): void {
      // No-op in M1: animation is driven by the `animated` edge flag per snapshot.
    },
    focusNode(_nodeId: string): void {
      // No-op in M1: the home panel has no focus-node requirement.
    },
    dispose(): void {
      host.dispose();
      hosted[CONTAINER_HOST_KEY] = null;
    },
  };
}

/** The built-in 2D renderer plugin. */
export const builtinReactFlowRenderer: TopologyRendererPlugin = {
  id: DEFAULT_TOPOLOGY_RENDERER_ID,
  name: "ReactFlow 2D",
  version: 1,
  // React DOM is always available in this app's client runtime; the module is
  // only ever mounted client-side (the host gates mount() behind useEffect).
  supported(): boolean {
    return true;
  },
  mount,
};

// Self-registration: importing this module makes the default renderer
// available to `getTopologyRenderer("reactflow-2d")` / `resolveTopologyRenderer`.
// Idempotent — re-importing (e.g. in a test) re-registers the same plugin.
registerTopologyRenderer(builtinReactFlowRenderer);
