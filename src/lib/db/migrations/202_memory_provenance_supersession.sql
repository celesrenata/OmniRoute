-- Migration 202: Intelligence Layer v2 (WP1) — memory provenance v2 + versioned supersession.
--
-- Builds on migration 197 (source / confidence / recorded_at + memory_audit).
-- This adds the remaining B1 provenance fields on `memories` and the two
-- append-only tables that make contradiction handling safe: instead of a
-- silent key-prefix UPSERT overwriting an older fact, we keep the previous
-- version in `memory_revisions` and link the winner via `memories.supersedes_id`.
--
-- All new `memories` columns are nullable / have safe defaults so pre-v2 rows
-- are read as-is. The migration runner treats "duplicate column name" as a no-op,
-- so re-running on a partially-migrated DB is safe. CREATE ... IF NOT EXISTS is
-- naturally idempotent.
--
-- Nothing is dropped and no existing row is rewritten destructively; backfills
-- set conservative defaults so a NULL never means "untrusted global".

-- ── Remaining provenance / authority columns ─────────────────────────────────
-- scope: strict tenant boundary. NULL for pre-v2 rows; readers treat NULL as
--        "key" (the legacy owner-level scope), NEVER as global.
ALTER TABLE memories ADD COLUMN scope TEXT DEFAULT NULL;
-- agent_id: authenticated agent identity, if known. NULL otherwise.
ALTER TABLE memories ADD COLUMN agent_id TEXT DEFAULT NULL;
-- workspace_id / project: project facts are scoped here. NULL = not project-bound.
ALTER TABLE memories ADD COLUMN workspace_id TEXT DEFAULT NULL;
-- subject / predicate: the structured (entity, key) a fact is about, used for
-- per-scope dedup and contradiction detection.
ALTER TABLE memories ADD COLUMN subject TEXT DEFAULT NULL;
ALTER TABLE memories ADD COLUMN predicate TEXT DEFAULT NULL;
-- verification_state: unverified | corroborated | confirmed | disputed | rejected.
-- Constant default so ANY row (old or new) that omits it reads as 'unverified'
-- — a legacy fact is never silently treated as operator-confirmed.
ALTER TABLE memories ADD COLUMN verification_state TEXT NOT NULL DEFAULT 'unverified';
-- sensitivity: normal | sensitive | secret. Constant default 'normal'.
ALTER TABLE memories ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal';
-- status: active | superseded | disputed | quarantined | deleted. Constant
-- default 'active' so nothing silently disappears on insert.
ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
-- supersedes_id: for a winner row, the id of the row it supersedes (version link).
ALTER TABLE memories ADD COLUMN supersedes_id TEXT DEFAULT NULL;
-- verified_at: when a memory transitioned to a verified / confirmed state.
ALTER TABLE memories ADD COLUMN verified_at TEXT DEFAULT NULL;
-- embedding provenance: which model/dim produced the vector, so a model swap
-- does not silently compare incompatible vectors.
ALTER TABLE memories ADD COLUMN embedding_model TEXT DEFAULT NULL;
ALTER TABLE memories ADD COLUMN embedding_version TEXT DEFAULT NULL;

-- ── Versioned supersession / audit history ───────────────────────────────────
-- Append-only history of prior versions of a memory. The live value stays in
-- `memories`; the superseded content + the reason for supersession live here,
-- so review/correction/rollback is possible without destroying history.
CREATE TABLE IF NOT EXISTS memory_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL,
  subject TEXT,
  predicate TEXT,
  source_kind TEXT,
  verification_state TEXT,
  confidence TEXT,
  superseded_reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_revisions_memory ON memory_revisions(memory_id);

-- Provenance quotes: persist the raw quote / reference separately from the
-- generated canonical fact, so a review can verify the source independently.
CREATE TABLE IF NOT EXISTS memory_provenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  quote_text TEXT,
  source_kind TEXT,
  source_uri TEXT,
  source_turn_id TEXT,
  observed_at TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_provenance_memory ON memory_provenance(memory_id);

-- Pre-v2 rows need no backfill: the `NOT NULL DEFAULT` clauses above give every
-- existing row a safe value on the ADD COLUMN itself, and any future insert that
-- omits the column inherits the same default. A legacy fact is therefore always
-- read as 'active' / 'unverified' / 'normal' with scope NULL — never
-- 'confirmed', never 'global'. `scope` stays nullable by design: "missing
-- trusted scope" is represented as NULL, not a synthetic global value.
