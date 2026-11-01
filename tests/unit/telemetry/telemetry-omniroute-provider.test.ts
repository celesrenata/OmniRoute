/**
 * OmniRoute adapter tests (T005 / M2): works from fixtures only (AC2),
 * normalizes without fabricating — token counts never become tok/s,
 * GPU fields are always null with unavailable semantics, queued/active
 * jobs come from real counts (AC3/AC5).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACTIVE_JOBS_BASIS,
  GPU_UNAVAILABLE_BASIS,
  QUEUED_JOBS_BASIS,
  buildOmnirouteTelemetryProvider,
  validatedBaseUrl,
  type OmnirouteCallLogRow,
  type OmnirouteProducers,
} from "../../../src/shared/topology/telemetry/providers/omniroute";
import type { FleetResourceObservation } from "../../../src/shared/topology/telemetry/types";

const NOW = 1_700_000_000_000;

type BreakerEntry = { name: string; state: string };

interface FixtureParts {
  connections?: Array<{
    id: string;
    provider: string;
    // DUAL SHAPE (caseMapping.ts::rowToCamel, line 46): the app DB path
    // JSON.parses the column, so rows may carry the raw JSON string OR the
    // already-parsed object.
    providerSpecificData?: string | Record<string, unknown>;
    provider_specific_data?: string | Record<string, unknown>;
  }>;
  breakers?: BreakerEntry[] | Record<string, { state: string }>;
  rateLimits?: Record<string, { queued: number; running: number; executing: number }>;
  inflight?: number;
  rows?: OmnirouteCallLogRow[];
}

function makeProducers(parts: FixtureParts = {}): OmnirouteProducers {
  return {
    now: () => NOW,
    providerConnections: async () =>
      parts.connections ?? [
        { id: "c1", provider: "openai" },
        { id: "c2", provider: "anthropic" },
      ],
    circuitBreakerStatuses: async () => parts.breakers ?? [],
    rateLimitStatus: async () => parts.rateLimits ?? {},
    inflightRequestCount: async () => parts.inflight ?? 0,
    callLogRows: async () => parts.rows ?? [],
  };
}

function snapshotFor(
  resources: FleetResourceObservation[],
  providerKey: string
): FleetResourceObservation {
  const match = resources.find((r) => r.resourceId === `provider:${providerKey}`);
  assert.ok(match, `expected resource provider:${providerKey}`);
  return match;
}

describe("omniroute adapter: fixture-only, no live infrastructure", () => {
  it("produces a provider row per provider key with canonical ids (join-by-id)", async () => {
    const provider = buildOmnirouteTelemetryProvider(makeProducers());
    const snap = await provider.snapshot({ windowMs: 60_000 });
    assert.equal(snap.schemaVersion, 1);
    assert.equal(snap.capturedAt, NOW);
    assert.equal(snap.resources.length, 2);
    const ids = snap.resources.map((r) => r.resourceId).sort();
    assert.deepEqual(ids, ["provider:anthropic", "provider:openai"]);
    for (const r of snap.resources) {
      assert.equal(r.kind, "provider");
      assert.equal(r.providerId, r.resourceId.slice("provider:".length));
    }
  });

  it("one snapshot carries device + runtime + omniroute facts without browser fan-out (AC1)", async () => {
    // The adapter is the sole provider; the gateway/merge path joins whatever
    // snapshots exist by id — here we prove the omniroute facts sit alongside
    // device facts in a single merged resource set.
    const { mergeSnapshots } =
      await import("../../../src/shared/topology/telemetry/mergeSnapshots");
    const provider = buildOmnirouteTelemetryProvider(makeProducers({ inflight: 3 }));
    const snap = await provider.snapshot({ windowMs: 60_000 });
    const deviceSnap = {
      schemaVersion: 1,
      capturedAt: NOW,
      resources: [
        {
          resourceId: "gpu:h1:gpu-uuid",
          kind: "gpu" as const,
          hostId: "h1",
          deviceUuid: "gpu-uuid",
          utilizationPercent: {
            value: 80,
            source: "prometheus" as const,
            sampledAt: NOW,
          },
        },
      ],
    };
    const merged = mergeSnapshots([deviceSnap, snap], NOW);
    const kinds = merged.snapshot.resources.map((r) => r.kind).sort();
    assert.deepEqual(kinds, ["gpu", "provider", "provider"]);
  });
});

describe("omniroute adapter: counts vs tok/s (AC3)", () => {
  it("derives tok/s ONLY from TTFT-excluded call-log data, with windowMs + basis", async () => {
    // duration 1000ms, ttft 400ms → generation 600ms; 120 tokens → 200 tok/s
    const provider = buildOmnirouteTelemetryProvider(
      makeProducers({
        rows: [{ provider: "openai", model: "gpt-4o", duration: 1000, ttft: 400, tokensOut: 120 }],
      })
    );
    const snap = await provider.snapshot({ windowMs: 60_000 });
    const row = snapshotFor(snap.resources, "openai");
    assert.equal(row.outputTokensPerSecond?.value, 200);
    assert.equal(row.outputTokensPerSecond?.source, "omniroute-call-log");
    assert.equal(row.outputTokensPerSecond?.windowMs, 60_000);
    assert.equal(row.outputTokensPerSecond?.basis, "call-logs:max-ttft-excluded:1of1");
  });

  it("keeps tok/s null when TTFT is unknown — token counts are NOT labeled tok/s", async () => {
    // Non-streaming row: duration known, ttft null → no derivable generation
    // window. The token COUNT must not be reported as a rate.
    const provider = buildOmnirouteTelemetryProvider(
      makeProducers({
        rows: [{ provider: "openai", duration: 1000, ttft: null, tokensOut: 120 }],
      })
    );
    const snap = await provider.snapshot({ windowMs: 60_000 });
    const row = snapshotFor(snap.resources, "openai");
    assert.equal(row.outputTokensPerSecond?.value, null);
    assert.equal(row.outputTokensPerSecond?.basis, "call-logs:max-ttft-excluded:0of1");
  });

  it("picks the max derivable rate across rows in the window", async () => {
    const provider = buildOmnirouteTelemetryProvider(
      makeProducers({
        rows: [
          { provider: "openai", duration: 1000, ttft: 500, tokensOut: 50 }, // 100 tok/s
          { provider: "openai", duration: 2000, ttft: 500, tokensOut: 900 }, // 600 tok/s
        ],
      })
    );
    const snap = await provider.snapshot({ windowMs: 60_000 });
    const row = snapshotFor(snap.resources, "openai");
    assert.equal(row.outputTokensPerSecond?.value, 600);
  });

  it("tolerates only the query window for rows (producer contract)", async () => {
    let requestedWindow: number | null = null;
    const provider = buildOmnirouteTelemetryProvider({
      ...makeProducers(),
      callLogRows: async (w) => {
        requestedWindow = w;
        return [];
      },
    });
    await provider.snapshot({ windowMs: 12_345 });
    assert.equal(requestedWindow, 12_345);
  });
});

describe("omniroute adapter: jobs come from real counts", () => {
  it("queuedJobs sums the limiter QUEUED buckets for the provider key (0 when none)", async () => {
    const provider = buildOmnirouteTelemetryProvider(
      makeProducers({
        rateLimits: {
          "openai:conn-a": { queued: 2, running: 1, executing: 1 },
          "openai:conn-b": { queued: 3, running: 1, executing: 1 },
          "anthropic:conn-c": { queued: 7, running: 1, executing: 1 },
        },
      })
    );
    const snap = await provider.snapshot({ windowMs: 60_000 });
    const openai = snapshotFor(snap.resources, "openai");
    const anthropic = snapshotFor(snap.resources, "anthropic");
    assert.equal(openai.queuedJobs?.value, 5);
    assert.equal(openai.queuedJobs?.basis, QUEUED_JOBS_BASIS);
    assert.equal(anthropic.queuedJobs?.value, 7);
  });

  it("activeJobs uses the process-wide in-flight count with a documenting basis", async () => {
    const provider = buildOmnirouteTelemetryProvider(makeProducers({ inflight: 9 }));
    const snap = await provider.snapshot({ windowMs: 60_000 });
    const row = snapshotFor(snap.resources, "openai");
    assert.equal(row.activeJobs?.value, 9);
    assert.equal(row.activeJobs?.basis, ACTIVE_JOBS_BASIS);
    assert.equal(row.activeJobs?.source, "omniroute-live");
  });

  it("0 in-flight is reported as 0 (distinct from missing)", async () => {
    const provider = buildOmnirouteTelemetryProvider(makeProducers({ inflight: 0 }));
    const snap = await provider.snapshot({ windowMs: 60_000 });
    const row = snapshotFor(snap.resources, "openai");
    assert.ok(row.activeJobs !== undefined);
    assert.equal(row.activeJobs?.value, 0);
  });
});

describe("omniroute adapter: GPU fields are ALWAYS null, no fabrication (AC5)", () => {
  it("every gpu-backed field is null with unavailable provenance", async () => {
    const provider = buildOmnirouteTelemetryProvider(makeProducers());
    const snap = await provider.snapshot({ windowMs: 60_000 });
    for (const row of snap.resources) {
      for (const field of [
        "utilizationPercent",
        "vramUsedBytes",
        "vramTotalBytes",
        "temperatureC",
        "powerWatts",
      ] as const) {
        const o = row[field];
        assert.ok(
          o !== undefined,
          `${field} must be present (not missing) with unavailable semantics`
        );
        assert.equal(o.value, null);
        assert.equal(o.basis, GPU_UNAVAILABLE_BASIS);
      }
    }
  });
});

describe("omniroute adapter: breaker state + model facts", () => {
  it("surfaces non-closed breaker state via basis (bounded, non-PII tag)", async () => {
    const provider = buildOmnirouteTelemetryProvider(
      makeProducers({
        breakers: [
          { name: "openai", state: "OPEN" },
          { name: "anthropic", state: "CLOSED" },
        ],
        inflight: 4,
      })
    );
    const snap = await provider.snapshot({ windowMs: 60_000 });
    const openai = snapshotFor(snap.resources, "openai");
    const anthropic = snapshotFor(snap.resources, "anthropic");
    assert.match(openai.activeJobs?.basis ?? "", /breakers:open/);
    assert.equal(anthropic.activeJobs?.basis, ACTIVE_JOBS_BASIS); // closed → untouched
  });

  it("accepts record-form breaker statuses too", async () => {
    const provider = buildOmnirouteTelemetryProvider(
      makeProducers({ breakers: { openai: { state: "DEGRADED" } }, inflight: 1 })
    );
    const snap = await provider.snapshot({ windowMs: 60_000 });
    assert.match(
      snapshotFor(snap.resources, "openai").activeJobs?.basis ?? "",
      /breakers:degraded/
    );
  });

  it("enriches modelId from call-log rows (stable fact, no PII)", async () => {
    const provider = buildOmnirouteTelemetryProvider(
      makeProducers({ rows: [{ provider: "openai", model: "gpt-4o" }] })
    );
    const snap = await provider.snapshot({ windowMs: 60_000 });
    assert.equal(snapshotFor(snap.resources, "openai").modelId, "gpt-4o");
  });
});

describe("omniroute adapter: probe + abort + identity hygiene", () => {
  it("probe reports availability from the producer", async () => {
    const provider = buildOmnirouteTelemetryProvider(makeProducers());
    const status = await provider.probe();
    assert.equal(status.available, true);
    assert.equal(status.checkedAt, NOW);
  });

  it("probe reports unavailable with the producer error message", async () => {
    const provider = buildOmnirouteTelemetryProvider({
      ...makeProducers(),
      providerConnections: async () => {
        throw new Error("db offline");
      },
    });
    const status = await provider.probe();
    assert.equal(status.available, false);
    assert.equal(status.message, "db offline");
  });

  it("aborted signal: probe reports aborted, snapshot rejects", async () => {
    const provider = buildOmnirouteTelemetryProvider(makeProducers());
    const ac = new AbortController();
    ac.abort();
    const status = await provider.probe(ac.signal);
    assert.equal(status.available, false);
    assert.equal(status.message, "aborted");
    await assert.rejects(() => provider.snapshot({ windowMs: 60_000 }, ac.signal), /aborted/);
  });

  it("skips connection rows with unusable provider keys (no partial ids leak)", async () => {
    const provider = buildOmnirouteTelemetryProvider(
      makeProducers({
        connections: [
          { id: "ok", provider: "openai" },
          { id: "bad1", provider: "" }, // empty key
          { id: "bad2", provider: "bad:key" }, // would break canonical shape
          { id: "dup", provider: "openai" }, // duplicate key
        ],
      })
    );
    const snap = await provider.snapshot({ windowMs: 60_000 });
    assert.equal(snap.resources.length, 1);
    assert.equal(snap.resources[0].resourceId, "provider:openai");
  });
});

describe("omniroute adapter: baseUrls join fact (OR-ATOM-009.2)", () => {
  async function providerRowFor(
    connections: FixtureParts["connections"]
  ): Promise<FleetResourceObservation> {
    const provider = buildOmnirouteTelemetryProvider(makeProducers({ connections }));
    const snap = await provider.snapshot({ windowMs: 60_000 });
    const row = snap.resources.find((r) => r.resourceId === "provider:openai");
    assert.ok(row, "expected provider:openai row");
    return row;
  }

  // REGRESSION (2026-10-30, live pod ~00:32Z): the app DB path
  // (getProviderConnections → rowToCamel, src/lib/db/providers.ts:324)
  // delivers the opaque blob as CAMEL CASE `providerSpecificData`. The
  // adapter once read snake_case `provider_specific_data` only → never
  // present on app rows → no baseUrls → 0 proven provider_runtime edges
  // (live: runtime node LIVE with endpointPort, edges=0).
  it("carries baseUrls from the EXACT app-DB row shape (camelCase providerSpecificData)", async () => {
    const row = await providerRowFor([
      {
        id: "c1",
        provider: "openai",
        providerSpecificData: JSON.stringify({
          baseUrl: "http://192.168.133.3:2701/v1",
          api_key: "[REDACTED:openai_compatible]",
        }),
      },
    ]);
    assert.deepEqual(row.baseUrls, ["http://192.168.133.3:2701/v1"]);
    // The raw JSON blob (with its credential fields) never rides on the
    // observation — exact-string absence of the credential value.
    assert.ok(
      !JSON.stringify(row).includes("[REDACTED:openai_compatible]"),
      "credential value must never leak into the resource"
    );
  });

  // REGRESSION (2026-10-30, live pod ~02:00Z, image 3.8.52-oratom0092-2d1d8cf):
  // caseMapping.ts::rowToCamel (line 46) JSON.parses the
  // `provider_specific_data` column for the app DB path, so the row arrives
  // with `providerSpecificData` as an ALREADY-PARSED OBJECT. 2d1d8cf fixed the
  // Casing but not the TYPE — `validatedBaseUrl` only accepted `string`, so the
  // live `provider:vllm` row (object shape) produced baseUrls=[] →
  // reconciliation.edges=0 while the runtime node was LIVE.
  it("carries baseUrls from a PARSER-OBJECT providerSpecificData (app DB path via rowToCamel)", async () => {
    const row = await providerRowFor([
      {
        id: "c1",
        provider: "openai",
        providerSpecificData: {
          baseUrl: "http://192.168.133.3:2701/v1",
          api_key: "sk-fake-never-leave",
        },
      },
    ]);
    assert.deepEqual(row.baseUrls, ["http://192.168.133.3:2701/v1"]);
    // The blob's credential field must never leave the module — exact-string
    // absence of the raw value in the serialized resource.
    assert.ok(
      !JSON.stringify(row).includes("sk-fake-never-leave"),
      "credential value must never leak into the resource"
    );
  });

  it("accepts a PARSER-OBJECT provider_specific_data (snake_case casing)", async () => {
    const row = await providerRowFor([
      {
        id: "c1",
        provider: "openai",
        provider_specific_data: { baseUrl: "http://192.168.133.3:2701/v1" },
      },
    ]);
    assert.deepEqual(row.baseUrls, ["http://192.168.133.3:2701/v1"]);
  });

  it("omits object-shape rows with missing / non-string / invalid / array baseUrl (defensive)", async () => {
    assert.equal(validatedBaseUrl({ api_key: "sk-x" }), null, "missing baseUrl → null");
    assert.equal(validatedBaseUrl({ baseUrl: 2701 }), null, "non-string baseUrl → null");
    assert.equal(validatedBaseUrl({ baseUrl: "" }), null, "empty baseUrl → null");
    assert.equal(validatedBaseUrl({ baseUrl: "not-a-url" }), null, "unparseable URL → null");
    assert.equal(
      validatedBaseUrl({ baseUrl: "ftp://192.168.133.3/v1" }),
      null,
      "non-http(s) scheme → null"
    );
    assert.equal(
      validatedBaseUrl({ baseUrl: ["http://192.168.133.3:2701/v1"] }),
      null,
      "array baseUrl → null"
    );
    // A full snapshot whose only row has a bad object-shape blob → no baseUrls.
    const row = await providerRowFor([
      {
        id: "c1",
        provider: "openai",
        providerSpecificData: { api_key: "sk-y" },
      },
    ]);
    assert.equal(row.baseUrls, undefined);
  });

  it("merges MIXED shapes for the same provider key (string + object rows, deduped)", async () => {
    const row = await providerRowFor([
      {
        id: "c1",
        provider: "openai",
        providerSpecificData: JSON.stringify({ baseUrl: "http://192.168.133.3:2701/v1" }),
      },
      {
        id: "c2",
        provider: "openai",
        providerSpecificData: { baseUrl: "http://10.1.1.12:2701/v1" },
      },
    ]);
    assert.deepEqual(row.baseUrls, ["http://192.168.133.3:2701/v1", "http://10.1.1.12:2701/v1"]);
  });

  it("also accepts the legacy snake_case row shape (driver/cache paths)", async () => {
    // Some driver/cache paths leave snake_case on the row — accept either
    // casing rather than trusting one shape (precedent:
    // src/lib/db/quotaSnapshots.ts:60).
    const row = await providerRowFor([
      {
        id: "c1",
        provider: "openai",
        provider_specific_data: JSON.stringify({
          baseUrl: "http://192.168.133.3:2701/v1",
        }),
      },
    ]);
    assert.deepEqual(row.baseUrls, ["http://192.168.133.3:2701/v1"]);
  });

  it("aggregates ALL validated baseUrls across every connection row of a provider key (live: vllm on 3 hosts)", async () => {
    const row = await providerRowFor([
      // Live mirror: one provider key, three distinct endpoints
      // (esnixi-5090 / gremlin-4070ti / stabulous-m5max).
      {
        id: "c1",
        provider: "openai",
        providerSpecificData: JSON.stringify({ baseUrl: "http://192.168.133.3:2701/v1" }),
      },
      {
        id: "c2",
        provider: "openai",
        providerSpecificData: JSON.stringify({ baseUrl: "http://10.1.1.12:2701/v1" }),
      },
      {
        id: "c3",
        provider: "openai",
        providerSpecificData: JSON.stringify({ baseUrl: "http://192.168.133.2:7777/v1" }),
      },
    ]);
    // ONE provider atom (dedup by key) carrying the FULL set — first row
    // wins NOTHING: rows excluded by the dedup still contribute.
    assert.deepEqual(row.baseUrls, [
      "http://192.168.133.3:2701/v1",
      "http://10.1.1.12:2701/v1",
      "http://192.168.133.2:7777/v1",
    ]);
  });

  it("dedupes identical baseUrls and caps the set at 16 (first-seen order)", async () => {
    const connections: NonNullable<FixtureParts["connections"]> = [
      // 17 distinct URLs → 17 unique, cap 16.
      {
        id: "c0",
        provider: "openai",
        providerSpecificData: JSON.stringify({ baseUrl: "http://10.0.0.1:8000/v1" }),
      },
      ...Array.from({ length: 17 }, (_, i) => ({
        id: `c${i + 1}`,
        provider: "openai",
        providerSpecificData: JSON.stringify({ baseUrl: `http://10.0.0.${i + 2}:8000/v1` }),
      })),
    ];
    const row = await providerRowFor(connections);
    assert.equal(row.baseUrls?.length, 16, "baseUrls capped at 16");
    assert.deepEqual(row.baseUrls?.[0], "http://10.0.0.1:8000/v1");
    assert.equal(
      row.baseUrls?.includes("http://10.0.0.18:8000/v1"),
      false,
      "17th distinct URL dropped by the cap"
    );
  });

  it("omits baseUrls when providerSpecificData is invalid JSON", async () => {
    const row = await providerRowFor([
      { id: "c1", provider: "openai", providerSpecificData: "{not-json" },
    ]);
    assert.equal(row.baseUrls, undefined);
  });

  it("omits baseUrls when providerSpecificData is absent", async () => {
    const row = await providerRowFor([{ id: "c1", provider: "openai" }]);
    assert.equal(row.baseUrls, undefined);
  });

  it("omits baseUrls when the JSON value is not a string", async () => {
    const row = await providerRowFor([
      { id: "c1", provider: "openai", providerSpecificData: JSON.stringify({ baseUrl: 1234 }) },
    ]);
    assert.equal(row.baseUrls, undefined);
  });

  it("omits baseUrls when the JSON has no baseUrl key", async () => {
    const row = await providerRowFor([
      { id: "c1", provider: "openai", providerSpecificData: JSON.stringify({ other: "x" }) },
    ]);
    assert.equal(row.baseUrls, undefined);
  });

  it("omits baseUrls when the value is not a parseable http(s) URL", async () => {
    const row = await providerRowFor([
      {
        id: "c1",
        provider: "openai",
        providerSpecificData: JSON.stringify({ baseUrl: "not a url" }),
      },
    ]);
    assert.equal(row.baseUrls, undefined);
  });

  it("omits baseUrls for non-http(s) schemes", async () => {
    const row = await providerRowFor([
      {
        id: "c1",
        provider: "openai",
        providerSpecificData: JSON.stringify({ baseUrl: "ftp://h1:21/x" }),
      },
    ]);
    assert.equal(row.baseUrls, undefined);
  });

  it("skips invalid rows but keeps valid baseUrls from sibling rows", async () => {
    const row = await providerRowFor([
      { id: "c1", provider: "openai", providerSpecificData: "{not-json" },
      {
        id: "c2",
        provider: "openai",
        providerSpecificData: JSON.stringify({ baseUrl: "http://192.168.133.3:2701/v1" }),
      },
    ]);
    assert.deepEqual(row.baseUrls, ["http://192.168.133.3:2701/v1"]);
  });

  it("carries ONLY validated baseUrls — credential values NEVER leave the DB row", async () => {
    const fakeApiKey = "[REDACTED:auth_header]";
    const fakeSecret = "sec-FAKE-CREDENTIAL-DO-NOT-LEAK";
    const psd = JSON.stringify({
      baseUrl: "http://192.168.133.3:2701/v1",
      api_key: fakeApiKey,
      secret: fakeSecret,
    });
    const row = await providerRowFor([{ id: "c1", provider: "openai", providerSpecificData: psd }]);
    assert.deepEqual(row.baseUrls, ["http://192.168.133.3:2701/v1"]);
    // Serialize the whole resource; the credential values must be absent.
    const serialized = JSON.stringify(row);
    assert.ok(!serialized.includes(fakeApiKey), "api_key value must never leak");
    assert.ok(!serialized.includes(fakeSecret), "secret value must never leak");
  });
});
