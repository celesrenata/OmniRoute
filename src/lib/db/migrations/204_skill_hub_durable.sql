-- Migration 204: Intelligence Layer v2 (WP6) — durable Skill Hub tables.
--
-- WP4 (SkillDiscoveryService + omr_catalog_* tools) currently reads the catalog
-- from disk in-memory and keeps import state only on the filesystem. This adds
-- the durable tables the spec (A2) requires so import state, collections
-- (skillsets), per-agent grants, import jobs, and execution approvals survive
-- across processes and are auditable.
--
-- These are additive. WP4's in-memory index still works (it indexes built-in
-- skills from src/lib/skills and imported skills from disk); this layer is the
-- persistence + policy backplane that the discovery service consults for
-- collections, grants, and quarantine/import state.
--
-- CREATE TABLE IF NOT EXISTS is naturally idempotent; re-running is a no-op.

-- A skill source: where imported skills come from (git URL / local path / registry).
CREATE TABLE IF NOT EXISTS skill_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,               -- git | path | registry
  uri TEXT NOT NULL,
  revision TEXT,                    -- branch / commit / tag / version
  trusted INTEGER NOT NULL DEFAULT 0,  -- 1 = operator-trusted source
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- An imported skill package (a skill discovered from a source).
CREATE TABLE IF NOT EXISTS skill_packages (
  id TEXT PRIMARY KEY,              -- e.g. imported:<domain>/<slug>
  source_id TEXT NOT NULL REFERENCES skill_sources(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  domain TEXT,
  description TEXT,
  revision TEXT,                    -- the revision the package was imported at
  tags TEXT,                        -- JSON array
  license TEXT,
  executable INTEGER NOT NULL DEFAULT 0,
  quarantine INTEGER NOT NULL DEFAULT 0,   -- 1 = quarantined by the importer
  quarantine_reasons TEXT,          -- JSON array of hard-block findings
  status TEXT NOT NULL DEFAULT 'active',   -- active | deprecated | deleted
  imported_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_skill_packages_source ON skill_packages(source_id);
CREATE INDEX IF NOT EXISTS idx_skill_packages_domain ON skill_packages(domain);

-- Files shipped with a package (for the resource browser / scan findings).
CREATE TABLE IF NOT EXISTS skill_package_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id TEXT NOT NULL REFERENCES skill_packages(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  size INTEGER,
  sha256 TEXT,
  scan_flags TEXT                   -- JSON array of soft-warning findings
);
CREATE INDEX IF NOT EXISTS idx_skill_package_files_package ON skill_package_files(package_id);

-- A skill collection (the "skillset" concept). A named, policy-checked bundle.
CREATE TABLE IF NOT EXISTS skill_collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'manual',   -- seed | manual | learned
  visible INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Membership: a skill package in a collection.
CREATE TABLE IF NOT EXISTS skill_collection_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id TEXT NOT NULL REFERENCES skill_collections(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,            -- skill_packages.id
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (collection_id, skill_id)
);
CREATE INDEX IF NOT EXISTS idx_skill_collection_members_coll ON skill_collection_members(collection_id);

-- Per-agent grant: an agent may access the skillsets it has been granted.
-- This is the policy layer WP4's searchCatalog consults to filter by agent.
CREATE TABLE IF NOT EXISTS skill_agent_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,            -- agent identity (or an api_key_id)
  collection_id TEXT NOT NULL REFERENCES skill_collections(id) ON DELETE CASCADE,
  permission TEXT NOT NULL DEFAULT 'discover',  -- discover | execute
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (agent_id, collection_id, permission)
);
CREATE INDEX IF NOT EXISTS idx_skill_agent_grants_agent ON skill_agent_grants(agent_id);

-- Durable record of a skill import run (WP3 importer audit trail).
CREATE TABLE IF NOT EXISTS skill_import_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT,
  trigger TEXT NOT NULL DEFAULT 'manual',   -- manual | scheduled | model_swap
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | failed
  discovered INTEGER NOT NULL DEFAULT 0,
  imported INTEGER NOT NULL DEFAULT 0,
  quarantined INTEGER NOT NULL DEFAULT 0,
  dry_run INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_skill_import_jobs_status ON skill_import_jobs(status);

-- Execution approval: a one-time or persistent approval to execute a skill.
CREATE TABLE IF NOT EXISTS skill_execution_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id TEXT NOT NULL,            -- skill_packages.id
  agent_id TEXT,
  scope TEXT NOT NULL DEFAULT 'once',   -- once | persistent | denied
  reason TEXT,
  granted_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_skill_execution_approvals_skill ON skill_execution_approvals(skill_id);
