// Migration 197 (script_vault_schema) ended with a stray top-level `COMMIT;`
// that had no matching `BEGIN;`. The migration runner wraps every migration in
// its own transaction (`db.transaction(...)` in migrationRunner.ts), so the
// migration's own COMMIT closed the runner's transaction early and the
// runner's final COMMIT failed with "cannot commit - no transaction is
// active". runMigrations() then threw, aborting any migrations that had not
// yet been recorded — on a fresh SQLite install the first boot crashed.
//
// This test isolates the migrations directory to just 197 and runs it against
// a fresh in-memory DB, asserting the run completes and the 197 ledger row is
// recorded. With the stray COMMIT present it fails with "cannot commit - no
// transaction is active"; with the fix it passes. (Isolated the same way
// migration-191-resilience-actions.test.ts isolates its migration.)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const repoMigrations = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/lib/db/migrations"
);
const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-migration-197-"));
fs.copyFileSync(
  path.join(repoMigrations, "197_script_vault_schema.sql"),
  path.join(migrationsDir, "197_script_vault_schema.sql")
);
const originalMigrationsDir = process.env.OMNIROUTE_MIGRATIONS_DIR;
process.env.OMNIROUTE_MIGRATIONS_DIR = migrationsDir;

const { runMigrations } = await import("../../../src/lib/db/migrationRunner.ts");

test.after(() => {
  fs.rmSync(migrationsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (originalMigrationsDir === undefined) delete process.env.OMNIROUTE_MIGRATIONS_DIR;
  else process.env.OMNIROUTE_MIGRATIONS_DIR = originalMigrationsDir;
});

test("migration 197 applies cleanly inside the runner's transaction", () => {
  const db = new Database(":memory:");
  try {
    // With the stray COMMIT this throws "cannot commit - no transaction is active".
    runMigrations(db);
    const marker = db
      .prepare("SELECT count(*) c FROM _omniroute_migrations WHERE version = ?")
      .get("197") as { c: number };
    assert.equal(marker.c, 1, "197 ledger row should be recorded");
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    assert.ok(tables.includes("script_vault"), "script_vault table should exist");
  } finally {
    db.close();
  }
});
