"use client";

/**
 * ProviderTopology2D (OR-ATOM-001 v2, T004 / M1)
 *
 * The React Flow 2D topology view, extracted from the original <ProviderTopology>
 * default export. Logic (rings, sort/precedence, handle selection, node/edge
 * shapes, empty state, click-through) is verbatim from that component — see AC1.
 * The only structural difference: instead of receiving the legacy
 * `{ providers, activeRequests, lastProvider, errorProvider }` props directly,
 * it receives a renderer-neutral {@link TopologySceneSnapshot} plus optional
 * render options, so it can be driven by a standalone plugin host (see
 * `BuiltinReactFlowRenderer`) in a separate React root.
 *
 * Snapshot → legacy-input reconstruction:
 *   activeSet = providerIds where traffic === "active"
 *   lastSet   = providerIds where traffic === "recent"
 *   errorSet  = providerIds where traffic === "idle" AND health === "unhealthy"
 *   p.status  = healthy→"active", unhealthy→"error", unknown→"idle"
 *
 * This reconstruction is behaviourally identical to the original inputs for
 * every state the legacy component could resolve (see tests/unit/topology/).
 *
 * `onProviderClick` / `emptyStateLabel` MUST be supplied by the host
 * (`ProviderTopology`, which runs inside the App Router tree and owns the
 * `useRouter` / `useTranslations` hooks). This component deliberately uses no
 * Next hooks of its own: it is mounted out-of-tree in its own `createRoot`,
 * where `useRouter` throws "invariant expected app router to be mounted" and
 * the throw is swallowed by React, leaving the panel blank. The static
 * fallbacks below exist only for direct-mount / test usage without a host.
 */

import { useCallback, useMemo } from "react";
import { Handle, Position, type Node, type Edge, type NodeTypes } from "@xyflow/react";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { FlowCanvas } from "@/shared/components/flow/FlowCanvas";
import { StatusDot } from "@/shared/components/flow/StatusDot";
import { edgeStyle, FLOW_EDGE_COLORS, flowColorAlpha } from "@/shared/components/flow/edgeStyles";
import { getFallbackProviderColor } from "@/shared/utils/providerFallbackColor";
import { resolveTopologyNodeLabel } from "./topologyLabel";
import { isTopologyEntryInSet } from "./topologyUtils";
import type { TopologySceneNode, TopologySceneSnapshot } from "@/shared/topology/domain/types";

// Rings: [capacity, rx, ry]. Each successive ring fits ~6 more nodes.
const RINGS: [number, number, number][] = [
  [8, 210, 132],
  [14, 370, 233],
  [20, 530, 334],
  [26, 690, 435],
  [32, 850, 536],
  [38, 1010, 637],
];

type ProviderConfig = { color?: string; name?: string; textIcon?: string };

function getProviderConfig(providerId: string): ProviderConfig {
  // Predefined providers keep their registry color/name untouched. Anything else (custom
  // openai-compatible-*/anthropic-compatible-* provider_nodes) gets a deterministic,
  // per-id fallback color instead of one shared gray — see #8328.
  return (
    (AI_PROVIDERS as Record<string, ProviderConfig>)[providerId] || {
      color: getFallbackProviderColor(providerId),
      name: providerId,
    }
  );
}

type ProviderNodeData = {
  label: string;
  color: string;
  providerId: string;
  active: boolean;
  error: boolean;
  /** Connection-health base state: a healthy connection with no in-flight traffic. */
  healthy: boolean;
  /** Most recently routed provider. Orthogonal to health — it can be last *and* healthy. */
  last: boolean;
  /** Click-through id when it differs from the node key (provider-node row id). */
  routeId?: string;
};

function ProviderNode({ data }: { data: ProviderNodeData }) {
  const { label, color, providerId, active, error, healthy, last } = data;
  const GREEN = FLOW_EDGE_COLORS.active;
  const RED = FLOW_EDGE_COLORS.error;
  const AMBER = FLOW_EDGE_COLORS.last;
  // "Last routed" is a traffic annotation, not a health state: the border keeps saying
  // whether the connection is up, and only the dot turns amber to mark recency.
  const dotColor = active ? color : last ? AMBER : GREEN;

  return (
    <div
      className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border-2 transition-all duration-300 bg-bg cursor-pointer hover:scale-105 active:scale-95 shadow-sm hover:shadow-md"
      style={{
        borderColor: error ? RED : active ? color : healthy ? GREEN : "var(--color-border)",
        boxShadow: error
          ? `0 0 12px ${flowColorAlpha(RED, 19)}`
          : active
            ? `0 0 12px ${color}30`
            : healthy
              ? `0 0 10px ${flowColorAlpha(GREEN, 13)}`
              : "none",
        minWidth: "136px",
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        id="top"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="target"
        position={Position.Bottom}
        id="bottom"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="target"
        position={Position.Left}
        id="left"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="target"
        position={Position.Right}
        id="right"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />

      <div
        className="size-6 rounded flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${color}18` }}
      >
        <ProviderIcon providerId={providerId} size={16} type="color" />
      </div>

      <span
        className="text-xs font-medium truncate flex-1"
        style={{
          color: active ? color : error ? RED : healthy ? GREEN : "var(--color-text-main)",
        }}
      >
        {label}
      </span>

      {(active || error || healthy || last) && (
        <StatusDot color={dotColor} error={error} pulse={active || error} />
      )}
    </div>
  );
}

type RouterNodeData = { activeCount: number };

function RouterNode({ data }: { data: RouterNodeData }) {
  return (
    <div className="flex items-center gap-2 px-5 py-3 rounded-xl border-2 border-primary bg-primary/8 shadow-lg min-w-[140px] justify-center">
      <Handle
        type="source"
        position={Position.Top}
        id="top"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="source"
        position={Position.Left}
        id="left"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />

      <div className="flex items-center justify-center size-7 rounded-md bg-primary/15 shrink-0">
        <span className="material-symbols-outlined text-primary text-[16px]">route</span>
      </div>
      <span className="text-sm font-bold text-primary">OmniRoute</span>
      {data.activeCount > 0 && (
        <span className="ml-1 px-1.5 py-0.5 rounded-full bg-primary text-white text-[10px] font-bold leading-none">
          {data.activeCount}
        </span>
      )}
    </div>
  );
}

const nodeTypes: NodeTypes = {
  provider: ProviderNode as any,
  router: RouterNode as any,
};

type ProviderHealth = "active" | "error" | "idle";
type ProviderEntry = {
  id?: string;
  provider: string;
  name?: string;
  status?: ProviderHealth;
  aliases?: string[];
  routeId?: string;
};

function getHandles(angle: number, cx: number): { sourceHandle: string; targetHandle: string } {
  const rel = (((angle + Math.PI / 2) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (rel < Math.PI / 4 || rel > (7 * Math.PI) / 4)
    return { sourceHandle: "top", targetHandle: "bottom" };
  if (rel > (3 * Math.PI) / 4 && rel < (5 * Math.PI) / 4)
    return { sourceHandle: "bottom", targetHandle: "top" };
  return cx > 0
    ? { sourceHandle: "right", targetHandle: "left" }
    : { sourceHandle: "left", targetHandle: "right" };
}

function buildLayout(
  providers: ProviderEntry[],
  activeSet: Set<string>,
  lastSet: Set<string>,
  errorSet: Set<string>
): { nodes: Node[]; edges: Edge[] } {
  const nodeW = 156;
  const nodeH = 28;
  const routerW = 148;
  const routerH = 44;

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  nodes.push({
    id: "router",
    type: "router",
    position: { x: -routerW / 2, y: -routerH / 2 },
    data: { activeCount: activeSet.size },
    draggable: false,
  });

  if (providers.length === 0) return { nodes, edges };

  // Sort: active → error → last-used → healthy(connected) → rest (alpha within groups)
  const sorted = [...providers].sort((a, b) => {
    const rank = (p: ProviderEntry) => {
      if (isTopologyEntryInSet(p, activeSet)) return 0;
      if (isTopologyEntryInSet(p, errorSet) || p.status === "error") return 1;
      if (isTopologyEntryInSet(p, lastSet)) return 2;
      if (p.status === "active") return 3;
      return 4;
    };
    const d = rank(a) - rank(b);
    return d !== 0 ? d : a.provider.toLowerCase().localeCompare(b.provider.toLowerCase()); // ASCII kasıtlı
  });

  let provIdx = 0;
  for (let ri = 0; ri < RINGS.length && provIdx < sorted.length; ri++) {
    const [cap, rx, ry] = RINGS[ri];
    const count = Math.min(cap, sorted.length - provIdx);

    for (let i = 0; i < count; i++) {
      const p = sorted[provIdx++];
      const active = isTopologyEntryInSet(p, activeSet);
      // Traffic signals (live/recent request) take precedence; connection health is the
      // base state shown when a provider has no in-flight or recent traffic, so the map
      // still reflects "what is connected" at rest instead of going blank after a restart.
      const trafficError = !active && isTopologyEntryInSet(p, errorSet);
      const last = !active && !trafficError && isTopologyEntryInSet(p, lastSet);
      // Health is orthogonal to recency: having just served a request does not make a
      // connection any less connected. `last` used to suppress `healthy`/`healthError`,
      // and because the node had no `last` visual it fell all the way through to the idle
      // grey — so the provider you had just used rendered *less* connected than an idle
      // peer, while its edge was amber. Health drives the border, `last` only the dot.
      const healthError = !active && !trafficError && p.status === "error";
      const healthy = !active && !trafficError && !healthError && p.status === "active";
      const error = trafficError || healthError;
      const config = getProviderConfig(p.provider);
      const nodeId = `provider-${p.provider}`;

      const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
      const cx = rx * Math.cos(angle);
      const cy = ry * Math.sin(angle);
      const { sourceHandle, targetHandle } = getHandles(angle, cx);

      nodes.push({
        id: nodeId,
        type: "provider",
        position: { x: cx - nodeW / 2, y: cy - nodeH / 2 },
        data: {
          label: resolveTopologyNodeLabel(p.name, config.name, p.provider),
          color: config.color || "#6b7280",
          providerId: p.provider,
          active,
          error,
          healthy,
          last,
          routeId: p.routeId,
        } satisfies ProviderNodeData,
        draggable: false,
      });

      edges.push({
        id: `e-${nodeId}`,
        source: "router",
        sourceHandle,
        target: nodeId,
        targetHandle,
        animated: active,
        style: edgeStyle(active, last, error, healthy),
      });
    }
  }

  return { nodes, edges };
}

/**
 * Every provider whose snapshot node has `traffic === "active"`.
 */
function buildActiveSet(snapshot: TopologySceneSnapshot): Set<string> {
  const set = new Set<string>();
  for (const node of snapshot.nodes) {
    if (node.kind === "provider" && node.traffic === "active" && node.providerId) {
      set.add(node.providerId);
    }
  }
  return set;
}

/**
 * Every provider whose snapshot node has `traffic === "recent"` (most-recently
 * routed, i.e. the legacy `lastSet`).
 */
function buildLastSet(snapshot: TopologySceneSnapshot): Set<string> {
  const set = new Set<string>();
  for (const node of snapshot.nodes) {
    if (node.kind === "provider" && node.traffic === "recent" && node.providerId) {
      set.add(node.providerId);
    }
  }
  return set;
}

/**
 * Every provider whose snapshot node has no active/recent traffic AND an
 * unhealthy health state. In the original component this covered both
 * `trafficError` (an error request observed on the provider) and `healthError`
 * (the configured connection is in error); the snapshot folds them into a
 * single `health === "unhealthy"` + `traffic === "idle"` combination and this
 * set is exactly the union the legacy code would have computed.
 */
function buildErrorSet(snapshot: TopologySceneSnapshot): Set<string> {
  const set = new Set<string>();
  for (const node of snapshot.nodes) {
    if (
      node.kind === "provider" &&
      node.traffic === "idle" &&
      node.health === "unhealthy" &&
      node.providerId
    ) {
      set.add(node.providerId);
    }
  }
  return set;
}

function healthToStatus(health: TopologySceneNode["health"]): ProviderHealth {
  if (health === "healthy") return "active";
  if (health === "unhealthy") return "error";
  return "idle";
}

/**
 * Rebuild the legacy `providers` array in the original
 * `<ProviderTopology providers={...}>` shape from the snapshot's provider
 * nodes. `id` is set to the canonical node id (traceability only —
 * `buildLayout` does not read it).
 */
function buildLegacyEntries(snapshot: TopologySceneSnapshot): ProviderEntry[] {
  const entries: ProviderEntry[] = [];
  for (const node of snapshot.nodes) {
    if (node.kind !== "provider" || !node.providerId) continue;
    entries.push({
      id: node.id,
      provider: node.providerId,
      name: node.label,
      status: healthToStatus(node.health),
      aliases: node.aliases,
      routeId: node.routeId,
    });
  }
  return entries;
}

type Props = {
  snapshot: TopologySceneSnapshot;
  /**
   * Optional empty-state label (localized by the caller). When absent, the
   * built-in `useTranslations("common")("providerTopologyEmpty")` is used —
   * preserving the original in-tree behaviour.
   */
  emptyStateLabel?: string;
  /**
   * Optional delegated click handler for provider atoms. When absent, the
   * built-in `useRouter().push('/dashboard/providers/<id>')` is used —
   * preserving the original in-tree behaviour.
   */
  onProviderClick?: (providerId: string) => void;
};

export function ProviderTopology2D({ snapshot, emptyStateLabel, onProviderClick }: Props) {
  const providers = useMemo(() => buildLegacyEntries(snapshot), [snapshot]);
  const activeSet = useMemo(() => buildActiveSet(snapshot), [snapshot]);
  const lastSet = useMemo(() => buildLastSet(snapshot), [snapshot]);
  const errorSet = useMemo(() => buildErrorSet(snapshot), [snapshot]);

  const { nodes, edges } = useMemo(
    () => buildLayout(providers, activeSet, lastSet, errorSet),
    // providers/activeSet/lastSet/errorSet are all derived from `snapshot`,
    // which is the single source of truth for this snapshot-driven component.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: snapshot is the sole input; the sets/entries are pure derivations of it
    [snapshot]
  );

  const providersKey = useMemo(
    () =>
      providers
        .map((p) => p.provider)
        .sort()
        .join(","),
    [providers]
  );

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.type !== "provider") return;
      const data = node.data as ProviderNodeData | undefined;
      const providerId = data?.routeId || data?.providerId || node.id.replace(/^provider-/, "");
      if (providerId) {
        if (onProviderClick) {
          // Host-provided delegation (plugin boundary) — the host owns navigation.
          onProviderClick(providerId);
        } else if (typeof window !== "undefined") {
          // Static fallback for direct-mount / test usage without a host.
          window.location.assign(`/dashboard/providers/${providerId}`);
        }
      }
    },
    [onProviderClick]
  );

  const containerClass =
    "h-[300px] w-full min-w-0 rounded-xl border border-border bg-bg-subtle/20 overflow-hidden sm:h-[420px]";

  if (providers.length === 0) {
    return (
      <div
        className={`${containerClass} flex flex-col items-center justify-center gap-2 text-text-muted`}
      >
        <span className="material-symbols-outlined text-[32px]">device_hub</span>
        <p className="text-sm">{emptyStateLabel ?? "No active providers"}</p>
      </div>
    );
  }

  return (
    <FlowCanvas
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitKey={providersKey}
      className={containerClass}
      onNodeClick={handleNodeClick}
    />
  );
}

export type ProviderTopology2DProps = Props;

export default ProviderTopology2D;
