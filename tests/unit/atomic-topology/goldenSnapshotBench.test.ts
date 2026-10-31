/**
 * Unit tests for the deterministic golden bench snapshot (OR-ATOM-010 T10.1/T10.6).
 *
 * `buildGoldenSnapshot` must stay PURE and DETERMINISTIC — the bench's
 * before/after screenshots and the 8/16/32 perf ladder are reproducible
 * run-to-run, so any `Math.random` or clock leak breaks them. Covers:
 *   - the default scene is the anchor-only 6-atom golden (hub + 5 providers)
 *   - the `atomCount` ladder fills the PROVIDER pool exactly (8 → 8 atoms)
 *   - anchor provenance providers are always present (KNOWN / UNKNOWN /
 *     STALE / FAILURE conditions stay exercisable at every scale)
 *   - scaled providers are deterministic and idempotent across builds
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildGoldenSnapshot,
  type GoldenSnapshotOptions,
} from "../../../src/app/dev/atomic-bench/goldenSnapshot";

function ids(snapshot: ReturnType<typeof buildGoldenSnapshot>): string[] {
  return snapshot.nodes.map((n) => n.id).sort();
}

const ANCHOR_PROVIDERS = [
  "provider:bench-primary",
  "provider:bench-secondary",
  "provider:bench-unknown",
  "provider:bench-stale",
  "provider:bench-error",
];

test("golden snapshot: default is the 6-atom anchor scene (hub + 5 providers)", () => {
  const s = buildGoldenSnapshot();
  assert.equal(s.schemaVersion, 1);
  assert.equal(s.nodes.length, 6);
  assert.equal(s.nodes.filter((n) => n.kind === "hub").length, 1);
  assert.equal(s.nodes.filter((n) => n.kind === "provider").length, 5);
  assert.equal(s.links.length, 5);
});

test("golden snapshot: anchor provenance providers are always present", () => {
  for (const id of ANCHOR_PROVIDERS) {
    assert.ok(
      buildGoldenSnapshot().nodes.some((n) => n.id === id),
      `missing anchor provider ${id}`
    );
  }
});

test("golden snapshot: default equals atomCount=6 (anchor floor, no scaled providers)", () => {
  assert.deepEqual(ids(buildGoldenSnapshot()), ids(buildGoldenSnapshot({ atomCount: 6 })));
  assert.deepEqual(ids(buildGoldenSnapshot()), ids(buildGoldenSnapshot({})));
});

test("golden snapshot: the perf ladder fills the provider pool exactly (8 / 16 / 32)", () => {
  for (const target of [8, 16, 32]) {
    const s = buildGoldenSnapshot({ atomCount: target });
    assert.equal(s.nodes.length, target, `atomCount=${target} should yield ${target} total atoms`);
    assert.equal(
      s.nodes.filter((n) => n.kind === "provider").length,
      target - 1 // hub + providers
    );
    assert.equal(s.links.length, target - 1);
  }
});

test("golden snapshot: scaled providers are named bench-perf-N and deterministic", () => {
  const s = buildGoldenSnapshot({ atomCount: 16 });
  const scaled = s.nodes
    .filter((n) => n.id.startsWith("provider:bench-perf-"))
    .map((n) => n.id)
    .sort();
  assert.equal(scaled.length, 10); // 16 total − 1 hub − 5 anchors
  // Lexicographic order: perf-1, perf-10, perf-2 … perf-9 (perf-10 sorts
  // between perf-1 and perf-2), so the last sorted entry is perf-9.
  assert.equal(scaled[0], "provider:bench-perf-1");
  assert.equal(scaled[1], "provider:bench-perf-10");
  assert.equal(scaled[scaled.length - 1], "provider:bench-perf-9");
});

test("golden snapshot: deterministic — same options → identical node set", () => {
  for (const options of [undefined, { atomCount: 32 }] as GoldenSnapshotOptions[]) {
    const a = ids(buildGoldenSnapshot(options));
    const b = ids(buildGoldenSnapshot(options));
    assert.deepEqual(a, b, `non-deterministic output for ${JSON.stringify(options)}`);
  }
});

test("golden snapshot: the 32-atom scale keeps every anchor + 26 scaled providers", () => {
  const s = buildGoldenSnapshot({ atomCount: 32 });
  const all = ids(s);
  for (const anchor of ANCHOR_PROVIDERS) {
    assert.ok(all.includes(anchor), `32-atom scale lost anchor ${anchor}`);
  }
  assert.equal(all.length, 32);
});
