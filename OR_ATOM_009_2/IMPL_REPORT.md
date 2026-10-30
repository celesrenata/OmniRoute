# OR-ATOM-009.2 — Proven provider→runtime fleet edges

Worktree: `atomic-0092-proven-routing` · Branch base: as confirmed by parent
Status: implemented, tested, docs updated. Not pushed (parent owns git remote ops).

## What changed, per file

### Production code (6 files, all under `src/shared/topology/telemetry/`)

1. **`types.ts`** — added two _join-only_ fields to `FleetResourceObservation`:
   - `baseUrl?: string` (provider atoms) — the configured upstream base URL.
     Used only to reconcile a proven `provider_runtime` edge; never rendered,
     never parsed for credentials.
   - `endpointPort?: number` (runtime atoms) — the runtime's metrics-endpoint
     port, derived only from a fully-parsed `<hostId>:<port>` instance label.
     Join-only; absent when unconfigured/invalid.

2. **`provenance.ts`** — the Zod `resourceSchema` gained the same two optional
   fields so they survive the fleet snapshot round-trip without widening the
   validation surface. `baseUrl: z.string().refine(isNonEmptyId).optional()`,
   `endpointPort: z.number().int().positive().optional()`.

3. **`providers/omniroute.ts`** —
   - `OmnirouteProviderConnectionRow` gained an optional `providerSpecificData?:
string` (the raw opaque `provider_specific_data` JSON blob).
   - New exported `validatedBaseUrl(providerSpecificData: string | undefined):
string | null`. The DB column may hold credentials, so ONLY a top-level
     **string** `baseUrl` that parses as an `http(s)` URL is returned. Malformed
     JSON, a non-string value, a non-URL string, or a non-http(s) scheme all
     return `null` (join fact stays absent — never guessed). No other field of
     the blob ever leaves the module.
   - The provider row carries `baseUrl` only when `validatedBaseUrl` is
     non-null; `createProductionOmnirouteProvider` maps only
     `provider_specific_data` (the opaque string) — credential columns are
     never mapped.

4. **`providers/prometheus.ts`** — runtime samples now derive
   `endpointPort` from the standard Prometheus `instance` label via
   `endpointPortFromInstanceLabel(instanceLabel, hostId)`. It is set ONLY when
   the label is exactly `<hostId>:<port>` where the host part equals the proven
   `hostId` and the port is an integer in `[1, 65535]`. Port-less instance,
   host mismatch, IPv6 endpoint, or non-numeric port → `undefined` (absent,
   never guessed).

5. **`mergeSnapshots.ts`** — the fill-gap merge now carries `baseUrl` and
   `endpointPort` with the same semantics as every other field (most-recent
   non-undefined value per `resourceId`; absent stays absent).

6. **`reconcile.ts`** — added the `provider_runtime` edge emitter. For each
   provider node with a `baseUrl`: parse the URL, require `http(s)`, require a
   non-IPv6 hostname, resolve the port (explicit or protocol default
   `https→443` / `http→80`). For each runtime, emit one edge only when
   `url.hostname === runtime.hostId && urlPort === runtime.endpointPort`.
   Each distinct (provider, runtime) pair yields exactly one edge — an N:M
   match is N edges; duplicate observations dedupe. Edge basis:
   `"configured provider baseUrl host:port match"`. Absent = unattached; we
   never join by display name.

   **Bug found & fixed during implementation:** the first draft used
   `url.host.includes(":")` to skip IPv6, but `url.host` for `http://h1:2701`
   is `h1:2701` (hostname+port), so it skipped **all** host:port URLs and no
   edges were ever emitted. Corrected to `url.hostname.includes(":")` (an
   IPv6 literal is bracketed, e.g. `[::1]`, and its hostname contains `:`).
   The N:M test caught this immediately.

### Tests (3 files, extended in place)

- **`tests/unit/telemetry/telemetry-reconcile.test.ts`** — new describe
  `provider_runtime join` (10 cases): match → exactly one edge with correct
  source/target/relation/basis/sampledAt; no baseUrl → no edge; no
  endpointPort → no edge; port mismatch → no edge; host mismatch → no edge;
  IPv6 baseUrl → no edge; protocol defaults (https→443, http→80); N:M (two
  providers, one runtime → two distinct edges); duplicate observations dedupe
  to one edge; runtime_device/runtime_model edges undisturbed. Also verifies
  `providerNodes[].baseUrl` and `runtimeNodes[].endpointPort` carry through.

- **`tests/unit/telemetry/telemetry-provider-prometheus.test.ts`** — new
  describe `runtime endpointPort join fact` (7 cases): instance
  `<hostId>:<port>` matching → endpointPort set; no port → omitted; host
  mismatch → omitted; IPv6 → omitted; non-numeric port → omitted; no instance
  label → omitted; port 0 (out of range) → omitted.

- **`tests/unit/telemetry/telemetry-omniroute-provider.test.ts`** — new
  describe `baseUrl join fact` (8 cases): valid baseUrl plumbed; invalid JSON
  → omitted; absent → omitted; non-string → omitted; no baseUrl key → omitted;
  non-URL string → omitted; non-http(s) scheme → omitted; **credential-leak
  test** — a `providerSpecificData` blob with fake `api_key`/`secret` values
  yields a row with only `baseUrl`, and `JSON.stringify(row)` never contains
  the credential strings (asserted by exact substring).

### Docs (1 file)

- **`docs/specs/atomic-topology-telemetry-matrix.md`** — added
  §7.2.9 "OR-ATOM-009.2 — proven provider→runtime edges (join rule)"
  documenting the join rule, the two join facts, the match rule, the q27/vLLM
  relabel contract, and the "no visual change required" finding; plus a
  verification note in §10.

## Renderer finding (why no visual change was needed)

The 3D atomic renderer **already consumes** `reconciliation.edges` and
`providerNodes` (see §7.2.7 of the matrix doc). The new `provider_runtime`
edge and the two join-fact fields flow through that **existing** seam — no
renderer code change was required. `AtomicTelemetryDiagnostics.tsx`
already counts `provider_runtime` edges (line 142) and surfaces the count in
the `?topology-dev=1` diagnostics payload (line 352), so the new edges are
already visible in diagnostics. Step 7 (per-runtime provenance surfacing) was
skipped as optional to keep scope tight; the edge-count wiring is sufficient
for now.

Demo snapshots carry no `baseUrl`, so no new edges appear in the demo harness —
its `expectedReconciled` expectations are unchanged and pass.

## q27 alias status (P1)

**CONFIRMED PRESENT** — no fix needed. `metricMapping.ts` already has both
families in the allowlist:

- `vllm:generation_tokens_total` / `vllm:num_requests_waiting` /
  `vllm:num_requests_running`
- `q27:generation_tokens_total` / `q27:num_requests_waiting` /
  `q27:num_requests_running`

All six map to the same `MetricField` values
(`runtime_output_tokens_total`, `runtime_scheduler_waiting`,
`runtime_scheduler_running`). The prometheus test suite already asserts
q27 alias coverage (allowlist cardinality + `mappingForMetric` round-trip).

## Prometheus relabel contract (exact, for the infra side)

For the live esnixi vLLM (dflash2 spec-decoding build) emitting `q27:`
prefix, the Prometheus relabel config must produce these labels on runtime
samples:

| Label                  | Value                                                       | Example              |
| ---------------------- | ----------------------------------------------------------- | -------------------- |
| `hostname` (or `host`) | **bare IP / host** matching the provider `baseUrl` host     | `192.168.133.3`      |
| `runtime_id`           | the runtime slug                                            | `rt-0`               |
| `instance`             | `<hostId>:<port>` — host part must exactly equal `hostname` | `192.168.133.3:2701` |

Rules:

- `hostname` is the bare host (no port, no scheme, no IPv6 brackets). It must
  match the provider `baseUrl` hostname for the `provider_runtime` edge to
  form. It is **never** guessed from `instance`.
- `instance` is consumed **only** for the endpoint-port join: it must be
  exactly `<hostId>:<port>` where the host part equals the proven `hostname`
  and the port is an integer in `[1, 65535]`. IPv6 endpoints, extra colons,
  a host mismatch, or a non-numeric port all leave `endpointPort` undefined
  (no edge).
- The `q27:*` metric names must appear in the allowlist alongside the
  canonical `vllm:*` names (already present in `metricMapping.ts`).

## Test results

All run in the worktree with `node --import tsx/esm --test <file>`.

| Test file                                         | Tests   | Pass    | Fail  |
| ------------------------------------------------- | ------- | ------- | ----- |
| `telemetry-reconcile.test.ts`                     | 25      | 25      | 0     |
| `telemetry-provider-prometheus.test.ts`           | 31      | 31      | 0     |
| `telemetry-omniroute-provider.test.ts`            | 25      | 25      | 0     |
| **Full `tests/unit/telemetry/` (15 files)**       | **274** | **274** | **0** |
| **Full `tests/unit/atomic-topology/` (28 files)** | **397** | **397** | **0** |

Key files run individually: `telemetry-reconcile.test.ts` (25/25),
`telemetry-provider-prometheus.test.ts` (31/31),
`telemetry-omniroute-provider.test.ts` (25/25),
`demoHarness.test.ts` (8/8), `atomSignals.test.ts` (21/21),
`atomicDiagnosticsAtoms.test.ts` (8/8),
`atomicDiagnosticsRouteLinks.test.ts` (6/6).

## Verification

- **typecheck:core** — clean for my files. The full `typecheck:core` output
  contains pre-existing errors in unrelated files
  (`open-sse/services/rateLimitManager.ts`, `src/lib/db/quotaPools.ts`,
  `src/lib/db/scripts.ts`, …). `grep "topology/telemetry"` on the output
  returns **zero** matches — my files are clean.
- **ESLint** (scoped to my 9 changed files) — exit 0, no findings.
- **Prettier** — applied via `--write` to 3 files
  (`telemetry-reconcile.test.ts`, `telemetry-omniroute-provider.test.ts`,
  `atomic-topology-telemetry-matrix.md`); all 10 files now pass
  `prettier --check`.
- **`npm run check:docs-all`** — 5 STRICT drifts, all pre-existing on base
  (stale "193 migrations" in README.md / AGENTS.md / llm.txt — my diff does
  not touch those files). My doc is not implicated.

## Deviations

- Step 7 (per-runtime provenance in `?topology-dev=1` diagnostics payload)
  was skipped — it was optional ("only if trivially safe") and the existing
  edge-count wiring already surfaces the new edges in diagnostics.
- No renderer file was modified (no visual change needed — existing seam
  already consumes `provider_runtime` edges).

---

## Fix round — baseUrls (pushed 2026-10-30, `2d1d8cfce`)

Follow-up to the initial implementation: the join fact was a singular
`baseUrl?: string` read from only the FIRST connection row per provider key
(and only the camelCase `providerSpecificData` field). A single provider key
can front several upstream endpoints (live 2026-10-30: vllm on 3 hosts), so
the provider→runtime reconcile silently attached at most one host per key —
the other hosts' runtimes stayed unattached even though their provider was
configured to reach them.

### Design decision: `baseUrl?: string` → `baseUrls?: string[]`

The field is now a **set** of validated base URLs per provider key. The
migration was chosen over alternatives (e.g. keep singular + pick best, or
parallel `baseUrls` list alongside `baseUrl`) because:

- The join fact is inherently a SET — a provider key with N endpoint rows
  has N legitimate upstream hosts, not "one canonical host."
- `ReconciledProviderNode` and the plugin/renderer consume only the join
  result (edges), not the field itself — a consumer sweep
  (`grep -rn "baseUrl" src/plugins/atomic-topology/`) returned 0 hits, so
  the migration is contained to the telemetry module.
- The array shape mirrors the source data (N rows per key) directly,
  eliminating the "first row wins" implicit selection that caused the bug.

### Per-file changes

| File                                                    | Change                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`                                              | `baseUrl?: string` → `baseUrls?: string[]` on `FleetResourceObservation`                                                                                                                                                                                                                                                                                                                           |
| `provenance.ts`                                         | `resourceSchema`: `baseUrls: z.array(z.string().refine(isNonEmptyId)).max(16).optional()`                                                                                                                                                                                                                                                                                                          |
| `providers/omniroute.ts`                                | New `providerSpecificDataBlob()` reads BOTH casings (`providerSpecificData` + `provider_specific_data`); new exported `aggregateProviderBaseUrls(rows)` validates every row per key, dedupes, first-seen order, caps at 16 (`MAX_PROVIDER_BASE_URLS`). The per-key `rowsByKey` Map is built once before the dedup loop, so rows excluded by the atom-dedup still contribute to the aggregated set. |
| `mergeSnapshots.ts`                                     | `baseUrls` merge is a UNION (deduped, `prev` order first) — a fact observed by any snapshot keeps its provenance.                                                                                                                                                                                                                                                                                  |
| `reconcile.ts`                                          | `ReconciledProviderNode.baseUrls?: string[]`; node-copy line updated; edge loop iterates every URL in `baseUrls`, emitting one edge per distinct `(provider, runtime)` pair regardless of matching-URL count.                                                                                                                                                                                      |
| `telemetry-omniroute-provider.test.ts`                  | 6 new tests: dual-casing (snake_case fallback), multi-URL aggregation, dedup (same URL twice → 1), 16-cap (first-16 kept, 17th dropped), invalid-among-valid (1 valid + 2 invalid → 1 URL), `aggregateProviderBaseUrls` direct unit test.                                                                                                                                                          |
| `telemetry-reconcile.test.ts`                           | All 10 `baseUrl` literals migrated to `baseUrls: [...]`; node assertion → `deepEqual(pNode.baseUrls, [...])`.                                                                                                                                                                                                                                                                                      |
| `docs/specs/atomic-topology-telemetry-matrix.md` §7.2.9 | Provider-side join-fact bullet rewritten (set, dual-casing, `aggregateProviderBaseUrls`, 16-cap); match-rule paragraph updated ("for each URL in `baseUrls`").                                                                                                                                                                                                                                     |

### Test results

| Suite                                              | Tests | Pass | Fail |
| -------------------------------------------------- | ----- | ---- | ---- |
| `tests/unit/telemetry/` (full dir, 15 files)       | 296   | 296  | 0    |
| `tests/unit/atomic-topology/` (full dir, 28 files) | 396   | 396  | 0    |
| `live-request-lifecycle-hook.test.tsx` (Vitest)    | 7     | 7    | 0    |

The 6 tests that failed on `fe6d45c` (the initial commit, before the fix)
now pass: `dual-casing snake_case`, `multi-URL aggregation`, `dedup`,
`16-cap`, `invalid-among-valid`, and `aggregateProviderBaseUrls` direct test.

### Verification

- **typecheck:core** — `grep "topology/telemetry"` returns zero matches;
  all remaining errors are pre-existing in `open-sse/` and `src/lib/db/`.
- **ESLint** (scoped to all 7 changed TS files) — exit 0, no findings.
- **`check:docs-all`** — 5 STRICT drifts, all pre-existing on base
  (stale migration/MCP-tool counts in README/AGENTS/llm.txt/MCP docs);
  none touch the telemetry matrix doc.
- **`git ls-remote origin fix/atomic-0092-proven-routing`** —
  `2d1d8cfceae58ec2f2401a01904dd3188048a1d4`, matching local HEAD.

---

## P3c deploy-3 — surgical fix: accept parsed-object `providerSpecificData`

(New commit on `fix/atomic-0092-proven-routing`, 2026-10-30 ~02:13Z)

### Live symptom (pod 3.8.52-oratom0092-2d1d8cf, ~02:00Z)

`providerNodes=18` including `provider:vllm`, but `provider:vllm` carried NO
`baseUrls` → `reconciliation.edges=[]`; the expected
`provider:vllm -> runtime:192.168.133.3:q27` edge was MISSING while the
runtime node was LIVE (TPS live, endpointPort=2701).

### Root cause (verified)

`src/lib/db/caseMapping.ts::rowToCamel` (line 46) JSON.parses the
`provider_specific_data` column on the app DB path
(`getProviderConnections → getRawProviderConnections → rowToCamel →
createLazyRowProxy`), so rows arrive with `providerSpecificData` as an
ALREADY-PARSED OBJECT. `2d1d8cf` fixed the casing (read both
`providerSpecificData` and `provider_specific_data`) but NOT the type:
`validatedBaseUrl` only accepted `string | undefined`, so a parsed object
failed the `typeof ... !== "string"` guard → returned null → no baseUrls →
no join → no edges.

### Fix (surgical — 2 files)

- `src/shared/topology/telemetry/providers/omniroute.ts`:
  - `OmnirouteProviderConnectionRow.providerSpecificData` /
    `provider_specific_data` widened `string` →
    `string | Record<string, unknown>` (dual-shape comment citing
    caseMapping.ts:46).
  - `validatedBaseUrl()` input widened to
    `string | Record<string, unknown> | undefined`; string → `JSON.parse`
    (existing try/catch), object → used directly (no re-parse), else null.
    Extraction unchanged: non-empty string `baseUrl`, `new URL(...)`
    http(s)-validated. Credential-safety comment preserved — only the
    validated baseUrl leaves the module. Exported signature stays
    backward-compatible (strings still work).
  - `providerSpecificDataBlob()` now returns
    `string | Record<string, unknown> | undefined`, forwarding BOTH casings
    AS-IS (string or non-array object), no coercion.
  - Production row mapper in `createProductionOmnirouteProvider()` widened:
    previously forwarded ONLY `c.provider_specific_data` (snake, string),
    so app-DB rows (camel, object) had the blob dropped entirely — now picks
    either casing, object or string, as-is.
- `tests/unit/telemetry/telemetry-omniroute-provider.test.ts`: TDD
  object-shape regression + snake object + defensive (missing/non-string/
  invalid/array baseUrl) + mixed string+object dedupe; FixtureParts widened
  to dual shape.

### TDD evidence

- BEFORE fix (on 2d1d8cf): `tests/unit/telemetry/telemetry-omniroute-provider.test.ts`
  → `tests 33 / pass 30 / fail 3`. Failing lines:
  - `✖ carries baseUrls from a PARSER-OBJECT providerSpecificData (app DB path via rowToCamel)` —
    `actual: undefined, expected: [ 'http://192.168.133.3:2701/v1' ]`
  - `✖ accepts a PARSER-OBJECT provider_specific_data (snake_case casing)` — same undefined.
  - `✖ merges MIXED shapes for the same provider key (string + object rows, deduped)` —
    actual only had the string-shape URL, missing the object-shape URL.
    (credential-absence and defensive tests passed pre-fix because the object
    shape produced no baseUrls at all; they still guard post-fix.)
- AFTER fix: `tests 33 / pass 33 / fail 0`.

### Verification (all in P = .claude/worktrees/atomic-0092-proven-routing)

- `node --import tsx/esm --test "tests/unit/telemetry/*.test.ts"` → 300/300 pass.
- `node --import tsx/esm --test "tests/unit/atomic-topology/*.test.ts*"` →
  398 tests, 396 pass, 1 fail = pre-existing runner mismatch in
  `live-request-lifecycle-hook.test.tsx` (acceptable per task).
- `npm run typecheck:core` → 45 pre-existing errors in 7 untouched files;
  ZERO in `src/shared/topology/**` / telemetry files
  (`grep "topology|telemetry"` on the errors returns nothing).
- `npx eslint` on the 2 changed files → clean (0 findings).
- `npm run check:cycles` → "no cycles detected across 462 files".
- Husky pre-commit ran in full (lint-staged prettier+eslint, docs-sync
  PASS, any-budget t11 OK, tracked-artifacts OK, ai-attribution OK).

### New SHA

Local + remote: `e3ada3153a6a705c33cd8d365a4ef127389d54c2`
(`git ls-remote origin fix/atomic-0092-proven-routing` → same SHA).
Working tree clean (this report dir `OR_ATOM_009_2/` remains untracked).

## Deploy-4 / Live proof

Live edge assertion from the `e3ada315` deploy (2026-10-30, pre-commit):

- Image: `registry.celestium.life/library/omniroute:3.8.52-oratom0092-e3ada315`
- Digest: `sha256:62ff77be9c40f5aa76f27981422ee5ed2cd700906b303d49e99d26fcaf36fbea`
- Pod: `omniroute-5cdc9474f8-qhknt` (ns `omniroute`) — 1/1 Running, restarts=0
- `/api/health` → HTTP 200
- `/api/telemetry/fleet` (internal-service token header
  `x-omniroute-internal-service-token`) → `reconciliation.edges` verbatim:

  ```json
  [
    "{\"source\":\"provider:vllm\",\"target\":\"runtime:192.168.133.3:q27\",\"relation\":\"provider_runtime\",\"basis\":\"configured provider baseUrl host:port match\",\"sampledAt\":1793327187960}"
  ]
  ```

This proves the provider↔runtime join survives on the live edge
(`provider:vllm → runtime:192.168.133.3:q27`).

Rollback note: the manifest backups `omniroute.yaml.bak-20261030-pre-oratom0092`,
`-pre-oratom0092b` and `-pre-oratom0092c` preserve the prior rollback paths
(roll back = manifest line 56 → image tag `3.8.52-oratom0091-b26a6d8a`).
