/**
 * Atomic topology — screen-space label collision / priority resolution
 * (OR-ATOM-002, V3).
 *
 * Pure, three-free behavior: the deterministic greedy placement (highest
 * priority wins), the never-hidden focused/hub invariants, the tie-break
 * order, the deterministic output for large fleets, and the chip-rect
 * bounds — the conservative CSS-matched {@link estimateChipWidth} (the
 * residual OR-ATOM-002 label-collision regression), the live DOM-measurement
 * override, and the viewport clamp.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CHIP_GEOMETRY,
  CHIP_MAX_WIDTH,
  CHIP_MIN_WIDTH,
  LABEL_HEIGHT,
  LABEL_OFFSET_Y,
  LABEL_PRIORITY_TIERS,
  estimateChipWidth,
  labelRect,
  resolveChipWidth,
  resolveLabelCollision,
  type LabelRect,
} from "@/plugins/atomic-topology/labelCollision";

const rect = (
  id: string,
  left: number,
  top: number,
  width = 90,
  height = 24,
  priority: number = LABEL_PRIORITY_TIERS.idle
): LabelRect => ({ id, left, top, width, height, priority });

/** A deterministic grid of `cols × rows` chips with `gap` spacing. */
function grid(
  cols: number,
  rows: number,
  gap: number,
  priority: number = LABEL_PRIORITY_TIERS.idle
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
  assert.deepEqual(
    result.map((r) => r.hidden),
    [false, false, false]
  );
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

test("focused label is never hidden, even when chips stack on it", () => {
  // Every chip overlaps the focused selection. The focused label is the top of
  // the priority order (Infinity): it is never hidden, and every overlapping
  // chip — the hub included, the hub's own tier being the highest of the
  // *ordinary* tiers but below focused — yields to the selection.
  const result = resolveLabelCollision([
    rect("focused", 0, 0, 90, 24, LABEL_PRIORITY_TIERS.focused),
    rect("e1", 0, 0, 90, 24, LABEL_PRIORITY_TIERS.error),
    rect("e2", 0, 0, 90, 24, LABEL_PRIORITY_TIERS.error),
    rect("a1", 0, 0, 90, 24, LABEL_PRIORITY_TIERS.active),
    rect("h1", 0, 0, 90, 24, LABEL_PRIORITY_TIERS.hub),
  ]);
  const byId = Object.fromEntries(result.map((r) => [r.id, r.hidden]));
  assert.equal(byId.focused, false, "the focused label is always visible");
  assert.equal(byId.h1, true, "the hub yields to the focused selection");
  assert.equal(byId.e1, true, "error yields to the focused selection");
  assert.equal(byId.e2, true, "the second error chip yields too");
  assert.equal(byId.a1, true, "active yields to the focused selection");
});

test("focused label occludes overlapping labels but a non-overlapping one stays", () => {
  // The focused selection overlaps the hub; a far-off healthy chip does not.
  // Only the overlapping chip hides — the non-overlapping one is unaffected.
  const result = resolveLabelCollision([
    rect("focused", 0, 0, 90, 24, LABEL_PRIORITY_TIERS.focused),
    rect("h1", 10, 2, 90, 24, LABEL_PRIORITY_TIERS.hub), // overlaps focused
    rect("ok", 400, 0, 90, 24, LABEL_PRIORITY_TIERS.healthy), // no overlap
  ]);
  const byId = Object.fromEntries(result.map((r) => [r.id, r.hidden]));
  assert.equal(byId.focused, false, "focused visible");
  assert.equal(byId.h1, true, "the overlapping hub yields to the selection");
  assert.equal(byId.ok, false, "a non-overlapping chip is untouched");
});

test("equal priority → deterministic tie-break by id (smaller id wins)", () => {
  const run = (ids: string[]) =>
    Object.fromEntries(
      resolveLabelCollision(ids.map((id) => rect(id, 0, 0, 90, 24, LABEL_PRIORITY_TIERS.idle))).map(
        (r) => [r.id, r.hidden]
      )
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
  assert.ok(
    result.every((r) => !r.hidden),
    "no collisions in a wide grid"
  );
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
  assert.ok(
    wide.every((r) => !r.hidden),
    "80 separated chips all readable"
  );

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
/* estimateChipWidth — CSS-matched, conservative chip width            */
/* ------------------------------------------------------------------ */

/** Fixed chrome: 2× padding + 2× border + swatch + 2 gaps (see CSS). */
const FIXED_CHROME =
  2 * CHIP_GEOMETRY.paddingX +
  2 * CHIP_GEOMETRY.borderX +
  CHIP_GEOMETRY.swatchWidth +
  CHIP_GEOMETRY.gapCount * CHIP_GEOMETRY.gap;

test("estimateChipWidth: covers the full chip chrome and the state word", () => {
  // "idle" chip: chrome + label text + uppercase state word (incl.
  // letter-spacing) — the state word alone must contribute width.
  const idle = estimateChipWidth("gpu", "idle");
  const labelPart = "gpu".length * CHIP_GEOMETRY.fontSize * CHIP_GEOMETRY.labelCharWidthRatio;
  const statePart =
    4 * CHIP_GEOMETRY.stateFontSize * CHIP_GEOMETRY.stateCharWidthRatio +
    3 * CHIP_GEOMETRY.stateFontSize * CHIP_GEOMETRY.stateLetterSpacingRatio;
  assert.equal(idle, FIXED_CHROME + labelPart + statePart, "chrome + label + state");
  assert.ok(idle > FIXED_CHROME + labelPart, "the state word adds width");
});

test("estimateChipWidth: is conservative for the OR-ATOM-002 labels", () => {
  // The deployed rescue commit (2321d5e7e) used `26 + len * 6.5` clamped to
  // [56, 190] — far below the rendered chip width, which is what let the
  // collision pass miss real overlaps on screen. The CSS-matched estimate
  // must exceed that under-estimate for the labels that actually collided.
  const oldEstimate = (len: number) => Math.max(56, Math.min(190, 26 + len * 6.5));
  for (const label of ["hub", "arc-embed", "vllm", "llama-cpp"]) {
    assert.ok(
      estimateChipWidth(label, "idle") >= oldEstimate(label.length),
      `estimate(${label}) must not be smaller than the old under-estimate`
    );
  }
  // The two collided pairs must be strictly wider than before (that is the
  // residual bug: the estimates were too small).
  assert.ok(estimateChipWidth("hub", "idle") > oldEstimate("hub".length), "hub grew");
  assert.ok(
    estimateChipWidth("arc-embed", "idle") > oldEstimate("arc-embed".length),
    "arc-embed grew"
  );
  assert.ok(estimateChipWidth("vllm", "idle") > oldEstimate("vllm".length), "vllm grew");
  assert.ok(
    estimateChipWidth("llama-cpp", "idle") > oldEstimate("llama-cpp".length),
    "llama-cpp grew"
  );
});

test("estimateChipWidth: monotonic in label length, clamped to [MIN, MAX]", () => {
  assert.ok(estimateChipWidth("openai", "idle") > estimateChipWidth("gpu", "idle"));
  assert.equal(estimateChipWidth("", ""), CHIP_MIN_WIDTH, "empty chip → minimum box");
  assert.equal(
    estimateChipWidth("openai:chatgpt-4o-mini-2024-08-06-very-long-provider-name", "idle"),
    CHIP_MAX_WIDTH,
    "very long label clamps to the CSS max-width cap"
  );
  assert.equal(CHIP_MAX_WIDTH, CHIP_GEOMETRY.maxWidthContent + 2 * CHIP_GEOMETRY.borderX);
});

test("resolveChipWidth: prefers the live DOM measurement, falls back to the estimate", () => {
  const est = estimateChipWidth("openai", "idle");
  assert.equal(resolveChipWidth("openai", "idle"), est, "no measurement → estimate");
  assert.equal(resolveChipWidth("openai", "idle", 120), 120, "measured width wins");
  assert.equal(resolveChipWidth("openai", "idle", 0), est, "zero measurement → estimate");
  assert.equal(resolveChipWidth("openai", "idle", NaN), est, "NaN measurement → estimate");
  assert.equal(
    resolveChipWidth("openai", "idle", 999),
    CHIP_MAX_WIDTH,
    "a stale measurement is clamped, never trusted unbounded"
  );
});

/* ------------------------------------------------------------------ */
/* labelRect — chip box from the estimate / measurement                */
/* ------------------------------------------------------------------ */

test("labelRect: width scales with label length and clamps to [MIN, MAX]", () => {
  const short = labelRect({
    id: "s",
    label: "gpu",
    state: "idle",
    x: 100,
    y: 100,
    priority: 0,
    viewportWidth: 1000,
    viewportHeight: 800,
  });
  const long = labelRect({
    id: "l",
    label: "openai:chatgpt-4o-mini-2024-08-06-very-long-provider-name",
    state: "idle",
    x: 100,
    y: 100,
    priority: 0,
    viewportWidth: 1000,
    viewportHeight: 800,
  });
  assert.ok(short.width < long.width, "longer label → wider chip");
  assert.ok(short.width >= CHIP_MIN_WIDTH, "minimum chip width");
  assert.ok(long.width <= CHIP_MAX_WIDTH, "maximum chip width");
  assert.equal(short.height, LABEL_HEIGHT);
});

test("labelRect: a measured width overrides the estimate", () => {
  const measured = labelRect({
    id: "m",
    label: "gpu",
    state: "idle",
    x: 100,
    y: 100,
    priority: 0,
    viewportWidth: 1000,
    viewportHeight: 800,
    measuredWidth: 118,
  });
  const estimated = labelRect({
    id: "m",
    label: "gpu",
    state: "idle",
    x: 100,
    y: 100,
    priority: 0,
    viewportWidth: 1000,
    viewportHeight: 800,
  });
  assert.equal(measured.width, 118, "measured width used verbatim");
  assert.notEqual(measured.width, estimated.width, "estimate differs from measurement");
  assert.equal(measured.left, 100, "anchor placement is unaffected");
});

test("labelRect: anchors above the atom and clamps to the viewport", () => {
  const base = labelRect({
    id: "a",
    label: "openai",
    state: "idle",
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
    state: "idle",
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

/* ------------------------------------------------------------------ */
/* OR-ATOM-002 residual regression — the two deployed overlaps         */
/* ------------------------------------------------------------------ */

/**
 * Reproduces the exact screen geometry of the authenticated screenshots of
 * deployed rescue commit 2321d5e7e: two chips whose *rendered* boxes overlap
 * were both left visible because the old width estimate
 * (`26 + len * 6.5`, clamped to [56, 190]) put the neighbor's anchor just
 * past the *estimated* right edge. The collision pass must now flag the
 * overlap and hide the lower-priority chip.
 */
function chipPair(
  highId: string,
  highLabel: string,
  highPriority: number,
  lowId: string,
  lowLabel: string,
  lowPriority: number,
  anchorX: number
): LabelRect[] {
  // 60px anchor gap, same row: rendered chips overlap, old estimates do not.
  return [
    labelRect({
      id: highId,
      label: highLabel,
      state: "idle",
      x: anchorX,
      y: 300,
      priority: highPriority,
      viewportWidth: 1280,
      viewportHeight: 800,
    }),
    labelRect({
      id: lowId,
      label: lowLabel,
      state: "idle",
      x: anchorX + 60,
      y: 300,
      priority: lowPriority,
      viewportWidth: 1280,
      viewportHeight: 800,
    }),
  ];
}

test("OR-ATOM-002 regression: hub / arc-embed overlap → arc-embed hidden", () => {
  const rects = chipPair(
    "hub",
    "hub",
    LABEL_PRIORITY_TIERS.hub,
    "provider:arc-embed",
    "arc-embed",
    LABEL_PRIORITY_TIERS.idle,
    400
  );
  const [hub, arc] = rects;
  // The *estimated* boxes themselves must overlap — the pure precondition
  // that the resolver sees (independent of the resolver's own logic).
  assert.ok(
    arc.left < hub.left + hub.width && hub.left < arc.left + arc.width,
    "the estimated chip boxes overlap, as on screen"
  );
  const byId = Object.fromEntries(resolveLabelCollision(rects).map((v) => [v.id, v.hidden]));
  assert.equal(byId.hub, false, "the hub (higher priority) stays visible");
  assert.equal(byId["provider:arc-embed"], true, "the overlapped arc-embed chip is hidden");
});

test("OR-ATOM-002 regression: vllm / llama-cpp overlap → llama-cpp hidden", () => {
  const rects = chipPair(
    "gpu:vllm",
    "vllm",
    LABEL_PRIORITY_TIERS.idle,
    "gpu:llama-cpp",
    "llama-cpp",
    LABEL_PRIORITY_TIERS.idle,
    600
  );
  const [vllm, llama] = rects;
  assert.ok(
    llama.left < vllm.left + vllm.width && vllm.left < llama.left + llama.width,
    "the estimated chip boxes overlap, as on screen"
  );
  const byId = Object.fromEntries(resolveLabelCollision(rects).map((v) => [v.id, v.hidden]));
  // Same priority tier → the further-left chip is placed first and wins.
  assert.equal(byId["gpu:vllm"], false, "vllm (further left) stays visible");
  assert.equal(byId["gpu:llama-cpp"], true, "the overlapped llama-cpp chip is hidden");
});

test("OR-ATOM-002 regression: focused label wins a collided pair anyway", () => {
  // Same 60px overlap, but the arc-embed atom is the focused selection:
  // the selection must never be obscured, so the *hub* yields instead.
  const rects = chipPair(
    "hub",
    "hub",
    LABEL_PRIORITY_TIERS.hub,
    "provider:arc-embed",
    "arc-embed",
    LABEL_PRIORITY_TIERS.focused,
    400
  );
  const byId = Object.fromEntries(resolveLabelCollision(rects).map((v) => [v.id, v.hidden]));
  assert.equal(byId["provider:arc-embed"], false, "focused label is never hidden");
  assert.equal(byId.hub, true, "the hub yields to the focused selection");
});

test("normal fixtures: well-separated chips do not intersect", () => {
  // Every pair stays further apart than the widest estimated chip box
  // (CHIP_MAX_WIDTH) plus the collision padding — no hidden labels.
  const rects = [
    labelRect({
      id: "hub",
      label: "hub",
      state: "idle",
      x: 100,
      y: 300,
      priority: LABEL_PRIORITY_TIERS.hub,
      viewportWidth: 1280,
      viewportHeight: 800,
    }),
    labelRect({
      id: "openai",
      label: "openai",
      state: "active",
      x: 100 + CHIP_MAX_WIDTH + 20,
      y: 300,
      priority: LABEL_PRIORITY_TIERS.active,
      viewportWidth: 1280,
      viewportHeight: 800,
    }),
    labelRect({
      id: "vllm",
      label: "vllm",
      state: "idle",
      x: 100 + 2 * (CHIP_MAX_WIDTH + 20),
      y: 300,
      priority: LABEL_PRIORITY_TIERS.idle,
      viewportWidth: 1280,
      viewportHeight: 800,
    }),
    labelRect({
      id: "llama",
      label: "llama-cpp",
      state: "last",
      x: 100,
      y: 300 + CHIP_MAX_WIDTH + 20,
      priority: LABEL_PRIORITY_TIERS.last,
      viewportWidth: 1280,
      viewportHeight: 800,
    }),
  ];
  // Sanity: no pair intersects even with the collision padding.
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      const separatedX = a.left + a.width <= b.left || b.left + b.width <= a.left;
      const separatedY = a.top + a.height <= b.top || b.top + b.height <= a.top;
      assert.ok(separatedX || separatedY, `${a.id}/${b.id} are separated`);
    }
  }
  const result = resolveLabelCollision(rects);
  assert.deepEqual(
    result.map((r) => r.hidden),
    [false, false, false, false],
    "all visible"
  );
});
