import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const homePageClientSrc = readFileSync(
  fileURLToPath(new URL("../../src/app/(dashboard)/dashboard/HomePageClient.tsx", import.meta.url)),
  "utf8"
);

const providerTopologySrc = readFileSync(
  fileURLToPath(new URL("../../src/app/(dashboard)/home/ProviderTopology.tsx", import.meta.url)),
  "utf8"
);

// OR-ATOM-001 (M1): the live-snapshot active-set derivation moved from the component
// into the renderer-neutral normalizer that the host feeds to the renderer plugin.
const normalizeTopologySrc = readFileSync(
  fileURLToPath(new URL("../../src/shared/topology/domain/normalizeTopology.ts", import.meta.url)),
  "utf8"
);

test("home topology uses provider-metrics topology.errorProvider instead of re-deriving from stale lastErrorAt", () => {
  assert.match(
    homePageClientSrc,
    /errorProvider:\s*normalizeProviderId\(data\.topology\?\.errorProvider\)/,
    "HomePageClient should trust /api/provider-metrics topology.errorProvider"
  );

  const localTopologyDerivation = homePageClientSrc.match(
    /const \{ lastProvider, errorProvider \} = useMemo[\s\S]*?\}, \[providerMetrics\]\);/
  );
  assert.equal(
    localTopologyDerivation,
    null,
    "HomePageClient must not re-derive topology error state from providerMetrics.lastErrorAt"
  );
});

test("ProviderTopology treats live activeRequests as the current snapshot without frontend timeout filtering", () => {
  assert.doesNotMatch(
    providerTopologySrc,
    /FE_ACTIVE_TIMEOUT_MS|FE_ACTIVE_TICK_MS|firstSeenRef|setInterval\(/,
    "ProviderTopology must not expire long-running live requests on its own"
  );

  assert.match(
    normalizeTopologySrc,
    /function buildActiveSet\(activeRequests: Array<\{ provider\?: string \}>\): Set<string>/,
    "activeSet should be derived directly from activeRequests/current live snapshot"
  );
  assert.match(
    normalizeTopologySrc,
    /for \(const request of activeRequests\) {/,
    "the active set must be built by scanning the current live activeRequests, not a cache"
  );
});
