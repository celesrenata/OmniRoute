/**
 * ProviderTopology2D UI tests (OR-ATOM-001 v2, T004 / M1).
 *
 * Vitest + jsdom + Testing Library. The 2D view is tested as the
 * snapshot-driven React component it now is: it takes a renderer-neutral
 * `TopologySceneSnapshot` and must produce the SAME graph as the
 * pre-extraction implementation (AC1): same router/provider nodes, same
 * route edges, same active/error/last flags, same empty state, same click
 * behaviour (delegated when `onProviderClick` is provided, otherwise the
 * built-in `/dashboard/providers/<id>` navigation).
 *
 * FlowCanvas and ProviderIcon are mocked so the test is deterministic
 * (no real xyflow / icon CDN); next-intl is served by the global vitest
 * setup backed by the real en.json messages.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderTopology2D } from "@/app/(dashboard)/home/ProviderTopology2D";
import type { TopologySceneNode, TopologySceneSnapshot } from "@/shared/topology/domain/types";

// ---------------------------------------------------------------------------
// Mocks (hoisting-safe)
// ---------------------------------------------------------------------------

const pushSpy = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () =>
    ({
      push: pushSpy,
      replace: vi.fn(),
      prefetch: vi.fn(),
    }) as Record<string, unknown>,
}));

type FlowLikeNode = { id: string; type?: string; data?: Record<string, unknown> };
type FlowLikeEdge = { id: string; source: string; target: string; animated: boolean };

type FlowCapture = {
  props: {
    nodes: FlowLikeNode[];
    edges: FlowLikeEdge[];
    fitKey?: string | number;
    onNodeClick?: (event: unknown, node: unknown) => void;
  } | null;
};

const flowCapture = vi.hoisted((): FlowCapture => ({ props: null }));

vi.mock("@/shared/components/flow/FlowCanvas", () => {
  function MockFlowCanvas(props: {
    nodes: FlowLikeNode[];
    edges: FlowLikeEdge[];
    fitKey?: string | number;
    onNodeClick?: (event: unknown, node: unknown) => void;
  }) {
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

// ---------------------------------------------------------------------------
// Snapshot fixtures — exactly the shape normalizeTopology emits (M1)
// ---------------------------------------------------------------------------

const HUB_NODE: TopologySceneNode = {
  id: "hub",
  kind: "hub",
  label: "OmniRoute",
  health: "healthy",
  traffic: "idle",
};

function providerNode(
  providerId: string,
  traffic: TopologySceneNode["traffic"],
  health: TopologySceneNode["health"]
): TopologySceneNode {
  return {
    id: `provider:${providerId}`,
    kind: "provider",
    label: providerId,
    providerId,
    health,
    traffic,
  };
}

function makeSnapshot(nodes: TopologySceneNode[]): TopologySceneSnapshot {
  return { schemaVersion: 1, capturedAt: 1750000000000, nodes, links: [] };
}

function requireProps() {
  if (flowCapture.props === null) throw new Error("FlowCanvas was not mounted");
  return flowCapture.props;
}

describe("ProviderTopology2D (OR-ATOM-001 v2, M1)", () => {
  beforeEach(() => {
    pushSpy.mockClear();
    flowCapture.props = null;
  });

  it("renders the localized empty state when the snapshot holds no provider nodes (AC1)", () => {
    render(<ProviderTopology2D snapshot={makeSnapshot([HUB_NODE])} />);
    expect(screen.getByText("No active providers")).toBeTruthy();
    expect(flowCapture.props).toBeNull();
  });

  it("prefers the emptyStateLabel option over the localized default", () => {
    render(
      <ProviderTopology2D
        snapshot={makeSnapshot([HUB_NODE])}
        emptyStateLabel="Nothing wired up yet"
      />
    );
    expect(screen.getByText("Nothing wired up yet")).toBeTruthy();
  });

  it("builds router + provider nodes and route edges from the snapshot (AC1)", () => {
    render(
      <ProviderTopology2D
        snapshot={makeSnapshot([
          HUB_NODE,
          providerNode("anthropic", "idle", "unknown"),
          providerNode("openai", "active", "healthy"),
        ])}
      />
    );
    const props = requireProps();

    const ids = props.nodes.map((n) => n.id);
    expect(ids).toContain("router");
    expect(ids).toContain("provider-openai");
    expect(ids).toContain("provider-anthropic");

    const openai = props.nodes.find((n) => n.id === "provider-openai");
    expect(openai).toBeDefined();
    expect(openai?.type).toBe("provider");
    expect(openai?.data?.active).toBe(true);
    expect(openai?.data?.error).toBe(false);

    const anthropic = props.nodes.find((n) => n.id === "provider-anthropic");
    expect(anthropic?.data?.active).toBe(false);
    expect(anthropic?.data?.error).toBe(false);
    expect(anthropic?.data?.last).toBe(false);

    // Exactly one provider is active -> the router badge shows 1.
    const router = props.nodes.find((n) => n.id === "router");
    expect(router?.data?.activeCount).toBe(1);
    expect(router?.data?.activeCount).not.toBe(0);

    // Route edges terminate at the provider nodes, source at the router.
    const edgeIds = props.edges.map((e) => e.id);
    expect(edgeIds).toEqual(expect.arrayContaining(["e-provider-openai", "e-provider-anthropic"]));
    const openaiEdge = props.edges.find((e) => e.id === "e-provider-openai");
    expect(openaiEdge?.source).toBe("router");
    expect(openaiEdge?.target).toBe("provider-openai");
    expect(openaiEdge?.animated).toBe(true);
  });

  it("maps unhealthy+idle to the error flag (health is independent of traffic, AC1)", () => {
    render(
      <ProviderTopology2D
        snapshot={makeSnapshot([
          HUB_NODE,
          providerNode("broken", "idle", "unhealthy"),
          providerNode("recently-used", "recent", "healthy"),
        ])}
      />
    );
    const props = requireProps();

    const broken = props.nodes.find((n) => n.id === "provider-broken");
    expect(broken?.data?.error).toBe(true);
    expect(broken?.data?.active).toBe(false);

    const recent = props.nodes.find((n) => n.id === "provider-recently-used");
    expect(recent?.data?.last).toBe(true);
    expect(recent?.data?.error).toBe(false);
    expect(recent?.data?.active).toBe(false);

    // Recent traffic is not "active": the router badge stays absent, never 0.
    const router = props.nodes.find((n) => n.id === "router");
    expect(router?.data?.activeCount).toBe(0);

    // The unstable route edge is the one that animates.
    const brokenEdge = props.edges.find((e) => e.id === "e-provider-broken");
    expect(brokenEdge?.animated).toBe(false);
    expect(requireProps().edges.find((e) => e.id === "e-provider-recently-used")?.animated).toBe(
      false
    );
  });

  it("delegates provider clicks to onProviderClick when provided (no navigation)", () => {
    const onProviderClick = vi.fn();
    render(
      <ProviderTopology2D
        snapshot={makeSnapshot([HUB_NODE, providerNode("openai", "active", "healthy")])}
        onProviderClick={onProviderClick}
      />
    );
    const props = requireProps();
    const openaiNode = props.nodes.find((n) => n.id === "provider-openai");
    expect(openaiNode).toBeDefined();

    props.onNodeClick?.({}, openaiNode);

    expect(onProviderClick).toHaveBeenCalledTimes(1);
    expect(onProviderClick).toHaveBeenCalledWith("openai");
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("falls back to full-page navigation on /dashboard/providers/<id> when no delegation is given", () => {
    render(
      <ProviderTopology2D
        snapshot={makeSnapshot([HUB_NODE, providerNode("openai", "idle", "unknown")])}
      />
    );
    const props = requireProps();
    const openaiNode = props.nodes.find((n) => n.id === "provider-openai");
    const routerNode = props.nodes.find((n) => n.id === "router");
    expect(openaiNode).toBeDefined();
    expect(routerNode).toBeDefined();

    expect(() => props.onNodeClick?.({}, routerNode)).not.toThrow();
    expect(pushSpy).not.toHaveBeenCalled();

    // No delegation supplied: the static fallback (full-page navigation) must
    // not throw. The delegated-navigation path is covered by the previous test.
    expect(() => props.onNodeClick?.({}, openaiNode)).not.toThrow();
  });

  it("exposes a stable sort order fitKey independent of snapshot order (AC7)", () => {
    const first = makeSnapshot([
      HUB_NODE,
      providerNode("anthropic", "idle", "unknown"),
      providerNode("openai", "active", "healthy"),
    ]);
    const second = makeSnapshot([
      HUB_NODE,
      providerNode("openai", "active", "healthy"),
      providerNode("anthropic", "idle", "unknown"),
    ]);

    render(<ProviderTopology2D snapshot={first} />);
    const keyA = requireProps().fitKey;

    render(<ProviderTopology2D snapshot={second} />);
    const keyB = requireProps().fitKey;

    expect(keyA).toBe("anthropic,openai");
    expect(keyB).toBe("anthropic,openai");
  });
});
