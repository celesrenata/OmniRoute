"use client";

import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useMemo } from "react";

import { Card } from "@/shared/components";
import { useLiveRequests } from "@/hooks/useLiveDashboard";
import { useRecentCallLogs } from "@/hooks/useRecentCallLogs";
import { selectActiveRequests } from "../home/topologyUtils";
import { groupEntriesByDevice } from "@/shared/topology/domain/fleetInventory";

const ProviderTopology = dynamic(() => import("../home/ProviderTopology"), { ssr: false });

type TopologyProvider = {
  id: string;
  provider: string;
  name?: string;
  /** Connection-health base state, so the topology can colour a node at rest. */
  status?: "active" | "error" | "idle";
  /** Extra ids matched against live/last/error sets (provider-node row id). */
  aliases?: string[];
  /** Click-through id (provider-node row id). */
  routeId?: string;
};

export function HomeProviderTopologySection({
  providers,
  lastProvider,
  errorProvider,
  connections = null,
  providerNodes = null,
  enabled = true,
}: {
  providers: TopologyProvider[];
  lastProvider: string;
  errorProvider: string;
  /** Provider connections (base URLs) used to group local endpoints by node + GPU. */
  connections?: ReadonlyArray<Record<string, unknown>> | null;
  /** Provider-node rows (base URLs) used to group local endpoints by node + GPU. */
  providerNodes?: ReadonlyArray<Record<string, unknown>> | null;
  enabled?: boolean;
}) {
  const t = useTranslations("home");
  // #4596: gate the live-WS connection so it only opens while the topology
  // section is actually shown on the home page.
  // M4: `lifecycleEvents` rides the SAME gated socket (no second WS) — it is
  // a bounded, deduped view over the request started/completed/failed stream.
  const { activeRequests: liveActiveRequests, lifecycleEvents } = useLiveRequests({ enabled });
  // Shared call-log poll (one poll for this and Recent Requests; no new socket).
  const { rows: recentCallLogs } = useRecentCallLogs(enabled);
  const activeRequests = selectActiveRequests(liveActiveRequests);
  // Fleet inventory: one entry per node + GPU (Esnixi 5090, Gremlin-1 4070, Gremlin-1..4 Arc,
  // Stabulous M5 Max) instead of one per provider type. Cloud providers stay as they are.
  // The call-log poll replaces its rows every 3 s; only the (connection -> model) pairs
  // matter here, so key the grouping on that set to avoid snapshot churn.
  const servedPairs = useMemo(() => {
    const pairs = new Set<string>();
    for (const r of recentCallLogs ?? []) {
      const row = r as { connectionId?: unknown; model?: unknown };
      if (typeof row.connectionId === "string" && typeof row.model === "string") {
        pairs.add(`${row.connectionId}\u0000${row.model}`);
      }
    }
    return [...pairs].sort().join("\u0001");
  }, [recentCallLogs]);
  const groupedProviders = useMemo(
    () =>
      groupEntriesByDevice(providers, {
        connections: connections as never,
        providerNodes: providerNodes as never,
        recentCallLogs: servedPairs
          ? servedPairs.split("\u0001").map((p) => {
              const [connectionId, model] = p.split("\u0000");
              return { connectionId, model };
            })
          : [],
      }),
    [providers, connections, providerNodes, servedPairs]
  );
  const activeProviderCount = new Set(activeRequests.map(({ provider }) => provider)).size;

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold">{t("providerTopology")}</h2>
          <p className="text-xs text-text-muted">
            {t("activeError", { active: activeProviderCount, errors: errorProvider ? 1 : 0 })}
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-text-muted">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-green-500" />
            {t("topologyLegendActive")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-amber-500" />
            {t("topologyLegendRecent")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-red-500" />
            {t("topologyLegendError")}
          </span>
        </div>
      </div>
      <ProviderTopology
        providers={groupedProviders}
        activeRequests={activeRequests}
        lifecycleEvents={lifecycleEvents}
        recentCallLogs={recentCallLogs}
        lastProvider={lastProvider}
        errorProvider={errorProvider}
        enabled={enabled}
      />
    </Card>
  );
}
