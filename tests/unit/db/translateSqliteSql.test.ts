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

test("IS $n (null-safe) becomes IS NOT DISTINCT FROM", () => {
  assert.match(
    translateSqliteSql("SELECT * FROM a WHERE a.scope = $1 AND a.scope_id IS $2"),
    /scope_id IS NOT DISTINCT FROM \$2/i
  );
});

test("IS NOT $n becomes IS DISTINCT FROM", () => {
  assert.match(translateSqliteSql("SELECT * FROM a WHERE x IS NOT $1"), /x IS DISTINCT FROM \$1/i);
});

test("IS NULL / IS NOT NULL are left untouched", () => {
  const sql = "SELECT * FROM a WHERE x IS NULL AND y IS NOT NULL";
  assert.equal(translateSqliteSql(sql), sql);
});

test("strftime(%w, col) becomes EXTRACT(DOW)", () => {
  assert.match(
    translateSqliteSql("SELECT strftime('%w', timestamp) AS dow"),
    /EXTRACT\(DOW FROM \(timestamp\)::timestamptz\)::int/i
  );
});

test("strftime(%s, col) becomes epoch extract", () => {
  assert.match(
    translateSqliteSql("SELECT strftime('%s', created_at)"),
    /EXTRACT\(EPOCH FROM \(created_at\)::timestamptz\)::bigint/i
  );
});

test("strftime(%s, now) becomes epoch of now", () => {
  assert.match(
    translateSqliteSql("SELECT strftime('%s','now')"),
    /EXTRACT\(EPOCH FROM NOW\(\)\)::bigint/i
  );
});

test("strftime ISO format becomes to_char with quoted literals", () => {
  const out = translateSqliteSql("SELECT strftime('%Y-%m-%dT%H:00:00Z', timestamp) AS hour");
  assert.match(out, /to_char\(\(timestamp\)::timestamptz, 'YYYY-MM-DD"T"HH24:00:00"Z"'\)/i);
  assert.doesNotMatch(out, /strftime/i);
});

test("strftime unixepoch modifier wraps to_timestamp", () => {
  const out = translateSqliteSql("SELECT strftime('%Y', created_at, 'unixepoch')");
  assert.match(out, /to_timestamp\(created_at\)/i);
});

test("nested datetime(strftime(...)) translates both", () => {
  const out = translateSqliteSql("SELECT datetime(strftime('%Y-%m-%d %H:00:00', created_at)) AS h");
  assert.doesNotMatch(out, /strftime/i);
  assert.doesNotMatch(out, /\bdatetime\(/i);
  assert.match(out, /to_char/i);
});

test("instr(a,b) becomes strpos(a,b)", () => {
  const out = translateSqliteSql("SELECT instr(requested_model, '/') FROM t");
  assert.match(out, /strpos\(requested_model, '\/'\)/i);
  assert.doesNotMatch(out, /\binstr\(/i);
});

test("plain PostgreSQL passes through untouched", () => {
  const sql = "SELECT id, name FROM provider_connections WHERE enabled = true ORDER BY name";
  assert.equal(translateSqliteSql(sql), sql);
});
