/**
 * OR-ATOM-005 (T5.5) — tooltip queue-row labeling freeze.
 *
 * The shared queue row of the Atomic tooltip must never read as ONE queue:
 * provider/gpu atoms carry the OmniRoute request rate-limiter queue
 * (basis `rateLimitManager:counts.QUEUED`), while runtime device atoms
 * carry the inference-scheduler queue. `queueRowLabel` is the single seam
 * that keeps them separately labeled.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { queueRowLabel } from "../../../src/plugins/atomic-topology/overlays/AtomicTooltip";

test("queueRowLabel: provider/gpu/hub atoms are labeled 'Rate-limit queue' (limiter, not scheduler)", () => {
  assert.equal(queueRowLabel("provider"), "Rate-limit queue");
  assert.equal(queueRowLabel("gpu"), "Rate-limit queue");
  assert.equal(queueRowLabel("hub"), "Rate-limit queue");
});

test("queueRowLabel: runtime device atoms are labeled 'Sched. queue' (inference scheduler)", () => {
  assert.equal(queueRowLabel("runtime"), "Sched. queue");
});

test("queueRowLabel: the two labels are distinct (freeze: limiter ≠ scheduler)", () => {
  assert.notEqual(queueRowLabel("provider"), queueRowLabel("runtime"));
});
