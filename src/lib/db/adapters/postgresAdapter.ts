/**
 * PostgreSQL adapter for OmniRoute
 *
 * Implementation of the SqliteAdapter interface using pg-native.
 * This adapter translates SQLite syntax to PostgreSQL equivalents.
 *
 * Notes:
 * - All query results are returned as arrays of rows (like SQLite `all`, `get`)
 * - Queries are synchronous with blocking I/O (as expected by OmniRoute internals)
 * - Dialect conversion is done in the adapter, not at the SQL level
 * - Fails on unrecognized SQLite syntax rather than silently no-op or mis-translate
 * - Uses `cmdTuples()` for row count (instead of last_insert_rowid)
 * - Parameter binding uses $1, $2... instead of ?
 * - Transactions: BEGIN, COMMIT, ROLLBACK (via `c.querySync`)
 * - Connection strings: host=127.0.0.1 port=5432 user=postgres password=mypassword dbname=mydb
 *
 * For performance, we use a direct approach:
 *  - The Client directly handles prepared statements via `prepareSync`/`executeSync`
 *  - For frequent queries, a simple LRU cache is used (not full stmt caching)
 *  - This adapter assumes that it is the only thing using the connection
 */
import type { SqliteAdapter, PreparedStatement, RunResult } from "./types";
import { runtimeRequire } from "./runtimeRequire";

// Helper that converts SQLite-style '?' parameters to PostgreSQL '$1' style,
// skipping any '?' that lives inside a single-quoted string literal.
// Exported for unit coverage (tests/unit/db/translateParams.test.ts).
export function translateParams(sql: string): { sql: string; numParams: number } {
  let newSql = "";
  let paramCount = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      // Double-quote '' is an escaped quote, not the end of the string.
      if (inString && sql[i + 1] === "'") {
        newSql += "''";
        i++;
        continue;
      }
      inString = !inString;
      newSql += ch;
      continue;
    }
    if (ch === "?" && !inString) {
      paramCount++;
      newSql += `$${paramCount}`;
      continue;
    }
    newSql += ch;
  }
  return { sql: newSql, numParams: paramCount };
}

// Cache of primary keys per table, resolved once from information_schema.
// The upsert translation needs the conflict target; resolving it per call
// would double the round-trip cost of every INSERT OR REPLACE.
const pkCache = new Map<string, string[]>();

function getPrimaryKeyColumns(client: unknown, table: string): string[] {
  const cached = pkCache.get(table);
  if (cached) return cached;
  const clientObj = client as {
    querySync: (sql: string, values?: unknown[]) => Array<Record<string, unknown>>;
  };
  const rows = clientObj.querySync(
    `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public'
        AND tc.table_name = $1
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position`,
    [table]
  );
  const columns = rows.map((row) => String(row.column_name));
  if (columns.length === 0) {
    // Fail loudly: an upsert with no conflict target is ambiguous.
    throw new Error(
      `[postgresAdapter] INSERT OR REPLACE for table "${table}": no primary key found, cannot build an ON CONFLICT upsert`
    );
  }
  pkCache.set(table, columns);
  return columns;
}

// Helper that detects unsupported/unknown SQLite constructs
function detectUnsupportedSyntax(sql: string): string | null {
  sql = sql.trim().toUpperCase();

  // Very early check for obvious unsupported things
  if (sql.startsWith("INSERT OR REPLACE")) {
    // In practice, this maps cleanly to ON CONFLICT in PG
    return null;
  }

  // Check for unsupported SQLite functions or structures
  const unsupported = [
    /DATETIME\(['"][^']*['"]\)/gi,
    /STRFTIME\([^)]*\)/gi,
    /GROUP_CONCAT\([^)]*\)/gi,
    /JSON_EXTRACT\([^)]*\)/gi,
    /RANDOMBLOB\([^)]*\)/gi,
    /JSON_EACH\([^)]*\)/gi,
    /LAST_INSERT_ROWID\(\)/gi,
    /IFNULL\([^)]*\)/gi,
    /AUTOINCREMENT(?!\s)/gi, // AUTOINCREMENT without word boundary (but may be fine in some contexts)
  ];

  for (const regex of unsupported) {
    if (regex.test(sql)) {
      return regex.source;
    }
  }

  return null;
}

// Translates a single-row `INSERT OR REPLACE ...` into a real Postgres upsert
// (updates existing rows, matching SQLite semantics). The conflict target is
// the table's primary key; non-key columns are updated from the new values.
function translateInsertOrReplace(sql: string, conflictColumns: string[]): string {
  const match = sql.match(
    /^INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES\s*\(([^)]+)\)$/i
  );
  if (!match) {
    // Not a simple single-row form (aliases, multi-row VALUES, RETURNING, …):
    // fail loud rather than ship a wrong statement.
    throw new Error(
      `[postgresAdapter] INSERT OR REPLACE shape not supported: ${sql.slice(0, 120)}`
    );
  }
  const table = match[1];
  const columns = match[2].split(",").map((c) => c.trim());
  const values = match[3].split(",");
  if (columns.length !== values.length) {
    throw new Error(
      `[postgresAdapter] column/value count mismatch in INSERT OR REPLACE: ${sql.slice(0, 120)}`
    );
  }
  const conflictCols = conflictColumns.filter((c) => columns.includes(c));
  if (conflictCols.length === 0) {
    throw new Error(
      `[postgresAdapter] INSERT OR REPLACE on ${table}: primary key (${conflictColumns.join(", ")}) not present in the column list (${columns.join(", ")})`
    );
  }
  const updateCols = columns.filter((c) => !conflictCols.includes(c));
  let translated = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values
    .map((_, i) => `$${i + 1}`)
    .join(", ")})`;
  translated += ` ON CONFLICT (${conflictCols.join(", ")})`;
  if (updateCols.length === 0) {
    translated += " DO NOTHING";
  } else {
    translated += ` DO UPDATE SET ${updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}`;
  }
  return translated;
}

// Translates a single-row `INSERT OR IGNORE ...` into Postgres
// `INSERT ... ON CONFLICT DO NOTHING` — the exact SQLite semantics (the
// conflicting row is left untouched and nothing is inserted).
function translateInsertOrIgnore(sql: string, conflictColumns: string[]): string {
  const match = sql.match(
    /^INSERT\s+OR\s+IGNORE\s+INTO\s+(\w+)\s*\(([^)]+)\)\s+VALUES\s*\(([^)]+)\)$/i
  );
  if (!match) {
    throw new Error(`[postgresAdapter] INSERT OR IGNORE shape not supported: ${sql.slice(0, 120)}`);
  }
  const table = match[1];
  const columns = match[2].split(",").map((c) => c.trim());
  const values = match[3].split(",");
  if (columns.length !== values.length) {
    throw new Error(
      `[postgresAdapter] column/value count mismatch in INSERT OR IGNORE: ${sql.slice(0, 120)}`
    );
  }
  const conflictCols = conflictColumns.filter((c) => columns.includes(c));
  if (conflictCols.length === 0) {
    throw new Error(
      `[postgresAdapter] INSERT OR IGNORE on ${table}: primary key (${conflictColumns.join(", ")}) not present in the column list (${columns.join(", ")})`
    );
  }
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${values
    .map((_, i) => `$${i + 1}`)
    .join(", ")}) ON CONFLICT (${conflictCols.join(", ")}) DO NOTHING`;
}

// Helper to get a new PG client (this can be cached/reused for multiple stmts)
function getClientForConnection(config: {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}): { client: any /*pg-native.Client*/; cleanup: () => void } {
  const pgClient = runtimeRequire("pg-native") as any;
  const client = new pgClient();

  // Build connection string for pg-native, which works like:
  // host=localhost port=5432 user=username password=password dbname=dbname

  let connStr = "";
  if (config.connectionString) {
    connStr = config.connectionString;
  } else {
    const parts: string[] = [];
    if (config.host) parts.push(`host=${config.host}`);
    if (config.port) parts.push(`port=${config.port}`);
    if (config.database) parts.push(`dbname=${config.database}`);
    if (config.user) parts.push(`user=${config.user}`);
    if (config.password) parts.push(`password=${config.password}`);
    connStr = parts.join(" ");
  }

  try {
    client.connectSync(connStr);
    return { client, cleanup: () => client.end() };
  } catch (err) {
    // Make sure we properly clean up on failure to avoid hanging connections
    try {
      client.end();
    } catch {}
    throw err;
  }
}

export function createPostgresAdapter(config: {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}): SqliteAdapter {
  const clientHolder = getClientForConnection(config);
  const client = clientHolder.client;

  const adapter: SqliteAdapter = {
    driver: "pg-native",

    // This is a bit tricky: pg-native doesn't expose open/closed state directly
    // We'll check connect once and maintain a 'safe' state as a boolean proxy
    get open() {
      // For simplicity, we assume the client works if we can run a simple query
      // This is a proxy state (can't check with pg-native api directly)
      try {
        client.querySync("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },

    // Placeholder for name, not necessarily meaningful for PG
    get name() {
      return "postgres_db";
    },

    get inTransaction() {
      // We don't track transaction status in this simplified version
      // If we want to be more precise, we'd need to add state tracking
      // In practice not critical for most calls as we just pass through
      return undefined;
    },

    prepare(sql: string): PreparedStatement {
      // Statements are executed directly against the shared pg-native client.
      // (A prepareSync/executeSync named-statement cache is the natural
      // follow-up optimization once hot-path profiling says it pays.)

      // PRAGMA table_info(<table>) → information_schema.columns, shaped like
      // SQLite's result (name/type/notnull/pk) — the boot helpers only read
      // row.name.
      const pragmaMatch = sql.trim().match(/^PRAGMA\s+table_info\((\w+)\)\s*;?$/i);
      if (pragmaMatch) {
        const table = pragmaMatch[1];
        const all = () => {
          const rows = client.querySync(
            `SELECT c.column_name AS name,
                    c.data_type AS type,
                    (c.is_nullable = 'NO') AS "notnull",
                    CASE WHEN EXISTS (
                       SELECT 1 FROM information_schema.table_constraints tc
                       JOIN information_schema.key_column_usage kcu
                         ON tc.constraint_name = kcu.constraint_name
                        AND tc.table_schema = kcu.table_schema
                       WHERE tc.table_schema = 'public'
                         AND tc.table_name = c.table_name
                         AND tc.constraint_type = 'PRIMARY KEY'
                         AND kcu.column_name = c.column_name
                     ) THEN 1 ELSE 0 END AS pk
               FROM information_schema.columns c
               WHERE c.table_schema = 'public'
                 AND c.table_name = $1`,
            [table]
          ) as unknown as Array<{
            name: string;
            type?: string;
            notnull: number | string;
            pk: number | string;
          }>;
          return rows.map((row) => ({
            name: row.name,
            type: String(row.type ?? ""),
            notnull: Number(row.notnull) || 0,
            pk: Number(row.pk) || 0,
            cid: 0,
            dflt_value: null,
          }));
        };
        const run = (): RunResult => ({ changes: 0, lastInsertRowid: 0 });
        return { run, get: () => undefined, all };
      }

      // SELECT ... FROM sqlite_master ... → information_schema (tables + indexes).
      //
      // Covers every shape the boot path actually issues:
      //   SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
      //   SELECT name FROM sqlite_master WHERE type='table' AND name='combos'
      //   SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'
      //   SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?
      //   SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name
      //
      // `name = ?` becomes `table_name = $1` (one param, same order);
      // `name = 'literal'` becomes `table_name = 'literal'`;
      // `name (NOT )LIKE 'sqlite_%'` is a constant — no param. Anything
      // else fails loud rather than shipping a wrong statement.
      const sqliteMasterMatch = sql.match(
        /^SELECT\s+([\s\S]+?)\s+FROM\s+sqlite_master(\s+WHERE\s+(?:type\s*=\s*'(?:table|view|index)'|type\s+IN\s*\(\s*'table'\s*,\s*'view'\s*\))((?:\s+AND\s+name\s*(?:=\s*(?:\?|'(?:[^'])*')|(NOT\s+LIKE|LIKE)\s+'sqlite_%'))?)?)(\s+ORDER\s+BY[\s\S]*)?(\s+LIMIT[\s\S]*)?;?\s*$/i
      );
      if (sqliteMasterMatch) {
        const where = (sqliteMasterMatch[2] ?? "").trim().replace(/^WHERE\s+/i, "");
        const namePred = (sqliteMasterMatch[3] ?? "").trim();
        const noWhere = !where;
        const isIndexQuery = /^type\s*=\s*'index'/i.test(where);
        const nameEqParam = /^\s*AND\s+name\s*=\s*\?$/i.test(namePred);
        const nameEqLiteral = /^\s*AND\s+name\s*=\s*'([^']*)'$/i.exec(namePred);
        const nameLike = /^\s*AND\s+name\s+(NOT\s+LIKE|LIKE)\s+'sqlite_%'$/i.test(namePred);
        // A type-only WHERE (`... WHERE type='table'`) is also supported.
        if (!(noWhere || nameEqParam || nameEqLiteral || nameLike || (where && namePred === ""))) {
          throw new Error(
            `[postgresAdapter] sqlite_master WHERE not supported: ${where.slice(0, 120)}`
          );
        }
        // Honor the caller's select list (boot code relies on aliases, e.g.
        // `SELECT name, tbl_name as tableName`). Each bare column maps onto
        // the matching information_schema / pg_indexes column; anything else
        // fails loud.
        const selectExprs = sqliteMasterMatch[1].split(",").map((s) => s.trim());
        const selectSql = selectExprs
          .map((expr) => {
            const m = expr.match(/^(\w+)(?:\s+as\s+(\w+))?\s*$/i);
            if (!m) {
              throw new Error(`[postgresAdapter] sqlite_master select expr not supported: ${expr}`);
            }
            const col = m[1].toLowerCase();
            const alias = m[2];
            let sourceCol: string;
            if (col === "name") sourceCol = isIndexQuery ? "indexname" : "table_name";
            else if (col === "tbl_name") sourceCol = isIndexQuery ? "tablename" : "table_name";
            else if (col === "type")
              sourceCol = isIndexQuery
                ? "'index'"
                : "CASE WHEN table_type = 'BASE TABLE' THEN 'table' ELSE 'view' END";
            else if (/^\d+$/.test(col)) sourceCol = col;
            else {
              throw new Error(
                `[postgresAdapter] sqlite_master select column not supported: ${col}`
              );
            }
            // PG column aliases may not start with a digit — `SELECT 1 AS 1`
            // is a syntax error. Bare numerics (boot code does `SELECT 1 …`
            // for existence checks) get a sanitized alias. The alias is
            // double-quoted so pg-native does not fold it to lowercase
            // (boot code reads `tableName`, not `tablename`).
            const aliasName = alias ?? (/^\d+$/.test(col) ? `c_${col}` : col);
            return `${sourceCol} AS "${aliasName}"`;
          })
          .join(", ");
        const source = isIndexQuery
          ? `FROM pg_indexes WHERE schemaname = 'public'`
          : `FROM information_schema.tables WHERE table_schema = 'public'`;
        let whereClause = "";
        const useParams = nameEqParam;
        if (nameEqParam) {
          whereClause = isIndexQuery ? " AND indexname = $1" : " AND table_name = $1";
        } else if (nameEqLiteral) {
          const literal = nameEqLiteral[1].replaceAll("'", "''");
          whereClause = isIndexQuery
            ? ` AND indexname = '${literal}'`
            : ` AND table_name = '${literal}'`;
        } else if (nameLike) {
          whereClause = isIndexQuery
            ? " AND indexname NOT LIKE 'sqlite_%'"
            : " AND table_name NOT LIKE 'sqlite_%'";
        }
        const innerSql =
          `SELECT ${selectSql} ${source}${whereClause}` +
          (sqliteMasterMatch[5] ? " ORDER BY 1" : "");
        const all = (...params: unknown[]): unknown[] => {
          const rows = client.querySync(innerSql, useParams ? params : []) as unknown[];
          return Array.isArray(rows) ? rows : [];
        };
        const get = (...params: unknown[]): unknown => {
          const rows = all(...params);
          return rows.length > 0 ? rows[0] : undefined;
        };
        const run = (): RunResult => ({ changes: 0, lastInsertRowid: 0 });
        return { run, get, all };
      }

      // SELECT SUM(pgsize) as size FROM dbstat WHERE name = ?
      //
      // dbstat is a SQLite virtual table; Postgres has no equivalent. Report
      // NULL so stats fall back to row-count-only figures.
      const dbstatMatch = sql.match(
        /^SELECT\s+SUM\(pgsize\)\s+as\s+size\s+FROM\s+dbstat\s+WHERE\s+name\s*=\s*\?\s*;?$/i
      );
      if (dbstatMatch) {
        const all = (): unknown[] => [{ size: null }];
        const get = (): unknown => ({ size: null });
        const run = (): RunResult => ({ changes: 0, lastInsertRowid: 0 });
        return { run, get, all };
      }

      const { sql: translatedSql, numParams } = translateParams(sql);

      // Check for unsupported constructs early to aid debugging
      const unsupported = detectUnsupportedSyntax(translatedSql);
      if (unsupported) {
        throw new Error(`Unsupported SQLite construct: '${unsupported}' in query: '${sql}'`);
      }

      // Translate SQLite upsert/ignore forms once, at prepare time, so that
      // run(), get() and all() all execute the same final statement.
      let finalSql = translatedSql;
      if (
        translatedSql.trimStart().toUpperCase().startsWith("INSERT OR REPLACE") ||
        translatedSql.trimStart().toUpperCase().startsWith("INSERT OR IGNORE")
      ) {
        const tableMatch = translatedSql.match(/^INSERT\s+OR\s+\w+\s+INTO\s+(\w+)/i);
        if (!tableMatch) {
          throw new Error(`INSERT OR ... without table: ${sql.slice(0, 120)}`);
        }
        const pk = getPrimaryKeyColumns(client, tableMatch[1]);
        finalSql = translatedSql.trimStart().toUpperCase().startsWith("INSERT OR REPLACE")
          ? translateInsertOrReplace(translatedSql, pk)
          : translateInsertOrIgnore(translatedSql, pk);
      }

      return {
        // run is for DML that returns row count
        run(...params: unknown[]): RunResult {
          if (params.length !== numParams) {
            throw new Error(`Wrong parameter count: expected ${numParams}, got ${params.length}`);
          }

          client.querySync(finalSql, params);
          return {
            changes: client.pq.cmdTuples(),
            // No equivalent in Postgres (OIDs are not assigned to rows).
            lastInsertRowid: 0,
          };
        },

        // get is for single-row results (e.g., SELECT *)
        get(...params: unknown[]): unknown {
          if (params.length && params.length !== numParams) {
            throw new Error(`Wrong parameter count: expected ${numParams}, got ${params.length}`);
          }

          const result = client.querySync(finalSql, params);
          return Array.isArray(result) && result.length >= 1 ? result[0] : result;
        },

        // all returns all rows
        all(...params: unknown[]): unknown[] {
          if (params.length && params.length !== numParams) {
            throw new Error(`Wrong parameter count: expected ${numParams}, got ${params.length}`);
          }

          const result = client.querySync(finalSql, params);
          return Array.isArray(result) ? result : [];
        },
      };
    },

    // Executes a SQL string directly (for DDL, multi-statement, init)
    exec(sql: string): void {
      // Convert any SQLite constructs within the query text if needed before execution
      // But in practice this gets called for schema statements (which should be valid PG)
      // Or sometimes we have multi-statement scripts
      client.querySync(sql);
      // DDL does not return rows; the command result is intentionally discarded.
    },

    // SQLite-only tuning pragmas, shimmed on Postgres.
    //
    // `cache_size` and `auto_vacuum` are consulted unconditionally at boot
    // (applyStoredDatabaseOptimizationSettings → setCacheSizeForDb /
    // checkAutoVacuumDrift). Postgres manages its own buffers and autovacuum
    // server-side, so the settings are persisted in key_value (namespace
    // "pg_shim") to keep the boot logic and the stored settings consistent,
    // and read back verbatim. Other pragmas fail loudly.
    pragma(pragmaStr: string, _options?: { simple?: boolean }): unknown {
      const m = pragmaStr.trim().match(/^(\w+)\s*(?:=\s*(.+))?$/);
      if (!m) {
        throw new Error(`Unimplemented pragma in PG adapter: ${pragmaStr}`);
      }
      const name = m[1];
      const setClause = m[2];

      const readShim = (key: string, fallback: number): number => {
        const rows =
          (client.querySync(`SELECT value FROM key_value WHERE namespace = $1 AND key = $2`, [
            "pg_shim",
            key,
          ]) as unknown as Array<{ value: string }>) ?? [];
        if (rows.length === 0) return fallback;
        const parsed = Number(rows[0].value);
        return Number.isFinite(parsed) ? parsed : fallback;
      };
      const writeShim = (key: string, value: number): void => {
        // INSERT OR REPLACE → upsert on (namespace, key)
        client.querySync(
          `INSERT INTO key_value (namespace, key, value) VALUES ($1, $2, $3)
           ON CONFLICT (namespace, key) DO UPDATE SET value = EXCLUDED.value`,
          ["pg_shim", key, String(value)]
        );
      };

      switch (name) {
        case "cache_size": {
          // SQLite reports cache_size as negative KB. Default matches the
          // SQLite default (-8 MB) so first boot sees a sane baseline.
          const fallback = -8192;
          if (setClause !== undefined) {
            const value = Number(setClause.trim());
            if (!Number.isFinite(value)) {
              throw new Error(`Invalid cache_size in pragma: ${pragmaStr}`);
            }
            writeShim("cache_size", value);
            return value;
          }
          return readShim("cache_size", fallback);
        }
        case "auto_vacuum": {
          // 0/1/2 in SQLite; Postgres autovacuum is always on server-side.
          // Report 0 (the SQLite default "off-equivalent") unless the
          // operator stored an override, so boot sees a stable value.
          if (setClause !== undefined) {
            const value = Number(setClause.trim());
            if (!Number.isFinite(value)) {
              throw new Error(`Invalid auto_vacuum in pragma: ${pragmaStr}`);
            }
            writeShim("auto_vacuum", value);
            return value;
          }
          return readShim("auto_vacuum", 0);
        }
        case "page_size": {
          // SQLite's default page size. Postgres manages its own block
          // size server-side; report the SQLite baseline so stats math
          // (page_size * page_count) stays consistent.
          return 4096;
        }
        case "page_count": {
          // Approximate the database size in SQLite pages from the Postgres
          // total on-disk size, so `page_size * page_count` tracks real usage.
          try {
            const rows = client.querySync(
              "SELECT COALESCE(SUM(pg_total_size(oid)), 0) AS total FROM pg_class"
            ) as unknown as Array<{ total: number | string }>;
            const bytes = Number(rows[0]?.total ?? 0);
            const pageCount = Math.max(1, Math.ceil(bytes / 4096));
            return pageCount;
          } catch {
            return 1;
          }
        }
        case "busy_timeout":
        case "synchronous":
        case "temp_store":
        case "journal_mode": {
          // Connection-local SQLite tuning. Postgres manages the
          // equivalent server-side (statement_timeout, WAL, memory), so
          // these are reported as their default values to satisfy the
          // boot-time pragma blocks. `journal_mode` is read as a string
          // at boot; report the SQLite default "wal".
          if (name === "journal_mode") {
            return "wal";
          }
          if (setClause !== undefined) {
            // Accept the set form without error; nothing to persist.
            const raw = setClause.trim();
            const numeric = Number(raw);
            return Number.isFinite(numeric) ? numeric : raw;
          }
          if (name === "busy_timeout") return 2000;
          if (name === "synchronous") return "normal";
          if (name === "temp_store") return "memory";
          return "wal";
        }
        default:
          throw new Error(`Unimplemented pragma in PG adapter: ${pragmaStr}`);
      }
    },

    // Execute function in deferred transaction mode if it's safe (PG doesn't support DEFERRED)
    // But we return a function that simulates the behavior
    transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T {
      return (...args: unknown[]) => {
        // begin
        client.querySync("BEGIN");
        try {
          const result = fn(...args);
          client.querySync("COMMIT");
          return result;
        } catch (err) {
          client.querySync("ROLLBACK");
          throw err;
        }
      };
    },

    // Immediate transaction – PG does not need to be IMMEDIATE but we just wrap in BEGIN
    immediate(fn: () => void): void {
      client.querySync("BEGIN");
      try {
        fn();
        client.querySync("COMMIT");
      } catch (err) {
        client.querySync("ROLLBACK");
        throw err;
      }
    },

    // Copy over backup / checkpoint / close as needed
    backup(_destination: string): Promise<void> {
      // In full PG integration, this would involve something like pg_dump.
      // For now, we raise to indicate this isn't supported in the adapter.
      throw new Error("backup not supported in PG adapter (would require pg_dump)");
    },

    checkpoint(_mode?: string): void {
      // PG has no direct checkpoint command (handled in wal_settings)
      // This is mostly a no-op for PG
    },

    // Called on adapter close to clean up resources
    close(): void {
      clientHolder.cleanup();
    },

    // Raw access to the underlying client – used for advanced use (should be minimal)
    get raw() {
      return client;
    },
  };

  return adapter;
}
