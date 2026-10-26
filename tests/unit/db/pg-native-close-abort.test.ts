import { test } from "node:test";
import assert from "assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  releasePgClient,
  getRetainedPgClientCount,
  resetRetainedPgClientsForTest,
} from "@/lib/db/adapters/postgresAdapter.ts";
import { isSocketDatabaseDriver } from "@/lib/db/adapters/driverFactory.ts";
import { shouldProbeSyncDriverForBoot } from "@/lib/db/core.ts";
import { createManagedDbBackup } from "@/lib/db/managedBackup.ts";
import type { SqliteAdapter } from "@/lib/db/adapters/types.ts";

/**
 * Regression guard for the PostgreSQL boot crashloop.
 *
 * pg-native (libpq 1.11.0) embeds its `uv_poll_t` in the native Connection and
 * calls `uv_close(handle, NULL)` from `PQ#finish()`. If the JS wrapper is
 * collected before libuv drains the close queue, `uv__finish_close` asserts and
 * the process SIGABRTs (exit 134). A Postgres deployment died ~2s into every
 * boot because `ensureDbInitialized()` opened a throwaway probe connection and
 * closed it. These tests pin the three defenses:
 *
 *   1. releasePgClient() keeps the ended client reachable (and calls end once).
 *   2. boot no longer probes a sync driver for socket-backed drivers.
 *   3. the SQLite-only `VACUUM INTO` backup is skipped, not executed, on PG.
 */

test("releasePgClient ends the client exactly once and retains the reference", () => {
  resetRetainedPgClientsForTest();
  let endCalls = 0;
  const client = {
    end() {
      endCalls += 1;
      return undefined;
    },
  };

  releasePgClient(client);

  assert.strictEqual(endCalls, 1, "end() must be called once");
  assert.strictEqual(getRetainedPgClientCount(), 1, "ended client must stay reachable");
});

test("releasePgClient caps retained clients so a reset loop cannot grow forever", () => {
  resetRetainedPgClientsForTest();
  for (let i = 0; i < 300; i += 1) {
    releasePgClient({ end: () => undefined });
  }
  assert.strictEqual(getRetainedPgClientCount(), 256);
  resetRetainedPgClientsForTest();
});

test("isSocketDatabaseDriver recognises postgres/pg-native only", () => {
  assert.strictEqual(isSocketDatabaseDriver({ DATABASE_DRIVER: "postgres" }), true);
  assert.strictEqual(isSocketDatabaseDriver({ DATABASE_DRIVER: "pg-native" }), true);
  assert.strictEqual(isSocketDatabaseDriver({ DATABASE_DRIVER: "better-sqlite3" }), false);
  assert.strictEqual(isSocketDatabaseDriver({}), false);
});

test("boot does not probe a sync driver for socket-backed drivers", () => {
  assert.strictEqual(shouldProbeSyncDriverForBoot({ DATABASE_DRIVER: "postgres" }), false);
  assert.strictEqual(shouldProbeSyncDriverForBoot({ DATABASE_DRIVER: "pg-native" }), false);
  // SQLite-file drivers still need the probe (sql.js fallback path).
  assert.strictEqual(shouldProbeSyncDriverForBoot({ DATABASE_DRIVER: "better-sqlite3" }), true);
  assert.strictEqual(shouldProbeSyncDriverForBoot({}), true);
});

test("createManagedDbBackup never runs VACUUM INTO against PostgreSQL", () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-pg-backup-"));
  const target = path.join(backupDir, "nested");
  let execCalls = 0;

  const pgAdapter = {
    driver: "pg-native",
    exec() {
      execCalls += 1;
      throw new Error("VACUUM INTO must not reach PostgreSQL");
    },
    raw: {},
  } as unknown as SqliteAdapter;

  try {
    const created = createManagedDbBackup(pgAdapter, "test", target);

    assert.strictEqual(created, false, "backup must report unsupported");
    assert.strictEqual(execCalls, 0, "no SQL may be executed on the pg adapter");
    assert.strictEqual(fs.existsSync(target), false, "no backup directory is created");
  } finally {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
});
