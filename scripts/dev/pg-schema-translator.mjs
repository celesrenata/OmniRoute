#!/usr/bin/env node
/**
 * pg-schema-translator.mjs — translates the OmniRoute SQLite DDL dump into
 * PostgreSQL DDL.
 *
 * Input: the `--TABLE:`/`--INDEX:` marker dump (scripts/dev/dump-sqlite-schema.mjs
 * or a hand-built equivalent). The dump is the single source of truth for the
 * 161-table schema; this translator never touches the live DB.
 *
 * Usage:
 *   node scripts/dev/pg-schema-translator.mjs <schema-sqlite.sql> [out.sql]
 *
 * Dialect rules (SQLite → PostgreSQL 18):
 *   - TEXT/VARCHAR → TEXT; INTEGER → INTEGER (BIGINT only for
 *     AUTOINCREMENT PKs, which become `BIGINT GENERATED ALWAYS AS IDENTITY`);
 *     REAL → DOUBLE PRECISION; BLOB → BYTEA; BOOLEAN → BOOLEAN;
 *     DATETIME/TIMESTAMP → TIMESTAMPTZ.
 *   - Timestamps stored as TEXT on SQLite stay TEXT on PG (see
 *     translateColumnType): every hot table stores ISO-8601 strings and the
 *     app consumes them as strings. The one DATETIME column becomes
 *     TIMESTAMPTZ and is backfilled by the migration script.
 *   - `datetime('now')` / `strftime(...,'now')` defaults →
 *     `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
 *     (ISO-8601 ms precision, matching live data).
 *   - `DEFAULT CURRENT_TIMESTAMP` → `DEFAULT (now() AT TIME ZONE 'UTC')`.
 *   - FK / CHECK / UNIQUE / table-level PRIMARY KEY pass through (PG syntax).
 *   - FTS5 + shadow tables → tsvector generated column on `memories` + GIN.
 *   - vec0 `vec_memories` → pgvector table `vec_memories(id BIGINT, embedding vector(1024))`.
 *   - SQLite shadow tables (memory_fts_*, vec_memories_*) are dropped:
 *     engine internals, no application queries.
 *
 * Output: single idempotent PG script (CREATE TABLE/INDEX IF NOT EXISTS),
 * tables in FK-topological order (stable; cycles fall back to dump order).
 */

import { readFileSync, writeFileSync } from "node:fs";

// ────────────────────────────────────────────────────────────────────────────
// Parse the marker dump
// ────────────────────────────────────────────────────────────────────────────

function parseDump(sql) {
  const lines = sql.split(/\r?\n/);
  const tables = new Map();
  const indexes = new Map();
  let mode = null; // "table" | "index" | null
  let name = null;
  let buf = [];

  const commit = () => {
    if (!mode || !name) return;
    let body = buf.join("\n");
    body = body.replace(/^(\s*--.*\n)+/, ""); // drop leading marker-echo comments
    body = body.replace(/\s*;\s*$/, "").trim(); // drop the trailing semicolon
    if (!body) return;
    (mode === "table" ? tables : indexes).set(name, body);
  };

  for (const line of lines) {
    const t = line.match(/^--TABLE:(\S+)\s*$/);
    // Index marker is `--INDEX:<table>:<index>` — keep BOTH so main() can
    // filter shadow/virtual-table indexes by their table name.
    const i = line.match(/^--INDEX:([^:]+):(\S+)\s*$/);
    if (t || i) {
      commit();
      mode = t ? "table" : "index";
      name = t ? t[1] : `${i[1]}:${i[2]}`;
      buf = [];
      continue;
    }
    if (mode) buf.push(line);
  }
  commit();
  return { tables, indexes };
}

// ────────────────────────────────────────────────────────────────────────────
// Statement parsing (comment/quote-aware)
// ────────────────────────────────────────────────────────────────────────────

/** Remove -- line comments and /* *\/ block comments, outside quotes. */
function stripComments(sql) {
  let out = "";
  let i = 0;
  let inS = false; // single-quote string
  let inQ = false; // double-quote identifier
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (inS) {
      out += c;
      if (c === "'" && n === "'") {
        out += n;
        i += 2;
        continue;
      }
      if (c === "'") inS = false;
      i++;
      continue;
    }
    if (inQ) {
      out += c;
      if (c === '"') inQ = false;
      i++;
      continue;
    }
    if (c === "'") {
      inS = true;
      out += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQ = true;
      out += c;
      i++;
      continue;
    }
    if (c === "-" && n === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Split a DDL body on top-level commas, skipping quotes/parens/comments. */
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  let inS = false;
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const n = s[i + 1];
    if (inS) {
      cur += c;
      if (c === "'") {
        if (n === "'") {
          cur += n;
          i++;
        } else inS = false;
      }
      continue;
    }
    if (inQ) {
      cur += c;
      if (c === '"') inQ = false;
      continue;
    }
    if (c === "'") inS = true;
    else if (c === '"') inQ = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Find the (outermost) column body of a CREATE TABLE statement. */
function extractTableBody(ddl, expectedName) {
  const clean = stripComments(ddl);
  const m = clean.match(
    /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s*\(/i
  );
  if (!m)
    throw new Error(`Translator: cannot parse header for '${expectedName}': ${clean.slice(0, 80)}`);
  const tableName = (m[1] || m[2] || m[3]).toLowerCase();
  if (tableName !== expectedName.toLowerCase()) {
    throw new Error(`Translator: name mismatch for '${expectedName}' (header says '${tableName}')`);
  }
  // Find the first '(' after the header; scan to its matching ')'.
  const open = clean.indexOf("(", clean.match(/^CREATE\s+TABLE\s+/i)[0].length);
  if (open < 0) throw new Error(`Translator: no column body for '${expectedName}'`);
  let depth = 0;
  let inS = false;
  let inQ = false;
  let close = -1;
  for (let i = open; i < clean.length; i++) {
    const c = clean[i];
    const n = clean[i + 1];
    if (inS) {
      if (c === "'") {
        if (n === "'") i++;
        else inS = false;
      }
      continue;
    }
    if (inQ) {
      if (c === '"') inQ = false;
      continue;
    }
    if (c === "'") inS = true;
    else if (c === '"') inQ = true;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) throw new Error(`Translator: unbalanced parens for '${expectedName}'`);
  return {
    tableName,
    body: clean.slice(open + 1, close),
    trailing: clean
      .slice(close + 1)
      .replace(/^[\s,]+/, "")
      .trim(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Column translator
// ────────────────────────────────────────────────────────────────────────────

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// PostgreSQL reserved keywords that appear as column/table/index names in
// this schema and must be double-quoted in DDL. (PG's full reserved list is
// larger, but this is the set that actually occurs.)
const PG_RESERVED = new Set(["user", "group", "key", "position", "date", "timestamp", "role"]);

function quoteIdent(name) {
  if (!SAFE_IDENT.test(name) || PG_RESERVED.has(name.toLowerCase())) {
    return `"${name.replace(/"/g, '""')}"`;
  }
  return name;
}

function splitColumnDef(colLine) {
  // [name] type [modifiers...] — first token is the name, second the type,
  // the rest a modifier string. We keep the modifier string as ONE blob
  // (no whitespace split) so multi-word modifiers like `NOT NULL` and
  // `DEFAULT (datetime('now'))` survive; translateColumn parses it.
  const clean = colLine.trim();
  const m = clean.match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s+([\s\S]+)$/);
  if (!m) return null;
  const name = m[1] || m[2] || m[3];
  const rest = m[4].trim();
  // Type = first token (may carry a width like VARCHAR(255), no internal space).
  let type = "";
  let i = 0;
  while (i < rest.length && !/\s/.test(rest[i])) {
    type += rest[i];
    i++;
  }
  const modString = rest.slice(i).trim();
  return { name, type, modString };
}

/**
 * Quote/paren-aware scanner that breaks a column modifier string into
 * structured pieces, keeping `NOT NULL`, `DEFAULT <value>`, `CHECK (...)`,
 * `REFERENCES ...`, `ON DELETE/UPDATE ...` intact. Returns a list of
 * {kind, value} in source order.
 */
function parseModifiers(modString) {
  const mods = [];
  const s = modString;
  let i = 0;
  const n = s.length;
  const ws = (j) => (j < n ? /\s/.test(s[j]) : true);

  const skipWs = (j) => {
    while (j < n && /\s/.test(s[j])) j++;
    return j;
  };
  const matchWord = (j, words) => {
    const u = s.slice(j).toUpperCase();
    for (const w of words) {
      if (u.startsWith(w + " ") || u === w) return w;
    }
    // also allow `(` to follow (e.g. CHECK (, DEFAULT ()
    for (const w of words) {
      if (u.startsWith(w + "(") || u.startsWith(w + "(")) return w;
    }
    return null;
  };

  while (i < n) {
    i = skipWs(i);
    if (i >= n) break;
    const c = s[i];

    if (c === "(" || c === "'") {
      // A bare paren/quoted value not preceded by a keyword we recognise —
      // this happens for a DEFAULT whose keyword we already consumed. Treat as
      // a stray value; should not occur in this schema, but capture it loudly.
      const v = readValue(s, i);
      mods.push({ kind: "value", value: v.text });
      i = v.end;
      continue;
    }

    const kw = matchWord(i, [
      "PRIMARY",
      "NOT",
      "NULL",
      "UNIQUE",
      "AUTOINCREMENT",
      "DEFAULT",
      "CHECK",
      "REFERENCES",
      "COLLATE",
      "ON",
      "MATCH",
    ]);
    if (!kw) {
      // Unknown single token — capture verbatim so review sees it.
      let j = i;
      while (j < n && !/\s/.test(s[j])) j++;
      mods.push({ kind: "passthrough", value: s.slice(i, j) });
      i = j;
      continue;
    }

    if (kw === "NOT") {
      // NOT NULL — consume both words.
      let j = i + 3;
      j = skipWs(j);
      const isNull = s.slice(j, j + 4).toUpperCase() === "NULL";
      mods.push({ kind: "notnull", value: isNull ? "NOT NULL" : "NOT" });
      i = isNull ? j + 4 : j;
      continue;
    }
    if (kw === "PRIMARY") {
      // PRIMARY KEY
      let j = i + 7;
      j = skipWs(j);
      const isKey = s.slice(j, j + 3).toUpperCase() === "KEY";
      mods.push({ kind: "primary", value: isKey ? "PRIMARY KEY" : "PRIMARY" });
      i = isKey ? j + 3 : j;
      continue;
    }
    if (kw === "DEFAULT") {
      let j = i + 7;
      j = skipWs(j);
      const v = readValue(s, j);
      mods.push({ kind: "default", value: v.text });
      i = v.end;
      continue;
    }
    if (kw === "CHECK") {
      let j = i + 5;
      j = skipWs(j);
      const v = readValue(s, j); // reads the balanced ( ... )
      mods.push({ kind: "check", value: v.text });
      i = v.end;
      continue;
    }
    if (kw === "COLLATE") continueToEndToken(i);
    if (kw === "MATCH") continueToEndToken(i);

    if (kw === "REFERENCES" || kw === "ON") {
      // `REFERENCES tbl(col) ON DELETE CASCADE ON UPDATE SET NULL` —
      // consume to the end of the column fragment (these are terminal in the
      // column-constraint grammar for this schema).
      mods.push({ kind: "ref", value: s.slice(i).trim() });
      i = n;
      continue;
    }

    if (kw === "UNIQUE") {
      mods.push({ kind: "unique", value: "UNIQUE" });
      i += 6;
      continue;
    }
    if (kw === "AUTOINCREMENT") {
      mods.push({ kind: "autoincrement", value: "AUTOINCREMENT" });
      i += 13;
      continue;
    }
    if (kw === "NULL") {
      mods.push({ kind: "null", value: "NULL" });
      i += 4;
      continue;
    }

    // Fallback: treat as a single token.
    let j = i;
    while (j < n && !/\s/.test(s[j])) j++;
    mods.push({ kind: "passthrough", value: s.slice(i, j) });
    i = j;
  }
  return mods;

  function continueToEndToken(start) {
    // Consume the keyword + one following token (e.g. COLLATE "name" / BINARY).
    let j = start;
    const kw = matchWord(j, ["COLLATE", "MATCH"]);
    j += kw === "MATCH" ? 5 : 7;
    j = skipWs(j);
    let k = j;
    while (k < n && !/\s/.test(s[k])) k++;
    mods.push({ kind: "drop", value: s.slice(start, k) });
    i = k;
  }
}

/** Read a value starting at index j: quoted string | (balanced) | bare token. */
function readValue(s, j) {
  const n = s.length;
  if (j >= n) return { text: "", end: j };
  const c = s[j];
  if (c === "'") {
    let k = j + 1;
    while (k < n) {
      if (s[k] === "'" && s[k + 1] === "'") {
        k += 2;
        continue;
      }
      if (s[k] === "'") break;
      k++;
    }
    return { text: s.slice(j, k + 1), end: k + 1 };
  }
  if (c === "(") {
    let depth = 0;
    let k = j;
    let inStr = false;
    while (k < n) {
      if (inStr) {
        if (s[k] === "'" && s[k + 1] === "'") k += 1;
        else if (s[k] === "'") inStr = false;
      } else if (s[k] === "'") inStr = true;
      else if (s[k] === "(") depth++;
      else if (s[k] === ")") {
        depth--;
        if (depth === 0) break;
      }
      k++;
    }
    return { text: s.slice(j, k + 1), end: k + 1 };
  }
  // bare token (number, identifier, CURRENT_TIMESTAMP, ...)
  let k = j;
  while (k < n && !/\s/.test(s[k]) && s[k] !== ",") k++;
  return { text: s.slice(j, k), end: k };
}

function translateColumnType(type) {
  const t = type.trim();
  const u = t.toUpperCase();
  if (u === "TEXT" || u === "VARCHAR" || /^VARCHAR\(\d+\)$/.test(u) || u === "CHAR" || u === "CLOB")
    return "TEXT";
  if (u === "DATETIME" || u === "TIMESTAMP") return "TIMESTAMPTZ";
  if (u === "INTEGER" || u === "INT" || u === "SMALLINT" || u === "TINYINT") return "INTEGER";
  if (u === "BIGINT" || u === "LONG") return "BIGINT";
  if (u === "REAL" || u === "DOUBLE" || u === "FLOAT") return "DOUBLE PRECISION";
  if (u === "BOOLEAN" || u === "BOOL") return "BOOLEAN";
  if (u === "BLOB" || u === "BYTEA") return "BYTEA";
  if (u === "DATE") return "DATE";
  if (u === "JSON") return "JSONB";
  if (/^(NUMERIC|DECIMAL)/.test(u)) return "NUMERIC";
  return u; // unknown → keep verbatim; loud in review
}

function translateDefault(expr) {
  const e = expr
    .trim()
    .replace(/^\(|\)$/g, "")
    .trim();
  // SQLite DQS compat: a double-quoted default is a string literal, not an
  // identifier — PG would parse it as a column reference and fail.
  const dqs = e.match(/^"(.*)"/s);
  if (dqs) return `'${dqs[1].replace(/'/g, "''")}'`;
  if (/^CURRENT_TIMESTAMP$/i.test(e)) return "(now() AT TIME ZONE 'UTC')";
  if (/^datetime\(\s*'now'\s*\)/i.test(e))
    return "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";
  if (/^strftime\(\s*'[^']*',\s*'now'\s*\)/i.test(e))
    return "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";
  if (/^strftime\(\s*'%s'/i.test(e)) return "extract(epoch from now())::BIGINT";
  if (/^random\(\s*\)$/i.test(e)) return "(random() * 2147483647)::INTEGER";
  // lower(hex(randomblob(n))) → lower(encode(gen_random_bytes(n), 'hex')).
  // PG has no hex() for bytea and no randomblob(); pgcrypto (created in the
  // header) provides gen_random_bytes().
  const uuid = e.match(/^lower\s*\(\s*hex\s*\(\s*randomblob\s*\((\d+)\)\s*\)\s*\)$/i);
  if (uuid) return `lower(encode(gen_random_bytes(${uuid[1]}), 'hex'))`;
  // Any other randomblob(n) occurrence (defensive):
  let out = e.replace(/randomblob\s*\((\d+)\)/gi, "gen_random_bytes($1)");
  if (/^unixepoch\(\s*\)/i.test(out)) return "extract(epoch from now())::BIGINT";
  if (/^julianday\(\s*'now'\s*\)/i.test(out)) return "extract(julian from now())";
  // Everything else (literals, subexpressions) passes through.
  return out;
}

function translateColumn(colLine, tableName) {
  const trimmed = colLine.trim();
  if (!trimmed) return null;
  if (/^(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|CONSTRAINT)\b/i.test(trimmed)) {
    return trimmed; // table constraint — PG-compatible, pass through
  }
  const parsed = splitColumnDef(trimmed);
  if (!parsed) {
    throw new Error(`Translator: unparseable column in '${tableName}': ${trimmed.slice(0, 60)}`);
  }
  const { name, type, modString } = parsed;
  if (!type) {
    throw new Error(`Translator: typeless column '${name}' in '${tableName}'`);
  }
  let autoincrementPk = false;
  const out = [`${quoteIdent(name)} ${translateColumnType(type)}`];
  for (const m of parseModifiers(modString)) {
    switch (m.kind) {
      case "primary":
        out.push(m.value);
        break;
      case "autoincrement":
        autoincrementPk = true;
        break;
      case "notnull":
        out.push("NOT NULL");
        break;
      case "null":
        break;
      case "unique":
        out.push("UNIQUE");
        break;
      case "default":
        if (m.value) out.push(`DEFAULT ${translateDefault(m.value)}`);
        break;
      case "check":
        // CHECK (...) passes through — PG accepts the SQLite boolean
        // expressions used here (=, !=, IN, IS NOT NULL, AND/OR, lower(),
        // length()). `IS DISTINCT FROM` already is PG-native.
        out.push(`CHECK ${m.value}`);
        break;
      case "ref":
        // REFERENCES tbl(col) [ON DELETE ...] [ON UPDATE ...]
        out.push(m.value.replace(/\s+REFERENCES/gi, " REFERENCES"));
        break;
      case "drop":
        break; // COLLATE / MATCH — no PG equivalent needed
      case "value":
      case "passthrough":
        throw new Error(
          `Translator: unrecognized column modifier '${m.value}' on '${name}' in '${tableName}'`
        );
    }
  }
  if (autoincrementPk) {
    // SQLite INTEGER PRIMARY KEY AUTOINCREMENT → PG identity. translateColumnType
    // already mapped INTEGER→INTEGER / BIGINT→BIGINT; rewrite whichever is present.
    out[0] = out[0].replace(
      /\b(BIGINT|INTEGER|SMALLINT|TEXT)\b/,
      "BIGINT GENERATED ALWAYS AS IDENTITY"
    );
    if (!out.join(" ").includes("PRIMARY KEY")) out.push("PRIMARY KEY");
  }
  return out.join(" ");
}

function translateTable(name, ddl) {
  const { tableName, body } = extractTableBody(ddl, name);
  const frags = splitTopLevel(body);
  const translated = [];
  for (const raw of frags) {
    if (!raw.trim()) continue;
    translated.push(translateColumn(raw, tableName));
  }
  if (translated.length === 0) throw new Error(`Translator: table '${name}' produced no columns`);
  // Commas BETWEEN items only — PG does not accept a trailing comma before ')'.
  const cols = translated.map((c) => `  ${c}`).join(",\n");
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} (\n${cols}\n);`;
}

// ────────────────────────────────────────────────────────────────────────────
// Trigger translator (SQLite DML triggers → PG plpgsql functions + triggers)
// ────────────────────────────────────────────────────────────────────────────
//
// The live DB carries 28 DML triggers. Three are FTS5 maintenance
// (memory_fts_ai/ad/au) and are replaced by the GENERATED search_tsv column;
// the rest are business logic (retired-provider guards, FK cascades, the
// request_detail_logs ring-buffer cap) and must keep working on PG.
//
// Rewrites applied to WHEN clauses and bodies:
//   char(N, ...)            → chr(N) || chr(...) || ...
//   trim(x[, set])          → btrim(x[, set])   (identical both-ends semantics)
//   datetime('now')         → ISO-8601 ms UTC string (all target columns are
//                              TEXT, so a string — not timestamptz — is the
//                              value the app expects)
//   CURRENT_TIMESTAMP       → same ISO expression (target columns are TEXT)
//   MAX(0, x)               → GREATEST(0, x)
//   IS NOT                  → IS DISTINCT FROM
//   AFTER UPDATE OF <cols>  → dropped (PG has no column list; the WHEN clause
//                              still gates the action; extra firings are no-ops)
//   BEGIN ... END           → plpgsql function body
//
const ISO_NOW = "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";

function parseTriggerDump(sql) {
  const lines = sql.split(/\r?\n/);
  const triggers = [];
  let name = null;
  let tbl = null;
  let buf = [];
  const commit = () => {
    if (!name) return;
    let body = buf
      .join("\n")
      .replace(/\s*;\s*$/, "")
      .trim();
    triggers.push({ name, tbl, body });
    name = null;
    tbl = null;
    buf = [];
  };
  for (const line of lines) {
    const t = line.match(/^--TRIGGER:([^:]+):(\S+)\s*$/);
    if (t) {
      commit();
      tbl = t[1];
      name = t[2];
      buf = [];
      continue;
    }
    if (name) buf.push(line);
  }
  commit();
  return triggers;
}

/** char(a, b, c) → chr(a) || chr(b) || chr(c), quote/paren aware. */
function rewriteCharCalls(s) {
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    // Standalone `char(` — must NOT be the tail of a longer identifier
    // (to_char, varchar), i.e. the char before the match must be a
    // non-identifier char.
    const m = s.slice(i).match(/^char\s*\(/i);
    const prev = i > 0 ? s[i - 1] : " ";
    if (m && !/[A-Za-z0-9_]/.test(prev)) {
      const start = i + m[0].length - 1; // position of '('
      // find the matching close paren
      let depth = 0;
      let j = start;
      for (; j < n; j++) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      const args = s
        .slice(start + 1, j)
        .split(",")
        .map((a) => a.trim());
      out += args.map((a) => `chr(${a})`).join(" || ");
      i = j + 1;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

function rewriteTriggerBody(s) {
  let out = s;
  // Order matters: char/trim rewrites run BEFORE the datetime replacement,
  // because the replacement introduces `to_char(...)` which the char()
  // rewriter must not touch.
  out = rewriteCharCalls(out);
  // trim → btrim (1- or 2-arg)
  out = out.replace(/\btrim\s*\(/gi, "btrim(");
  // ISO now for TEXT timestamp columns.
  out = out.replace(/\bdatetime\(\s*'now'\s*\)/gi, ISO_NOW);
  out = out.replace(/\bCURRENT_TIMESTAMP\b/gi, ISO_NOW);
  // MAX(0, x) → GREATEST(0, x)
  out = out.replace(/\bMAX\s*\(\s*0\s*,/gi, "GREATEST(0,");
  // IS NOT → IS DISTINCT FROM
  out = out.replace(/\bIS NOT\b/gi, "IS DISTINCT FROM");
  return out;
}

function translateTrigger(t) {
  const clean = stripComments(t.body).trim();
  const m = clean.match(
    /^CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s+(\w+)\s+(INSERT|UPDATE|DELETE)\s*(?:OF\s+[\w\s,]+?)?\s*ON\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s*(?:FOR\s+EACH\s+ROW\s*)?/i
  );
  if (!m) throw new Error(`Translator: cannot parse trigger '${t.name}': ${clean.slice(0, 100)}`);
  const name = m[1] || m[2] || m[3];
  const timing = m[4].toUpperCase();
  const op = m[5].toUpperCase();
  const tbl = m[6] || m[7] || m[8];
  // Remainder after ON <table>: optional WHEN clause + BEGIN/END body.
  const afterTable = clean.slice(m[0].length);
  const whenM = afterTable.match(/\bWHEN\s+([\s\S]*?)\bBEGIN\b/i);
  let when = null;
  let body = afterTable;
  if (whenM) {
    when = whenM[1].trim();
    const beginIdx = afterTable.search(/\bBEGIN\b/i);
    body = afterTable.slice(beginIdx);
  }
  // Strip leading BEGIN and trailing END
  body = body
    .replace(/^\s*BEGIN\b/i, "")
    .replace(/\bEND\s*;?\s*$/i, "")
    .trim();
  if (!body) throw new Error(`Translator: empty body in trigger '${name}'`);
  body = rewriteTriggerBody(body);
  when = when ? rewriteTriggerBody(when) : null;

  // PG forbids subqueries (EXISTS/SELECT) inside a trigger WHEN clause.
  // When the condition has one, hoist it into the function body as an
  // early-return guard — identical per-row semantics for AFTER triggers.
  if (when && /\bSELECT\b/i.test(when)) {
    const guard = op === "DELETE" ? "RETURN OLD" : "RETURN NEW";
    body = `IF NOT (${when}) THEN ${guard}; END IF;\n${body}`;
    when = null;
  }

  const fnName = `trg_${name.replace(/^trg_/, "")}_fn`;
  const ret = op === "DELETE" ? "OLD" : "NEW";
  const lines = [
    `CREATE OR REPLACE FUNCTION ${fnName}() RETURNS trigger`,
    `LANGUAGE plpgsql AS $$`,
    `BEGIN`,
    indent(body, 2),
    `RETURN ${ret};`,
    `END;`,
    `$$;`,
    "",
    `CREATE OR REPLACE TRIGGER ${quoteIdent(name)}`,
    `${timing} ${op} ON ${quoteIdent(tbl)} FOR EACH ROW`,
    ...(when ? [`WHEN (${when})`, ""] : []),
    `EXECUTE FUNCTION ${fnName}();`,
    "",
  ];
  return lines.join("\n");
}

function indent(s, spaces) {
  const pad = " ".repeat(spaces);
  return s
    .split("\n")
    .map((l) => (l.trim() ? pad + l : l))
    .join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// Index translator
// ────────────────────────────────────────────────────────────────────────────

function translateIndex(name, ddl) {
  const clean = stripComments(ddl).trim();
  const m = clean.match(
    /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s+ON\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s*([\s\S]*)$/i
  );
  if (!m) throw new Error(`Translator: cannot parse index '${name}': ${clean.slice(0, 80)}`);
  const unique = m[1] ? "UNIQUE " : "";
  const idxName = m[2] || m[3] || m[4];
  const tableName = m[5] || m[6] || m[7];
  let rest = m[8].trim();
  // Extract the column list (first paren group) and any WHERE clause.
  const open = rest.indexOf("(");
  if (open < 0) throw new Error(`Translator: index '${name}' has no column list`);
  let depth = 0;
  let close = -1;
  for (let i = open; i < rest.length; i++) {
    if (rest[i] === "(") depth++;
    else if (rest[i] === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  const colList = rest.slice(open + 1, close);
  const after = rest.slice(close + 1).trim();
  const where = after.startsWith("WHERE") ? after : null;
  // Quote reserved words used as index columns (e.g. ON table(group)).
  // Each top-level comma-separated entry is a column/expression; only its
  // leading bare identifier is a candidate for quoting.
  const quotedCols = colList
    .split(",")
    .map((part) => {
      const t = part.trim();
      const idMatch = t.match(/^([A-Za-z_][A-Za-z0-9_]*)(\s|$|\.)/);
      if (idMatch && PG_RESERVED.has(idMatch[1].toLowerCase())) {
        return `  "${idMatch[1]}"${t.slice(idMatch[1].length)}`;
      }
      return `  ${t}`;
    })
    .join(",\n");
  const parts = [
    `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdent(idxName)} ON ${quoteIdent(tableName)} (${quotedCols})`,
  ];
  if (where) parts.push(where);
  return parts.join(" ") + ";";
}

// ────────────────────────────────────────────────────────────────────────────
// Topological order by FK edges
// ────────────────────────────────────────────────────────────────────────────

function topologicalOrder(tables) {
  const names = [...tables.keys()];
  const refs = new Map();
  for (const name of names) {
    const edges = new Set();
    const re = /REFERENCES\s+["']?(\w+)["']?/gi;
    let m;
    while ((m = re.exec(tables.get(name))) !== null) edges.add(m[1].toLowerCase());
    refs.set(name, edges);
  }
  const placed = new Set();
  const order = [];
  let guard = 0;
  while (order.length < names.length && guard++ < names.length * names.length + 10) {
    for (const name of names) {
      if (placed.has(name)) continue;
      const deps = refs.get(name);
      if ([...deps].every((d) => placed.has(d) || !tables.has(d))) {
        placed.add(name);
        order.push(name);
      }
    }
  }
  for (const name of names) if (!placed.has(name)) order.push(name); // cyclic → dump order
  return order;
}

// ────────────────────────────────────────────────────────────────────────────
// Special cases
// ────────────────────────────────────────────────────────────────────────────

const SHADOW_TABLES = new Set([
  "memory_fts_config",
  "memory_fts_data",
  "memory_fts_docsize",
  "memory_fts_idx",
  "vec_memories_chunks",
  "vec_memories_info",
  "vec_memories_rowids",
  "vec_memories_vector_chunks00",
]);
const VIRTUAL_TABLES = new Set(["memory_fts", "vec_memories"]);

const FTS_REPLACEMENT = [
  "-- ── FTS5 replacement: memory_fts → tsvector on memories ──",
  "-- Live FTS5 indexed (content, key) from the external-content table",
  "-- `memories`. PG equivalent: generated tsvector + GIN index.",
  "ALTER TABLE memories ADD COLUMN IF NOT EXISTS search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, '') || ' ' || coalesce(key, ''))) STORED;",
  "CREATE INDEX IF NOT EXISTS memory_fts_idx ON memories USING gin(search_tsv);",
].join("\n");

const VEC_REPLACEMENT = [
  "-- ── vec0 replacement: vec_memories → pgvector ──",
  "-- vec0 keyed embeddings by the memories rowid (memory_id INTEGER).",
  "CREATE TABLE IF NOT EXISTS vec_memories (",
  "  id BIGINT PRIMARY KEY,",
  "  embedding vector(1024)",
  ");",
  "-- HNSW index only if the vector extension build supports it; commented",
  "-- out by default because PG 18 hnsw requires a distance operator class.",
  "-- CREATE INDEX IF NOT EXISTS vec_memories_hnsw ON vec_memories USING hnsw(id);",
].join("\n");

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("usage: pg-schema-translator.mjs <schema-sqlite.sql> [out.sql]");
    process.exit(2);
  }
  const inputPath = args[0];
  const outputPath = args[1] || inputPath.replace(/\.sql$/, ".pg.sql");
  const sql = readFileSync(inputPath, "utf8");
  const { tables, indexes } = parseDump(sql);

  const out = [];
  out.push("-- ── Generated by scripts/dev/pg-schema-translator.mjs ──");
  out.push("-- Source: live SQLite schema dump. Target: PostgreSQL 18, db `omniroute`.");
  out.push("-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS.");
  out.push("");
  out.push("CREATE EXTENSION IF NOT EXISTS vector;");
  out.push("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  out.push("");

  const order = topologicalOrder(tables);
  let regular = 0;
  for (const name of order) {
    if (SHADOW_TABLES.has(name) || VIRTUAL_TABLES.has(name)) continue;
    out.push(`--TABLE:${name}`);
    out.push(translateTable(name, tables.get(name)));
    out.push("");
    regular++;
  }

  out.push("-- ── Special-case replacements ──");
  out.push("");
  out.push(FTS_REPLACEMENT);
  out.push("");
  out.push(VEC_REPLACEMENT);
  out.push("");

  out.push("-- ── Indexes ──");
  let idxCount = 0;
  for (const [name, ddl] of indexes) {
    const [tableName, idxName] = name.split(":");
    if (SHADOW_TABLES.has(tableName) || VIRTUAL_TABLES.has(tableName)) continue;
    out.push(`--INDEX:${name}`);
    out.push(translateIndex(idxName, ddl));
    out.push("");
    idxCount++;
  }

  // ── Triggers (optional: pass the trigger dump as a second arg) ──
  const triggerSkip = new Set(["memory_fts_ai", "memory_fts_ad", "memory_fts_au"]);
  let trigCount = 0;
  if (args[2]) {
    const triggerSql = readFileSync(args[2], "utf8");
    const triggers = parseTriggerDump(triggerSql);
    out.push("-- ── Triggers (SQLite DML triggers → PG plpgsql) ──");
    out.push("");
    for (const t of triggers) {
      if (triggerSkip.has(t.name)) continue;
      out.push(`--TRIGGER:${t.tbl}:${t.name}`);
      out.push(translateTrigger(t));
      out.push("");
      trigCount++;
    }
  }

  writeFileSync(outputPath, out.join("\n"));
  console.log(
    `Translator OK: ${tables.size} tables in (${regular} regular), ${indexes.size} indexes in (${idxCount} out), ${trigCount} triggers → ${outputPath}`
  );
}

main();
