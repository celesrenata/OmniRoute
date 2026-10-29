# Embedder Validation Report

**Task**: `01a17f12-a0ba-7449-88c4-9b8fe262f1f4` (worker-2)  
**Date**: 2026-10-28  
**Target**: Running OmniRoute dev server on `localhost:20128` (NOT started by me; already up)

---

## Operator Report Interpretation

> "my embedders seem to be missing from omniroute again"

Two contributing causes identified:

1. **14 embedding-capable models from openai, mistral, and bedrock are present in `/v1/models` but NOT typed as `embedding`** — they are invisible to `/v1/embeddings` (root-cause category **c**).
2. **The 3 `ollama-local/*` embedding models ARE typed and visible, but their remote Ollama backend at `10.1.1.12:2701` is unreachable** — live POST requests time out (root-cause category **e**).

The word "again" aligns with state drift: the operator's remote Ollama machine (gremlin-4070ti) at `10.1.1.12` has `embeddinggemma` and `nomic-embed-text` loaded but is currently offline. The connection row still exists (`testStatus: "active"`, `lastErrorType: "server_error"`) so the catalog still lists those models, but actual embedding calls fail.

---

## Catalog State (Evidence)

### GET /v1/embeddings

Command: `curl -s http://localhost:20128/v1/embeddings`  
**Status**: 200  
**Count**: **3** models (all `ollama-local`)

| ID                              | owned_by     | type      |
| ------------------------------- | ------------ | --------- |
| `ollama-local/embeddinggemma`   | ollama-local | embedding |
| `ollama-local/nomic-embed-text` | ollama-local | embedding |
| `ollama-local/bge-m3`           | ollama-local | embedding |

### GET /v1/models

Command: `curl -s http://localhost:20128/v1/models`  
**Total models**: **1072** (one call) / 1073 (second call — transient combo addition)  
**Embedding-typed subset**: **3** (same as above)  
**Providers present (19)**: combo, kiro, devin-cli-agentic, opencode, duckduckgo-web, cloudflare-playground, felo-web, theoldllm, chipotle, veoaifree-web, auggie, zcode, codex-app-server, uncloseai, aihorde, openai, mistral, bedrock, llama-cpp, ollama-local, vllm

### Discovered but NOT typed as embedding (keyword search on /v1/models)

Command: node filter on `id` matching `embed|bge|nomic|text-embedding|mxbai|arctic|e5|gte`

| Model ID                                     | Provider | Actual type |
| -------------------------------------------- | -------- | ----------- |
| openai/text-embedding-ada-002                | openai   | **none**    |
| openai/text-embedding-3-small                | openai   | **none**    |
| openai/text-embedding-3-large                | openai   | **none**    |
| mistral/codestral-embed                      | mistral  | **none**    |
| mistral/codestral-embed-2505                 | mistral  | **none**    |
| mistral/mistral-embed-2312                   | mistral  | **none**    |
| mistral/mistral-embed                        | mistral  | **none**    |
| bedrock/cohere.embed-v4:0                    | bedrock  | **none**    |
| bedrock/global.cohere.embed-v4:0             | bedrock  | **none**    |
| bedrock/twelvelabs.marengo-embed-2-7-v1:0    | bedrock  | **none**    |
| bedrock/twelvelabs.marengo-embed-3-0-v1:0    | bedrock  | **none**    |
| bedrock/us.cohere.embed-v4:0                 | bedrock  | **none**    |
| bedrock/us.twelvelabs.marengo-embed-2-7-v1:0 | bedrock  | **none**    |
| bedrock/us.twelvelabs.marengo-embed-3-0-v1:0 | bedrock  | **none**    |

**14 models** with embedding capability are invisible to `/v1/embeddings`.

---

## Live Embedding Test

### Test 1: POST via OmniRoute (ollama-local/embeddinggemma)

```
curl -s -X POST http://localhost:20128/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"ollama-local/embeddinggemma","input":["embedder validation 2026-10-28"]}'
```

**Result**: Timeout (HTTP 000) after >8s. The `ollama-local` connection points at `http://10.1.1.12:2701` (remote box "gremlin-4070ti") which is unreachable from this machine. `lastErrorType: "server_error"` on that connection corroborates.

### Test 2: POST via OmniRoute (ollama-local/bge-m3)

Same result: timeout, HTTP 000 after 8s.

### Test 3: Direct local Ollama (bypasses OmniRoute)

```
curl -s -X POST http://localhost:11434/api/embed \
  -d '{"model":"bge-m3","input":["embedder validation 2026-10-28"]}'
```

**Result**: HTTP 200 in ~4s. `embeddings[0]` = numeric array, **dimension 1024**, first values `[-0.01584983, -0.022748897, -0.0005015282]`.

**Verdict**: The embedding _dispatch code path_ in OmniRoute is not broken in isolation; the failure is the unreachable remote Ollama backend.

---

## Root-Cause Analysis

### Primary: (c) Models filtered out by classification / registry gate

The unified catalog builds the embedding list in `src/app/api/v1/models/catalog.ts:1505–1537`:

```ts
for (const embModel of getAllEmbeddingModels()) {
  if (!isProviderActive(embModel.provider)) continue;          // line 1506
  const rawModelId = getSpecialtyModelRelativeId(...);
  if (!providerSupportsModel(embModel.provider, rawModelId)) continue; // line 1508 ← GATE
  ...
  models.push({ ..., type: "embedding", ... });                 // line 1534
}
```

`providerSupportsModel` (line 540–551) delegates to `hasEligibleConnectionForModel(connections, modelId)` — it checks whether the provider's **synced/eligible model list** contains that model ID. For openai, mistral, and bedrock, the connections are primarily chat-oriented and their synced model inventories do **not** include the embedding model IDs (e.g. `text-embedding-3-small`, `mistral-embed`, `cohere.embed-v4:0`). Therefore the registry entry is **skipped** and the discovered chat-catalog rows retain `type: "none"`, making them invisible to the `model.type === "embedding"` filter in `src/app/api/v1/embeddings/route.ts:29`.

**Why the 3 ollama-local models DO work**: the `ollama-local` connection has `passthroughModels: true` (confirmed via `GET /api/providers`). Passthrough mode means the remote Ollama's model list is used directly, which includes `embeddinggemma`, `nomic-embed-text`, `bge-m3`. The `providerSupportsModel` gate passes, and the registry loop types them `embedding`.

**This is not a recent regression** — it's a pre-existing architectural gap: static embedding registry entries are gated by `providerSupportsModel`, which was designed for chat-model eligibility and does not account for embedding-specialty models that exist on the same provider connection but were never in the synced chat model inventory.

### Secondary: (e) Runtime dispatch to remote backend fails

The `ollama-local` connection at `http://10.1.1.12:2701` (remote machine "gremlin-4070ti") is unreachable from the current network. All 3 visible embedding models route through this backend, so live calls time out. `testStatus: "active"` with `lastErrorType: "server_error"` confirms the backend was last reachable but is now down.

### The "again" factor

State drift: the remote Ollama machine was previously reachable (connection row exists, models were discovered and cached). When it went offline, the catalog still shows the 3 models (because the connection row still exists with `isActive: true`), but actual calls fail. Additionally, if the operator previously had the local Ollama (`:11434`) as the `ollama-local` backend and switched to the remote one, the local models `mxbai-embed-large` and `snowflake-arctic-embed2` (confirmed present via `curl localhost:11434/api/tags`) would no longer appear — they are on the local box, not the remote.

---

## Provider/Connection State (read-only, no secrets)

| Provider     | Name                  | Auth   | Active | testStatus | lastErrorType | rateLimitedUntil |
| ------------ | --------------------- | ------ | ------ | ---------- | ------------- | ---------------- |
| openai       | openai-cloud          | apikey | true   | active     | —             | —                |
| mistral      | mistral-free          | apikey | true   | active     | —             | —                |
| bedrock      | bedrock-cloud         | apikey | true   | active     | —             | —                |
| ollama-local | gremlin-4070ti-ollama | apikey | true   | active     | server_error  | —                |
| vllm         | gremlin-4070ti        | apikey | true   | active     | —             | —                |
| vllm         | esnixi-5090           | apikey | true   | active     | server_error  | —                |

All providers are `active` with no rate-limit cooldowns.

---

## Recommended Fix (NOT implemented)

1. **For category (c)**: In the embedding-model injection loop (`catalog.ts:1505`), remove or relax the `providerSupportsModel` gate for embedding-type models. The embedding registry (`open-sse/config/embeddingRegistry.ts`) is the authority for which models support `/v1/embeddings`; the chat-model eligibility check is the wrong filter. Alternatively, add embedding model IDs to each provider's synced model inventory so `hasEligibleConnectionForModel` passes.

2. **For category (e)**: Restore network reachability to `10.1.1.12:2701`, or re-point the `ollama-local` connection to the local Ollama at `http://127.0.0.1:11434` (which is up and has `bge-m3` loaded). The local Ollama would also surface `mxbai-embed-large` and `snowflake-arctic-embed2` as available embedders.

---

## CORP-Header Interpretation (brief)

The `cross-origin-embedder-policy` string appears in `src/lib/services/reverseProxy.ts` as part of a header denylist (stripped from proxied upstream responses). This is unrelated to embedding-model functionality and would only affect cross-origin embedded _content_ (iframes, media) on proxied pages, not the `/v1/embeddings` API. No evidence of CORP-related breakage in this validation.

---

## Summary

| Metric                             | Value                                    |
| ---------------------------------- | ---------------------------------------- |
| GET /v1/embeddings count           | **3** (all ollama-local)                 |
| GET /v1/models total               | **1072**                                 |
| Embedding-capable models NOT typed | **14** (openai 3, mistral 4, bedrock 7)  |
| Live POST via OmniRoute            | **FAIL** (timeout — remote backend down) |
| Direct Ollama POST (local)         | **PASS** (1024-dim, ~4s)                 |
| Root-cause category                | **(c)** primary + **(e)** secondary      |
