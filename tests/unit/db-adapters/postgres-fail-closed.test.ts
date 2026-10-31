import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tryOpenSync } from "../../../src/lib/db/adapters/driverFactory.ts";

const ENV_KEYS = [
  "DATABASE_DRIVER",
  "POSTGRES_CONNECTION_STRING",
  "POSTGRES_HOST",
  "POSTGRES_PORT",
  "POSTGRES_DATABASE",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
] as const;

const savedEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]])
);
const tempDirs: string[] = [];

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DATABASE_DRIVER=postgres with an unreachable server fails closed and never creates a local SQLite file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-pg-fail-closed-"));
  tempDirs.push(dir);
  const sqliteFile = path.join(dir, "storage.sqlite");

  process.env.DATABASE_DRIVER = "postgres";
  process.env.POSTGRES_HOST = "127.0.0.1";
  process.env.POSTGRES_PORT = "1";
  process.env.POSTGRES_USER = "omniroute";
  process.env.POSTGRES_PASSWORD = "unused";

  assert.throws(() => tryOpenSync(sqliteFile), /PostgreSQL unavailable.*refusing SQLite fallback/s);
  assert.equal(
    fs.existsSync(sqliteFile),
    false,
    "a replica must not create its own SQLite database on the shared data volume"
  );
});
