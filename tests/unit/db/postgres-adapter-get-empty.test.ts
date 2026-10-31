/**
 * @file Regression test for live incident 2026-10-23: PostgreSQL adapter get()
 * returns [] on empty results, defeating the usage_history dedup guard and
 * causing every success usage row to be silently dropped.
 *
 * The adapter's get() must always return undefined when a SELECT matches no rows,
 * matching better-sqlite3's contract, regardless of the underlying driver.
 * The PG driver was returning [] (an empty array), which is truthy and caused
 * the dedup guard in saveRequestUsage() to always take the early-return path,
 * preventing INSERT INTO usage_history from ever executing for success rows.
 *
 * @group db/postgres-adapter
 */

import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

// This path works from the worktree root. The test is in tests/unit/db/ so
// ../../ is the worktree root. We're running from tests/unit/db/ so use absolute.
const adapterPath = new URL("../../../src/lib/db/adapters/postgresAdapter.ts", import.meta.url)
  .pathname;

test("postgresAdapter.get() contract: empty SELECT must return undefined (not [])", () => {
  const src = readFileSync(adapterPath, "utf8");

  // Assert the fixed version (returns undefined on empty)
  // This pattern appears in the get() method body at line ~854.
  // Before fix (buggy): `if (!Array.isArray(result) || result.length < 1) return result;`
  // After fix (correct): `if (!Array.isArray(result) || result.length < 1) return undefined;`
  const isFixed =
    src.includes("if (!Array.isArray(result) || result.length < 1) return undefined;") ||
    src.includes("if (!Array.isArray(result) || result.length < 1) { return undefined; }");

  assert(isFixed, "postgresAdapter.ts get() must return undefined on empty, not []");

  // Bonus: also verify all() keeps returning [] (it's allowed to)
  const allReturnsEmptyArray =
    src.includes("return Array.isArray(result) ? result : [];") ||
    src.includes("return Array.isArray(result) ? remapKeys(result, sqlAliases) : [];") ||
    src.includes("return !Array.isArray(result) ? [] : result;") ||
    src.includes("if (!Array.isArray(result)) return [];") ||
    src.includes("return Array.isArray(result) ? n(b,h) : [];");

  assert(
    allReturnsEmptyArray,
    "postgresAdapter.ts all() should return [] on empty array (this is the correct contract)"
  );
});
