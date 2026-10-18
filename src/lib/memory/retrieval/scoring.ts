import { Memory, MemoryType } from "../types";

export interface MemoryRow {
  id: string;
  api_key_id?: string;
  apiKeyId?: string;
  session_id?: string | null;
  sessionId?: string | null;
  type: MemoryType;
  key?: string | null;
  content: string;
  metadata?: string | null;
  created_at?: string;
  createdAt?: string;
  updated_at?: string;
  updatedAt?: string;
  expires_at?: string | null;
  expiresAt?: string | null;
  access_count?: number | null;
  last_accessed_at?: string | null;
}

/**
 * Simple token estimation function (roughly 1 token per 4 characters)
 */
export function estimateTokens(text: string): number {
  if (!text || typeof text !== "string") return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Sanitize query text for SQLite FTS5 MATCH expressions.
 * Strips FTS control operators and wraps individual terms in double quotes.
 */
export function sanitizeFts5Query(query?: string): string {
  if (!query) return "";
  const cleaned = query.replace(/[^\w\s\u00C0-\u024F\u1E00-\u1EFF]/g, " ").trim();
  if (!cleaned) return "";
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" ");
}

export function parseMetadata(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function rowToMemory(row: MemoryRow): Memory {
  const createdAt = row.created_at || row.createdAt || new Date().toISOString();
  const updatedAt = row.updated_at || row.updatedAt || createdAt;
  const expiresAt = row.expires_at ?? row.expiresAt ?? null;

  return {
    id: String(row.id),
    apiKeyId: String(row.api_key_id || row.apiKeyId || ""),
    sessionId: String(row.session_id ?? row.sessionId ?? ""),
    type: row.type as MemoryType,
    key: String(row.key || ""),
    content: String(row.content || ""),
    metadata: parseMetadata(row.metadata),
    createdAt: new Date(createdAt),
    updatedAt: new Date(updatedAt),
    expiresAt: expiresAt ? new Date(String(expiresAt)) : null,
    accessCount: typeof row.access_count === "number" ? row.access_count : 0,
    lastAccessedAt: row.last_accessed_at ? new Date(String(row.last_accessed_at)) : null,
  };
}

/**
 * Score a memory against a query using simple string matching (no dynamic RegExp).
 * Uses indexOf() for full-phrase matches and split-token substring checks only,
 * so there is no ReDoS risk — no user input is passed to RegExp().
 */
export function getRelevanceScore(memory: Memory, query: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return 0;

  const haystacks = [
    memory.content.toLowerCase(),
    memory.key.toLowerCase(),
    JSON.stringify(memory.metadata).toLowerCase(),
  ];
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);

  let score = 0;
  for (const haystack of haystacks) {
    // Full phrase match (safe: literal string, not regex)
    if (haystack.includes(normalizedQuery)) {
      score += 20;
    }

    for (const token of tokens) {
      if (!token) continue;
      // Token-level substring count using indexOf loop (no RegExp on user input)
      if (haystack === memory.key.toLowerCase() && haystack.includes(token)) {
        score += 6;
        continue;
      }
      // Count occurrences via indexOf loop — avoids new RegExp(token)
      let pos = 0;
      let matchCount = 0;
      while ((pos = haystack.indexOf(token, pos)) !== -1) {
        matchCount++;
        pos += token.length;
      }
      score += matchCount * 3;
    }
  }

  return score;
}

/**
 * Intelligence Layer v2 — Relevance Accept Gate (`MEMORY_V2_ACCEPT_GATE`).
 *
 * A positive substring count from {@link getRelevanceScore} is a *ranking*
 * signal, not an *acceptance* signal: on the legacy path any score > 0 admitted a
 * candidate, so a query token that happened to appear as a fragment of an
 * unrelated word (or only inside serialized metadata) pulled that memory into
 * the context. The accept gate requires a *meaningful* relevance signal before a
 * candidate may be returned:
 *
 *   - an exact full-phrase hit, OR
 *   - at least one non-stopword query token present as a whole word (word
 *     boundary, case-insensitive) in the memory content or key.
 *
 * Returns a verdict with a machine-readable `reason` so the retrieval event log
 * can record *why* each candidate was kept or dropped. This is a pure decision —
 * it never mutates the memory or the index.
 */
const ACCEPT_GATE_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "i",
  "you",
  "we",
  "they",
  "this",
  "that",
  "these",
  "those",
  "do",
  "does",
  "did",
  "not",
  "no",
  "what",
  "which",
  "who",
  "how",
  "when",
  "where",
  "why",
  "as",
  "by",
  "from",
  "about",
  "into",
  "over",
  "under",
  "it",
  "its",
  "my",
  "your",
  "our",
  "their",
]);

/** Case-insensitive whole-word test that never compiles a RegExp from input. */
function containsWholeWord(haystack: string, word: string): boolean {
  const len = word.length;
  if (len === 0 || haystack.length < len) return false;
  let start = 0;
  while (true) {
    const idx = haystack.indexOf(word, start);
    if (idx === -1) return false;
    const before = idx === 0 ? " " : haystack[idx - 1];
    const after = idx + len >= haystack.length ? " " : haystack[idx + len];
    const isWordBefore = !/[a-z0-9_]/.test(before);
    const isWordAfter = !/[a-z0-9_]/.test(after);
    if (isWordBefore && isWordAfter) return true;
    start = idx + 1;
  }
}

/**
 * True when the (possibly multi-word) phrase occurs in `haystack` as a literal
 * substring bounded by word boundaries at both ends — so "mod" does not match
 * "modern" but "dark mode" matches "…dark mode…".
 */
function containsBoundedPhrase(haystack: string, phrase: string): boolean {
  const len = phrase.length;
  if (len === 0 || haystack.length < len) return false;
  let start = 0;
  while (true) {
    const idx = haystack.indexOf(phrase, start);
    if (idx === -1) return false;
    const before = idx === 0 ? " " : haystack[idx - 1];
    const after = idx + len >= haystack.length ? " " : haystack[idx + len];
    if (!/[a-z0-9_]/.test(before) && !/[a-z0-9_]/.test(after)) return true;
    start = idx + 1;
  }
}

export interface AcceptVerdict {
  accepted: boolean;
  /** Stable machine-readable reason for the retrieval event log / debugger. */
  reason: "no_query" | "phrase_hit" | "term_hit" | "stopword_only" | "no_signal";
  /** The query token(s) that satisfied the gate (for explainability). */
  matchedTerms: string[];
}

/**
 * Decide whether a memory should be admitted for a query.
 *
 * With an empty query there is no relevance signal to gate on, so the decision is
 * delegated to the caller (exact/recency strategies still run); this function
 * returns `accepted: false` with reason `no_query` purely to document that case.
 */
export function acceptRelevance(memory: Memory, query: string): AcceptVerdict {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return { accepted: false, reason: "no_query", matchedTerms: [] };

  const content = memory.content.toLowerCase();
  const key = memory.key.toLowerCase();

  // A full-phrase hit must also be bounded by word boundaries — otherwise a
  // short query token that is merely a fragment of a longer word ("mod" inside
  // "modern") would be treated as a meaningful match, the same flaw the
  // substring-count scorer had.
  if (
    containsBoundedPhrase(content, normalizedQuery) ||
    containsBoundedPhrase(key, normalizedQuery)
  ) {
    return { accepted: true, reason: "phrase_hit", matchedTerms: [normalizedQuery] };
  }

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const matched: string[] = [];
  for (const token of tokens) {
    if (ACCEPT_GATE_STOPWORDS.has(token)) continue;
    if (containsWholeWord(content, token) || containsWholeWord(key, token)) {
      matched.push(token);
    }
  }
  if (matched.length > 0) {
    return { accepted: true, reason: "term_hit", matchedTerms: matched };
  }
  // Only stopwords / pure fragments matched: no meaningful signal.
  const hadSignal = tokens.some((t) => !ACCEPT_GATE_STOPWORDS.has(t));
  return {
    accepted: false,
    reason: hadSignal ? "no_signal" : "stopword_only",
    matchedTerms: [],
  };
}
