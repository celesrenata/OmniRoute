/**
 * Unit tests for the fleet-telemetry normalization layer (OR-ATOM-005 / Step 5):
 * `normalizeSample` / `counterRate` (normalizeSample.ts) and
 * `createCounterRateEngine` / `isAcceptableSampleTime` (metricMapping.ts).
 *
 * Deterministic + hermetic: fixed epoch clock, no network, no DB.
 *
 * Data semantics under test (task table):
 *   - a PRESENT zero is a real measurement (kept, with provenance);
 *   - a MISSING / non-finite sample is `null` (unknown) — never a fabricated zero;
 *   - monotonic counters become a windowed rate (delta / seconds);
 *   - counter reset / first read / zero-elapsed → unknown (null), never negative;
 *   - samples older than the freshness window are marked `stale`;
 *   - units are validated (percent [0,100], non-negative counts/bytes/watts/tps,
 *     celsius > -273);
 *   - sample times are validated (finite, not in the future).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  counterRate,
  normalizeSample,
  type CounterRateInput,
  type NormalizeSampleInput,
} from "../../../src/shared/topology/telemetry/providers/normalizeSample";
import {
  createCounterRateEngine,
  isAcceptableSampleTime,
} from "../../../src/shared/topology/telemetry/providers/metricMapping";
import { fixtureNow, resetFixtureClock } from "./telemetry-fixtures";

resetFixtureClock(1_700_000_000_000);

const FRESH = 30_000;

function sampleInput(over: Partial<NormalizeSampleInput> = {}): NormalizeSampleInput {
  const now = fixtureNow();
  return {
    value: 42,
    source: "prometheus",
    sampledAt: now,
    capturedAt: now,
    basis: "DCGM_FI_DEV_GPU_UTIL",
    freshnessMs: FRESH,
    ...over,
  };
}

function rateInput(over: Partial<CounterRateInput> = {}): CounterRateInput {
  const now = fixtureNow();
  return {
    value: 1000,
    previous: 900,
    deltaSeconds: 10,
    sampledAt: now,
    capturedAt: now,
    source: "derived",
    basis: "counter:test",
    freshnessMs: FRESH,
    ...over,
  };
}

describe("normalizeSample: value semantics", () => {
  it("keeps a valid numeric sample with full provenance", () => {
    const o = normalizeSample(sampleInput());
    assert.equal(o.value, 42);
    assert.equal(o.source, "prometheus");
    assert.equal(o.sampledAt, fixtureNow());
    assert.equal(o.basis, "DCGM_FI_DEV_GPU_UTIL");
    assert.equal(o.stale, undefined);
  });

  it("keeps a PRESENT zero as a real measurement (zero ≠ missing)", () => {
    const o = normalizeSample(sampleInput({ value: 0, unit: "nonNegative" }));
    assert.equal(o.value, 0);
    assert.equal(o.stale, undefined);
  });

  it("maps a missing value (null/undefined) to unknown (null)", () => {
    assert.equal(normalizeSample(sampleInput({ value: null })).value, null);
    assert.equal(normalizeSample(sampleInput({ value: undefined })).value, null);
  });

  it("maps non-finite values (NaN/Infinity) to unknown, not a number", () => {
    assert.equal(normalizeSample(sampleInput({ value: Number.NaN })).value, null);
    assert.equal(normalizeSample(sampleInput({ value: Number.POSITIVE_INFINITY })).value, null);
    assert.equal(normalizeSample(sampleInput({ value: Number.NEGATIVE_INFINITY })).value, null);
  });

  it("rejects non-number sample values (e.g. unparsed strings)", () => {
    assert.equal(normalizeSample(sampleInput({ value: "42" as unknown as number })).value, null);
  });
});

describe("normalizeSample: provenance + window", () => {
  it("substitutes capturedAt when sampledAt is non-finite", () => {
    const o = normalizeSample(sampleInput({ value: 7, sampledAt: Number.NaN }));
    assert.equal(o.sampledAt, fixtureNow());
    assert.equal(o.value, 7);
  });

  it("adds windowMs only when finite and > 0", () => {
    assert.equal(normalizeSample(sampleInput({ windowMs: 1000 })).windowMs, 1000);
    assert.equal(normalizeSample(sampleInput({ windowMs: 0 })).windowMs, undefined);
    assert.equal(normalizeSample(sampleInput({ windowMs: Number.NaN })).windowMs, undefined);
    assert.equal(normalizeSample(sampleInput()).windowMs, undefined);
  });
});

describe("normalizeSample: unit guards", () => {
  it("percent: keeps [0,100], rejects out-of-range as unknown", () => {
    assert.equal(normalizeSample(sampleInput({ value: 0, unit: "percent" })).value, 0);
    assert.equal(normalizeSample(sampleInput({ value: 100, unit: "percent" })).value, 100);
    assert.equal(normalizeSample(sampleInput({ value: 100.0001, unit: "percent" })).value, null);
    assert.equal(normalizeSample(sampleInput({ value: -0.0001, unit: "percent" })).value, null);
  });

  it("nonNegative / bytes / watts / tps: reject negative as unknown", () => {
    for (const unit of ["nonNegative", "bytes", "watts", "tps"] as const) {
      assert.equal(normalizeSample(sampleInput({ value: -1, unit })).value, null);
      assert.equal(normalizeSample(sampleInput({ value: 0, unit })).value, 0);
    }
  });

  it("celsius: rejects absolute zero (≤ -273), keeps just above it", () => {
    assert.equal(normalizeSample(sampleInput({ value: -273, unit: "celsius" })).value, null);
    assert.equal(normalizeSample(sampleInput({ value: -272.9, unit: "celsius" })).value, -272.9);
  });

  it("an out-of-unit sample is unknown even when fresh", () => {
    const o = normalizeSample(sampleInput({ value: 500, unit: "percent" }));
    assert.equal(o.value, null);
    assert.equal(o.stale, undefined);
  });
});

describe("normalizeSample: staleness", () => {
  it("marks a sample older than the freshness window stale (value kept)", () => {
    const o = normalizeSample(sampleInput({ sampledAt: fixtureNow() - (FRESH + 1) }));
    assert.equal(o.value, 42);
    assert.equal(o.stale, true);
  });

  it("does not mark a sample exactly at the freshness boundary stale", () => {
    const o = normalizeSample(sampleInput({ sampledAt: fixtureNow() - FRESH }));
    assert.equal(o.stale, undefined);
  });

  it("marks a MISSING ancient sample stale too (we saw nothing recent)", () => {
    const o = normalizeSample(sampleInput({ value: null, sampledAt: fixtureNow() - (FRESH + 1) }));
    assert.equal(o.value, null);
    assert.equal(o.stale, true);
  });

  it("marks an out-of-unit ancient sample stale", () => {
    const o = normalizeSample(
      sampleInput({ value: -5, unit: "bytes", sampledAt: fixtureNow() - (FRESH + 1) })
    );
    assert.equal(o.value, null);
    assert.equal(o.stale, true);
  });

  it("substitutes capturedAt for a non-finite sampledAt (not stale — provenance is the capture time)", () => {
    const o = normalizeSample(sampleInput({ sampledAt: Number.NaN }));
    assert.equal(o.sampledAt, fixtureNow());
    assert.equal(o.stale, undefined);
  });

  it("marks a sample stale when the capturedAt itself is non-finite", () => {
    const o = normalizeSample(sampleInput({ capturedAt: Number.NaN }));
    assert.equal(o.stale, true);
  });
});

describe("counterRate: windowed rate semantics", () => {
  it("computes delta / seconds for a monotonic counter", () => {
    const o = counterRate(rateInput());
    assert.equal(o.value, 10); // (1000 - 900) / 10s
    assert.equal(o.source, "derived");
    assert.equal(o.stale, undefined);
  });

  it("a zero delta is a real 0 rate (not unknown)", () => {
    const o = counterRate(rateInput({ value: 900 }));
    assert.equal(o.value, 0);
  });

  it("a counter reset (value < previous) is unknown, never negative", () => {
    const o = counterRate(rateInput({ value: 899, previous: 900 }));
    assert.equal(o.value, null);
    assert.notEqual(o.value, -0.1);
  });

  it("no prior reading → unknown (never a fabricated rate)", () => {
    assert.equal(counterRate(rateInput({ previous: undefined })).value, null);
    assert.equal(counterRate(rateInput({ previous: Number.NaN })).value, null);
  });

  it("zero or negative elapsed window → unknown", () => {
    assert.equal(counterRate(rateInput({ deltaSeconds: 0 })).value, null);
    assert.equal(counterRate(rateInput({ deltaSeconds: -1 })).value, null);
    assert.equal(counterRate(rateInput({ deltaSeconds: Number.NaN })).value, null);
  });

  it("non-finite current value → unknown", () => {
    assert.equal(counterRate(rateInput({ value: Number.NaN })).value, null);
  });

  it("substitutes capturedAt when sampledAt is non-finite", () => {
    const o = counterRate(rateInput({ sampledAt: Number.NaN }));
    assert.equal(o.sampledAt, fixtureNow());
    assert.equal(o.value, 10);
  });

  it("marks a stale sample stale, even when the rate is computable", () => {
    const o = counterRate(rateInput({ sampledAt: fixtureNow() - (FRESH + 1) }));
    assert.equal(o.value, 10);
    assert.equal(o.stale, true);
  });

  it("marks an unknown stale (first read of an ancient sample)", () => {
    const o = counterRate(
      rateInput({ previous: undefined, sampledAt: fixtureNow() - (FRESH + 1) })
    );
    assert.equal(o.value, null);
    assert.equal(o.stale, true);
  });

  it("adds windowMs only when finite and > 0", () => {
    assert.equal(counterRate(rateInput({ windowMs: 1200 })).windowMs, 1200);
    assert.equal(counterRate(rateInput({ windowMs: 0 })).windowMs, undefined);
  });
});

describe("createCounterRateEngine: cross-snapshot counter state", () => {
  it("first-ever reading yields no prior (null)", () => {
    const engine = createCounterRateEngine();
    assert.equal(engine.readRate("k", 0, 1_000), null);
  });

  it("second reading returns the prior (value + timestamps) for a real rate", () => {
    const engine = createCounterRateEngine();
    engine.readRate("k", 100, 1_000);
    const reading = engine.readRate("k", 400, 31_000);
    assert.ok(reading);
    assert.equal(reading.previousValue, 100);
    assert.equal(reading.previousAtMs, 1_000);
    assert.equal(reading.currentAtMs, 31_000);
  });

  it("state advances on every read (chain of priors)", () => {
    const engine = createCounterRateEngine();
    engine.readRate("k", 100, 1_000);
    const r2 = engine.readRate("k", 400, 31_000);
    assert.equal(r2?.previousValue, 100);
    const r3 = engine.readRate("k", 400, 61_000); // equal value is NOT a reset
    assert.equal(r3?.previousValue, 400);
    assert.equal(r3?.previousAtMs, 31_000);
  });

  it("a counter reset returns null but re-baselines state for the next read", () => {
    const engine = createCounterRateEngine();
    engine.readRate("k", 500, 1_000);
    assert.equal(engine.readRate("k", 100, 31_000), null); // reset
    const after = engine.readRate("k", 200, 61_000);
    assert.equal(after?.previousValue, 100); // the (lower) reset value is the new baseline
  });

  it("a zero span (same timestamp) yields no rate", () => {
    const engine = createCounterRateEngine();
    engine.readRate("k", 100, 5_000);
    assert.equal(engine.readRate("k", 200, 5_000), null);
  });

  it("a span older than maxSpanMs yields no rate (default cap: 10 min)", () => {
    const engine = createCounterRateEngine();
    engine.readRate("k", 100, 0);
    assert.equal(engine.readRate("k", 200, 10 * 60 * 1000 + 1), null);
  });

  it("a span exactly at the custom maxSpanMs is still usable (inclusive)", () => {
    const engine = createCounterRateEngine({ maxSpanMs: 60_000 });
    engine.readRate("k", 100, 0);
    assert.ok(engine.readRate("k", 200, 60_000));
  });

  it("non-finite value drops state entirely", () => {
    const engine = createCounterRateEngine();
    engine.readRate("k", 100, 0);
    assert.equal(engine.readRate("k", Number.NaN, 1_000), null);
    // state deleted → next read is a first-ever read
    assert.equal(engine.readRate("k", 200, 2_000), null);
  });

  it("uses the injectable clock when sampledAt is non-finite", () => {
    let now = 5_000;
    const engine = createCounterRateEngine({ now: () => now });
    engine.readRate("k", 100, Number.NaN); // at := 5000
    now = 6_000;
    const reading = engine.readRate("k", 200, Number.NaN); // at := 6000
    assert.equal(reading?.previousAtMs, 5_000);
    assert.equal(reading?.currentAtMs, 6_000);
  });

  it("isolates state per key", () => {
    const engine = createCounterRateEngine();
    engine.readRate("a", 100, 0);
    assert.equal(engine.readRate("b", 200, 1_000), null);
  });

  it("reset() clears all state", () => {
    const engine = createCounterRateEngine();
    engine.readRate("k", 100, 0);
    engine.reset();
    assert.equal(engine.readRate("k", 200, 1_000), null);
  });
});

describe("isAcceptableSampleTime: future-sample rejection", () => {
  const capturedAt = 1_700_000_000_000;

  it("accepts a sample exactly at capture time", () => {
    assert.equal(isAcceptableSampleTime(capturedAt, capturedAt), true);
  });

  it("accepts up to a 1ms clock-skew tolerance", () => {
    assert.equal(isAcceptableSampleTime(capturedAt + 1, capturedAt), true);
  });

  it("rejects future-dated samples", () => {
    assert.equal(isAcceptableSampleTime(capturedAt + 2, capturedAt), false);
    assert.equal(isAcceptableSampleTime(capturedAt + 60_000, capturedAt), false);
  });

  it("accepts past samples of any age (staleness is a separate rule)", () => {
    assert.equal(isAcceptableSampleTime(capturedAt - 10_000_000, capturedAt), true);
  });

  it("rejects non-finite inputs", () => {
    assert.equal(isAcceptableSampleTime(Number.NaN, capturedAt), false);
    assert.equal(isAcceptableSampleTime(capturedAt, Number.POSITIVE_INFINITY), false);
  });
});
