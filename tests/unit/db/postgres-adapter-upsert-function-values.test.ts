/**
 * @file Regression tests for the postgresAdapter `INSERT OR REPLACE` / `INSERT OR IGNORE`
 * translation when a VALUES entry contains a function call.
 *
 * Production failure: `PATCH /api/model-capability-overrides` (and
 * `PATCH /api/model-context-overrides`) returned 500 on the PostgreSQL backend with
 *   `[postgresAdapter] INSERT OR REPLACE shape not supported: INSERT OR REPLACE INTO
 *    model_context_overrides (provider, model_id, real_context, source, refreshed_at)
 *    VALUES ($1, $2, $3, $4, NOW())`
 * because the values group was matched with `[^)]+`, which cannot contain the `)` of
 * `NOW()` / `datetime('now')` / `to_char(...)`. The upsert was therefore never translated.
 *
 * @group db/postgres-adapter
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  translateInsertOrIgnore,
  translateInsertOrReplace,
  translateSqliteSql,
} from "@/lib/db/adapters/postgresAdapter.ts";

const PK = ["provider", "model_id"];

test("INSERT OR REPLACE with datetime('now') translates to ON CONFLICT upsert", () => {
  // Exact shape used by src/lib/db/modelContextOverrides.ts::setModelContextOverride
  const sqliteSql =
    "INSERT OR REPLACE INTO model_context_overrides " +
    "(provider, model_id, real_context, source, refreshed_at) " +
    "VALUES (?, ?, ?, ?, datetime('now'))";

  // The adapter rewrites SQLite dialect first, then translates the upsert.
  const translated = translateParamsLike(sqliteSql);
  const finalSql = translateInsertOrReplace(translated, PK);

  assert.match(finalSql, /^INSERT INTO model_context_overrides \(/);
  assert.match(
    finalSql,
    /ON CONFLICT \(provider, model_id\) DO UPDATE SET real_context = EXCLUDED\.real_context/
  );
  // The function value must survive verbatim (never re-numbered or dropped).
  assert.match(finalSql, /NOW\(\)/);
  assert.doesNotMatch(finalSql, /^INSERT OR REPLACE/);
});

test("INSERT OR REPLACE keeps multi-comma function calls in VALUES intact", () => {
  const sql = translateParamsLike(
    "INSERT OR REPLACE INTO t (id, at) VALUES (?, to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD'))"
  );
  const finalSql = translateInsertOrReplace(sql, ["id"]);

  assert.match(finalSql, /ON CONFLICT \(id\) DO UPDATE SET at = EXCLUDED\.at/);
  // Two columns in, two values out — the inner comma must not split the value.
  assert.match(finalSql, /VALUES \(\$1, to_char\(NOW\(\) AT TIME ZONE 'UTC', 'YYYY-MM-DD'\)\)/);
});

test("INSERT OR REPLACE tolerates leading whitespace and a trailing newline", () => {
  const sql = translateParamsLike("\n  INSERT OR REPLACE INTO kv (key, value) VALUES (?, NOW())\n");
  const finalSql = translateInsertOrReplace(sql, ["key"]);
  assert.match(finalSql, /^INSERT INTO kv \(key, value\) VALUES \(\$1, NOW\(\)\)/);
  assert.match(finalSql, /ON CONFLICT \(key\) DO UPDATE SET value = EXCLUDED\.value/);
});

test("INSERT OR IGNORE with a function value translates to ON CONFLICT DO NOTHING", () => {
  const sql = translateSqliteSql(
    "INSERT OR IGNORE INTO kv (key, value) VALUES (?, datetime('now'))"
  );
  const finalSql = translateInsertOrIgnore(sql, ["key"]);
  assert.match(finalSql, /ON CONFLICT \(key\) DO NOTHING$/);
  assert.match(finalSql, /NOW\(\)/);
});

test("a comma inside a string literal is not treated as a value separator", () => {
  const sql = translateParamsLike("INSERT OR REPLACE INTO kv (key, value) VALUES (?, 'a, b')");
  const finalSql = translateInsertOrReplace(sql, ["key"]);
  assert.match(finalSql, /VALUES \(\$1, 'a, b'\)/);
});

test("uniqBy/db_meta inline literal upserts still keep their literals", () => {
  // Guards the pre-existing invariant documented in translateInsertOrReplace:
  // literal-only statements must not become placeholder-only.
  const sql = "INSERT OR REPLACE INTO db_meta (key, value) VALUES ('schema_version', '1')";
  const finalSql = translateInsertOrReplace(sql, ["key"]);
  assert.match(finalSql, /VALUES \('schema_version', '1'\)/);
  assert.doesNotMatch(finalSql, /\$1/);
});

test("multi-row VALUES still fails loud instead of being mangled into one row", () => {
  // The paren-tolerant matcher must not turn `VALUES (a), (b)` into a single
  // row: that would silently upsert one row with garbage values.
  const sql = translateParamsLike("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?), (?, ?)");
  assert.throws(
    () => translateInsertOrReplace(sql, ["key"]),
    /INSERT OR REPLACE shape not supported/
  );
});

// `translateParams` rewrites `?` -> `$n`; the adapter runs it before the upsert
// translation, so mirror that order here.
function translateParamsLike(sql: string): string {
  const translated = translateSqliteSql(sql);
  let index = 0;
  return translated.replace(/\?/g, () => `$${++index}`);
}
