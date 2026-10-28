# Remote Embedder Validation — arcforge/qwen3-embedding-0.6b

**Date:** 2026-10-28
**Target URL:** `https://omniroute.celestium.life/v1/embeddings`
**Key source:** `/run/secrets/omniroute_management_api_key` (35 bytes, mounted at runtime; value never printed or stored in any artifact)

---

## Catalog Check (GET /v1/embeddings)

- **Status code:** 200
- **Wall time:** 4,074 ms
- **Total models listed:** 9
- **Full model ID list:**
  1. `openrouter/openai/text-embedding-3-small`
  2. `openrouter/openai/text-embedding-3-large`
  3. `openrouter/qwen/qwen3-embedding-8b`
  4. `openrouter/qwen/qwen3-embedding-4b`
  5. `openrouter/baai/bge-m3`
  6. `openrouter/mistralai/mistral-embed-2312`
  7. `openrouter/google/gemini-embedding-001`
  8. `openrouter/google/gemini-embedding-2`
  9. `openrouter/google/gemini-embedding-2-preview`

- **`arcforge/qwen3-embedding-0.6b` present in catalog:** **NO** (0 arcforge models listed)

> **Key finding:** The production deployment's `/v1/embeddings` catalog does NOT list `arcforge/qwen3-embedding-0.6b`. This is consistent with the operator's reported "embedders missing" symptom. All 9 listed models are `openrouter/*` prefixed; no local/arcforge embedders appear.

---

## Live Embedding Call (POST /v1/embeddings)

- **Model requested:** `arcforge/qwen3-embedding-0.6b`
- **Input:** `["embedder validation 2026-10-28"]`
- **Status code:** 200
- **Wall time:** 230 ms
- **Response `model` field:** `arcforge/qwen3-embedding-0.6b`
- **Embedding is array:** true
- **Dimension count:** **1024** (exactly as expected)
- **Type of first element:** `number`
- **All 1024 entries are numeric:** true
- **Usage object:** `{"prompt_tokens":null,"total_tokens":null,"arcforge":{"dim":1024,"items":1,"infer_s":0.0866}}`

- **Retries needed:** 0 (first attempt succeeded)

---

## Error Body

None — both requests returned HTTP 200.

---

## Verdict

**WORKING** — `arcforge/qwen3-embedding-0.6b` successfully produces 1024-dimensional numeric embeddings on the production deployment (HTTP 200, 230 ms, all 1024 values numeric).

**However:** The model is **NOT listed** in the remote GET `/v1/embeddings` catalog. The production catalog only exposes 9 `openrouter/*` models. This means:

- Direct API calls with the model ID work correctly.
- Any client that discovers models via the catalog endpoint will NOT see `arcforge/qwen3-embedding-0.6b` (or any other non-openrouter embedder).
- This is the root cause of the "embedders missing" symptom: local/arcforge embedders are not registered in the remote catalog's model list, even though they are functional when addressed by name.

---

## Security Statement

The secret value (mounted at `/run/secrets/omniroute_management_api_key`) was read into a shell variable exclusively at runtime via `KEY=$(cat "$SECRET_FILE")` and was **never** printed, logged, written to any file, or included in any command output. No secret material appears in this document or any other artifact.
