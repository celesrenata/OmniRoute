import { test } from "node:test";
import assert from "assert";

// Import the translation function directly
import { translateParams } from "@/lib/db/adapters/postgresAdapter.ts";

test("translateParams should not convert '?' inside string literals", () => {
  const input = "SELECT * FROM tbl WHERE a = '?' AND b = ?";
  const result = translateParams(input);

  assert.strictEqual(result.sql, "SELECT * FROM tbl WHERE a = '?' AND b = $1");
  assert.strictEqual(result.numParams, 1);
});

test("translateParams should handle escaped quotes in strings", () => {
  const input = "SELECT * FROM tbl WHERE a = 'It''s a test' AND b = ?";
  const result = translateParams(input);

  assert.strictEqual(result.sql, "SELECT * FROM tbl WHERE a = 'It''s a test' AND b = $1");
  assert.strictEqual(result.numParams, 1);
});

test("translateParams should ignore '?' in string literals with quotes", () => {
  const input = "INSERT INTO table VALUES ('Hello ? World', ?, ?)";
  const result = translateParams(input);

  assert.strictEqual(result.sql, "INSERT INTO table VALUES ('Hello ? World', $1, $2)");
  assert.strictEqual(result.numParams, 2);
});

test("translateParams should support multi-line queries", () => {
  const input = `
    SELECT *
    FROM table
    WHERE col1 = ? 
      AND col2 LIKE '%?%'
      AND col3 = ?
  `;
  const result = translateParams(input);

  assert.strictEqual(
    result.sql,
    `
    SELECT *
    FROM table
    WHERE col1 = $1 
      AND col2 LIKE '%?%'
      AND col3 = $2
  `
  );
  assert.strictEqual(result.numParams, 2);
});

test("translateParams should handle empty queries", () => {
  const input = "";
  const result = translateParams(input);

  assert.strictEqual(result.sql, "");
  assert.strictEqual(result.numParams, 0);
});

test("translateParams should handle queries without parameters", () => {
  const input = "SELECT * FROM users WHERE id = 123";
  const result = translateParams(input);

  assert.strictEqual(result.sql, "SELECT * FROM users WHERE id = 123");
  assert.strictEqual(result.numParams, 0);
});

test("translateParams should handle multiple parameters", () => {
  const input = "UPDATE users SET name = ?, email = ? WHERE id = ?";
  const result = translateParams(input);

  assert.strictEqual(result.sql, "UPDATE users SET name = $1, email = $2 WHERE id = $3");
  assert.strictEqual(result.numParams, 3);
});

test("translateParams should handle complex edge cases", () => {
  const input = "SELECT * FROM test WHERE a = 'a?' AND b = '??' AND c = ?";
  const result = translateParams(input);

  assert.strictEqual(result.sql, "SELECT * FROM test WHERE a = 'a?' AND b = '??' AND c = $1");
  assert.strictEqual(result.numParams, 1);
});

test("translateParams maps @named params to $n with ordered names", () => {
  const r = translateParams("UPDATE t SET is_active = @isActive WHERE provider = @provider");
  assert.strictEqual(r.sql, "UPDATE t SET is_active = $1 WHERE provider = $2");
  assert.strictEqual(r.numParams, 2);
  assert.deepStrictEqual(r.names, ["isActive", "provider"]);
});

test("translateParams reuses the slot for a repeated named param", () => {
  const r = translateParams("INSERT INTO t (a, b) VALUES (@x, @x)");
  assert.strictEqual(r.sql, "INSERT INTO t (a, b) VALUES ($1, $1)");
  assert.strictEqual(r.numParams, 1);
  assert.deepStrictEqual(r.names, ["x"]);
});

test("translateParams supports :name and $name styles", () => {
  const r = translateParams("SELECT * FROM t WHERE a = :foo AND b = $bar");
  assert.strictEqual(r.sql, "SELECT * FROM t WHERE a = $1 AND b = $2");
  assert.deepStrictEqual(r.names, ["foo", "bar"]);
});

test("translateParams leaves :: casts and $1 positionals untouched", () => {
  const r = translateParams("SELECT x::timestamptz, $1 FROM t WHERE y = ?");
  // $1 is a literal already-positional token (digit after $), :: is a cast.
  assert.match(r.sql, /x::timestamptz/);
  assert.match(r.sql, /\$1 FROM/);
});

test("translateParams does not treat @ inside a string literal as a param", () => {
  const r = translateParams("SELECT * FROM t WHERE email = 'a@b.com' AND id = @id");
  assert.strictEqual(r.sql, "SELECT * FROM t WHERE email = 'a@b.com' AND id = $1");
  assert.deepStrictEqual(r.names, ["id"]);
});
