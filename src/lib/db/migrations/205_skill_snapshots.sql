-- Migration 205: Skill snapshots with 30-day retention
-- Adds persistent snapshots to track skillset state across process restarts
-- and provides a foundation for AI-driven discovery and automatic refresh.

-- Skill snapshots (readable, not modifiable after creation)
CREATE TABLE IF NOT EXISTS skill_snapshots (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- snapshot type: 'full' = all skills at time of creation
  type TEXT NOT NULL DEFAULT 'full',
  -- JSON payload: { total: number, sources: { builtin: number, imported: number }, domains: string[] }
  metadata TEXT NOT NULL,
  -- JSON payload: skill catalog array for restore (optional, can be rebuilt)
  data TEXT,
  -- 30-day retention; after this time, cleanup will remove the snapshot
  retention_until TEXT NOT NULL DEFAULT (datetime('now', '+30 days')),
  -- reference to the import job that created this (null for automated snapshots)
  import_job_id TEXT REFERENCES skill_import_jobs(id) ON DELETE SET NULL
);

-- Index for retention cleanup
CREATE INDEX IF NOT EXISTS idx_skill_snapshots_retention ON skill_snapshots(retention_until);

-- Index for quick lookup of latest snapshot
CREATE INDEX IF NOT EXISTS idx_skill_snapshots_created ON skill_snapshots(created_at DESC);

-- Per-skill enable/disable overrides for catalog skills (Skill Hub toggles).
-- A row means "disabled" (enabled=0). Removing the row re-enables the skill
-- (catalog skills are enabled by default — a default-on catalog must not
-- require a row per skill).
CREATE TABLE IF NOT EXISTS skill_catalog_state (
  skill_id TEXT PRIMARY KEY,       -- catalog id: builtin:<name> | imported:<domain>/<slug>
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
