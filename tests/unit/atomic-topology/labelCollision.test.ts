/**
 * Atomic topology — screen-space label collision / priority resolution
 * (OR-ATOM-002, V3).
 *
 * Pure, three-free behavior: the deterministic greedy placement (highest
 * priority wins), the never-hidden focused/hub invariants, the tie-break
 * order, the deterministic output for large fleets, and the chip-rect
 * estimate (text-length width + viewport clamp).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  LABEL_PRIORITY_TIERS,
  LABEL_HEIGHT,
  LABEL_OFFSET_Y,
  labelRect,
  resolveLabelCollision,
  type LabelRect,
} from "@/plugins/atomic-topology/labelCollision";

const rect = (
  id: string,
  left: number,
  top: number,
  width = 90,
  height = 24,
  priority = LABEL_PRIORITY_TIERS.idle
): LabelRect => ({ id, left, top, width, height, priority });

/** A deterministic grid of `cols × rows` chips with `gap` spacing. */
function grid(
  cols: number,
  rows: number,
  gap: number,
  priority = LABEL_PRIORITY_TIERS.idle
): LabelRect[] {
  const out: LabelRect[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      out.push(rect(`a${r}-${c}`, 10 + c * gap, 10 + r * gap, 80, 24, priority));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Priority tiers                                                      */
/* ------------------------------------------------------------------ */

test("LABEL_PRIORITY_TIERS pins the precedence order", () => {
  assert.equal(LABEL_PRIORITY_TIERS.focused, Number.POSITIVE_INFINITY);
  assert.equal(LABEL_PRIORITY_TIERS.hub, 100);
  assert.equal(LABEL_PRIORITY_TIERS.error, 60);
  assert.equal(LABEL_PRIORITY_TIERS.active, 50);
  assert.equal(LABEL_PRIORITY_TIERS.last, 40);
  assert.equal(LABEL_PRIORITY_TIERS.healthy, 30);
  assert.equal(LABEL_PRIORITY_TIERS.idle, 20);
  assert.equal(LABEL_PRIORITY_TIERS.default, 0);
  // The emphasis order must be strictly decreasing hub > error > active >
  // last > healthy > idle (so a collision always hides the *less* urgent label).
  assert.ok(LABEL_PRIORITY_TIERS.hub > LABEL_PRIORITY_TIERS.error);
  assert.ok(LABEL_PRIORITY_TIERS.error > LABEL_PRIORITY_TIERS.active);
  assert.ok(LABEL_PRIORITY_TIERS.active > LABEL_PRIORITY_TIERS.last);
  assert.ok(LABEL_PRIORITY_TIERS.last > LABEL_PRIORITY_TIERS.healthy);
  assert.ok(LABEL_PRIORITY_TIERS.healthy > LABEL_PRIORITY_TIERS.idle);
  assert.ok(LABEL_PRIORITY_TIERS.idle > LABEL_PRIORITY_TIERS.default);
});

/* ------------------------------------------------------------------ */
/* No collisions                                                       */
/* ------------------------------------------------------------------ */

test("no overlap → every label visible", () => {
  const rects = [rect("a", 0, 0), rect("b", 200, 0), rect("c", 0, 200)];
  const result = resolveLabelCollision(rects);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map((r) => r.hidden), [false, false, false]);
});

/* ------------------------------------------------------------------ */
/* Collisions — priority decides                                       */
/* ------------------------------------------------------------------ */

test("two overlapping chips → the higher-priority one wins", () => {
  const result = resolveLabelCollision([
    rect("low", 0, 0, 90, 24, LABEL_PRIORITY_TIERS.idle),
    rect("high", 10, 5, 90, 24, LABEL_PRIORITY_TIERS.error),
  ]);
  const byId = Object.fromEntries(result.map((r) => [r.id, r.hidden]));
  assert.equal(byId.low, true, "idle label hidden");
  assert.equal(byId.high, false, "error label visible");
});

test("three stacked chips → only the highest priority survives", () => {
  const result = resolveLabelCollision([
    rect("idle", 0, 0, 90, 24, LABEL_PRIORITY_TIERS.idle),
    rect("active", 0, 0, 90, 24, LABEL_PRIORITY_TIERS.active),
    rect("error", 0, 0, 90, 24, LABEL_PRIORITY_TIERS.error),
  ]);
  const byId = Object.fromEntries(result.map((r) => [r.id, r.hidden]));
  assert.deepEqual(byId, { idle: true, active: true, error: false });
});

test("focused label is never hidden, even when 5 chips stack on it", () => {
  const result = resolveLabelCollision([
    rect("focused", 0, 0, 90, 24, LABEL_PRIORITY_TIERS.focused),
    rect("e1", 0, 0, 90, 24, LABEL_PRIORITY_TIERS.error),
    rect("e2", 0, 0, 90, 24, LABEL_PRIORITY_TIERS.error),
    rect("a1", 0, 0, 90, 24, LABEL_PRIORITY_TIERS.active),
    rect("h1", 0, 0, 90, 24, LABEL_PRIORITY_TIERS.hub),
  ]);
  const byId = Object.fromEntries(result.map((r) => [r.id, r.hidden]));
  assert.equal(byId.focused, false, "the focused label is always visible");
  assert.equal(byId.h1, false, "the hub (100) beats error/active and stays visible");
  assert.equal(byId.e1, true, "error yields to the hub");
  assert.equal(byId.e2, true, "the second error chip is hidden too");
  assert.equal(byId.a1, true);
});

test("equal priority → deterministic tie-break by id (smaller id wins)", () => {
  const run = (ids: string[]) =>
    Object.fromEntries(
      resolveLabelCollision(
        ids.map((id) => rect(id, 0, 0, 90, 24, LABEL_PRIORITY_TIERS.idle))
      ).map((r) => [r.id, r.hidden])
    );
  const a = run(["a", "b", "c"]);
  const b = run(["a", "b", "c"]);
  assert.deepEqual(a, b, "deterministic across identical runs");
  assert.equal(a.a, false, "smallest id placed first → visible");
  assert.equal(a.b, true);
  assert.equal(a.c, true);
  // A different input *order* with the same geometry must give the same
  // decision (order-independence of the deterministic placement).
  assert.deepEqual(run(["c", "a", "b"]), a);
});

/* ------------------------------------------------------------------ */
/* Scale — 8 / 20 / 40 / 80 label fleets                               */
/* ------------------------------------------------------------------ */

test("8 chips stacked on one spot → exactly one visible (deterministic)", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const rects = ids.map((id, i) => rect(id, 0, 0, 90, 24, LABEL_PRIORITY_TIERS.idle + i));
  const result = resolveLabelCollision(rects);
  const visible = result.filter((r) => !r.hidden);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, "h", "highest priority (last) wins");
  const shuffled = resolveLabelCollision([...rects].reverse());
  assert.deepEqual(
    shuffled.filter((r) => !r.hidden).map((r) => r.id),
    ["h"]
  );
});

test("20 well-separated chips → all visible", () => {
  const result = resolveLabelCollision(grid(5, 4, 140));
  assert.equal(result.length, 20);
  assert.ok(result.every((r) => !r.hidden), "no collisions in a wide grid");
});

test("20 densely clustered chips → exactly one visible per cluster", () => {
  const result = resolveLabelCollision(grid(5, 4, 8));
  const visible = result.filter((r) => !r.hidden);
  assert.equal(visible.length, 1, "a single cluster collapses to one label");
});

test("40 chips as two dense clusters → two visible", () => {
  const left = grid(4, 5, 6).map((r) => ({ ...r, id: `L${r.id}` }));
  const right = grid(4, 5, 6).map((r) => ({ ...r, id: `R${r.id}`, left: r.left + 600 }));
  const result = resolveLabelCollision([...left, ...right]);
  const visible = result.filter((r) => !r.hidden);
  assert.equal(visible.length, 2, "one survivor per cluster");
  assert.ok(visible.every((r) => r.id.startsWith("L") || r.id.startsWith("R")));
});

test("80 chips — wide grid all visible, dense grid collapses", () => {
  const wide = resolveLabelCollision(grid(10, 8, 130));
  assert.equal(wide.length, 80);
  assert.ok(wide.every((r) => !r.hidden), "80 separated chips all readable");

  const dense = resolveLabelCollision(grid(10, 8, 3));
  assert.equal(dense.filter((r) => !r.hidden).length, 1, "80 stacked chips → one");

  // Determinism: two runs on the identical 80-chip input agree.
  const again = resolveLabelCollision(grid(10, 8, 3));
  assert.deepEqual(
    dense.map((r) => [r.id, r.hidden]),
    again.map((r) => [r.id, r.hidden])
  );
});

test("a mix of priorities in a cluster keeps the urgent label readable", () => {
  const result = resolveLabelCollision([
    rect("idle-1", 0, 0, 90, 24, LABEL_PRIORITY_TIERS.idle),
    rect("idle-2", 5, 4, 90, 24, LABEL_PRIORITY_TIERS.idle),
    rect("active", 8, 2, 90, 24, LABEL_PRIORITY_TIERS.active),
    rect("error", 3, 6, 90, 24, LABEL_PRIORITY_TIERS.error),
  ]);
  const byId = Object.fromEntries(result.map((r) => [r.id, r.hidden]));
  assert.equal(byId.error, false, "the error label is the survivor");
  assert.equal(byId.active, true);
  assert.equal(byId["idle-1"], true);
  assert.equal(byId["idle-2"], true);
});

/* ------------------------------------------------------------------ */
/* labelRect — chip box estimate                                       */
/* ------------------------------------------------------------------ */

test("labelRect: width scales with label length and clamps to [56, 190]", () => {
  const short = labelRect({
    id: "s",
    label: "gpu",
    x: 100,
    y: 100,
    priority: 0,
    viewportWidth: 1000,
    viewportHeight: 800,
  });
  const long = labelRect({
    id: "l",
    label: "openai:chatgpt-4o-mini-2024-08-06-very-long-provider-name",
    x: 100,
    y: 100,
    priority: 0,
    viewportWidth: 1000,
    viewportHeight: 800,
  });
  assert.ok(short.width < long.width, "longer label → wider chip");
  assert.ok(short.width >= 56, "minimum chip width");
  assert.ok(long.width <= 190, "maximum chip width");
  assert.equal(short.height, LABEL_HEIGHT);
});

test("labelRect: anchors above the atom and clamps to the viewport", () => {
  const base = labelRect({
    id: "a",
    label: "openai",
    x: 200,
    y: 300,
    priority: 0,
    viewportWidth: 800,
    viewportHeight: 600,
  });
  assert.equal(base.top, 300 + LABEL_OFFSET_Y, "chip sits above its atom");
  assert.ok(LABEL_OFFSET_Y < 0, "offset is upward");

  // An atom near the right edge: the chip is clamped to stay on-screen.
  const edge = labelRect({
    id: "b",
    label: "openai",
    x: 9999,
    y: 40,
    priority: 0,
    viewportWidth: 800,
    viewportHeight: 600,
  });
  assert.equal(edge.left, 800 - base.width, "clamped to the viewport's right edge");
  assert.ok(edge.left >= 0 && edge.left + edge.width <= 800);
  assert.equal(edge.top, Math.max(0, 40 + LABEL_OFFSET_Y), "top clamped to ≥ 0");
});
