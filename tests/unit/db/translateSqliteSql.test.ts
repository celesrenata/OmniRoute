import { test } from "node:test";
import assert from "assert";
import { translateSqliteSql } from "@/lib/db/adapters/postgresAdapter.ts";

test("AUTOINCREMENT integer primary key becomes BIGSERIAL", () => {
  const out = translateSqliteSql("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, x TEXT)");
  assert.match(out, /id BIGSERIAL PRIMARY KEY/i);
  assert.doesNotMatch(out, /AUTOINCREMENT/i);
});

test("stray AUTOINCREMENT keyword is dropped", () => {
  const out = translateSqliteSql("CREATE TABLE t (id INTEGER AUTOINCREMENT)");
  assert.doesNotMatch(out, /AUTOINCREMENT/i);
});

test("DATETIME('now') becomes NOW()", () => {
  assert.match(translateSqliteSql("SELECT DATETIME('now')"), /SELECT NOW\(\)/i);
  assert.match(translateSqliteSql('INSERT INTO t(a) VALUES (DATETIME("now"))'), /NOW\(\)/i);
});

test("DATETIME(col) maps to a timestamptz cast", () => {
  assert.match(translateSqliteSql("SELECT DATETIME(created_at)"), /\(created_at\)::timestamptz/i);
});

test("COLLATE NOCASE is stripped", () => {
  const out = translateSqliteSql("SELECT * FROM t WHERE name = 'x' COLLATE NOCASE");
  assert.doesNotMatch(out, /COLLATE\s+NOCASE/i);
});

test("IFNULL becomes COALESCE", () => {
  assert.match(translateSqliteSql("SELECT IFNULL(a, 0) FROM t"), /COALESCE\(a, 0\)/i);
});

test("strftime('%s','now') becomes epoch extract", () => {
  assert.match(
    translateSqliteSql("SELECT strftime('%s','now')"),
    /EXTRACT\(EPOCH FROM NOW\(\)\)::bigint/i
  );
});

test("DATETIME('now','-'||$1||' days') becomes a NOW() - interval expression", () => {
  const out = translateSqliteSql(
    "DELETE FROM t WHERE datetime(ts) < datetime('now', '-' || $1 || ' days')"
  );
  assert.match(out, /NOW\(\) - \(\(\$1\) \|\| ' days'\)::interval/i);
  assert.doesNotMatch(out, /DATETIME\(/i);
});

test("plain PostgreSQL passes through untouched", () => {
  const sql = "SELECT id, name FROM provider_connections WHERE enabled = true ORDER BY name";
  assert.equal(translateSqliteSql(sql), sql);
});
