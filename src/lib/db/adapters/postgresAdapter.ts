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
// Converts SQLite-style parameters to PostgreSQL positional `$n`, skipping any
// token inside a single-quoted string literal. Handles BOTH better-sqlite3
// styles:
//   - anonymous positional  `?`               -> $1, $2 … (bound from an array)
//   - named `@name` / `:name` / `$name`       -> $1, $2 … (bound from an object)
// For named params the first occurrence of each distinct name claims the next
// positional slot; repeat uses of the same name reuse that slot (SQLite
// semantics). `names` is the ordered list of distinct bind names ([] for
// anonymous). Exported for unit coverage (tests/unit/db/translateParams.test.ts).
export function translateParams(sql: string): {
  sql: string;
  numParams: number;
  names: string[];
} {
  let newSql = "";
  let paramCount = 0;
  let inString = false;
  const names: string[] = [];
  const nameToIndex = new Map<string, number>();
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
    if (inString) {
      newSql += ch;
      continue;
    }
    if (ch === "?") {
      paramCount++;
      newSql += `$${paramCount}`;
      continue;
    }
    // Named parameter: @name / :name / $name followed by an identifier.
    // (A bare `$1` already-positional token also matches `$`; the identifier
    // regex requires a leading letter/underscore so `$1` is left alone. The
    // PostgreSQL `::type` cast is guarded explicitly so `::timestamptz` is not
    // misread as a `:timestamptz` bind.)
    if (ch === ":" && sql[i + 1] === ":") {
      newSql += "::";
      i++;
      continue;
    }
    if (ch === "@" || ch === ":" || ch === "$") {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1));
      if (m) {
        const name = m[0];
        let idx = nameToIndex.get(name);
        if (idx === undefined) {
          paramCount++;
          idx = paramCount;
          nameToIndex.set(name, idx);
          names.push(name);
        }
        newSql += `$${idx}`;
        i += name.length; // skip the name chars (the sigil char is consumed by the loop step)
        continue;
      }
    }
    newSql += ch;
  }
  return { sql: newSql, numParams: paramCount, names };
}

/**
 * Extracts all AS aliases from a SQLite/Postgres SELECT statement.
 * Returns an array of objects { declared: string, pgFolded: string }
 * where pgFolded is what Postgres will actually return (lowercase for unquoted).
 * This is used to remap result-row keys back to the case the SQL declared,
 * fixing the class of bugs where PG folds unquoted aliases to lowercase.
 */
function extractAliases(sql: string): Array<{ declared: string; pgFolded: string }> {
  const aliases: Array<{ declared: string; pgFolded: string }> = [];
  // Match: column alias AS "Name" or AS name (no quotes). Also handle quoted identifiers.
  // Examples:
  //   SELECT foo AS bar           -> bar
  //   SELECT foo AS "TotalCount"  -> TotalCount (PG keeps case because it's quoted)
  //   SELECT foo AS "totalCount"  -> totalCount
  // The regex captures:
  //   group 1: the alias itself (with or without quotes stripped)
  // We store the declared form (as written by the caller) and the PG-folded form.
  const aliasRegex = /\bAS\s+((?:")?([a-zA-Z_][a-zA-Z0-9_]*)(?:")?)/gi;
  let match;
  while ((match = aliasRegex.exec(sql)) !== null) {
    const aliasCore = match[2];
    // When not quoted, PG folds to lowercase; when quoted (AS "TotalCount"),
    // PG preserves the declared case, so the PG-folded form equals the declared.
    const isQuoted = match[1].startsWith('"');
    aliases.push({ declared: aliasCore, pgFolded: isQuoted ? aliasCore : aliasCore.toLowerCase() });
  }
  return aliases;
}

/**
 * Remaps row keys from their PG-folded form (lowercase) back to the declared
 * alias case in the SQL, so code that reads row.totalRequests doesn't get
 * undefined on Postgres where unquoted aliases fold to lowercase.
 */
function remapKeys<T extends Record<string, unknown>>(
  rows: T[],
  aliases: Array<{ declared: string; pgFolded: string }>
): T[] {
  if (aliases.length === 0) return rows;
  // Build map from pgFolded → declared for fast lookup
  const aliasMap = new Map(aliases.map((a) => [a.pgFolded, a.declared]));
  return rows.map((row) => {
    const newRow: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      newRow[aliasMap.get(k) ?? k] = v;
    }
    return newRow as T;
  });
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

// Maps a SQLite strftime() format string to a PostgreSQL to_char() template.
// Only the specifiers OmniRoute actually uses are mapped; an unknown one throws
// so a wrong translation is never shipped silently. %w and %s are NOT to_char
// specifiers and are handled by the caller before this runs.
function sqliteFormatToPgTemplate(fmt: string): string {
  // Longest tokens first so %Y-%m etc. don't partially match.
  const map: Array<[RegExp, string]> = [
    [/%Y/g, "YYYY"],
    [/%m/g, "MM"],
    [/%d/g, "DD"],
    [/%H/g, "HH24"],
    [/%M/g, "MI"],
    [/%S/g, "SS"],
    [/%f/g, "MS"], // SQLite %f is seconds.fraction; closest useful PG part is milliseconds
  ];
  let out = fmt;
  for (const [re, rep] of map) out = out.replace(re, rep);
  if (/%[A-Za-z]/.test(out)) {
    throw new Error(`[postgresAdapter] unsupported strftime specifier in: ${fmt}`);
  }
  // Literal text in a to_char template must be double-quoted (T, Z, fixed
  // punctuation stays literal). We quote any run that isn't a known pattern
  // token; simplest robust approach: quote the whole known-safe punctuation
  // by wrapping non-alphanumeric literal chars. to_char treats unrecognized
  // letters as literals only if quoted, so quote stray letters (T, Z).
  out = out.replace(/([A-Za-z])/g, (ch) => (/Y|M|D|H|I|S/.test(ch) ? ch : `"${ch}"`));
  return out;
}

// Converts the time argument of a strftime/datetime call into a PG timestamptz
// expression. 'now' -> NOW(); a quoted ISO string or a column -> cast;
// a trailing 'unixepoch' modifier means the value is epoch SECONDS.
function pgTimeExpr(timeArg: string, modifier?: string): string {
  const t = timeArg.trim();
  const isNow = /^['"]now['"]$/i.test(t);
  if (modifier && /unixepoch/i.test(modifier)) {
    return `to_timestamp(${isNow ? "extract(epoch from now())" : t})`;
  }
  if (isNow) return "NOW()";
  // Quoted literal or bare column/expression: cast to timestamptz.
  return `(${t})::timestamptz`;
}

// Translates a single strftime(fmt, time[, modifier]) call to PostgreSQL.
function translateStrftimeCall(fmt: string, timeArg: string, modifier?: string): string {
  // %w — day of week 0..6 (Sunday=0). PG: extract(dow) is already 0..6 Sun=0.
  if (fmt === "%w") {
    return `EXTRACT(DOW FROM ${pgTimeExpr(timeArg, modifier)})::int`;
  }
  // %s — epoch seconds.
  if (fmt === "%s") {
    return `EXTRACT(EPOCH FROM ${pgTimeExpr(timeArg, modifier)})::bigint`;
  }
  const template = sqliteFormatToPgTemplate(fmt);
  return `to_char(${pgTimeExpr(timeArg, modifier)}, '${template}')`;
}

// Translates common SQLite-specific SQL into PostgreSQL equivalents. Applied to
// both prepared statements and exec()'d DDL so background/lazy code paths that
// emit SQLite dialect (module self-init CREATE TABLEs, DATETIME()/IFNULL()
// scalars, COLLATE NOCASE) run on PostgreSQL instead of erroring. Conservative
// and string-literal-aware where it matters; only well-known constructs are
// rewritten, everything else passes through untouched.
export function translateSqliteSql(sql: string): string {
  let out = sql;

  // --- DDL (CREATE TABLE) ---
  // INTEGER PRIMARY KEY AUTOINCREMENT  ->  BIGSERIAL PRIMARY KEY (auto id).
  out = out.replace(
    /\b(?:INTEGER|INT)\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi,
    "BIGSERIAL PRIMARY KEY"
  );
  // Any stray AUTOINCREMENT keyword (already has PRIMARY KEY elsewhere) -> drop.
  out = out.replace(/\s+AUTOINCREMENT\b/gi, "");

  // --- COLLATE NOCASE ---
  // Postgres has no NOCASE collation. Drop it in DDL/index/column contexts; the
  // app's case-insensitive lookups that relied on it use LOWER()/ILIKE in the
  // query layer, and dropping the collation keeps comparisons byte-exact
  // (acceptable for the key/enum columns that carried it).
  out = out.replace(/\s+COLLATE\s+NOCASE\b/gi, "");

  // --- scalar functions ---
  // strftime() runs FIRST (innermost), before datetime(), so nested forms like
  // datetime(strftime('%Y-%m-%d %H:00:00', created_at)) translate correctly.
  // strftime(fmt, timeArg[, modifier]) -> to_char / EXTRACT. Handles the forms
  // OmniRoute uses: strftime('%w', col), strftime('%s', col|'now'),
  // strftime('%Y-%m-%dT%H:...', col|'now'[, '+1 month'|'unixepoch']).
  // fmt and modifier are single-quoted literals; timeArg is a column, 'now',
  // or a quoted literal (no nested parens/commas — the only shapes in use).
  out = out.replace(
    /\bSTRFTIME\(\s*'([^']*)'\s*,\s*('now'|"now"|[A-Za-z_][\w.]*|'[^']*')\s*(?:,\s*'([^']*)'\s*)?\)/gi,
    (_m, fmt: string, timeArg: string, modifier?: string) =>
      translateStrftimeCall(fmt, timeArg, modifier)
  );
  // --- DATETIME() forms ---
  // datetime('now', '-' || <n> || ' days')  ->  (NOW() - ((<n>) || ' days')::interval)
  // Keep the value expression (a bound $n or literal) intact.
  out = out.replace(
    /\bDATETIME\(\s*['"]now['"]\s*,\s*'-'\s*\|\|\s*(.+?)\s*\|\|\s*'\s*days'\s*\)/gi,
    "to_char((NOW() - (($1) || ' days')::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
  );
  // date('now') -> ISO date text 'YYYY-MM-DD' (SQLite date() shape). The TEXT
  // timestamp columns it is compared against start with that prefix, so a
  // lexical `created_at >= date('now')` keeps working ('operator does not
  // exist: text >= date' otherwise).
  out = out.replace(
    /\bDATE\(\s*['"]now['"]\s*\)/gi,
    "to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD')"
  );
  // datetime('now', <modifier>) where <modifier> is a single bound param ($n)
  // or a quoted SQLite interval literal ('-6 hours', '+1 month'). SQLite
  // interval strings are valid PostgreSQL interval literals. OmniRoute's
  // timestamp columns are TEXT in ISO-8601 (e.g. 2026-09-15T07:48:11.674Z), and
  // SQLite's datetime() returns a string too, so callers compare text<->text.
  // Emit ISO-8601 text (to_char) rather than a timestamptz, otherwise a
  // `text_column >= datetime(...)` comparison fails with
  // "operator does not exist: text >= timestamp with time zone".
  //   datetime('now', $1) -> to_char((NOW() + ($1)::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  out = out.replace(
    /\bDATETIME\(\s*['"]now['"]\s*,\s*(\$\d+|'[^']*')\s*\)/gi,
    "to_char((NOW() + ($1)::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
  );
  // datetime('now') / datetime("now")  ->  NOW().
  out = out.replace(
    /\bDATETIME\(\s*['"]now['"]\s*\)/gi,
    "to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
  );
  // datetime(<epoch_seconds_expr>, 'unixepoch') -> to_timestamp(<expr>).
  // The epoch expression may itself contain parentheses (e.g. a bucketing
  // math expression), so match everything up to the literal `, 'unixepoch')`
  // terminator rather than a bare `[^)]` group. Must run BEFORE the generic
  // datetime(expr) rule below, otherwise the 2-arg form casts a record and
  // yields "could not identify a comparison function for type unknown".
  out = out.replace(/\bDATETIME\(\s*([\s\S]+?)\s*,\s*'unixepoch'\s*\)/gi, "to_timestamp($1)");
  // datetime(expr) -> (expr)::timestamptz. Covers the common case where the
  // argument is a TEXT ISO-8601 column (config_audit_log.timestamp) or a date
  // literal. Millisecond-epoch BIGINT columns are the minority and would need
  // to_timestamp(col/1000) — callers hitting that must translate explicitly;
  // a blanket epoch-division guess here mis-handled the far more common TEXT
  // ISO columns ("operator does not exist: text / numeric").
  // datetime(expr) -> ISO-8601 TEXT in the stored column format. OmniRoute
  // stores all timestamps as ISO text and compares them lexically (as SQLite's
  // datetime() returns text), so keep datetime() text-typed end to end. Parsing
  // via ::timestamptz then to_char() normalizes a TEXT ISO column or literal and
  // keeps `datetime(col) < datetime('now', …)` a text<->text comparison (both
  // sides of this rule family emit the same format). Returning a bare
  // ::timestamptz instead made `timestamptz < text` / `text < timestamptz`
  // mismatches depending on which side wrapped the column.
  out = out.replace(
    /\bDATETIME\(\s*([^)]+?)\s*\)/gi,
    "to_char(($1)::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
  );
  // IFNULL(a, b) -> COALESCE(a, b) (identical semantics).
  out = out.replace(/\bIFNULL\s*\(/gi, "COALESCE(");
  // SQLite instr(haystack, needle) -> PostgreSQL strpos(haystack, needle):
  // identical argument order, both 1-based with 0 when not found. (substr() is
  // already compatible between SQLite and PostgreSQL, so it is left as-is.)
  out = out.replace(/\bINSTR\s*\(/gi, "strpos(");

  // --- JSON (SQLite JSON1 -> PostgreSQL jsonb) ---
  // json_extract(expr, '$.a.b') -> (expr)::jsonb #>> '{a,b}' (text result,
  // matching SQLite which returns the scalar as text). Top-level '$.key'
  // becomes #>> '{key}'. Only simple dotted paths are handled.
  // NOTE: json_each()/json_valid() are intentionally NOT translated here — they
  // appear only inside nested CASE/table-function expressions that a regex
  // cannot balance safely, so those few queries are rewritten at the source
  // (PG-compatible jsonb_array_elements) instead.
  out = out.replace(
    /\bJSON_EXTRACT\s*\(\s*([\s\S]+?)\s*,\s*'\$\.?([^']*)'\s*\)/gi,
    (_m, expr: string, path: string) => {
      const parts = path.split(".").filter(Boolean);
      return `(${expr})::jsonb #>> '{${parts.join(",")}}'`;
    }
  );
  // group_concat(x[, sep]) -> string_agg(x::text, sep|','). SQLite's default
  // separator is ','.
  out = out.replace(
    /\bGROUP_CONCAT\s*\(\s*([^,()]+?)\s*(?:,\s*('[^']*')\s*)?\)/gi,
    (_m, expr: string, sep?: string) => `string_agg((${expr})::text, ${sep || "','"})`
  );

  // SQLite `x IS ?` / `x IS NOT ?` is a NULL-safe comparison against a bound
  // value; PostgreSQL's `IS` only accepts NULL/TRUE/FALSE/DISTINCT FROM, so a
  // bound placeholder there is a syntax error ('syntax error at or near "$2"').
  // Rewrite to the NULL-safe `IS [NOT] DISTINCT FROM $n`. Only placeholders
  // ($n) are rewritten — `IS NULL`, `IS NOT NULL`, `IS TRUE/FALSE` are left
  // intact. Runs after translateParams, so the operand is already `$n`.
  out = out.replace(/\bIS\s+NOT\s+(\$\d+)\b/gi, "IS DISTINCT FROM $1");
  out = out.replace(/\bIS\s+(\$\d+)\b/gi, "IS NOT DISTINCT FROM $1");

  // SQLite scalar max(a,b)/min(a,b) (2+ args) -> PostgreSQL greatest()/least().
  // PG max()/min() are aggregate-only, so `max(a, b)` as a row scalar errors
  // ("function max(bigint, bigint) does not exist"). A single-arg max(x) is the
  // aggregate and is left untouched (negative lookahead for a comma).
  out = out.replace(/\bMAX\s*\(([^(),]+,[^()]*)\)/gi, "GREATEST($1)");
  out = out.replace(/\bMIN\s*\(([^(),]+,[^()]*)\)/gi, "LEAST($1)");

  return out;
}

// Helper that detects unsupported/unknown SQLite constructs
function detectUnsupportedSyntax(sql: string): string | null {
  sql = sql.trim().toUpperCase();

  // Very early check for obvious unsupported things
  if (sql.startsWith("INSERT OR REPLACE")) {
    // In practice, this maps cleanly to ON CONFLICT in PG
    return null;
  }

  // Check for genuinely unsupported SQLite functions (no safe translation yet).
  // DATETIME/STRFTIME('%s','now')/IFNULL/AUTOINCREMENT/COLLATE NOCASE are handled
  // by translateSqliteSql() before this runs, so they are intentionally NOT here.
  const unsupported = [/RANDOMBLOB\([^)]*\)/gi, /LAST_INSERT_ROWID\(\)/gi];

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
  // Preserve each VALUES entry verbatim. By the time this runs, translateParams()
  // has already rewritten any `?` to `$n`, so `values` holds the final mix of
  // SQL literals ('schema_version', 1, NULL) and positional placeholders ($1…).
  // Re-numbering every entry as $1..$n (the previous behavior) corrupted
  // literal-only statements — e.g. db_meta's inline
  // VALUES ('schema_version','1') became VALUES ($1,$2) with no bound params,
  // producing "bind message supplies 0 parameters, but prepared statement
  // requires 2".
  const valuesSql = values.map((v) => v.trim()).join(", ");
  let translated = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${valuesSql})`;
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
  // Preserve VALUES verbatim (literals + already-translated $n placeholders);
  // see translateInsertOrReplace for why re-numbering as $1..$n is wrong.
  const valuesSql = values.map((v) => v.trim()).join(", ");
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${valuesSql}) ON CONFLICT (${conflictCols.join(", ")}) DO NOTHING`;
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
  // Explicit type parsers so numeric/boolean columns come back as native JS
  // types (number/boolean), matching better-sqlite3. pg-native defaults to
  // pg-types, but its resolution is fragile across the standalone bundle /
  // tsx / CJS boundaries (observed: int columns returned as strings, so
  // callers' `typeof x === "number"` checks failed — combos were skipped,
  // sort_order/flags mis-read). Passing a self-contained parser removes that
  // dependency on how pg-types resolves. OIDs: bool=16, int8=20, int2=21,
  // int4=23, float4=700, float8=701, numeric=1700. Everything else (text,
  // json, timestamptz, bytea…) stays a string, exactly like SQLite's TEXT
  // affinity, so JSON columns (combos.data) are parsed by the caller as before.
  const NUMERIC_OIDS = new Set([20, 21, 23, 700, 701, 1700]);
  const typeParsers = {
    getTypeParser(oid: number) {
      if (oid === 16) return (v: string) => v === "t" || v === "true" || v === "1";
      if (NUMERIC_OIDS.has(oid)) {
        return (v: string) => {
          if (v === null || v === undefined) return v;
          const n = Number(v);
          return Number.isNaN(n) ? v : n;
        };
      }
      return (v: string) => v; // identity for text/json/dates/bytea
    },
  };
  const client = new pgClient({ types: typeParsers });

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

      const { sql: paramSql, numParams, names } = translateParams(sql);
      // Extract aliases to remap PG-folded keys back to declared case
      // (Postgres folds unquoted aliases to lowercase; callers expect case-preserving keys).
      const sqlAliases = extractAliases(sql);

      // Rewrite SQLite dialect (DATETIME/IFNULL/COLLATE NOCASE/AUTOINCREMENT…)
      // to PostgreSQL before the unsupported-construct gate and execution.
      const translatedSql = translateSqliteSql(paramSql);

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
        const tableMatch = translatedSql.match(/^\s*INSERT\s+OR\s+\w+\s+INTO\s+(\w+)/i);
        if (!tableMatch) {
          throw new Error(`INSERT OR ... without table: ${sql.slice(0, 120)}`);
        }
        const pk = getPrimaryKeyColumns(client, tableMatch[1]);
        finalSql = translatedSql.trimStart().toUpperCase().startsWith("INSERT OR REPLACE")
          ? translateInsertOrReplace(translatedSql, pk)
          : translateInsertOrIgnore(translatedSql, pk);
      }
      const isNamed = names.length > 0;

      // Resolves a better-sqlite3 call signature into the positional array
      // pg-native needs. Supports:
      //   - named statements: a single object arg { name: value } (or a bare
      //     value when there is exactly one name) reordered to the `names` order;
      //   - positional statements: the spread args as-is.
      // A 0-placeholder statement always binds nothing (callers sometimes pass
      // trailing args to such statements; better-sqlite3 ignores them).
      const resolveBindRaw = (params: unknown[]): unknown[] => {
        if (numParams === 0) return [];
        if (isNamed) {
          const obj =
            params.length === 1 && params[0] !== null && typeof params[0] === "object"
              ? (params[0] as Record<string, unknown>)
              : undefined;
          if (obj) {
            return names.map((n) => {
              if (!(n in obj)) {
                throw new Error(
                  `[postgresAdapter] missing named parameter "${n}" for: ${sql.slice(0, 120)}`
                );
              }
              return obj[n];
            });
          }
          // Single named param can also be supplied positionally.
          if (names.length === 1 && params.length === 1) return params;
          throw new Error(
            `[postgresAdapter] named statement expects an object with {${names.join(", ")}}: ${sql.slice(0, 120)}`
          );
        }
        if (params.length !== numParams) {
          throw new Error(`Wrong parameter count: expected ${numParams}, got ${params.length}`);
        }
        return params;
      };
      // Coerce `undefined` bind values to SQL NULL. pg-native stringifies an
      // undefined parameter to the literal text "undefined", which then fails
      // against non-text columns ('invalid input syntax for type integer:
      // "undefined"'); better-sqlite3 binds a missing/undefined value as NULL.
      const resolveBind = (params: unknown[]): unknown[] =>
        resolveBindRaw(params).map((v) => (v === undefined ? null : v));

      // Wraps pg-native errors with the translated SQL so a dialect/translation
      // bug is diagnosable (pg-native's raw error is just e.g. 'syntax error at
      // or near "$2"' with no statement text).
      const exec1 = (bind: unknown[]): unknown => {
        try {
          return client.querySync(finalSql, bind);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`${msg} | SQL: ${finalSql.slice(0, 300)}`);
        }
      };

      return {
        // run is for DML that returns row count
        run(...params: unknown[]): RunResult {
          exec1(resolveBind(params));
          return {
            // pg-native's pq.cmdTuples() returns the affected-row count as a
            // STRING; better-sqlite3 callers expect RunResult.changes to be a
            // number (e.g. `result.deleted = r.changes`), so coerce.
            changes: Number(client.pq.cmdTuples()) || 0,
            // No equivalent in Postgres (OIDs are not assigned to rows).
            lastInsertRowid: 0,
          };
        },

        // get is for single-row results (e.g., SELECT *)
        get(...params: unknown[]): unknown {
          const result = exec1(resolveBind(params));
          if (!Array.isArray(result) || result.length < 1) return result;
          // Remap keys to match the declared alias case (fixes PG's lowercase folding).
          const remapped = remapKeys([result[0]], sqlAliases);
          return remapped[0];
        },

        // all returns all rows
        all(...params: unknown[]): unknown[] {
          const result = exec1(resolveBind(params));
          if (!Array.isArray(result)) return [];
          // Remap keys to match the declared alias case (fixes PG's lowercase folding).
          return remapKeys(result, sqlAliases);
        },
      };
    },

    // Executes a SQL string directly (for DDL, multi-statement, init)
    exec(sql: string): void {
      // Convert SQLite dialect (AUTOINCREMENT, DATETIME(), COLLATE NOCASE…) to
      // PostgreSQL before executing. exec() carries module self-init CREATE TABLE
      // DDL and multi-statement scripts that still use SQLite syntax.
      client.querySync(translateSqliteSql(sql));
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
      // wal_checkpoint(PASSIVE|FULL|RESTART|TRUNCATE): SQLite WAL maintenance.
      // PostgreSQL has no WAL client pragma (checkpoints are server-side), so
      // report a successful no-op checkpoint row {busy,log,checkpointed}=0 that
      // parseCheckpointRow() reads as ok. Matched before the simple-name regex
      // because of the parenthesized argument.
      if (/^wal_checkpoint\s*\(/i.test(pragmaStr.trim())) {
        return [{ busy: 0, log: 0, checkpointed: 0 }];
      }
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
        case "freelist_count": {
          // SQLite's free-page count drives VACUUM scheduling / space
          // reclamation. PostgreSQL manages free space server-side via
          // autovacuum, so there is no equivalent to report — return 0 so the
          // reclaim/vacuum schedulers treat the DB as having nothing to reclaim
          // (a no-op) instead of crashing on an unimplemented pragma.
          return 0;
        }
        case "quick_check":
        case "integrity_check": {
          // SQLite page-level corruption checks. PostgreSQL has no equivalent
          // client pragma (integrity is enforced server-side), so report the
          // healthy sentinel the callers assert on. `quick_check` is read with
          // { simple: true } as a bare string; `integrity_check` is read as a
          // row array [{ integrity_check: "ok" }].
          return name === "quick_check" ? "ok" : [{ integrity_check: "ok" }];
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
