-- Migration 197: Script Vault Schema
-- Creates the script_vault table to store versioned executable script artifacts

-- Create the script_vault table
CREATE TABLE IF NOT EXISTS script_vault (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT,
  script_content TEXT NOT NULL,
  hash TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT NOT NULL,
  tags TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  install_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(name, version)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_script_vault_name ON script_vault(name);
CREATE INDEX IF NOT EXISTS idx_script_vault_created_by ON script_vault(created_by);
CREATE INDEX IF NOT EXISTS idx_script_vault_status ON script_vault(status);
CREATE INDEX IF NOT EXISTS idx_script_vault_tags ON script_vault(tags);
CREATE INDEX IF NOT EXISTS idx_script_vault_updated_at ON script_vault(updated_at);

-- Create the script migration table to track which migrations have been applied
CREATE TABLE IF NOT EXISTS _omniroute_script_migrations (
  migration_name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

COMMIT;