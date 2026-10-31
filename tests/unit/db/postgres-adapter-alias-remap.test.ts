/**
 * @file Regression test for the analytics blank-page incident: PostgreSQL folds
 * unquoted SELECT aliases to lowercase (AS totalRequests -> totalrequests), so
 * analytics reads of camelCase fields came back undefined and the dashboard
 * rendered empty. The adapter must return keys in the case the SQL declared.
 *
 * @group db/postgres-adapter
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresAdapter } from "@/lib/db/adapters/postgresAdapter";

function makeAdapter(rows: Record<string, unknown>[]) {
  const client = {
    querySync: (_sql: string, _values?: unknown[]) => rows,
    pq: { cmdTuples: () => "0" },
  };
  return createPostgresAdapter({ client } as never);
}

const SUMMARY_SQL = `
  SELECT
    COALESCE(SUM(requests), 0) as totalRequests,
    COALESCE(SUM(tokens_input), 0) as promptTokens
  FROM usage_history AS _u
`;

test("get() restores the declared camelCase alias case", () => {
  const adapter = makeAdapter([{ totalrequests: 42, prompttokens: 7 }]);
  const row = adapter.prepare(SUMMARY_SQL).get() as Record<string, unknown>;
  assert.equal(row.totalRequests, 42);
  assert.equal(row.promptTokens, 7);
  assert.equal(row.totalrequests, undefined);
});

test("all() restores the declared camelCase alias case on every row", () => {
  const adapter = makeAdapter([
    { accountkey: "a", promptTokens: undefined, prompttokens: 1 },
    { accountkey: "b", prompttokens: 2 },
  ]);
  const rows = adapter
    .prepare(
      "SELECT account_key as accountKey, SUM(tokens_input) as promptTokens FROM usage_history GROUP BY account_key"
    )
    .all() as Array<Record<string, unknown>>;
  assert.deepEqual(
    rows.map((r) => [r.accountKey, r.promptTokens]),
    [
      ["a", 1],
      ["b", 2],
    ]
  );
});

test("quoted aliases and columns without AS pass through unchanged", () => {
  const adapter = makeAdapter([{ MyAlias: "quoted", plaincol: 3 }]);
  const row = adapter.prepare('SELECT x AS "MyAlias", plaincol FROM usage_history').get() as Record<
    string,
    unknown
  >;
  assert.equal(row.MyAlias, "quoted");
  assert.equal(row.plaincol, 3);
});
