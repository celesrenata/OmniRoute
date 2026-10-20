-- Migration 199: Intelligence Layer v2 (WP5) — memory feedback, retrieval
-- events, and reindex jobs.
--
-- These are the durable, append-only audit + feedback tables that let operators
-- (and the future skillset debugger) explain and improve retrieval quality:
--
--   memory_feedback        — human/operator (or agent) feedback on whether a
--                            returned memory was actually useful. This is the
--                            signal source for ranking recalibration and for
--                            quarantining consistently-wrong memories.
--
--   memory_retrieval_events— one row per retrieval decision: what was queried,
--                            which ids were candidates, which were accepted vs
--                            dropped and why (reason code), and the backend
--                            used. Pairs with memory_audit (per-candidate gate
--                            log from migration 197) to form a full decision
--                            trail.
--
--   memory_reindex_jobs    — durable record of background reindex runs: start,
--                            end, how many were processed/failed, and the
--                            embedding model/dim used, so a model swap or a
--                            failed batch is diagnosable and retryable.
--
-- CREATE TABLE IF NOT EXISTS is naturally idempotent; re-running is a no-op.

CREATE TABLE IF NOT EXISTS memory_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  signal TEXT NOT NULL,              -- useful | not_useful | wrong | outdated | off_topic
  source_kind TEXT,                  -- operator | user | agent | auto
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_feedback_memory ON memory_feedback(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_feedback_key ON memory_feedback(api_key_id);

CREATE TABLE IF NOT EXISTS memory_retrieval_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id TEXT NOT NULL,
  query TEXT,
  strategy TEXT,                     -- hybrid | lexical | semantic | exact | preview
  backend TEXT,                      -- sqlite_fts5 | sqlite_vec | qdrant | hybrid
  candidate_count INTEGER NOT NULL DEFAULT 0,
  returned_count INTEGER NOT NULL DEFAULT 0,
  dropped_reasons TEXT,              -- JSON array of {memoryId, reason}
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_retrieval_events_key ON memory_retrieval_events(api_key_id);

CREATE TABLE IF NOT EXISTS memory_reindex_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id TEXT,                   -- NULL = whole-DB reindex
  trigger TEXT NOT NULL,             -- manual | model_swap | failure_retry | scheduled
  embedding_model TEXT,
  embedding_dim INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | failed
  total INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_reindex_jobs_status ON memory_reindex_jobs(status);
