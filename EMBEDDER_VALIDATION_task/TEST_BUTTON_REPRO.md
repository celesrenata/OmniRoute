# "Test model" button repro — arcforge/qwen3-embedding-0.6b (production)

Live read-only repro performed **2026-10-28 ~06:41–06:47 UTC** against
`https://omniroute.celestium.life` (management API key in
`/run/secrets/omniroute_management_api_key`, 35 bytes, read into `$KEY` in-shell only;
its value is never printed or recorded). **No production code changed. No git actions.**

## Reproduction (exact requests + statuses + verbatim bodies)

Management endpoints that work with the API key:

- `GET /api/providers` → HTTP 200
- `GET /api/provider-nodes` → HTTP 200
- `GET /api/connections` → HTTP 404 (does not exist)

### Request 1 — pure auto-resolve embeddings (parent's proven-fact control)

```
POST /v1/embeddings  {"model":"arcforge/qwen3-embedding-0.6b","input":["hello"]}
```

→ **HTTP 200 in 0.103s**; 1024-dim vector; `usage:{"prompt_tokens":null,"total_tokens":null,"arcforge":{"dim":1024,"items":1,"infer_s":0.0485}}`
(note: usage tag is `arcforge`, **not** openrouter — auto-resolve picks the arcforge node, not OpenRouter).

### Request 2 — the Test button payload (embedding node id as providerId, no connectionId)

`providerId` = `openai-compatible-embeddings-3833d25a-afe5-4b51-b50d-1851afaf0211`,
`modelId` = `arcforge/qwen3-embedding-0.6b`, `connectionId` = _absent_.

```
POST /api/models/test
```

→ **HTTP 200 in 0.076s**

```json
{ "status": "ok", "latencyMs": 44, "responseText": "[Embedding generated successfully]" }
```

Repeats **HTTP 200 / ok** on all 4 embedding node ids:

- `…-3833d25a…` → 200, latencyMs 44
- `…-79d196eb…` → 200, latencyMs 62
- `…-a2dc8639…` → 200, latencyMs 117
- `…-eb1f24b6…` → 200 (embedding node ids are `openai-compatible-embeddings-*`, prefix `arcforge`, apiType `embeddings`, base `http://10.1.1.{12,13,14,15}:8100/v1`)

> **The "Fetch Failed" toast is NOT currently reproducible.** Every legitimate Test-button payload returns `status:"ok"`.

### Request 3 — variant with `modelId="qwen3-embedding-0.6b"` (bare, no `arcforge/` prefix)

→ **HTTP 400**

```json
{
  "status": "error",
  "latencyMs": 4,
  "error": "Unknown embedding provider: openai-compatible-embeddings-3833d25a-afe5-4b51-b50d-1851afaf0211. No matching hardcoded or local provider found.",
  "statusCode": 400
}
```

Only reachable if the caller drops the `arcforge/` prefix; not the button's payload (button sends `fullModel` which already contains the slash).

### Request 4 — pinned **rerank** connection used for the embedding model (misroute discriminator)

`providerId`=`arcf-15-…`, `modelId`=`arcforge/qwen3-embedding-0.6b`, `connectionId`=`e7bede2a-003b-43e4-be45-59ae53e2921c`
→ **HTTP 200** `{"status":"ok","latencyMs":194,"responseText":"[Rerank completed successfully]"}` — i.e. `detectTestKind` classified it rerank (misclass, but not an error).

### Request 5 — pinned OpenRouter connection for the arcforge embedding

`providerId`=`openrouter`, `connectionId`=`ddfe7ed8-16fc-47b5-9632-885912e5c78e`
→ **HTTP 200** `{"status":"ok","latencyMs":96,"responseText":"[Embedding generated successfully]"}`

## Discrimination (pinned vs auto-resolve)

| Variant                         | connectionId | Result                                       |
| ------------------------------- | ------------ | -------------------------------------------- |
| embedding node id, auto-resolve | none         | **ok** (200)                                 |
| openrouter pin                  | `ddfe7ed8…`  | **ok** (200)                                 |
| rerank-connection pin           | `e7bede2a…`  | ok but misclassified as rerank               |
| bare model id (no `arcforge/`)  | none         | **error** (400 "Unknown embedding provider") |

**No pinned-connection variant fails.** The "pinned upstream connection is unreachable" hypothesis is **disproven** by live evidence.

## Upstream reachability (step 5 — from THIS host, suggestive only)

All four arcforge embedding upstreams are up from this host:

- `http://10.1.1.{12,13,14,15}:8100/v1` → HTTP 404 (route not `/v1` root, expected)
- `http://10.1.1.{12,13,14,15}:8100/v1/models` → **HTTP 200**, each lists
  `{"id":"qwen3-embedding-0.6b","owned_by":"arcforge","arcforge":{"device":"GPU","dim":1024,"max_length":4096}}`

Limitation: reachability from this host is suggestive, not authoritative for the deployment container; however the deployment **itself** is confirmed healthy because Request 1/2 succeed end-to-end through it.

## Root cause

**Not a network/`fetch failed` failure — the arcforge embedding upstream is up and the
exact button payload succeeds in the current state.** The observed "Error - Fetch Failed"
is **transient/stale**, not a reproducible steady-state defect. Two concrete, non-contradicting
explanations:

1. **Transient upstream blip on one node.** The button uses auto-resolve (no embedding
   connection is bound — see below), so a single node being momentarily down (or a per-node
   `rateLimitedUntil`/circuit-breaker OPEN state) at click time would surface a sanitized
   upstream error. All 4 nodes are healthy _now_.
2. **The toast text is client-side, not the server's sanitized string.** The dashboard's
   `onTestModel` `catch` branch emits a fixed network message, and `extractApiErrorMessage`
   only surfaces `data.error`. The server never emits a capitalized `"Fetch Failed"`;
   OmniRoute's server error strings are lowercase (`"fetch failed"`) or the 400 text above. A
   capitalized "Fetch Failed" points to the **browser's own fetch** to `/api/models/test`
   failing (e.g. request aborted/timed out), not a server-returned upstream error.

Supporting structural facts:

- **No connection is bound to any arcforge embedding node.** `GET /api/providers?provider=<embeddings-node-id>` → `{"connections":[],"total":0}`. The only arcforge connections are the 4 **"ArcForge Rerank"** (apiType `rerank`, ports `:8101`). Hence on the embeddings provider page `selectedConnection` is null → `connectionId` omitted → auto-resolve.
- **The model is absent from every catalog:** not in `/v1/models` (only 9 `openrouter/*` embeddings listed), not in `open-sse/config/embeddingRegistry.ts`, not in `/api/provider-models?provider=…` for any provider, not in custom models (`/api/models`) nor aliases (`/api/models/alias`). It exists only in the upstream nodes' own `/v1/models`. So the row the operator tested came from a synced/derived listing, not OmniRoute's static catalog.

## Recommended fix (NOT implemented)

1. **Confirm transient vs steady:** on next failure capture the server log line for that
   `connectionId`/node and its `lastError` + `rateLimitedUntil` (`/api/providers` fields) to
   prove whether a specific arcforge node was down / circuit-broken at click time.
2. **Make the toast show the real message:** route the dashboard test-failure toast through
   `extractApiErrorMessage` already used, but ensure the server returns a stable,
   human-readable `error` string (currently auto-resolve never errors, so the "Fetch Failed"
   text is likely the client `catch` fallback). Verify the capitalized string's origin — if it
   is the browser `catch`, it means the request itself never reached a server response
   (abort/timeout), which is a client-side/latency issue, not an upstream outage.
3. **Catalog gap (separate from the toast):** `arcforge/qwen3-embedding-0.6b` should be
   surfaced in `/v1/models` / the embedding node listing if it is to be a first-class
   testable model; today it is testable only by exact `arcforge/`-prefixed name.
4. Add a failing-then-passing test or a VPS live-test record per Hard Rule #18 before claiming a fix.

## Limitations

- Read-only: no code change, no git operations, no login/JWT (API key was sufficient for all `/api/*` used).
- Upstream probes were from the analyst host, not the deployment container; deployment health is instead proven by the successful end-to-end `/api/models/test` + `/v1/embeddings` calls.
- "Fetch Failed" was **not** reproduced in the current state; the diagnosis is a transient/structural analysis, not a captured steady-state error body from the exact click.
