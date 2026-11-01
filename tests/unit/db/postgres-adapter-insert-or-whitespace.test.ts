/**
 * @file Tests for postgresAdapter INSERT OR regex fix (leading whitespace tolerance).
 * The regex `^INSERT\s+OR\s+\w+\s+INTO\s+(\w+)` rejected queries with leading whitespace
 * (e.g., multi-line `INSERT OR REPLACE INTO …`). Changed to `^\s*INSERT\s+OR\s+...`.
 *
 * @group db/postgres-adapter
 */

import { test } from "node:test";
import assert from "assert";

test("postgresAdapter INSERT OR regex: leading whitespace tolerance", () => {
  // The old regex:
  //   /^INSERT\s+OR\s+\w+\s+INTO\s+(\w+)/i
  // Fails on multi-line SQL with leading whitespace:
  //   "\nINSERT OR REPLACE INTO table_name ...\n"
  //
  // Fixed regex:
  //   /^\s*INSERT\s+OR\s+\w+\s+INTO\s+(\w+)/i
  //
  // This allows optional leading whitespace before INSERT.

  const oldRegex = /^INSERT\s+OR\s+\w+\s+INTO\s+(\w+)/i;
  const newRegex = /^\s*INSERT\s+OR\s+\w+\s+INTO\s+(\w+)/i;

  const multilineSql = `\nINSERT OR REPLACE INTO users (id) VALUES (1)`;
  const singleLineSql = "INSERT OR REPLACE INTO users (id) VALUES (1)";

  // Old regex only matches single-line
  assert.strictEqual(oldRegex.test(singleLineSql), true);
  assert.strictEqual(oldRegex.test(multilineSql), false);

  // New regex matches both
  assert.strictEqual(newRegex.test(singleLineSql), true);
  assert.strictEqual(newRegex.test(multilineSql), true);

  // Extracted table names match
  const oldMatch = oldRegex.exec(singleLineSql);
  const newMatch = newRegex.exec(multilineSql);
  assert.strictEqual(oldMatch?.[1], "users");
  assert.strictEqual(newMatch?.[1], "users");
});
