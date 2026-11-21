/**
 * chatCore Codex service-tier resolvers (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Pure, side-effect-free extraction of the two service-tier resolvers that used to be inline
 * closures at the top of handleChatCore. Both are no-ops for non-Codex providers; for Codex they
 * read the client-supplied `service_tier`, normalize it, and fall back to the per-connection
 * request defaults. Behaviour is byte-identical to the previous inline code — the handler now binds
 * `provider`/`providerSpecificData` once and delegates here.
 */

import {
  getCodexRequestDefaults,
  normalizeCodexServiceTier,
  type CodexServiceTier,
} from "@/lib/providers/requestDefaults";

/** The effective service tier carried through a request: "standard" or a normalized Codex tier. */
export type EffectiveServiceTier = "standard" | CodexServiceTier;

/**
 * Resolve the effective service tier for the *outbound* request. Non-Codex/Bedrock providers are
 * always "standard". For Codex, a valid client `service_tier` wins; otherwise the per-connection
 * request default applies, falling back to "standard". For Bedrock, a valid client `service_tier`
 * (only "flex" / "default" are routed) wins; anything else is "standard".
 */
export function resolveEffectiveServiceTier(
  provider: string | null | undefined,
  providerSpecificData: unknown,
  requestBody?: unknown
): EffectiveServiceTier {
  const providerKey = typeof provider === "string" ? provider.trim().toLowerCase() : "";
  if (providerKey !== "codex" && providerKey !== "bedrock") return "standard";
  const requestRecord =
    requestBody && typeof requestBody === "object" && !Array.isArray(requestBody)
      ? (requestBody as Record<string, unknown>)
      : {};
  const rawServiceTier = requestRecord.service_tier;
  if (typeof rawServiceTier === "string" && rawServiceTier.trim().length > 0) {
    const normalizedServiceTier = normalizeCodexServiceTier(rawServiceTier);
    if (normalizedServiceTier) {
      // Bedrock: only "flex" and "default" are routable tiers. A Codex alias
      // (e.g. "fast"→"priority") or the real Bedrock "priority"/"reserved" is
      // not routed by us → fall through to standard.
      if (
        providerKey === "bedrock" &&
        normalizedServiceTier !== "flex" &&
        normalizedServiceTier !== "default"
      ) {
        return "standard";
      }
      return normalizedServiceTier;
    }
  }
  if (providerKey === "bedrock") return "standard";
  return getCodexRequestDefaults(providerSpecificData).serviceTier ?? "standard";
}

/**
 * Resolve the service tier *reported by the upstream* response. Non-Codex/Bedrock providers and
 * missing payloads return null (caller keeps the prior value). For Codex, reads a top-level
 * `service_tier` and otherwise descends through nested `response` envelopes up to `maxDepth`
 * levels. For Bedrock, the same walk captures only the tiers we route ("flex" / "default"); a
 * reported tier we do not route (e.g. "priority") is ignored and the walk continues.
 */
export function resolveReportedServiceTier(
  provider: string | null | undefined,
  payload?: unknown,
  maxDepth = 3
): EffectiveServiceTier | null {
  const providerKey = typeof provider === "string" ? provider.trim().toLowerCase() : "";
  if (
    maxDepth <= 0 ||
    (providerKey !== "codex" && providerKey !== "bedrock") ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const rawServiceTier = record.service_tier;
  if (typeof rawServiceTier === "string" && rawServiceTier.trim().length > 0) {
    const normalizedServiceTier = normalizeCodexServiceTier(rawServiceTier);
    if (normalizedServiceTier) {
      // Bedrock: only "flex" and "default" are routable tiers; a reported
      // "priority" (75% premium we do not route) must not fabricate a tier —
      // keep descending / fall back to the prior value.
      if (
        providerKey === "bedrock" &&
        normalizedServiceTier !== "flex" &&
        normalizedServiceTier !== "default"
      ) {
        return resolveReportedServiceTier(provider, record.response, maxDepth - 1);
      }
      return normalizedServiceTier;
    }
  }
  return resolveReportedServiceTier(provider, record.response, maxDepth - 1);
}
