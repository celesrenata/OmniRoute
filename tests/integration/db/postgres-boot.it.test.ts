/**
 * PostgreSQL boot-path integration test.
 *
 * Drives the REAL database boot (ensureDbInitialized → core.ts) against a live
 * PostgreSQL so the pg-native adapter is exercised exactly the way the pod does
 * at startup. Reproduces (then guards against) the production boot crashes:
 *   - raw SQLite DDL (AUTOINCREMENT) reaching PostgreSQL
 *   - "bind message supplies 0 parameters, but prepared statement requires N"
 *
 * Gated on OMNIROUTE_PG_IT=1 + a reachable Postgres (schema pre-loaded from
 * db/postgres/schema-pg.sql). It is NOT part of the default unit run because it
 * needs a live server and the native pg-native addon.
 *
 *   OMNIROUTE_PG_IT=1 \
 *   PG_IT_HOST=10.1.1.12 PG_IT_DB=omniroute_iter \
 *   PG_IT_USER=omniroute PG_IT_PASSWORD='***' \
 *   node --import tsx/esm --test tests/integration/db/postgres-boot.it.test.ts
 */
import { test } from "node:test";
import assert from "node:assert";

const ENABLED = process.env.OMNIROUTE_PG_IT === "1";

test(
  "ensureDbInitialized boots cleanly against PostgreSQL",
  { skip: ENABLED ? false : "set OMNIROUTE_PG_IT=1 + PG_IT_* to run" },
  async () => {
    process.env.DATABASE_DRIVER = "postgres";
    process.env.POSTGRES_HOST = process.env.PG_IT_HOST ?? "127.0.0.1";
    process.env.POSTGRES_PORT = process.env.PG_IT_PORT ?? "5432";
    process.env.POSTGRES_DATABASE = process.env.PG_IT_DB ?? "omniroute_iter";
    process.env.POSTGRES_USER = process.env.PG_IT_USER ?? "omniroute";
    process.env.POSTGRES_PASSWORD = process.env.PG_IT_PASSWORD ?? "";

    const core = await import("@/lib/db/core");
    // The crash under test happens inside ensureDbInitialized(); let it throw so
    // the assertion message carries the real PG error.
    await core.ensureDbInitialized();

    // Prove the connection is live and the adapter round-trips a parameterized
    // query (the class of statement that triggered the bind-count crash).
    const db = core.getDbInstance();
    assert.equal(db.driver, "pg-native");
    // Round-trip a parameterized query (the class of statement that triggered
    // the "bind supplies 0 parameters" crash).
    const kv = db
      .prepare("SELECT count(*)::int AS c FROM key_value WHERE namespace = ?")
      .get("pg_shim") as { c: number } | undefined;
    assert.ok(kv, "key_value is queryable after boot");
    assert.ok(typeof kv.c === "number");

    // Regression guards for the non-fatal background-path errors seen in the pod:
    // (1) module self-init DDL with AUTOINCREMENT via exec(); (2) a jobs upsert
    // with datetime('now') + ? placeholders + hand-written ON CONFLICT.
    db.exec(
      "CREATE TABLE IF NOT EXISTS _it_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT, created_at TEXT DEFAULT (datetime('now')))"
    );
    db.prepare("INSERT INTO _it_audit (msg) VALUES (?)").run("hello");
    const auditCount = db.prepare("SELECT count(*)::int AS c FROM _it_audit").get() as {
      c: number;
    };
    assert.ok(auditCount.c >= 1, "AUTOINCREMENT table accepts inserts on PostgreSQL");

    db.exec("CREATE TABLE IF NOT EXISTS _it_jobs (id TEXT PRIMARY KEY, n BIGINT, updated_at TEXT)");
    db.prepare(
      "INSERT INTO _it_jobs (id, n, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(id) DO UPDATE SET n = excluded.n, updated_at = datetime('now')"
    ).run("j1", 5);
    const job = db.prepare("SELECT n::int AS n FROM _it_jobs WHERE id = ?").get("j1") as {
      n: number;
    };
    assert.equal(job.n, 5, "jobs upsert with datetime('now') + ON CONFLICT works on PostgreSQL");

    // Clean up the throwaway tables so repeat runs stay idempotent.
    db.exec("DROP TABLE IF EXISTS _it_audit");
    db.exec("DROP TABLE IF EXISTS _it_jobs");
  }
);
