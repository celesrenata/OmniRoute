/**
 * BuiltinReactFlowRenderer tests (OR-ATOM-001 v2, T004 / M1).
 *
 * Vitest + jsdom. Exercises the plugin contract that bridges the renderer-
 * neutral core to the React component: importing the module self-registers
 * the plugin (AC3), `mount` opens a React root that renders exactly the
 * snapshot it is handed, the double-mount guard replaces a prior root on the
 * same container, `update` re-renders, `dispose` unmounts, and the M1 no-ops
 * (resize / setPaused / focusNode) never throw.
 *
 * FlowCanvas / ProviderIcon are mocked (deterministic, no xyflow/CDN).
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { builtinReactFlowRenderer } from "@/shared/topology/renderer/BuiltinReactFlowRenderer";
import { getTopologyRenderer } from "@/shared/topology/renderer/registry";
import type { TopologySceneNode, TopologySceneSnapshot } from "@/shared/topology/domain/types";
import type { TopologyRendererInstance } from "@/shared/topology/renderer/types";

vi.mock("next/navigation", () => ({
  useRouter: () =>
    ({
      push: pushSpy,
      replace: vi.fn(),
      prefetch: vi.fn(),
    }) as Record<string, unknown>,
}));

const pushSpy = vi.hoisted(() => vi.fn());

type FlowLikeNode = { id: string; type?: string; data?: Record<string, unknown> };

const flowCapture = vi.hoisted(() => ({ props: null as unknown | null }));

vi.mock("@/shared/components/flow/FlowCanvas", () => {
  function MockFlowCanvas(props: unknown) {
    flowCapture.props = props;
    return <div data-testid="flow-canvas" />;
  }
  return { FlowCanvas: MockFlowCanvas };
});

vi.mock("@/shared/components/ProviderIcon", () => ({
  default: (props: { providerId: string }) => (
    <span data-testid={`provider-icon:${props.providerId}`} />
  ),
}));

const HUB_NODE: TopologySceneNode = {
  id: "hub",
  kind: "hub",
  label: "OmniRoute",
  health: "healthy",
  traffic: "idle",
};

function makeSnapshot(nodes: TopologySceneNode[]): TopologySceneSnapshot {
  return { schemaVersion: 1, capturedAt: 1750000000000, nodes, links: [] };
}

const EMPTY_SNAPSHOT = makeSnapshot([HUB_NODE]);

let container: HTMLDivElement = document.createElement("div");
let instance: TopologyRendererInstance | null = null;

function mount(containerEl: HTMLDivElement, snapshot: TopologySceneSnapshot) {
  act(() => {
    instance = builtinReactFlowRenderer.mount(containerEl, snapshot, {
      emptyStateLabel: "Custom empty state text",
    });
  });
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  pushSpy.mockClear();
  flowCapture.props = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  instance = null;
});

afterEach(() => {
  if (instance) {
    act(() => {
      instance?.dispose();
      instance = null;
    });
  }
  container.remove();
  container = document.createElement("div");
});

describe("BuiltinReactFlowRenderer (OR-ATOM-001 v2, M1)", () => {
  it("self-registers under reactflow-2d when its module is imported (AC3 / AC5)", () => {
    expect(getTopologyRenderer("reactflow-2d")).toBe(builtinReactFlowRenderer);
    expect(builtinReactFlowRenderer.id).toBe("reactflow-2d");
    expect(builtinReactFlowRenderer.version).toBe(1);
    expect(builtinReactFlowRenderer.supported()).toBe(true);
  });

  it("mount renders the handoff snapshot into the host container (AC1)", () => {
    mount(container, EMPTY_SNAPSHOT);
    expect(instance).not.toBeNull();
    expect(container.textContent).toContain("Custom empty state text");
    expect(container.childElementCount).toBe(1);
  });

  it("a second mount on the same container replaces the prior root (double-mount guard)", () => {
    act(() => {
      instance = builtinReactFlowRenderer.mount(container, EMPTY_SNAPSHOT, {
        emptyStateLabel: "FIRST",
      });
    });
    expect(container.textContent).toContain("FIRST");
    expect(container.textContent).not.toContain("SECOND");

    act(() => {
      instance = builtinReactFlowRenderer.mount(container, EMPTY_SNAPSHOT, {
        emptyStateLabel: "SECOND",
      });
    });
    expect(container.textContent).toContain("SECOND");
    expect(container.textContent).not.toContain("FIRST");
    // Exactly one React root is ever rendered into the container.
    expect(container.childElementCount).toBe(1);
  });

  it("update re-renders the new snapshot (AC1)", () => {
    mount(container, EMPTY_SNAPSHOT);
    expect(container.textContent).toContain("Custom empty state text");
    expect(flowCapture.props).toBeNull();

    const providerNode: TopologySceneNode = {
      id: "provider:openai",
      kind: "provider",
      label: "OpenAI",
      providerId: "openai",
      health: "healthy",
      traffic: "active",
    };
    act(() => {
      instance?.update(makeSnapshot([HUB_NODE, providerNode]));
    });

    expect(container.textContent).not.toContain("Custom empty state text");
    const props = flowCapture.props as { nodes: FlowLikeNode[] } | null;
    expect(props).not.toBeNull();
    expect(props?.nodes.map((n) => n.id)).toContain("provider-openai");
  });

  it("update / resize / setPaused / focusNode are safe after dispose (single dispose, AC M1)", () => {
    mount(container, EMPTY_SNAPSHOT);
    act(() => {
      instance?.dispose();
    });
    const disposed = instance;
    instance = null;

    expect(container.childElementCount).toBe(0);
    expect(() => act(() => disposed?.update(EMPTY_SNAPSHOT))).not.toThrow();
    expect(() => act(() => disposed?.resize(10, 10))).not.toThrow();
    expect(() => act(() => disposed?.setPaused(true))).not.toThrow();
    expect(() => act(() => disposed?.focusNode("router"))).not.toThrow();
    // Dispose is idempotent (root is already unmounted).
    expect(() => act(() => disposed?.dispose())).not.toThrow();
  });
});
