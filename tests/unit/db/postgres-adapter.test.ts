import { test } from "node:test";
import assert from "assert";
import { createPostgresAdapter } from "@/lib/db/adapters/postgresAdapter.ts";

// The adapter is a synchronous `pg-native` driver that connects eagerly in the
// factory. In a unit environment there is no reachable PostgreSQL (and often no
// `pg-native` native addon installed), so the factory is expected to throw
// rather than return a half-open adapter. This asserts the observable
// fail-loud contract the driver factory relies on (it catches and falls back
// to SQLite). A live round-trip is covered by the boot/integration demo, not
// here, to keep the unit suite free of a database dependency.
test("createPostgresAdapter throws when it cannot connect (no live PG / no pg-native)", () => {
  assert.throws(() => {
    createPostgresAdapter({
      host: "127.0.0.1",
      port: 1, // unroutable port — connectSync fails fast
      database: "omniroute_unit_test_nope",
      user: "nobody",
      password: "nobody",
    });
  });
});

test("createPostgresAdapter accepts a connectionString form without throwing synchronously before connect", () => {
  // Still expected to throw on connect, but the call shape (connectionString
  // instead of discrete fields) must be accepted by the factory signature.
  assert.throws(() => {
    createPostgresAdapter({
      connectionString:
        "host=127.0.0.1 port=1 dbname=omniroute_unit_test_nope user=nobody password=nobody",
    });
  });
});

// ── prepare().get() no-row semantics ───────────────────────────────────────
// Regression: pg-native's querySync() returns an EMPTY ARRAY for a zero-row
// SELECT, not `undefined`. The adapter's general-SQL get() must mirror
// better-sqlite3 (which returns `undefined` for no row). Returning `[]`
// (truthy) broke every `(prepare().get(...) || null)` idiom: createProvider-
// Connection's api-key dedup treated "no row" as "a row with no columns" and
// 500'd POST /api/providers with "Failed to create provider" for every new
// connection (the reported "cannot add llama-cpp" failure).
//
// These drive the REAL prepare()/get()/all() path via the injected-client
// seam (no live PostgreSQL, no native addon required).

const DEDUP_SQL =
  "SELECT * FROM provider_connections WHERE provider = ? AND auth_type = 'apikey' AND name = ?";

/** Minimal pg-native client stub. querySync mirrors the driver's zero-row shape ([]). */
function stubClient(rows: unknown) {
  return {
    _rows: rows,
    querySync(_sql: string, _params?: unknown[]) {
      return rows;
    },
    end() {},
  };
}

test("general-SQL get() returns undefined (not []) when the SELECT matches no row", () => {
  const adapter = createPostgresAdapter({
    // host/port are never used because an injected client is supplied.
    host: "127.0.0.1",
    database: "omniroute_unit_test_nope",
    user: "nobody",
    password: "nobody",
    client: stubClient([]), // real pg-native zero-row shape
  });

  const row = adapter.prepare(DEDUP_SQL).get("llama-cpp", "My Local");

  // The bug returned `[]` here. Callers do `(...) || null` and treat `[]`
  // as a found row — so this must be `undefined` (falsy), not a truthy array.
  assert.strictEqual(row, undefined);
  assert.ok(!row, "get() must be falsy for a no-row SELECT");
});

test("general-SQL get() returns the first row when the SELECT matches one", () => {
  const singleRow = { id: "abc", provider: "llama-cpp", auth_type: "apikey", name: "My Local" };
  const adapter = createPostgresAdapter({
    host: "127.0.0.1",
    database: "omniroute_unit_test_nope",
    user: "nobody",
    password: "nobody",
    client: stubClient([singleRow]),
  });

  assert.deepStrictEqual(adapter.prepare(DEDUP_SQL).get("llama-cpp", "My Local"), singleRow);
});

test("general-SQL all() still returns [] for a no-row SELECT (unchanged)", () => {
  const adapter = createPostgresAdapter({
    host: "127.0.0.1",
    database: "omniroute_unit_test_nope",
    user: "nobody",
    password: "nobody",
    client: stubClient([]),
  });

  const rows = adapter
    .prepare("SELECT * FROM provider_connections WHERE provider = ?")
    .all("llama-cpp");
  assert.deepStrictEqual(rows, []);
});

test("general-SQL get() over multi-row result returns only the first row", () => {
  const twoRows = [{ id: "a" }, { id: "b" }];
  const adapter = createPostgresAdapter({
    host: "127.0.0.1",
    database: "omniroute_unit_test_nope",
    user: "nobody",
    password: "nobody",
    client: stubClient(twoRows),
  });

  assert.deepStrictEqual(adapter.prepare(DEDUP_SQL).get("llama-cpp", "x"), { id: "a" });
});
