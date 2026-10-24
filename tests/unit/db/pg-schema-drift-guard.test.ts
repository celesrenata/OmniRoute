/**
 * PG schema drift guard (regression: WP6 skill-hub toggle 500 on PostgreSQL —
 * live incident 2026-10-24, session ses_09f27e1f0ffe161i3JbB30618c).
 *
 * `db/postgres/schema-pg.sql` is the DDL applied at provisioning time for
 * PostgreSQL deployments (core.ts skips the SQLite migration runner entirely
 * on the pg-native driver — it bootstraps from this file "out-of-band").
 * When a migration adds a table that is not reflected in schema-pg.sql, the
 * PG production DB never gets it and routes that touch the table 500 on the
 * first use. Migrations 204/205 (skill hub) are exactly that case: the file
 * pre-dated migration 205, so `skill_snapshots` / `skill_catalog_state` were
 * missing in production and /api/skills/catalog/[id]/toggle returned
 * 500 `relation "skill_catalog_state" does not exist`.
 *
 * This test is the cheap always-on stand-in for provisioning a real
 * PostgreSQL instance:
 *
 *   1. Every CREATE TABLE in the numbered migrations (SQLite dialect) must be
 *      represented by a `CREATE TABLE IF NOT EXISTS <name>` block in
 *      schema-pg.sql — except FTS5 shadow tables and virtual tables, which the
 *      translator replaces with FTS_REPLACEMENT / VEC_REPLACEMENT.
 *   2. The translator must turn SQLite `datetime('now', '+30 days')` defaults
 *      (used by migration 205) into a valid PostgreSQL expression instead of
 *      passing the unsupported `datetime(...)` call through verbatim.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MIGRATIONS_DIR = join(repoRoot, "src/lib/db/migrations");
const SCHEMA_PG = join(repoRoot, "db/postgres/schema-pg.sql");

// Must mirror the translator's exclusion sets (scripts/dev/pg-schema-translator.mjs).
// Kept as literals rather than imported: the translator is a .mjs CLI script;
// importing it would execute its main() top-level flow on test load.
const SHADOW_TABLES = new Set([
  "memory_fts_config",
  "memory_fts_data",
  "memory_fts_docsize",
  "memory_fts_idx",
  "vec_memories_chunks",
  "vec_memories_info",
  "vec_memories_rowids",
  "vec_memories_vector_chunks00",
]);
const VIRTUAL_TABLES = new Set(["memory_fts", "vec_memories"]);

function migrationTableNames() {
  const names = new Set();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))) {
    let sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    // Strip SQL comments so prose like "…CREATE TABLE if … / CREATE TABLE is …"
    // does not contribute false-positive table names.
    sql = sql.replace(/--[^\n]*/g, "");
    for (const m of sql.matchAll(
      /CREATE\s+(TEMPORARY\s+|TEMP\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)[\s"'`]/gi
    )) {
      const isTemp = Boolean(m[1]);
      const isRenameScratch = m[3].toLowerCase().endsWith("_new");
      if (isTemp || isRenameScratch) continue;
      names.add(m[3].toLowerCase());
    }
  }
  return names;
}

test("schema-pg.sql covers every migration-created table", () => {
  const schema = readFileSync(SCHEMA_PG, "utf8");
  const missing = [...migrationTableNames()].filter(
    (t) =>
      !SHADOW_TABLES.has(t) &&
      !VIRTUAL_TABLES.has(t) &&
      !new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${t}\\s*\\(`, "i").test(schema)
  );
  assert.deepEqual(
    missing.sort(),
    [],
    `schema-pg.sql is out of date: migrations create ${missing.join(", ")} but the PG provisioning schema does not define them. Regenerate with scripts/dev/pg-schema-translator.mjs.`
  );
});

test("translator converts SQLite datetime('now', '<interval>') defaults to PostgreSQL", async () => {
  // Import the translator module and exercise translateDefault() directly — a
  // stronger guarantee than grepping the artifact: it proves the translator
  // (the code that generates schema-pg.sql) handles the interval form that
  // migration 205 introduced.
  const mod = await import("../../../scripts/dev/pg-schema-translator.mjs");
  // Column defaults in DDL are parenthesized expression defaults, e.g.
  // `DEFAULT (datetime('now'))`; translateDefault() strips one outer pair.
  assert.equal(
    mod.translateDefault("(datetime('now'))"),
    "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
  );
  const out = mod.translateDefault("(datetime('now', '+30 days'))");
  assert.match(out, /INTERVAL '\+30 days'/i, "interval must survive the translation");
  assert.match(out, /to_char\(now\(\)/i, "must emit a to_char(now() …) expression");
  assert.ok(!/^\s*datetime\(/i.test(out), "must not emit a raw SQLite datetime() call");
});
