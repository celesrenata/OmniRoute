/**
 * Fleet inventory: the operator's declared node/GPU map. It turns the home
 * topology from "one atom per provider type" (every vLLM box merged into one
 * `vllm` atom) into "one atom per node + GPU", so each physical accelerator is
 * its own entity in the 2D and Atomic views, tinted by its vendor.
 *
 * A provider connection / provider node belongs to a device when its base-URL
 * endpoint (host + port) matches one of the device's endpoints. The inventory
 * is a declared operator fact (not telemetry): it names the hardware, it never
 * invents activity. Activity still comes only from real live requests and
 * call-log rows, attributed per device by connection id or served model.
 *
 * Pure (no DOM, no fetch).
 */
import type { TopologyEntry } from "@/app/(dashboard)/home/topologyUtils";

export type GpuVendor = "nvidia" | "intel" | "apple" | "amd" | "other";

/** Vendor identity colours (2D border/badge, Atomic rim). */
export const VENDOR_COLORS: Record<GpuVendor, string> = {
  nvidia: "#76B900",
  intel: "#2F8FFF",
  // Apple: pale silver with a rose-gold cast (plain silver would read as "unknown").
  apple: "#F2CFC4",
  amd: "#ED1C24",
  other: "#94A3B8",
};

export interface FleetDevice {
  /** Stable slug, e.g. `esnixi-rtx5090`. */
  id: string;
  /** Machine name, e.g. `Esnixi`. */
  node: string;
  /** Accelerator name, e.g. `RTX 5090`. */
  gpu: string;
  vendor: GpuVendor;
  /** `host:port` endpoints served by this GPU (`host` alone = any port). */
  endpoints: string[];
  /** Models this GPU is known to serve (disambiguates providers shared by several GPUs). */
  models?: string[];
  /**
   * Fleet-telemetry identity: the Prometheus `hostname` label, plus a substring of the
   * GPU device id (`uuid`) when the host reports several GPUs (DCGM ids start `GPU-`;
   * the Intel Arc exporter reports `intel-arc`).
   */
  telemetry?: { hostname: string; gpuMatch?: string };
}

const ARC_PORTS = [8100, 8101, 10200, 10300];
const arc = (n: number, ip: string): FleetDevice => ({
  id: `gremlin-${n}-arc`,
  node: `Gremlin-${n}`,
  gpu: "Intel Arc",
  vendor: "intel",
  endpoints: ARC_PORTS.map((p) => `${ip}:${p}`),
  telemetry: { hostname: `gremlin-${n}`, gpuMatch: "intel-arc" },
});

/** The operator's fleet (declared hardware). */
export const FLEET_INVENTORY: readonly FleetDevice[] = Object.freeze([
  {
    id: "esnixi-rtx5090",
    node: "Esnixi",
    gpu: "RTX 5090",
    vendor: "nvidia",
    endpoints: ["192.168.133.3:2701"],
    models: ["qwen3.8-27b-nvfp4", "qwen3.5-9b-nvfp4-reader"],
    telemetry: { hostname: "esnixi", gpuMatch: "gpu-" },
  },
  {
    id: "gremlin-1-rtx4070tis",
    node: "Gremlin-1",
    gpu: "RTX 4070 Ti SUPER",
    vendor: "nvidia",
    endpoints: ["10.1.1.12:2701"],
    models: ["granite-4.2-8b"],
    telemetry: { hostname: "gremlin-1", gpuMatch: "gpu-" },
  },
  {
    id: "stabulous-m5max",
    node: "Stabulous",
    gpu: "M5 Max",
    vendor: "apple",
    endpoints: ["192.168.133.2:7777"],
    telemetry: { hostname: "stabulous" },
  },
  arc(1, "10.1.1.12"),
  arc(2, "10.1.1.13"),
  arc(3, "10.1.1.14"),
  arc(4, "10.1.1.15"),
]);

/** Entry member: a provider key this device serves, optionally scoped to models / connections. */
export interface DeviceMember {
  provider: string;
  /** Canonical model ids (set when the provider is shared by several devices). */
  models?: string[];
  connectionIds?: string[];
}

export interface DeviceTopologyInfo {
  id: string;
  node: string;
  gpu: string;
  vendor: GpuVendor;
  color: string;
  telemetry?: { hostname: string; gpuMatch?: string };
}

export type DeviceTopologyEntry = TopologyEntry & {
  device: DeviceTopologyInfo;
  members: DeviceMember[];
};

const canon = (s: unknown): string => (typeof s === "string" ? s.trim().toLowerCase() : "");

/** `host:port` of a base URL (default ports filled), or null. */
export function endpointOf(baseUrl: unknown): { host: string; port: string } | null {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;
  try {
    const u = new URL(baseUrl.trim());
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return { host: u.hostname.toLowerCase(), port };
  } catch {
    return null;
  }
}

/** The device serving `baseUrl`, or null. */
export function deviceForBaseUrl(
  baseUrl: unknown,
  inventory: readonly FleetDevice[] = FLEET_INVENTORY
): FleetDevice | null {
  const ep = endpointOf(baseUrl);
  if (!ep) return null;
  for (const d of inventory) {
    for (const e of d.endpoints) {
      const [h, p] = e.toLowerCase().split(":");
      if (h === ep.host && (!p || p === ep.port)) return d;
    }
  }
  return null;
}

type ConnectionRow = {
  id?: string;
  provider?: string;
  isActive?: boolean;
  testStatus?: string;
  providerSpecificData?: { baseUrl?: string } | null;
};
type NodeRow = { id?: string; prefix?: string; baseUrl?: string };
type CallRow = { provider?: string; model?: string; connectionId?: unknown };

/**
 * Regroup provider topology entries by node + GPU. Entries whose endpoints all
 * belong to declared devices are replaced by one entry per device; everything
 * else (cloud providers, unmapped hosts) is returned untouched.
 */
export function groupEntriesByDevice<T extends TopologyEntry>(
  entries: readonly T[],
  ctx: {
    connections?: readonly ConnectionRow[] | null;
    providerNodes?: readonly NodeRow[] | null;
    recentCallLogs?: readonly CallRow[] | null;
    inventory?: readonly FleetDevice[];
  }
): Array<T | DeviceTopologyEntry> {
  const inventory = ctx.inventory ?? FLEET_INVENTORY;
  const connections = (ctx.connections ?? []).filter((c) => c && c.isActive !== false);
  const nodes = ctx.providerNodes ?? [];

  // provider key -> (device id -> connection ids)
  const byProvider = new Map<string, Map<string, Set<string>>>();
  const unmapped = new Set<string>();
  const note = (provider: string, device: FleetDevice | null, connectionId?: string) => {
    const key = canon(provider);
    if (!key) return;
    if (!device) {
      unmapped.add(key);
      return;
    }
    const m = byProvider.get(key) ?? new Map<string, Set<string>>();
    const set = m.get(device.id) ?? new Set<string>();
    if (connectionId) set.add(connectionId);
    m.set(device.id, set);
    byProvider.set(key, m);
  };
  const nodeById = new Map(nodes.map((n) => [canon(n.id), n]));
  for (const c of connections) {
    const viaNode = nodeById.get(canon(c.provider));
    const base = c.providerSpecificData?.baseUrl ?? viaNode?.baseUrl;
    note(c.provider ?? "", deviceForBaseUrl(base, inventory), c.id);
  }
  for (const n of nodes) {
    const d = deviceForBaseUrl(n.baseUrl, inventory);
    if (n.prefix) note(n.prefix, d);
    if (n.id) note(n.id, d);
  }

  // Models learned from real call-log rows (connection id -> served model).
  const learned = new Map<string, Set<string>>();
  for (const r of ctx.recentCallLogs ?? []) {
    const cid = typeof r.connectionId === "string" ? r.connectionId : "";
    const model = canon(r.model);
    if (!cid || !model || model === "connection-test" || model === "model-sync") continue;
    const set = learned.get(cid) ?? new Set<string>();
    set.add(model);
    learned.set(cid, set);
  }

  const deviceEntries = new Map<string, DeviceTopologyEntry>();
  const memberEntries = new Map<string, T[]>();
  const keep: T[] = [];
  for (const entry of entries) {
    const keys = [entry.provider, ...(entry.aliases ?? [])].map(canon).filter(Boolean);
    const owners = keys.map((k) => byProvider.get(k)).filter(Boolean) as Map<string, Set<string>>[];
    const mappedOnly = keys.length > 0 && owners.length > 0 && keys.every((k) => !unmapped.has(k));
    if (!mappedOnly) {
      keep.push(entry);
      continue;
    }
    for (const key of keys) {
      const devs = byProvider.get(key);
      if (!devs) continue;
      const shared = devs.size > 1;
      for (const [deviceId, connIds] of devs) {
        const device = inventory.find((d) => d.id === deviceId);
        if (!device) continue;
        let de = deviceEntries.get(deviceId);
        if (!de) {
          de = {
            id: `gpu-${device.id}`,
            provider: `gpu-${device.id}`,
            name: `${device.node} · ${device.gpu}`,
            status: "idle",
            routeId: entry.routeId ?? entry.provider,
            device: {
              id: device.id,
              node: device.node,
              gpu: device.gpu,
              vendor: device.vendor,
              color: VENDOR_COLORS[device.vendor],
              ...(device.telemetry ? { telemetry: device.telemetry } : {}),
            },
            members: [],
          };
          deviceEntries.set(deviceId, de);
        }
        if (de.members.some((m) => m.provider === key)) continue;
        const member: DeviceMember = { provider: key };
        if (connIds.size > 0) member.connectionIds = [...connIds].sort();
        if (shared) {
          const models = new Set((device.models ?? []).map(canon).filter(Boolean));
          for (const cid of connIds) for (const m of learned.get(cid) ?? []) models.add(m);
          // A load-balanced pool (no per-device models known anywhere, e.g. the ArcForge
          // embeddings prefix) stays unscoped: pool traffic lights every member GPU.
          if (models.size > 0) member.models = [...models].sort();
        }
        de.members.push(member);
        const list = memberEntries.get(deviceId) ?? [];
        list.push(entry);
        memberEntries.set(deviceId, list);
      }
    }
  }
  // Device health: any healthy member -> active; else any errored -> error; else idle.
  for (const [deviceId, de] of deviceEntries) {
    const list = memberEntries.get(deviceId) ?? [];
    de.status = list.some((e) => e.status === "active")
      ? "active"
      : list.some((e) => e.status === "error")
        ? "error"
        : "idle";
  }
  const ordered = inventory
    .map((d) => deviceEntries.get(d.id))
    .filter(Boolean) as DeviceTopologyEntry[];
  return [...keep, ...ordered];
}

/** True when the device entry serves this (provider, model, connection) observation. */
export function memberClaims(
  members: readonly DeviceMember[],
  provider: unknown,
  model?: unknown,
  connectionId?: unknown
): boolean {
  const p = canon(provider);
  if (!p) return false;
  const m = canon(model);
  const cid = typeof connectionId === "string" ? connectionId : "";
  for (const member of members) {
    if (member.provider !== p) continue;
    if (cid && member.connectionIds?.includes(cid)) return true;
    if (!member.models) return true;
    if (m && member.models.includes(m)) return true;
  }
  return false;
}

/** True when this member set only claims a provider through a model/connection scope. */
export function memberIsScoped(members: readonly DeviceMember[], provider: unknown): boolean {
  const p = canon(provider);
  return members.some((m) => m.provider === p && Array.isArray(m.models));
}
