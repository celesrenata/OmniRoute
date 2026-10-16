import test from "node:test";
import assert from "node:assert/strict";

// Requirement 17.3: OmniRoute must populate call_logs.added_wait_ms/_cause for
// every hold it imposes before dispatch (admission queue, connection-concurrency
// gate, rate limit, lane max-queue-wait) so that added_wait_ms + upstream
// duration reconstructs the end-to-end latency. accumulateAddedWait composes
// multiple holds onto the proxy capture sink. Fakes only — no fetch, no DB.

const proxyFetch = await import("../../open-sse/utils/proxyFetch.ts");

test("1. single gate hold: accumulateAddedWait records ms + cause", () => {
  const sink: { proxy: unknown } = { proxy: null };
  proxyFetch.runWithAppliedProxyCapture(sink as never, () => {
    proxyFetch.accumulateAddedWait(1200, "connection-concurrency");
    const w = proxyFetch.readAddedWait();
    assert.ok(w);
    assert.equal(w.ms, 1200);
    assert.equal(w.cause, "connection-concurrency");
  });
});

test("2. multiple holds compose: ms sums and causes join in stable order", () => {
  const sink: { proxy: unknown } = { proxy: null };
  proxyFetch.runWithAppliedProxyCapture(sink as never, () => {
    // Holds happen in dispatch order: concurrency gate, then rate limit.
    proxyFetch.accumulateAddedWait(800, "connection-concurrency");
    proxyFetch.accumulateAddedWait(300, "rate-limit");
    const w = proxyFetch.readAddedWait();
    assert.ok(w);
    assert.equal(w.ms, 1100);
    // Stable order: admission-queue, lane-max-queue-wait, connection-concurrency, rate-limit.
    assert.equal(w.cause, "connection-concurrency+rate-limit");
  });
});

test("3. admission seed composes with in-dispatch gates", () => {
  // The admission/lane wait is seeded onto the sink BEFORE the ALS capture (the
  // admission queue runs ahead of the capture scope); gate waits accumulate on top.
  const sink: { proxy: unknown; addedWaitMs?: number | null; addedWaitCause?: string | null } = {
    proxy: null,
    addedWaitMs: 500,
    addedWaitCause: "admission-queue",
  };
  proxyFetch.runWithAppliedProxyCapture(sink as never, () => {
    proxyFetch.accumulateAddedWait(250, "rate-limit");
    const w = proxyFetch.readAddedWait();
    assert.ok(w);
    assert.equal(w.ms, 750);
    assert.equal(w.cause, "admission-queue+rate-limit");
  });
});

test("4. duplicate cause does not double-list but still sums ms", () => {
  const sink: { proxy: unknown } = { proxy: null };
  proxyFetch.runWithAppliedProxyCapture(sink as never, () => {
    proxyFetch.accumulateAddedWait(100, "rate-limit");
    proxyFetch.accumulateAddedWait(50, "rate-limit");
    const w = proxyFetch.readAddedWait();
    assert.ok(w);
    assert.equal(w.ms, 150);
    assert.equal(w.cause, "rate-limit");
  });
});

test("5. lane-max-queue-wait orders before connection-concurrency", () => {
  const sink: { proxy: unknown } = { proxy: null };
  proxyFetch.runWithAppliedProxyCapture(sink as never, () => {
    // Record out of canonical order; serialization is deterministic.
    proxyFetch.accumulateAddedWait(10, "connection-concurrency");
    proxyFetch.accumulateAddedWait(20, "lane-max-queue-wait");
    const w = proxyFetch.readAddedWait();
    assert.ok(w);
    assert.equal(w.ms, 30);
    assert.equal(w.cause, "lane-max-queue-wait+connection-concurrency");
  });
});

test("6. non-positive / non-finite deltas are ignored (no wait, no cause)", () => {
  const sink: { proxy: unknown } = { proxy: null };
  proxyFetch.runWithAppliedProxyCapture(sink as never, () => {
    proxyFetch.accumulateAddedWait(0, "rate-limit");
    proxyFetch.accumulateAddedWait(-5, "connection-concurrency");
    proxyFetch.accumulateAddedWait(Number.NaN, "admission-queue");
    assert.equal(proxyFetch.readAddedWait(), null);
  });
});

test("7. accumulateAddedWait outside a capture is a no-op and never throws", () => {
  proxyFetch.accumulateAddedWait(1000, "rate-limit");
  assert.equal(proxyFetch.readAddedWait(), null);
});
