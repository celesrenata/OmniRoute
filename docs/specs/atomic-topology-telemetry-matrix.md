---
title: Atomic Topology Telemetry Matrix (OR-ATOM-001 / M0 + M2)
---

# Atomic Topology Telemetry Matrix (OR-ATOM-001 / M0 + M2)

Status: M0 gate — evidence-only audit artifact; M2 — fleet telemetry endpoint
shipped (T005).
Scope owner: T003. This document records what the repository ships, what it can
derive, and what is unavailable. It makes no runtime measurements and fabricates
no telemetry values.

## 1. Scope and audit boundary

- Repository root of this worktree (OmniRoute monorepo snapshot, Node v24.21.0).
  Audit boundary is source code plus repository configuration; no deployment,
  no live gateway, and no external system was inspected.
- Every claim below carries `path:line` evidence verified in this session.
  "Available" = shipped and reachable from source. "Derived (with provenance)" =
  computable from shipped values, and the derivation formula is stated.
  "Unavailable" = no producer exists in the repository.
- Fleet telemetry stack claim verified: `grep -inE 'prometheus|influx|grafana|node.exporter|telegraf' package.json package-lock.json`
  returned zero matches, so the repository ships no Prometheus client, no InfluxDB
  client, no Grafana integration, no exporter/agent binary, and no embedded
  inference-runtime telemetry stack. The only `wireguard` references are proxy
  protocol support for user-supplied proxy subscriptions, not a telemetry
  transport: [src/lib/proxySubscription/needsCore.ts](../../src/lib/proxySubscription/needsCore.ts#L17-L19).

## 2. Capability matrix

| Capability                        | Status                    | Producer (path:line)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider identity                 | Available                 | `provider_connections.provider` column: [src/lib/db/core.ts](../../src/lib/db/core.ts#L220-L265)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Provider aliases                  | Available                 | `resolveProviderAlias`: [open-sse/services/providerAlias.ts](../../open-sse/services/providerAlias.ts#L38); alias search pool `nvidia`/`nvidia_nim`: [src/sse/services/auth.ts](../../src/sse/services/auth.ts#L937-L952)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Provider labels                   | Available                 | `display_name`, `name`, `group` on `provider_connections`: [src/lib/db/core.ts](../../src/lib/db/core.ts#L220-L265)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Health (provider breaker)         | Available                 | states `CLOSED/DEGRADED/OPEN/HALF_OPEN`: [src/shared/utils/circuitBreaker.ts](../../src/shared/utils/circuitBreaker.ts#L130-L137); status struct: same file [L204-L216](../../src/shared/utils/circuitBreaker.ts#L204-L216)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Health (local nodes)              | Available                 | `HealthStatus` with `isHealthy`, `responseTimeMs`, `consecutiveFailures`: [src/lib/localHealthCheck.ts](../../src/lib/localHealthCheck.ts#L20-L28); exported via `getAllHealthStatuses`: [src/lib/localHealthCheck.ts](../../src/lib/localHealthCheck.ts#L214)                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Health (per-connection)           | Available                 | `test_status`, `error_code`, `last_error`, `rate_limited_until`, `backoff_level` on `provider_connections`: [src/lib/db/core.ts](../../src/lib/db/core.ts#L234-L244)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Last used                         | Available                 | `last_used_at` on `provider_connections`: [src/lib/db/core.ts](../../src/lib/db/core.ts#L255); `lastUsed` bookkeeping on TLS transport leases: [open-sse/utils/tlsClient.ts](../../open-sse/utils/tlsClient.ts#L149-L151)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Errors                            | Available                 | `error_code`, `last_error`, `last_error_at`, `last_error_type` on `provider_connections`: [src/lib/db/core.ts](../../src/lib/db/core.ts#L235-L239); `error_summary` on `call_logs`: [src/lib/db/core.ts](../../src/lib/db/core.ts#L370)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Active requests                   | Available                 | dedup in-flight count: [src/app/api/monitoring/health/route.ts](../../src/app/api/monitoring/health/route.ts#L319-L322); rate-limiter `queued/running/executing` per limiter key: [open-sse/services/rateLimitManager.ts](../../open-sse/services/rateLimitManager.ts#L1050-L1061); pending-request tracking: [open-sse/handlers/chatCore.ts](../../open-sse/handlers/chatCore.ts#L942-L944)                                                                                                                                                                                                                                                                                                                             |
| Model IDs                         | Available                 | `model` / `requested_model` on `call_logs`: [src/lib/db/core.ts](../../src/lib/db/core.ts#L349-L350); `model` on `usage_history`: [src/lib/db/core.ts](../../src/lib/db/core.ts#L319)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Lanes                             | Derived (with provenance) | admission "lanes" are opaque HMAC fairness fingerprints per session with `waiting` counts: [src/lib/monitoring/observability.ts](../../src/lib/monitoring/observability.ts#L14-L27). Provenance: lane key = `resolveSessionId` fingerprint of a session, never credentials. Not a topology object; joins to accounts only through the admission runtime snapshot.                                                                                                                                                                                                                                                                                                                                                        |
| Token counts                      | Available                 | `tokens_input`, `tokens_output`, `tokens_cache_read`, `tokens_cache_creation`, `tokens_reasoning` on `usage_history`: [src/lib/db/core.ts](../../src/lib/db/core.ts#L326-L330); mirrored `tokens_in`/`tokens_out` on `call_logs`: [src/lib/db/core.ts](../../src/lib/db/core.ts#L355-L356)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Output tok/s                      | Derived (with provenance) | `tokensPerSecond = outputTokens / ((totalMs - ttftMs) / 1000)`, TTFT always excluded: [open-sse/utils/generationThroughput.ts](../../open-sse/utils/generationThroughput.ts#L8-L25); emitted as `X-OmniRoute-Tokens-Per-Second`: [src/shared/constants/headers.ts](../../src/shared/constants/headers.ts#L20) and [src/domain/omnirouteResponseMeta.ts](../../src/domain/omnirouteResponseMeta.ts#L200-L207). Omitted when TTFT is unknown (non-streaming).                                                                                                                                                                                                                                                              |
| Queue depth                       | Available                 | Bottleneck `counts().QUEUED/RUNNING/EXECUTING` per provider+connection (+model where scoped): [open-sse/services/rateLimitManager.ts](../../open-sse/services/rateLimitManager.ts#L1036-L1044); limiter key shape `provider:connectionId[:model]`: [open-sse/services/rateLimitManager.ts](../../open-sse/services/rateLimitManager.ts#L582-L597)                                                                                                                                                                                                                                                                                                                                                                        |
| GPU/device identity               | Unavailable               | no producer in repository (see §7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| VRAM / utilization / temp / power | Unavailable               | no producer in repository (see §7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Durable event IDs                 | Available                 | `call_logs.id` (TEXT PK, stable) + `correlation_id`: [src/lib/db/core.ts](../../src/lib/db/core.ts#L344-L379); `usage_history.id` (AUTOINCREMENT): [src/lib/db/core.ts](../../src/lib/db/core.ts#L317); per-attempt pending request id, reused across combo attempts sharing one `correlationId`: [src/lib/usage/usageHistory.ts](../../src/lib/usage/usageHistory.ts#L210-L223)                                                                                                                                                                                                                                                                                                                                         |
| Route/resource IDs                | Available                 | `provider_connections.id` (TEXT PK): [src/lib/db/core.ts](../../src/lib/db/core.ts#L221); `provider_nodes.id`: [src/lib/db/core.ts](../../src/lib/db/core.ts#L271); `api_keys.id` + `machine_id`: [src/lib/db/core.ts](../../src/lib/db/core.ts#L300-L308); `combos.id`: [src/lib/db/core.ts](../../src/lib/db/core.ts#L291-L298); `quota_snapshots.provider` + `connection_id` + `window_key`: [src/lib/db/core.ts](../../src/lib/db/core.ts#L485-L496)                                                                                                                                                                                                                                                                 |
| Fleet telemetry snapshot          | Available                 | M2 endpoint `GET /api/telemetry/fleet` (M2, T005): one server-side bounded snapshot, management-gated, single native backend, no browser fan-out. Query `windowMs` (default 300000 ms, bounds 1…777600000) + `providers`/`hosts`/`gpus` lists (caps 64/64/256). Auth: [src/app/api/telemetry/fleet/route.ts](../../src/app/api/telemetry/fleet/route.ts#L34-L36); query mapping: [src/shared/topology/telemetry/httpQuery.ts](../../src/shared/topology/telemetry/httpQuery.ts); gateway: [src/shared/topology/telemetry/gateway.ts](../../src/shared/topology/telemetry/gateway.ts); native adapter: [src/shared/topology/telemetry/providers/omniroute.ts](../../src/shared/topology/telemetry/providers/omniroute.ts) |

## 3. Producer paths, exact units, semantics

- Provider circuit breaker — in-process state machine, persisted to
  `domain_circuit_breakers (name, state, failure_count, last_failure_time, options)`:
  [src/lib/db/core.ts](../../src/lib/db/core.ts#L463-L469). Units: `failure_count` in
  failures, `last_failure_time` in epoch ms, `retryAfterMs` in ms.
  [src/shared/utils/circuitBreaker.ts](../../src/shared/utils/circuitBreaker.ts#L204-L216).
- Per-connection cooldown — `rate_limited_until` (ISO timestamp),
  `backoff_level` (integer exponent). Semantics: connection skipped while
  `rate_limited_until > now`; terminal states `banned`/`expired`/`credits_exhausted`
  never become cooldowns (project rule, `AGENTS.md` §Resilience → Connection Cooldown).
- Model lockout — per (provider, connection, model), `remainingMs` in ms,
  `lockedAt` ISO: [open-sse/services/accountFallback.ts](../../open-sse/services/accountFallback.ts#L1094-L1128).
- Rate limiter queue — Bottleneck counts are raw queue lengths (requests),
  keyed by `provider:connectionId` or `provider:connectionId:model`
  (codex, antigravity, gemini, github): [open-sse/services/rateLimitManager.ts](../../open-sse/services/rateLimitManager.ts#L582-L597).
- Quota snapshots — `remaining_percentage` (REAL, 0–100 where the source reports it),
  `window_duration_ms` (ms), `next_reset_at` (ISO); written to
  `quota_snapshots`: [src/lib/db/core.ts](../../src/lib/db/core.ts#L485-L496);
  monitor states `starting|idle|healthy|warning|exhausted|error`:
  [open-sse/services/quotaMonitor.ts](../../open-sse/services/quotaMonitor.ts#L52-L72).
  Source ordering and the "unknown is not exhausted" rule:
  [`docs/OMNIROUTE_QUOTA_TELEMETRY.md`](../OMNIROUTE_QUOTA_TELEMETRY.md#L15-L17).
- Local node health — `GET /models` probe, 5 s timeout, backoff
  30 s → 60 s → 120 s → 300 s; `responseTimeMs` in ms; state kept in memory:
  [src/lib/localHealthCheck.ts](../../src/lib/localHealthCheck.ts#L1-L35).
- In-flight requests — dedup module `getInflightCount()` exposed on the health
  payload: [src/app/api/monitoring/health/route.ts](../../src/app/api/monitoring/health/route.ts#L319-L322).
- Web-session pools — `PoolStats.sessions.{total,active,cooldown,dead}`,
  `requests.{total,success,rate429,otherErrors}`, `throughput` (req/s, string),
  per-session `inflight`: [open-sse/services/sessionPool/types.ts](../../open-sse/services/sessionPool/types.ts#L59-L88);
  aggregated health `down/degraded/healthy`: [open-sse/services/webSessionPoolHealth.ts](../../open-sse/services/webSessionPoolHealth.ts#L1-L17).
- Compression memo stats — in-process size/hits/misses/hitRate on
  `GET /api/monitoring/compression`: [src/app/api/monitoring/compression/route.ts](../../src/app/api/monitoring/compression/route.ts#L21-L38).
- Per-request tokens — from upstream `usage` objects; cache and reasoning
  token columns persist alongside: [src/lib/db/core.ts](../../src/lib/db/core.ts#L326-L330).

## 4. Freshness / staleness

| Surface                       | Freshness mechanism                                                                                                                                                                                                                                                 | Evidence                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/monitoring/health`  | SWR: 1 s TTL (`HEALTH_PAYLOAD_TTL_MS`), expired entries served immediately and refreshed in background; deep probe verdict 30 s TTL, opt-in via `DEEP_HEALTH_CHECK_ENABLED=1` + `?deep=1`                                                                           | [src/app/api/monitoring/health/route.ts](../../src/app/api/monitoring/health/route.ts#L23-L48)                                                                                                                                                                                                               |
| Local node health             | Poll backoff 30 s–300 s; `lastCheck` recorded per node                                                                                                                                                                                                              | [src/lib/localHealthCheck.ts](../../src/lib/localHealthCheck.ts#L32-L34)                                                                                                                                                                                                                                     |
| Pending requests              | In-memory FIFO; sweep every 300 s; max age 3600 s; bounded to 5000 details                                                                                                                                                                                          | [src/lib/usage/usageHistory.ts](../../src/lib/usage/usageHistory.ts#L225-L227)                                                                                                                                                                                                                               |
| Quota snapshots               | Poll per monitor with `nextPollAt`/`nextPollDelayMs`; `lastPolledAt` on each snapshot                                                                                                                                                                               | [open-sse/services/quotaMonitor.ts](../../open-sse/services/quotaMonitor.ts#L58-L68)                                                                                                                                                                                                                         |
| `call_logs` / `usage_history` | Durable rows written at request completion; latency from `duration`/`latency_ms` (ms); windowed aggregation by consumer (e.g. health matrix ranges `1h                                                                                                              | 24h                                                                                                                                                                                                                                                                                                          | 7d  | 30d`) | [src/lib/db/core.ts](../../src/lib/db/core.ts#L354); [src/lib/monitoring/providerHealthMatrix.ts](../../src/lib/monitoring/providerHealthMatrix.ts#L11) |
| Model lockouts / breakers     | Read-time computation against `Date.now()`; lazy recovery (expired `OPEN` refreshes to `HALF_OPEN` on status read)                                                                                                                                                  | [open-sse/services/accountFallback.ts](../../open-sse/services/accountFallback.ts#L1108-L1128); [src/shared/utils/circuitBreaker.ts](../../src/shared/utils/circuitBreaker.ts#L130-L137)                                                                                                                     |
| `GET /api/telemetry/fleet`    | Force-dynamic route (no Next cache): server-side gateway merges the native snapshot per request, short-TTL in-memory cache (10 s, LRU, 16 entries) keyed by the full query; staleness per field vs the provider's own `capturedAt` (> 3 × windowMs → `stale: true`) | [src/app/api/telemetry/fleet/route.ts](../../src/app/api/telemetry/fleet/route.ts#L32); [src/shared/topology/telemetry/gateway.ts](../../src/shared/topology/telemetry/gateway.ts#L29-L32); [src/shared/topology/telemetry/mergeSnapshots.ts](../../src/shared/topology/telemetry/mergeSnapshots.ts#L69-L80) |

No repository component emits monotonic, gap-free event streams: durability is
row-per-request, and the in-memory pending map is the only live in-flight view.

## 5. Canonical identity / join gaps

- Primary join keys: `provider_connections.id` ⇄ `usage_history.connection_id`
  ([src/lib/db/core.ts](../../src/lib/db/core.ts#L320)), `api_keys.id` ⇄
  `usage_history.api_key_id` / `call_logs.api_key_id`
  ([src/lib/db/core.ts](../../src/lib/db/core.ts#L324-L325),
  [src/lib/db/core.ts](../../src/lib/db/core.ts#L365)).
- Gap 1 — breaker scope: `domain_circuit_breakers.name` is the provider string,
  not a connection id, so breaker state joins at provider level only.
  [src/lib/db/core.ts](../../src/lib/db/core.ts#L463-L469).
- Gap 2 — limiter key: rate-limiter keys are composite strings
  `provider:connectionId[:model]` (codex/antigravity/gemini/github vary),
  reconstructed by `getLimiterKey`, not stored as rows; a consumer must rebuild
  them to join queues to connections.
  [open-sse/services/rateLimitManager.ts](../../open-sse/services/rateLimitManager.ts#L582-L597).
- Gap 3 — lanes: admission lane keys are opaque HMAC fingerprints
  (`resolveSessionId`); they cannot be joined to `api_keys.id` or
  `provider_connections.id` without the admission runtime.
  [src/lib/monitoring/observability.ts](../../src/lib/monitoring/observability.ts#L14-L27).
- Gap 4 — alias fan-out: a stored `provider` may be an alias
  (`nvidia` vs `nvidia_nim`); joins across `usage_history.provider` and breaker
  names must go through `resolveProviderAlias`
  ([open-sse/services/providerAlias.ts](../../open-sse/services/providerAlias.ts#L38),
  [src/sse/services/auth.ts](../../src/sse/services/auth.ts#L937-L952)).
- Gap 5 — per-attempt vs per-request IDs: each combo attempt has its own pending
  request id, but `correlation_id` is stable across attempts of one client
  request; durable dedup must key on `correlation_id`, not the attempt id.
  [src/lib/usage/usageHistory.ts](../../src/lib/usage/usageHistory.ts#L210-L223).

## 6. Auth / privacy constraints

- `GET /api/monitoring/health`: anonymous callers receive only
  `status` + `setupComplete` (liveness view); the full payload (providers,
  breakers, rate limits, sessions, admission) requires a management principal —
  see `publicHealthView` and the `requireManagementAuth` wiring:
  [src/app/api/monitoring/health/route.ts](../../src/app/api/monitoring/health/route.ts#L52-L66).
- `GET /api/providers/health-matrix`: hard-gated by
  `requireManagementAuth`: [src/app/api/providers/health-matrix/route.ts](../../src/app/api/providers/health-matrix/route.ts#L7-L8).
- `GET /api/monitoring/compression`: no auth (low-card in-process counters only):
  [src/app/api/monitoring/compression/route.ts](../../src/app/api/monitoring/compression/route.ts#L21).
- `GET /api/telemetry/fleet` (M2): hard-gated by `requireManagementAuth` BEFORE
  any data access (401 fallback; `?windowMs`/list validation → 400). The snapshot
  carries only provenance-carrying numbers — no credentials; GPU fields are
  emitted `null` with unavailable basis, never fabricated:
  [src/app/api/telemetry/fleet/route.ts](../../src/app/api/telemetry/fleet/route.ts#L34-L36),
  [src/shared/topology/telemetry/httpQuery.ts](../../src/shared/topology/telemetry/httpQuery.ts).
- Credentials at rest: `api_key`/`access_token` on `provider_connections` are
  encrypted at rest (project hard rule #1); a telemetry plane must never copy
  those columns into events. `call_logs` may carry request/response body
  artifacts (`artifact_relpath`, `has_request_body`, `has_response_body`)
  depending on operator logging settings — a collector that reads `call_logs`
  directly inherits that operator policy.
- Log export destinations are operator-owned external systems; the only
  repository-shipped destination is BigQuery:
  [src/lib/logExport/registry.ts](../../src/lib/logExport/registry.ts#L12).

## 7. Unavailable telemetry (no repository producer)

- GPU/device identity, VRAM, GPU utilization, temperature, power draw: zero
  producers found (searches for `vram`, `gpu_util`, `temperature`, `power_draw`,
  `nvidia-smi`, `nvml` across `src/` and `open-sse/` match only provider-name
  handling for the `nvidia`/`nvidia_nim` cloud provider, e.g.
  [src/sse/services/auth.ts](../../src/sse/services/auth.ts#L937-L939)). Local
  inference runtimes (e.g. Ollama-class nodes registered in `provider_nodes`)
  are probed for `/models` liveness only
  ([src/lib/localHealthCheck.ts](../../src/lib/localHealthCheck.ts#L1-L17)); no device
  metrics are scraped or persisted.
- No push channel exists: no Prometheus exposition endpoint, no OTLP exporter,
  no agent process, no WireGuard-managed telemetry network.

## 8. Centralized collection decision (M0)

- M2 shipped (T005): the endpoint itself now exists — `GET /api/telemetry/fleet`
  is the management-gated, server-side bounded snapshot with EXACTLY ONE
  registered backend, the OmniRoute-native adapter (`src/shared/topology/telemetry/providers/omniroute.ts`);
  no browser fan-out, no per-atom queries, no external backend. It is the
  read-side of the "direct backend" decision below; device metrics stay `null`
  with documented unavailable provenance (§7).
- Direct backend is the only option supported by repository evidence: the
  gateway already exposes authenticated, server-side JSON snapshots
  (`/api/monitoring/health`, `/api/providers/health-matrix`,
  `/api/monitoring/compression`) over HTTP and durable SQLite rows
  (`usage_history`, `call_logs`, `quota_snapshots`, `domain_circuit_breakers`,
  `domain_lockout_state`). A collector should read these directly — polling the
  HTTP surfaces or, when co-located, the SQLite DB — and never fan out through
  browsers.
- Grafana is rejected as a telemetry backend for M0: no repository component
  speaks Prometheus/Influx/Loki (zero dependency matches; the only Grafana
  references are a log-export destination doc comment at
  [`src/lib/logExport/registry.ts`](../../src/lib/logExport/registry.ts#L4) and an
  operator UI note at
  `src/app/(dashboard)/dashboard/log-export/components/DestinationFormModal.tsx:52`
  (written in code form: its parentheses are not link-safe).
  If an operator later supplies a Grafana server, it may serve only as a
  read-only server-side rendering facade over the direct backend data; it must
  never sit in the write path and never become a browser fan-out target.
- Event IDs for durable dedup: `call_logs.id` or `correlation_id`; per-attempt
  pending ids are not durable-dedup keys (Gap 5).

## 9. M0 decision and operator prerequisites

M2 shipped (T005): the management-gated `GET /api/telemetry/fleet` endpoint is
live — server-side bounded snapshot, single native backend, GPU fields honest
`null` (§2, §4, §6, §7).

M0 verdict: the telemetry substrate for an atomic topology matrix is
**partially available**. Provider-connection-level telemetry (identity, aliases,
health states, last-used, errors, active/queued requests, model IDs, token
counts, per-request tok/s, durable IDs, quota snapshots) is collectable today
from the direct backend. Device-level telemetry for inference runtimes
(GPU identity, VRAM, utilization, temperature, power) is unavailable and must
be declared `unknown` in any topology matrix until a producer exists.

Operator prerequisites before M0 sign-off:

1. Confirm which local inference runtimes are in scope and confirm they expose
   no device metrics to the gateway (evidence: `provider_nodes` schema has no
   device-metric columns, [src/lib/db/core.ts](../../src/lib/db/core.ts#L270-L282)).
2. Authorize the collection mode: HTTP polling of the management-gated
   endpoints (management principal required — since M2 this is satisfied by
   `GET /api/telemetry/fleet`) or co-located SQLite reads.
3. Set the staleness policy per surface using §4 TTLs/backoffs (health 1 s SWR,
   local-node backoff up to 300 s, pending sweep 300 s, quota poll cadence).
4. Approve the identity-join mapping in §5 (breaker at provider scope, limiter
   keys reconstructed, lanes opaque, alias resolution mandatory).
5. Acknowledge that GPU/device rows in the topology matrix are `unknown` by
   construction until a device-metric producer ships; no value may be
   fabricated to fill them.

## 10. Verification notes

- M0 (T003): no production code was modified; the only change in that task was
  this file plus the `docs/specs/` directory creation.
- M2 (T005): production code added — `src/app/api/telemetry/fleet/route.ts`,
  `src/shared/topology/telemetry/gatewayServer.ts`,
  `src/shared/topology/telemetry/httpQuery.ts` (the shared topology telemetry
  contracts pre-existed). Unit tests: `tests/unit/telemetry/` —
  `telemetry-fleet-query-mapping.test.ts` (8 cases),
  `telemetry-fleet-route.test.ts` (6 source-scan invariants),
  `telemetry-fleet-gateway.test.ts` (12 behavioral cases) — focused suite 27/27
  passing, `tsc --noEmit` clean.
- `GET /api/telemetry/fleet?windowMs=…&windowMs=…`: the first value wins
  (`URLSearchParams.get` semantics) — pinned by the query-mapping test.
- `prompt.md` in the worktree root is empty; repository files were used as the
  source of truth, per task instructions.
