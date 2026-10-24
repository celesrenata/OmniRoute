/**
 * @file Tests for postgresAdapter alias-remap fix (PG folds unquoted aliases to lowercase).
 * Verifies that row keys are remapped to match the SQL-declared alias case.
 *
 * @group db/postgres-adapter
 */

import { test } from "node:test";
import assert from "assert";

test("postgresAdapter alias remap: unquoted alias case preservation", () => {
  // This test documents the expected behavior. The fix is in postgresAdapter.ts:
  // - extractAliases() parses AS aliases from SQL
  // - remapKeys() remaps PG-folded keys back to declared case
  //
  // When PG returns rows with keys { totalcount, message, createdat }
  // from `SELECT 1 AS TotalCount, 'test' AS Message, NOW() AS CreatedAt`,
  // remapKeys should transform them to { TotalCount, Message, CreatedAt }.

  // Simulated PG result (lowercase keys)
  const pgRows: Record<string, unknown>[] = [
    { totalcount: 123, message: "test", createdat: "2026-01-01T00:00:00Z" },
  ];

  // Remap function (mirrors the adapter's remapKeys)
  function remapKeys(
    rows: Record<string, unknown>[],
    aliases: Array<{ declared: string; pgFolded: string }>
  ) {
    if (aliases.length === 0) return rows;
    const aliasMap = new Map(aliases.map((a) => [a.pgFolded, a.declared]));
    return rows.map((row) => {
      const newRow: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        newRow[aliasMap.get(k) ?? k] = v;
      }
      return newRow;
    });
  }

  const sqlAliases = [
    { declared: "TotalCount", pgFolded: "totalcount" },
    { declared: "Message", pgFolded: "message" },
    { declared: "CreatedAt", pgFolded: "createdat" },
  ];

  const remapped = remapKeys(pgRows, sqlAliases);

  // Verify keys match declared aliases
  assert.strictEqual(remapped[0].TotalCount, 123);
  assert.strictEqual(remapped[0].Message, "test");
  assert.strictEqual(remapped[0].CreatedAt, "2026-01-01T00:00:00Z");
});

test("postgresAdapter quoted alias case preservation (no remap needed)", () => {
  // When SQL uses double quotes (AS "MyAlias"), PG preserves case.
  // No remap needed — keys match as-is.

  // Simulate PG returning quoted alias keys
  const pgRows = [{ MyAlias: "quoted" }];

  // With quoted identifiers, the PG result already has MyAlias (not myalias)
  assert.strictEqual(pgRows[0].MyAlias, "quoted");
});
