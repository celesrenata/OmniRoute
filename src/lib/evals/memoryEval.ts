/**
 * WP5 — Memory evaluation harness.
 *
 * Measures the four acceptance properties of the memory pipeline on a
 * deterministic, seeded database (no live LLM required, so it runs in CI):
 *
 *   1. recall     — do the ground-truth relevant memories get returned?
 *   2. precision  — what share of returned memories are actually relevant?
 *   3. grounding  — are returned memories real, owned, unexpired rows?
 *   4. cross-account — does key A's retrieval ever surface key B's memories?
 *
 * The harness seeds a known memory set across two api keys, issues a set of
 * retrieval queries, and scores each query against its ground truth. It is a
 * measurement tool — it does not mutate any shared state beyond the isolated
 * DATA_DIR it is given.
 */

import { getDbInstance } from "../db/core";
import { createMemory } from "../memory/store";
import { retrieveMemories } from "../memory/retrieval";
import { MemoryType } from "../memory/types";

export interface EvalMemorySeed {
  /** Api key that owns this memory. */
  apiKeyId: string;
  key: string;
  content: string;
  type?: MemoryType;
  /** When the row expires; null/omitted = no expiry. */
  expiresAt?: Date | null;
}

export interface EvalQuery {
  /** The api key issuing the retrieval. */
  apiKeyId: string;
  query: string;
  /**
   * Ground truth: the memory keys (unique `key` per seed) that SHOULD be
   * returned for this query. An empty array means "no relevant memory
   * expected" (used for precision / cross-account negative cases).
   */
  expectedKeys: string[];
}

export interface EvalQueryResult {
  query: string;
  apiKeyId: string;
  returned: string[];
  expected: string[];
  precision: number;
  recall: number;
  grounded: boolean;
  crossAccountLeaks: string[];
}

export interface EvalReport {
  queries: EvalQueryResult[];
  precision: number;
  recall: number;
  groundingRate: number;
  crossAccountLeaks: number;
  pass: boolean;
}

/**
 * Run the full memory eval harness.
 *
 * Seeds `seeds` (each created via the real `createMemory` so provenance, FTS
 * sync, and vector upsert all run for real), then issues `queries` and scores
 * them. Returns a report whose `pass` is true when every acceptance gate holds:
 * precision ≥ `minPrecision`, recall ≥ `minRecall`, grounding = 1.0, and zero
 * cross-account leaks.
 */
export async function runMemoryEval(
  seeds: EvalMemorySeed[],
  queries: EvalQuery[],
  thresholds?: { minPrecision?: number; minRecall?: number }
): Promise<EvalReport> {
  const minPrecision = thresholds?.minPrecision ?? 0.8;
  const minRecall = thresholds?.minRecall ?? 0.9;
  const db = getDbInstance();

  // Seed memories through the real store so FTS/provenance run for real.
  for (const seed of seeds) {
    await createMemory({
      apiKeyId: seed.apiKeyId,
      sessionId: "eval",
      type: seed.type ?? MemoryType.FACTUAL,
      key: seed.key,
      content: seed.content,
      metadata: { eval: true },
      source: "user-message",
      confidence: "high",
      expiresAt: seed.expiresAt ?? null,
    });
  }

  const results: EvalQueryResult[] = [];
  let tpTotal = 0;
  let returnedTotal = 0;
  let expectedTotal = 0;
  let groundedCount = 0;
  let crossAccountLeaksTotal = 0;

  for (const q of queries) {
    const returned = await retrieveMemories(q.apiKeyId, { query: q.query });
    const returnedKeys = returned.map((m) => m.key ?? "");
    const returnedSet = new Set(returnedKeys);
    const expectedSet = new Set(q.expectedKeys);

    // Grounding: every returned memory must be a real row owned by q.apiKeyId
    // and unexpired.
    let grounded = true;
    const crossLeaks: string[] = [];
    for (const mem of returned) {
      const row = db
        .prepare("SELECT api_key_id, expires_at FROM memories WHERE id = ?")
        .get(mem.id) as { api_key_id: string; expires_at: string | null } | undefined;
      if (!row || row.api_key_id !== q.apiKeyId) {
        grounded = false;
        if (row) crossLeaks.push(row.api_key_id);
      } else if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
        grounded = false;
      }
    }
    if (grounded) groundedCount += 1;
    crossAccountLeaksTotal += crossLeaks.length;

    const tp = [...returnedSet].filter((k) => expectedSet.has(k)).length;
    // A query that expects nothing is "perfect precision" iff it returned
    // nothing; otherwise returning anything is a precision error.
    const precision = returnedSet.size > 0 ? tp / returnedSet.size : expectedSet.size === 0 ? 1 : 0;
    const recall = expectedSet.size > 0 ? tp / expectedSet.size : 1;

    tpTotal += tp;
    returnedTotal += returnedSet.size;
    expectedTotal += expectedSet.size;

    results.push({
      query: q.query,
      apiKeyId: q.apiKeyId,
      returned: returnedKeys,
      expected: q.expectedKeys,
      precision,
      recall,
      grounded,
      crossAccountLeaks: crossLeaks,
    });
  }

  const precision = returnedTotal > 0 ? tpTotal / returnedTotal : 1;
  const recall = expectedTotal > 0 ? tpTotal / expectedTotal : 1;
  const groundingRate = queries.length > 0 ? groundedCount / queries.length : 1;

  return {
    queries: results,
    precision,
    recall,
    groundingRate,
    crossAccountLeaks: crossAccountLeaksTotal,
    pass:
      precision >= minPrecision &&
      recall >= minRecall &&
      groundingRate === 1.0 &&
      crossAccountLeaksTotal === 0,
  };
}
