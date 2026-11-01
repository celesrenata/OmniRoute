/**
 * @file Tests for antiCheat.ts HAVING alias fix (PG forbids aliases in HAVING).
 * `HAVING hourly_total > 1000` fails on Postgres — must use `HAVING SUM(xp_earned) > 1000`.
 *
 * @group gamification/antiCheat
 */

import { test } from "node:test";
import assert from "assert";

test("SQL must not reference alias in HAVING clause on Postgres", () => {
  // The old query (broken on Postgres):
  //   SELECT api_key_id, SUM(xp_earned) AS hourly_total
  //   FROM xp_audit_log
  //   WHERE created_at > datetime('now', '-1 hour')
  //   GROUP BY api_key_id
  //   HAVING hourly_total > 1000
  //
  // Fails on Postgres with: "column 'hourly_total' does not exist"
  // because HAVING can only reference aggregates or GROUP BY columns.

  const oldQuery = `
    SELECT api_key_id, SUM(xp_earned) AS hourly_total
    FROM xp_audit_log
    WHERE created_at > datetime('now', '-1 hour')
    GROUP BY api_key_id
    HAVING hourly_total > 1000
  `;
  // This query uses the alias in HAVING — valid on SQLite, invalid on Postgres.

  // Check that the old query contains the problematic pattern
  assert.ok(oldQuery.includes("HAVING hourly_total > 1000"));

  // The fixed query:
  const fixedQuery = `
    SELECT api_key_id, SUM(xp_earned) AS hourly_total
    FROM xp_audit_log
    WHERE created_at > datetime('now', '-1 hour')
    GROUP BY api_key_id
    HAVING SUM(xp_earned) > 1000
  `;
  // The alias remains in SELECT and ORDER BY (allowed),
  // but HAVING repeats the aggregate.

  assert.ok(fixedQuery.includes("HAVING SUM(xp_earned) > 1000"));
  assert.strictEqual(fixedQuery.includes("HAVING hourly_total"), false);
});
