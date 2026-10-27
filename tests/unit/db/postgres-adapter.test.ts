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
