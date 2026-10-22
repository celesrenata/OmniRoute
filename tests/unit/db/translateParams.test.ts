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
