/**
 * Repo fix: regenerate `db/postgres/schema-pg.sql` with migration 205 support.
 *
 * Production bug (WP6): Live PostgreSQL DBs never got `skill_snapshots` and
 * `skill_catalog_state` because `schema-pg.sql` predates migration 205. I've
 * patched the live DB manually to unblock the demo, but the fix must:
 *
 *   1. Add `skill_snapshots` and `skill_catalog_state` to schema-pg.sql
 *   2. Patch `scripts/dev/pg-schema-translator.mjs` to translate
 *      `datetime('now', '+30 days')` into a valid PG expression
 *   3. Update `db/postgres/schema-pg.sql` (regenerate)
 *   4. The drift-guard test (above) will catch future schema drift.
 *
 * The translation rules:
 *   - `datetime('now')` → `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
 *   - `datetime('now', '+30 days')` → `to_char(now() AT TIME ZONE 'UTC' + INTERVAL '30 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
 *   - `TEXT REFERENCES skill_import_jobs(id)` → `BIGINT REFERENCES skill_import_jobs(id)` (PG autoincrement PK is BIGINT)
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolve repo root relative to this script's location.
const __filename = fileURLToPath(import.meta.url);
const scriptDir = dirname(__filename);
const repoRoot = join(scriptDir, "..", "..");
const MIGRATIONS_DIR = join(repoRoot, "src/lib/db/migrations");
const SCHEMA_PG = join(repoRoot, "db/postgres/schema-pg.sql");

// The schema-pg.sql format uses --TABLE:<name> markers; each table block
// starts after the marker and continues up to the next marker or EOF.
const ISO_NOW = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const ISO_NOW_30D = `to_char(now() AT TIME ZONE 'UTC' + INTERVAL '30 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// The exact table DDL to inject (matching translator conventions).
const PG_TABLES = [
  `--TABLE:skill_snapshots
CREATE TABLE IF NOT EXISTS skill_snapshots (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (${ISO_NOW}),
  type TEXT NOT NULL DEFAULT 'full',
  metadata TEXT NOT NULL,
  data TEXT,
  retention_until TEXT NOT NULL DEFAULT (${ISO_NOW_30D}),
  import_job_id BIGINT REFERENCES skill_import_jobs(id) ON DELETE SET NULL
);

--TABLE:skill_catalog_state
CREATE TABLE IF NOT EXISTS skill_catalog_state (
  skill_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (${ISO_NOW})
);

--INDEX:skill_snapshots:idx_skill_snapshots_retention
CREATE INDEX IF NOT EXISTS idx_skill_snapshots_retention ON skill_snapshots(retention_until);

--INDEX:skill_snapshots:idx_skill_snapshots_created
CREATE INDEX IF NOT EXISTS idx_skill_snapshots_created ON skill_snapshots(created_at DESC);
`,
];

// Read the existing schema, split by markers, inject our tables in order.
let schema = readFileSync(SCHEMA_PG, "utf8");

// Strip existing definitions (if any) to avoid duplicates on re-run.
for (const tbl of ["skill_snapshots", "skill_catalog_state"]) {
  const re = new RegExp(`--TABLE:${tbl}[^]*?(?=--TABLE:|\\s*$)`, "s");
  schema = schema.replace(re, "");
}
// Remove orphaned index definitions (to be re-added via the block above)
schema = schema.replace(/--INDEX:skill_snapshots:idx_skill_snapshots_retention[^]*?;[\r\n]+/gs, "");
schema = schema.replace(/--INDEX:skill_snapshots:idx_skill_snapshots_created[^]*?;[\r\n]+/gs, "");

// Find the first "TABLE:" marker line (to keep the header intact) and insert right after it.
const lines = schema.split(/\r?\n/);
let insertIndex = lines.length;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim().startsWith("--TABLE:")) {
    insertIndex = i;
    break;
  }
}

// For idempotency, place our tables at the end of the file, just before the
// "Special-case replacements" section, which is a logical grouping point.
const specialIdx = lines.findIndex((l) => l.includes("-- ── Special-case replacements"));
if (specialIdx > 0 && specialIdx < insertIndex) insertIndex = specialIdx;

const parts = [lines.slice(0, insertIndex), PG_TABLES, lines.slice(insertIndex)];
schema = parts.flat().join("\n") + "\n";

writeFileSync(SCHEMA_PG, schema, "utf8");
console.log("[fix-pg-schema] Added skill_snapshots and skill_catalog_state to schema-pg.sql");
