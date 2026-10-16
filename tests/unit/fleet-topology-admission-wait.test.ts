/**
 * Requirement 17.3: the chat admission queue (and per-tenant virtual lane) HOLD
 * a request before dispatch. createChatAdmissionContext.getAdmissionWait() must
 * expose that wall-clock wait so the chat handler can seed it onto the call-log
 * added_wait sink. No provider/network work — pure runtime + context seams.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createChatAdmissionContext } from "../../src/sse/handlers/chatAdmission.ts";
import {
  createAdaptiveAdmissionRuntime,
  type AdaptiveAdmissionRuntime,
} from "../../open-sse/services/admission/runtime.ts";
import type { AdaptiveAdmissionConfig } from "../../open-sse/services/admission/types.ts";

function enforceConfig(overrides: Partial<AdaptiveAdmissionConfig> = {}): AdaptiveAdmissionConfig {
  return {
    mode: "enforce",
    minLimit: 1,
    maxLimit: 4,
    initialLimit: 1,
    maxQueueCount: 4,
    maxQueueCost: 16,
    defaultMaxWaitMs: 5_000,
    windowMs: 50,
    ...overrides,
  };
}

function makeRuntime(config: AdaptiveAdmissionConfig = enforceConfig()): AdaptiveAdmissionRuntime {
  // Real clock: getAdmissionWait measures wall-clock Date.now() elapsed inside acquire.
  return createAdaptiveAdmissionRuntime({
    config,
    checkResourcePressure: () => null,
    getResourcePressureObservation: () => ({
      signals: null,
      state: {
        severity: "normal",
        reason: "none",
        elevatedStreak: 0,
        recoveryStreak: 0,
        lastTransitionAtMs: 0,
        observedAtMs: 0,
      },
    }),
  });
}

describe("chat admission wait observation (Req 17.3)", () => {
  let runtime: AdaptiveAdmissionRuntime;

  beforeEach(() => {
    runtime = makeRuntime(
      enforceConfig({ initialLimit: 64, minLimit: 8, maxLimit: 100, maxQueueCost: 200 })
    );
  });

  afterEach(() => {
    runtime.dispose();
  });

  it("immediate admit records at most negligible admission wait", async () => {
    const ctx = createChatAdmissionContext(() => runtime);
    const rejection = await ctx.acquire(
      "tenant-fast",
      { signal: undefined },
      { messages: [{ role: "user", content: "hi" }], stream: false }
    );
    assert.equal(rejection, null);
    // An immediate admit imposes no queue hold. The acquire is measured on the
    // real clock, so sub-millisecond scheduling can round to 1ms; the contract
    // is only that an un-queued request records no meaningful wait.
    const wait = ctx.getAdmissionWait();
    if (wait !== null) {
      assert.ok(
        wait.ms <= 2,
        `immediate admit must not record a meaningful wait, got ${wait.ms}ms`
      );
    }
    ctx.getAdmittedState()!.admitted.lease.release("success");
  });

  it("getAdmissionWait is null before acquire runs", () => {
    const ctx = createChatAdmissionContext(() => runtime);
    assert.equal(ctx.getAdmissionWait(), null);
  });

  it("a queued request records a positive admission-queue wait when lanes are off", async () => {
    // Capacity = 1: hold it, queue a second request, release the hold after a
    // real delay. The queued request's acquire resolves only after that delay,
    // so its measured admission wait is > 0 and the cause is the shared queue.
    const tiny = makeRuntime(
      enforceConfig({
        initialLimit: 1,
        minLimit: 1,
        maxLimit: 1,
        maxQueueCount: 2,
        maxQueueCost: 8,
        defaultMaxWaitMs: 5_000,
        cost: { maxRequestCost: 1, baseCost: 1 },
      })
    );
    try {
      assert.equal(tiny.snapshot().virtualLanes, false, "virtual lanes default off");

      const holdCtx = createChatAdmissionContext(() => tiny);
      assert.equal(
        await holdCtx.acquire("hold", {}, { messages: [{ role: "user", content: "x" }] }),
        null
      );

      const waitCtx = createChatAdmissionContext(() => tiny);
      const waiterPromise = waitCtx.acquire(
        "waiter",
        {},
        { messages: [{ role: "user", content: "y" }] }
      );

      // Release the held lease a little later so the waiter actually parks.
      await new Promise((resolve) => setTimeout(resolve, 15));
      holdCtx.getAdmittedState()!.admitted.lease.release("success");

      const rejection = await waiterPromise;
      assert.equal(rejection, null, "waiter is admitted after capacity frees");

      const wait = waitCtx.getAdmissionWait();
      assert.ok(wait, "a parked request must record an admission wait");
      assert.ok(wait.ms > 0, "measured admission wait is positive");
      assert.equal(wait.cause, "admission-queue");

      waitCtx.getAdmittedState()!.admitted.lease.release("success");
    } finally {
      tiny.dispose();
    }
  });

  it("records lane-max-queue-wait when virtual lanes are enabled", async () => {
    const laned = makeRuntime(
      enforceConfig({
        initialLimit: 1,
        minLimit: 1,
        maxLimit: 1,
        maxQueueCount: 2,
        maxQueueCost: 8,
        defaultMaxWaitMs: 5_000,
        virtualLanes: true,
        cost: { maxRequestCost: 1, baseCost: 1 },
      })
    );
    try {
      assert.equal(laned.snapshot().virtualLanes, true);

      const holdCtx = createChatAdmissionContext(() => laned);
      assert.equal(
        await holdCtx.acquire("tenant-A", {}, { messages: [{ role: "user", content: "x" }] }),
        null
      );

      const waitCtx = createChatAdmissionContext(() => laned);
      const waiterPromise = waitCtx.acquire(
        "tenant-A",
        {},
        { messages: [{ role: "user", content: "y" }] }
      );

      await new Promise((resolve) => setTimeout(resolve, 15));
      holdCtx.getAdmittedState()!.admitted.lease.release("success");

      assert.equal(await waiterPromise, null);
      const wait = waitCtx.getAdmissionWait();
      assert.ok(wait, "a lane-parked request must record a wait");
      assert.ok(wait.ms > 0);
      assert.equal(wait.cause, "lane-max-queue-wait");

      waitCtx.getAdmittedState()!.admitted.lease.release("success");
    } finally {
      laned.dispose();
    }
  });
});
