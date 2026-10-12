/**
 * Job-lane derivation for the topology snapshot (OR-ATOM-001 v2, T004b /
 * M4-closure).
 *
 * A "lane" is the job family a provider is serving *right now*. The topology
 * snapshot is the only place in the codebase that can know this per node,
 * because it is the single module that sees both the provider list AND the
 * in-flight request set (provider+model) in one pass. Live home-page
 * topology inputs carry only `{ provider, model }` — no category field.
 *
 * ### No-fabrication contract
 * The lane is derived **only from an observed in-flight model id** via the
 * conservative keyword classifier below. Absent in-flight traffic on a
 * provider → **no lane observation at all** (field absent on the node), never
 * `null` or `"unknown"`. Unrecognizable model ids → also **no observation**:
 * we do not call `gpt-4o` "chat" because it usually happens to be — that's
 * fabrication; the only honest answer for an unclassified observed model is
 * to attach no observation. (When nothing in the provider's in-flight set is
 * recognizable, the renderer falls back to the neutral hue `unknown`, which
 * is a *coloring* default, not an observed lane fact.)
 *
 * The taxonomy is deliberately a subset of what the Atomic renderer's
 * `JobLane` union supports (`chat | prefill | decode | embedding | rerank |
 * vision | image | audio | system | unknown`): only the lanes we can *actually
 * classify from a model id today* are emitted here. `chat` is intentionally
 * not in `TOPOLOGY_LANES` even though it *is* a valid `JobLane` — "every model
 * that isn't clearly a specialist is chat" is exactly the fabrication this
 * module refuses to make.
 */

/**
 * The lanes the topology snapshot can *actually derive from observed model
 * ids*. Every value here is also a valid {@link JobLane} on the renderer
 * side (`TopologyLane ⊆ JobLane`), so a `TopologyLane` value can flow
 * directly into a descriptor's `lane: JobLane` field without mapping.
 */
export const TOPOLOGY_LANES = [
  "embedding",
  "rerank",
  "vision",
  "image",
  "audio",
  "unknown",
] as const;

export type TopologyLane = (typeof TOPOLOGY_LANES)[number];

/**
 * Ordered classifier rules — first match wins. Order is significant
 * (e.g. `embedding` must match before `image` so `text-embed-image-*`
 * hypothetical future ids classify as embeddings, not images).
 *
 * **Conservative: no rule should match ordinary chat/assistant models.**
 * Each rule must be a distinctive family token that appears in real
 * model-id names (not a broad English word).
 */
const LANE_TOKENS: ReadonlyArray<readonly [Pattern: RegExp, Lane: TopologyLane]> = [
  // `text-embedding-3-small`, `bge-large-en-v1.5`, `openai/v3-large`, etc.
  [/embed/i, "embedding"],
  // `bge-reranker-v2-m3`, `cohere-rerank-3`.
  [/rerank|re-rank/i, "rerank"],
  // `gpt-4o-vision-alpha`, `llava-v1.6`, `gemini-vision`, `qwen-vl-max`,
  // `qwen2-vl-*`, `-vl` at end of id, `-vlm` (vision-language model).
  // Deliberately NOT bare `vl` (would false-positive on e.g. `vllm` in an
  // inference server name).
  [/[-_](vl|vlm|vision)\b|\bvision\b|\bvlm\b/i, "vision"],
  // `dall-e-3`, `flux-image-*`, `sdxl-*` (image generators). Anchored to
  // start/end or brand tokens — a mid-id `image` segment (e.g. a
  // multimodal reader named `*-text-image-*`) is NOT classified as an
  // image generator; false positives are worse than false negatives here.
  [/^image([-_]|$)|[._-]image$|\bdall\b|\bflux\b|\bsdxl\b/i, "image"],
  // `whisper-1`, `whisper-3`, `tts-1`, `speech-001`, `speech-1.1`.
  // Deliberately NOT bare `audio` (would false-positive on `gpt-4o-audio`
  // which is a multimodal model id, not an audio-only generator).
  [/\bwhisper\b|\btts\b|\bspeech-\d|[-_]asr\b|[-_]sts\b/i, "audio"],
];

/**
 * Derive a job lane from a single in-flight model id.
 *
 * @returns the recognized lane, or `null` when the model id does not match
 *   any classification rule. Callers MUST treat `null` as "no observation
 *   from this model id", not as "unknown".
 */
export function deriveLaneFromModel(model: string | undefined): TopologyLane | null {
  if (!model) return null;
  for (const [token, lane] of LANE_TOKENS) {
    if (token.test(model)) return lane;
  }
  return null;
}

/**
 * Collapse the in-flight model ids for one provider into a *single* lane
 * observation (or `null` when no observation is warranted).
 *
 * Rules:
 * - **No in-flight models** → `null` (provider idle; no lane fact).
 * - **All observed model ids fail to classify** → `null` (unrecognizable;
 *   no fabrication).
 * - **All observed model ids classify to the same lane** → that lane.
 * - **Observed model ids classify to more than one lane** →
 *   `{ lane: "unknown" }` **with a basis listing each distinct (model,
 *   lane) pair** — this is the *one* place `unknown` may appear as an
 *   observed value, because it names a real state ("mixed in-flight lanes")
 *   that the honest alternatives (silently pick one, or leave the field
 *   absent) would hide.
 *
 * Basis format: stable, human-readable; model ids deduplicated and in
 * first-occurrence order, lanes per model shown when they differ.
 */
export function deriveLaneForProvider(
  models: ReadonlyArray<string | undefined>
): { lane: TopologyLane; basis: string } | null {
  const byModel = new Map<string, TopologyLane | null>();
  for (const m of models) {
    if (!m) continue;
    if (byModel.has(m)) continue;
    byModel.set(m, deriveLaneFromModel(m));
  }
  if (byModel.size === 0) return null; // no in-flight models

  const recognizedLanes = new Set<TopologyLane>();
  for (const lane of byModel.values()) {
    if (lane) recognizedLanes.add(lane);
  }
  if (recognizedLanes.size === 0) return null; // nothing recognizable

  const lane: TopologyLane =
    recognizedLanes.size === 1 ? ([...recognizedLanes][0] as TopologyLane) : "unknown";

  // Basis: list the model ids (dedup'd, first-occurrence) with their per-model
  // classifications shown only where they differ from the aggregate, so the
  // string stays short in the common single-lane case.
  const modelIds = [...byModel.keys()];
  if (lane === "unknown") {
    // Mixed-lane case: show each model's lane so the observation is
    // self-explaining even in a log line.
    const basis =
      "mixed in-flight lanes: " +
      modelIds.map((m) => `${m}→${byModel.get(m) ?? "unrecognized"}`).join(", ") +
      ` (model ids: ${modelIds.join(", ")})`;
    return { lane, basis };
  }
  const basis = `in-flight models all classify as ${lane} (${modelIds.join(", ")})`;
  return { lane, basis };
}
