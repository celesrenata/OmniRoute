/**
 * Cloud refusal for secure combos.
 *
 * A secure combo may only route to inference backends whose base URL is local or private.
 * A provider with no resolvable base URL (the usual case for hosted/OAuth providers) is
 * treated as cloud. Fail-closed throughout.
 */
import {
  getRegistryEntry,
  isLocalProvider as isLocalBaseUrl,
} from "@omniroute/open-sse/config/providerRegistry.ts";
import { resolveCanonicalProviderModel } from "@omniroute/open-sse/services/model.ts";
import { isComboTreeSecure } from "./secure";

type ComboLike = {
  name?: string | null;
  config?: Record<string, unknown> | null;
  models?: unknown;
};
type ConnectionLike = { id?: string; providerSpecificData?: unknown };

export type SecureCloudViolation = {
  combo: string;
  provider: string;
  reason: "no_base_url" | "non_local_base_url" | "unknown_provider";
};

/** Default base URL(s) the registry advertises for a provider, if any. */
export function registryBaseUrls(provider: string): string[] {
  const entry = getRegistryEntry(provider) as { baseUrl?: string; baseUrls?: string[] } | null;
  if (!entry) return [];
  if (Array.isArray(entry.baseUrls) && entry.baseUrls.length > 0) return entry.baseUrls;
  return entry.baseUrl ? [entry.baseUrl] : [];
}

/** Classifies one provider given the base URL stored on a connection (or null for default). */
export function classifyBaseUrl(
  provider: string,
  connectionBaseUrl: string | null | undefined
): SecureCloudViolation["reason"] | null {
  const urls = connectionBaseUrl ? [connectionBaseUrl] : registryBaseUrls(provider);
  if (urls.length === 0) return "no_base_url";
  return urls.every((u) => isLocalBaseUrl(u)) ? null : "non_local_base_url";
}

function connectionBaseUrl(conn: ConnectionLike): string | null {
  const psd = conn.providerSpecificData;
  if (psd && typeof psd === "object") {
    const v = (psd as Record<string, unknown>).baseUrl;
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

type Leaf = { provider: string; connectionId: string | null };

function stepToLeaf(step: unknown): Leaf | null {
  const obj = typeof step === "string" ? { model: step } : (step as Record<string, unknown>);
  if (!obj || typeof obj !== "object") return null;
  const model = typeof obj.model === "string" ? obj.model : "";
  let provider = typeof obj.providerId === "string" ? obj.providerId : "";
  if (!provider && model.includes("/")) {
    const [head, ...rest] = model.split("/");
    provider = resolveCanonicalProviderModel(head, rest.join("/")).provider || head;
  }
  const connectionId =
    typeof obj.connectionId === "string" && obj.connectionId ? obj.connectionId : null;
  return { provider: provider || "unknown", connectionId };
}

/** All static leaf targets reachable from a combo (transitively through combo-refs). */
export function collectLeaves(
  combo: ComboLike,
  allCombos: readonly ComboLike[],
  seen: Set<string> = new Set()
): Leaf[] {
  if (combo.name) {
    if (seen.has(combo.name)) return [];
    seen.add(combo.name);
  }
  const out: Leaf[] = [];
  const steps = Array.isArray(combo.models) ? combo.models : [];
  for (const step of steps) {
    const s = step as Record<string, unknown> | string;
    if (s && typeof s === "object" && s.kind === "combo-ref") {
      const nested = allCombos.find((c) => c.name === s.comboName);
      if (nested) out.push(...collectLeaves(nested, allCombos, seen));
      continue;
    }
    const leaf = stepToLeaf(s);
    if (leaf) out.push(leaf);
  }
  return out;
}

/**
 * Returns every (secure combo, cloud provider) violation in the given combo set.
 * `getConnections(provider)` must return the provider's active connections.
 */
export async function findSecureCloudViolations(
  allCombos: readonly ComboLike[],
  getConnections: (provider: string) => Promise<ConnectionLike[]>
): Promise<SecureCloudViolation[]> {
  const violations: SecureCloudViolation[] = [];
  const cache = new Map<string, ConnectionLike[]>();
  for (const combo of allCombos) {
    if (!isComboTreeSecure(combo, allCombos)) continue;
    const reported = new Set<string>();
    for (const leaf of collectLeaves(combo, allCombos)) {
      let conns = cache.get(leaf.provider);
      if (!conns) {
        conns = await getConnections(leaf.provider);
        cache.set(leaf.provider, conns);
      }
      const relevant = leaf.connectionId ? conns.filter((c) => c.id === leaf.connectionId) : conns;
      const urls: Array<string | null> =
        relevant.length > 0 ? relevant.map(connectionBaseUrl) : [null];
      for (const url of urls) {
        const reason = classifyBaseUrl(leaf.provider, url);
        if (reason && !reported.has(leaf.provider)) {
          reported.add(leaf.provider);
          violations.push({ combo: String(combo.name ?? ""), provider: leaf.provider, reason });
        }
      }
    }
  }
  return violations;
}

/** DB-backed variant used by the combo routes. */
export async function findSecureCloudViolationsFromDb(
  allCombos: readonly ComboLike[]
): Promise<SecureCloudViolation[]> {
  const { getProviderConnections } = await import("@/lib/db/providers");
  return findSecureCloudViolations(allCombos, async (provider) => {
    const rows = await getProviderConnections({ provider, isActive: true });
    return rows as ConnectionLike[];
  });
}

export function describeSecureCloudViolations(v: SecureCloudViolation[]): string {
  return (
    "Secure combos may only route to local/private backends. Refused: " +
    v.map((x) => `${x.combo} -> ${x.provider} (${x.reason})`).join(", ")
  );
}
