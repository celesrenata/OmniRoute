---
title: Atomic Topology Telemetry Matrix (OR-ATOM-001 / M0 + M2)
---

# Atomic Topology Telemetry Matrix (OR-ATOM-001 / M0 + M2)

Status: M0 gate — evidence-only audit artifact; M2 — fleet telemetry endpoint
shipped (T005); OR-ATOM-005 / Step 5 — optional external metrics adapters
(Prometheus / InfluxDB2 / Grafana) + reconciliation block in the fleet
response (§7.2).
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

## 7.1 OR-ATOM-003 — what the visual scene derives from this matrix

The topology scene (`src/plugins/atomic-topology/scene/`) consumes the fleet
telemetry snapshot and renders **only** what this matrix says is available. The
deliberate visual treatments, mapped to the gaps above:

- **Per-runtime spin / TPS is not rendered from telemetry.** Output tok/s
  (`X-OmniRoute-Tokens-Per-Second`) is a per-request derived value
  (§2, "Derived (with provenance)") — it is never attributed to a runtime,
  node, or GPU in the topology snapshot. The scene therefore resolves the
  spin state to `mode: "unavailable"` and applies the neutral slow spin
  (0.1 rad/s reference) rather than scaling the spin rate from any fabricated
  per-runtime throughput. Fabricating a per-atom TPS from the request-level
  value would conflate request throughput with runtime utilization, which no
  producer in this repository can support.
- **GPU identity / VRAM / utilization / temperature / power** have zero
  producers (§7), so atom bodies and halos never encode GPU state; the
  "GPU runtime" node role renders its _observed_ provider-connection state
  (idle / active / degraded) with no device-metric overlay.
- **Job lanes are opaque HMAC fingerprints** (§5), so lane hues are a
  presentation choice: a stable hue per lane identity, with an honest neutral
  hue for `"unknown"` (lane not observed) — never a color that implies a
  specific provider or product.
- **Queue depth is per provider + connection**, not per atom, so the queue
  vibration visual is keyed to the observed per-connection queue where
  available and left neutral otherwise; there is no per-atom queue count.
- **Failed requests are transient events**, not route-health state: the red
  link flash is a short decaying transient from the request lifecycle event
  pool and returns to the neutral filament; there is no persistent red on a
  route because of a failed request.

These choices are pinned by the pure geometry/encoding tests in
`tests/unit/atomic-topology/` (including `geometry.test.ts` for the nucleus
cluster and shell configuration math).

## 7.2 OR-ATOM-005 / Step 5 — optional external adapters + reconciliation

Supersedes the "no external backend" invariant in §8 for the **server-side**
path only. The M0 audit (this document) found no telemetry backend **shipped in
the repository**; Step 5 adds **operator-configured** external adapters as
opt-in backends alongside the mandatory native adapter.

### 7.2.1 Shared metric mapping + allowlist (OR-ATOM-005 / Step 5)

`src/shared/topology/telemetry/providers/metricMapping.ts` is the single source
of truth for the allowlist; the three adapters only ever query names from this
set (the SSRF chokepoint). The allowlist is **keyed by upstream metric NAME,
not by normalized field**: DCGM and macmon feed the same normalized fields
(`gpu_util` / `gpu_temperature_c` / `gpu_power_w`), and a field-keyed map
silently dropped the DCGM names (a load-time duplicate-name guard throws on
collision).

The 11 allowlisted names:

| Upstream name                  | Normalized field        | Kind    | Unit        |
| ------------------------------ | ----------------------- | ------- | ----------- |
| `DCGM_FI_DEV_GPU_UTIL`         | `utilizationPercent`    | gpu     | percent     |
| `DCGM_FI_DEV_FB_USED`          | `vramUsedBytes`         | gpu     | bytes       |
| `DCGM_FI_DEV_FB_TOTAL`         | `vramTotalBytes`        | gpu     | bytes       |
| `DCGM_FI_DEV_GPU_TEMP`         | `temperatureC`          | gpu     | celsius     |
| `DCGM_FI_DEV_POWER_USAGE`      | `powerWatts`            | gpu     | watts       |
| `vllm:generation_tokens_total` | `outputTokensPerSecond` | runtime | tps (rate)  |
| `vllm:num_requests_waiting`    | `queuedJobs`            | runtime | nonNegative |
| `vllm:num_requests_running`    | `activeJobs`            | runtime | nonNegative |
| `macmon_gpu_scaled_ratio`      | `utilizationPercent`    | gpu     | percent     |
| `macmon_gpu_temp_celsius`      | `temperatureC`          | gpu     | celsius     |
| `macmon_gpu_power_watts`       | `powerWatts`            | gpu     | watts       |

Semantic invariants pinned by the adapter tests:

- **Scaling** routes through `scaleFieldValue()` in one place: DCGM VRAM
  MiB→bytes only when `vramUnit="mib"`; `macmon_gpu_scaled_ratio` 0..1 → 0..100
  with out-of-range values reported as **unknown (null)**, never clamped;
  everything else passes through.
- **Counter rate** (`vllm:generation_tokens_total` → `outputTokensPerSecond`)
  is a windowed rate from the shared `createCounterRateEngine()` — a counter
  reset (`value < previous`) returns **null** (never negative) and re-baselines
  state for the next read; bounded by `maxSeries` with LRU eviction. The
  gateway passes one engine per stateful adapter (`registerExternalAdapter`),
  so the production vLLM rate is no longer always-null.
- **Runtime-level facts only on runtime rows**: the vLLM counter and the
  scheduler gauges map onto a `kind:"runtime"` row only when a stable
  `runtime_id` identity is present — never split across GPUs, never fabricated.

### 7.2.2 Optional external metrics adapters

Three HTTP-based adapters are available, each registered **only** when the
operator configures it via env (opt-in; the native adapter always stays
registered, so a misconfigured or down external source never 503s the
endpoint):

| Adapter                               | Env                                                                                                                 | Identity join key                                                 | SSRF defense                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| Prometheus                            | `OMNIROUTE_FLEET_METRICS_SOURCE=prometheus` + `OMNIROUTE_FLEET_METRICS_URL`                                         | `host` label + `gpu_uuid` / `runtime_id` label                    | `fleetMetricsFetch` (host/port allowlist) |
| InfluxDB 2                            | `OMNIROUTE_FLEET_METRICS_SOURCE=influxdb2` + `OMNIROUTE_FLEET_METRICS_URL`                                          | `host_id` tag + `gpu_uuid` / `runtime_id` tag (row-based parsing) | `fleetMetricsFetch` (host/port allowlist) |
| Grafana (Prometheus datasources only) | `OMNIROUTE_FLEET_METRICS_SOURCE=grafana` + `OMNIROUTE_FLEET_METRICS_URL` + `OMNIROUTE_FLEET_METRICS_DATASOURCE_UID` | Same label keys as Prometheus (datasource-query API)              | `fleetMetricsFetch` (host/port allowlist) |

Registration lives in `registerExternalAdapter()` in
[src/shared/topology/telemetry/gatewayServer.ts](../../src/shared/topology/telemetry/gatewayServer.ts);
construction failures are caught and logged — the gateway keeps serving on the
native adapter. At most two providers register simultaneously (native + one
external). Per-provider **snapshot** failures remain graceful (timeout →
warning + drop, never 503): see `FleetTelemetryGateway.snapshot()` in
[src/shared/topology/telemetry/gateway.ts](../../src/shared/topology/telemetry/gateway.ts).

### 7.2.3 Reconciliation block in the fleet response

The `GET /api/telemetry/fleet` response now carries an additive
`reconciliation` block (OR-ATOM-005 / Step 5) alongside the raw `snapshot`.
The raw snapshot shape is unchanged, so existing consumers are unaffected.

```jsonc
{
  "snapshot": {/* FleetTelemetrySnapshot — unchanged */},
  "reconciliation": {
    "schemaVersion": 1,
    "capturedAt": 0,
    "gpuNodes": [/* ReconciledGpuNode[] */],
    "runtimeNodes": [/* ReconciledRuntimeNode[] */],
    "providerNodes": [/* ReconciledProviderNode[] */],
    "edges": [/* ReconciliationEdge[] */],
    "providerCentricFallback": false,
  },
}
```

The reconciliation is produced by `reconcileSnapshot()` (pure, deterministic) in
[src/shared/topology/telemetry/reconcile.ts](../../src/shared/topology/telemetry/reconcile.ts).
GPU / runtime nodes are emitted **only** for devices with a proven canonical ID
(`gpu:<host_id>:<device_uuid>`, `runtime:<host_id>:<runtime_id>`); cloud-only
providers stay provider atoms. Edges carry explicit provenance (basis +
sampledAt); a missing relationship is an **absent** edge, never a guessed one.

### 7.2.4 Renderer-neutral domain snapshot

`TopologySceneSnapshot` (src/shared/topology/domain/types.ts) gained an optional
`fleetTelemetry?: ReconciliationResult | null` field, carried additively by
`normalizeTopology()` when the caller passes a `reconciliation` input. The 2D
ReactFlow renderer reads only `nodes` / `links` and ignores the block; the 3D
atomic renderer consumes it to place GPU / runtime atoms alongside providers.
`null` / `undefined` → no device telemetry in this snapshot (absent, never an
empty claim).

### 7.2.5 InfluxDB 2 row-based identity parsing

The InfluxDB 2 adapter reads identity tags (`host_id`, `gpu_uuid`, `runtime_id`)
from column values in the JSON `rows` response (InfluxDB HTTP API v2 shape),
not from measurement names. Rows without a stable identity tag are dropped
(honest unknown). Metric fields are read from separate columns. The adapter
builds canonical `gpu:<host_id>:<uuid>` / `runtime:<host_id>:<id>` resource
IDs via `buildCanonicalResourceId()` — never display labels, never a bare
PCI index.

### 7.2.6 Staleness semantics

Staleness is computed upstream by `mergeSnapshots.mergeSnapshots()` (age >
3 × windowMs → `stale: true`, value decayed to `null`). `reconcileSnapshot()`
trusts the pre-computed `stale` flag rather than re-deriving age. A sample
without a known `windowMs` can only be judged stale by the explicit flag —
its sampling interval is unknown.

### 7.2.7 OR-ATOM-005 / T5.4 — renderer seam: measured motion + device band

The 3D atomic renderer (`src/plugins/atomic-topology/`) consumes
`snapshot.fleetTelemetry` (added in §7.2.4) at a single pure seam —
`resolveAtomDescriptors()` in
[src/plugins/atomic-topology/AtomicTopologyRenderer.tsx](../../src/plugins/atomic-topology/AtomicTopologyRenderer.tsx).
Everything downstream of the seam (scene, camera, labels, overlays) is
untouched; everything upstream (snapshot normalization) is unchanged.

**Device band — GPU/runtime atoms in outer rings.** Proven device nodes are
**not** fed into `snapshot.nodes` / `computeAtomicLayout` (provider atoms,
their rings, and the hub are byte-identical to the pre-telemetry baseline).
Instead a new pure
[`computeDeviceBandLayout()`](../../src/plugins/atomic-topology/layout.ts)
places each `gpu:`/`runtime:` atom in rings starting at
`maxProviderRing + 1` (device rings can never overlap a provider ring),
reusing the same `capacityAt` / `radiusAt` / `ringPhaseOffset` / `fnv1a`
helpers as the provider layout, so device rings share the provider ring
geometry and are deterministic under input reordering. Device atoms are
appended to the descriptor list after the provider map.

**Measured motion — spin/vibration binding.**

- Provider atoms: spin ← `reconciliation.providerNodes[providerId]
.outputTokensPerSecond.value`, vibration ← `.queuedJobs.value`.
- GPU device atoms: spin ← `gpu.outputTokensPerSecond ??
runtime.outputTokensPerSecond` (runtime wins when both exist — the
  runtime is the measured inference workload); vibration ←
  `runtime.queuedJobs` (GPU atoms have no own queue → "unavailable").
- Stale nodes, absent Observed values, or a missing/`null`
  `fleetTelemetry` → `mode: "unavailable"` (never a fabricated 0); a real
  observed 0 → `"measured-zero"` / `"zero"`.
- **Intentional behavior change (T5.4):** provider atoms that rendered
  `"unavailable"` spin before T5.4 now animate as `"measured"` when a real
  measured TPS exists in the fleet reconciliation. Without a
  `fleetTelemetry` block, every descriptor stays byte-identical to the M1
  baseline (pinned by `atomicSceneBridge.test.ts` "spin is unavailable
  regardless of request count").
- A device atom's color is driven by `deviceFacts.modelId` (a single
  observed model), or neutral when no model is observed — no hash guess.

**Fit radius.** `computeFitRadiusFromPositions()` gained an optional
`maxRadius` cap
([src/plugins/atomic-topology/cameraFit.ts](../../src/plugins/atomic-topology/cameraFit.ts));
the renderer passes `deviceBandCap = maxDeviceRingNorm + ATOM_FIT_MARGIN`
so outer device rings are not clipped by the provider-only default cap.
Without a device band the cap is `undefined` and fit math is unchanged.

**Badge freshness.** The "captured" badge prefers
`snapshot.fleetTelemetry?.capturedAt ?? snapshot.capturedAt` — the feed the
rendered numbers came from.

**Queue labeling (limiter ≠ scheduler).** The OmniRoute request
**rate-limiter** queue (basis `rateLimitManager:counts.QUEUED`, §7.2.3) and
the inference-**scheduler** queue are different systems and are labeled
separately in the tooltip: `queueRowLabel()`
([AtomicTooltip.tsx](../../src/plugins/atomic-topology/overlays/AtomicTooltip.tsx))
renders "Rate-limit queue" for provider/gpu atoms and "Sched. queue" for
runtime device atoms; the runtime facts block shows the raw "Queue depth"
row. Pinned by `tooltipQueueLabel.test.ts`.

**No-data policy (unchanged).** An unobserved value stays "unavailable" /
"no data" — never 0, never a decal; stale values are dropped upstream
(§7.2.6) and surface as "no data".

### 7.2.8 OR-ATOM-005 / T5.14b-2 — macmon (Apple SMC) GPU source

The shared allowlist
([metricMapping.ts](../../src/shared/topology/telemetry/providers/metricMapping.ts)
→ `ALLOWLISTED_METRIC_NAMES`, name→field) maps the macmon exporter's Apple
GPU gauges (Prometheus job `macmon_apple_gpu`) onto `kind:"gpu"` rows.
**Live-verified** against `127.0.0.1:9090` (2026-10-27): the source rows
carry the labels `hostname` (host key) and `uuid` (device key, e.g.
`Apple M5 Max`) plus a redundant `chip` label. The join keys are the
operator-configured `OMNIROUTE_FLEET_METRICS_LABEL_HOST` /
`OMNIROUTE_FLEET_METRICS_LABEL_GPU_DEVICE` (defaults `host` / `gpu_uuid`;
the deployed macmon source uses `hostname` / `uuid`).

| Upstream metric           | Field               | Scale                       | Notes                                              |
| ------------------------- | ------------------- | --------------------------- | -------------------------------------------------- |
| `macmon_gpu_scaled_ratio` | `gpu_util`          | ratio × 100 (0..1 → 0..100) | out-of-range values are **dropped**, never clamped |
| `macmon_gpu_temp_celsius` | `gpu_temperature_c` | pass-through (°C)           | same GPU row as util (shared join)                 |
| `macmon_gpu_power_watts`  | `gpu_power_w`       | pass-through (W)            | same GPU row as util (shared join)                 |

- **VRAM absent by design.** macmon (SMC) exposes **no** discrete GPU memory
  metric — Apple GPUs use shared system RAM — so macmon GPU rows carry no
  `gpu_vram_*` fields. The fields are _absent_, never a fabricated 0.
- **Four adjacent macmon families are deliberately OFF the allowlist** —
  unknown names are dropped silently, never fabricated: the deprecated
  `macmon_gpu_usage_ratio` alias, `macmon_gpu_active_ratio`,
  `macmon_gpu_freq_mhz`, and `macmon_gpu_ram_power_watts`.
- Scale is applied per source name in `scaleFieldValue()` /
  `ratioScaleFor()` (metricMapping.ts); the observation `basis` records the
  **raw upstream name** (e.g. `macmon_gpu_scaled_ratio`) so provenance shows
  the true source, not the normalized field.
- **Identity contract:** the canonical id `kind:host:id` splits only on `:`
  and `/`; spaces inside the device id are **legal** (`isUsableIdentity` /
  `hasForbiddenChars` reject only `:` and `/` — the live
  `uuid: "Apple M5 Max"` value is preserved in the id, e.g.
  `gpu:stabulous:Apple M5 Max`). A sample missing the device label is
  dropped, never guessed.

Pinned by `tests/unit/telemetry/telemetry-provider-prometheus-macmon.test.ts`
(12 cases — allowlist, mapping + scale, VRAM absence, excluded-family silent
drop, missing-uuid drop, out-of-range drop, DCGM/vLLM regression, space
identity contract); the prometheus + grafana provider suites carry the
11-name allowlist cardinality.

## 8. Centralized collection decision (M0)

- M2 shipped (T005): the endpoint itself exists — `GET /api/telemetry/fleet`
  is the management-gated, server-side bounded snapshot with the
  OmniRoute-native adapter (`src/shared/topology/telemetry/providers/omniroute.ts`)
  as the MANDATORY backend; no browser fan-out, no per-atom queries. It is the
  read-side of the "direct backend" decision below; device metrics stay `null`
  with documented unavailable provenance (§7). OR-ATOM-005 / Step 5 (§7.2)
  supersedes the "no external backend" finding: an opt-in operator-configured
  external adapter (Prometheus / InfluxDB2 / Grafana) may register alongside
  the native one; a misconfigured or down external source never 503s the
  endpoint — the native adapter keeps serving.
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
