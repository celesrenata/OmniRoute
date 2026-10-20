-- Migration 201: Intelligence Layer v2 (WP2) — memory provenance + audit log.
--
-- Adds three per-memory provenance columns and an append-only audit table so
-- operators can explain WHY a query returned / dropped a candidate.
--
--   memories.source        — where a fact came from ("user-message",
--                            "assistant-response", "manual", "skill", ...). NULL
--                            for pre-v2 rows (readers treat NULL as
--                            "user-message").
--   memories.confidence    — extraction confidence label ("high" | "medium" |
--                            "low" | NULL). NULL until an extractor scores it.
--   memories.recorded_at   — when the fact was originally asserted. Defaults to
--                            created_at so readers always have a value.
--
--   memory_audit           — gate-decision log (materialize / accept / extract /
--                            dedup / injection). Bounded by created_at so a
--                            future sweep can purge old rows.
--
-- Idempotency: the migration runner (src/lib/db/migrationRunner.ts) treats a
-- "duplicate column name" error as a no-op, so re-running on a partially-migrated
-- DB is safe. CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS are
-- naturally idempotent.

ALTER TABLE memories ADD COLUMN source TEXT DEFAULT NULL;
ALTER TABLE memories ADD COLUMN confidence TEXT DEFAULT NULL;
ALTER TABLE memories ADD COLUMN recorded_at TEXT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS memory_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id TEXT NOT NULL,
  action TEXT NOT NULL,          -- materialize | accept | extract | dedup | injection
  memory_id TEXT,
  query TEXT,
  outcome TEXT,                  -- accepted | dropped | created | merged | recorded
  reason TEXT,                   -- machine-readable reason (see AcceptVerdict.reason)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_audit_key_time ON memory_audit(api_key_id, created_at);
