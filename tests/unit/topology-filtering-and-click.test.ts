import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const homePageClientSrc = readFileSync(
  fileURLToPath(new URL("../../src/app/(dashboard)/dashboard/HomePageClient.tsx", import.meta.url)),
  "utf8"
);

const providerTopologySrc = readFileSync(
  fileURLToPath(new URL("../../src/app/(dashboard)/home/ProviderTopology2D.tsx", import.meta.url)),
  "utf8"
);

// Renderer host (plugin boundary). It owns the Next router/intl context and
// delegates navigation to the 2D renderer via the `onProviderClick` option —
// the 2D renderer itself is context-free (mounted out-of-tree in its own
// createRoot, where useRouter/useTranslations throw).
const providerTopologyHostSrc = readFileSync(
  fileURLToPath(new URL("../../src/app/(dashboard)/home/ProviderTopology.tsx", import.meta.url)),
  "utf8"
);

test("HomePageClient filters out providers where all connections are deactivated (isActive === false)", () => {
  assert.match(
    homePageClientSrc,
    /hasActiveConn\s*=\s*providerConnections\.some\(\s*\(c\)\s*=>\s*normalizeProviderId\(c\.provider\)\s*===\s*canonicalProviderId\s*&&\s*c\.isActive\s*!==\s*false\s*\)/,
    "HomePageClient must exclude providers whose connections are all inactive/disabled"
  );

  assert.match(
    homePageClientSrc,
    /\}, \[providerStats, providerMetrics, providerNodes, providerConnections\]\);/,
    "topologyProviders must depend on providerConnections to reflect switch toggle state changes"
  );
});

test("ProviderTopology configures click-to-navigate on provider nodes", () => {
  assert.match(
    providerTopologyHostSrc,
    /router\.push\(`\/dashboard\/providers\/\${providerId}`\)/,
    "host must navigate to the clicked provider page /dashboard/providers/${providerId}"
  );

  assert.match(
    providerTopologyHostSrc,
    /onProviderClick:/,
    "host must delegate provider navigation to the renderer via onProviderClick"
  );

  assert.match(
    providerTopologySrc,
    /onNodeClick=\{handleNodeClick\}/,
    "ProviderTopology2D must pass handleNodeClick to FlowCanvas"
  );

  assert.match(
    providerTopologySrc,
    /cursor-pointer hover:scale-105/,
    "ProviderNode must render with a pointer cursor and visual hover effect"
  );
});
