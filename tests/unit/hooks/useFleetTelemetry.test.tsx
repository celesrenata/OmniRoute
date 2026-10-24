// @vitest-environment jsdom
import { renderHook, act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useFleetTelemetry } from "../../../src/hooks/useFleetTelemetry";
import type { FleetTelemetrySnapshot } from "../../../src/shared/topology/telemetry/types";

/**
 * useFleetTelemetry — browser consumer for GET /api/telemetry/fleet.
 *
 * Behavioral coverage:
 *   - happy path: fetch → decoded snapshot → status "ready", snapshot exposed
 *   - shape guard: a body that does NOT decode to a v1 snapshot → "error"
 *   - auth terminal: 401/403 → "auth-error"
 *   - transient error: 5xx → "error", previous snapshot preserved
 *   - network failure → stable sanitized "error", no upstream leak (hard rule #12)
 *   - disabled: no fetch is issued
 *   - query mapping: windowMs + providers/hosts/gpus appear on the URL
 */

function makeSnapshot(overrides: Partial<FleetTelemetrySnapshot> = {}): FleetTelemetrySnapshot {
  return {
    schemaVersion: 1,
    capturedAt: Date.now(),
    resources: [],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function render(options: Parameters<typeof useFleetTelemetry>[0]) {
  const spy = vi.spyOn(globalThis, "fetch");
  spy.mockResolvedValue(jsonResponse(makeSnapshot()));
  const { result, unmount } = renderHook(() => useFleetTelemetry(options));
  return {
    get: () => result.current,
    calls: () => spy.mock.calls,
    unmount,
  };
}

describe("useFleetTelemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches on mount, decodes a v1 snapshot, and reaches 'ready'", async () => {
    const r = render({ pollIntervalMs: 10_000 });

    await waitFor(() => expect(r.get().status).toBe("ready"));

    const s = r.get();
    expect(s.snapshot).not.toBeNull();
    expect(s.snapshot!.schemaVersion).toBe(1);
    expect(s.snapshot!.resources).toEqual([]);
    expect(s.error).toBeNull();
    expect(s.lastReceivedAt).toBeTypeOf("number");
    expect(r.calls().length).toBe(1);
    const [url, init] = r.calls()[0] as [string, RequestInit];
    expect(url).toContain("/api/telemetry/fleet");
    expect(init.credentials).toBe("same-origin");
    r.unmount();
  });

  it("rejects a body that does not decode to a v1 snapshot (shape guard)", async () => {
    const r = render({ pollIntervalMs: 10_000 });
    // Settle the initial (good) fetch so the in-flight guard is clear.
    await waitFor(() => expect(r.get().status).toBe("ready"));

    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ schemaVersion: 999, capturedAt: 1, resources: [] })
    );

    await act(async () => {
      await r.get().refetch();
    });

    expect(r.get().status).toBe("error");
    // A bad body must NOT clobber the last good snapshot (same resilience as the
    // 5xx/network paths) — the previously accepted snapshot is preserved.
    expect(r.get().snapshot).not.toBeNull();
    expect(r.get().snapshot!.schemaVersion).toBe(1);
    expect(r.get().error).toMatch(/snapshot shape/);
    r.unmount();
  });

  it("treats 401 as terminal 'auth-error'", async () => {
    const r = render({ pollIntervalMs: 10_000 });
    await waitFor(() => expect(r.get().status).toBe("ready"));

    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: { message: "x" } }, 401));

    await act(async () => {
      await r.get().refetch();
    });

    expect(r.get().status).toBe("auth-error");
    expect(r.get().error).toMatch(/Not authenticated/);
    r.unmount();
  });

  it("treats 403 as terminal 'auth-error' (missing scope)", async () => {
    const r = render({ pollIntervalMs: 10_000 });
    await waitFor(() => expect(r.get().status).toBe("ready"));

    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: { message: "x" } }, 403));

    await act(async () => {
      await r.get().refetch();
    });

    expect(r.get().status).toBe("auth-error");
    expect(r.get().error).toMatch(/management scope/);
    r.unmount();
  });

  it("treats 5xx as transient 'error' and preserves the previous snapshot", async () => {
    const r = render({ pollIntervalMs: 10_000 });
    // Let the initial good fetch settle so a snapshot is in place.
    await waitFor(() => expect(r.get().status).toBe("ready"));

    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: { message: "x" } }, 503));
    await act(async () => {
      await r.get().refetch();
    });

    expect(r.get().status).toBe("error");
    expect(r.get().error).toMatch(/HTTP 503/);
    expect(r.get().snapshot).not.toBeNull(); // previous snapshot preserved
    r.unmount();
  });

  it("surfaces a stable network error and does not leak the raw error", async () => {
    const r = render({ pollIntervalMs: 10_000 });
    await waitFor(() => expect(r.get().status).toBe("ready"));

    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy.mockReset();
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed: ECONNREFUSED"));

    await act(async () => {
      await r.get().refetch();
    });

    expect(r.get().status).toBe("error");
    expect(r.get().error).toMatch(/network/);
    // Hard rule #12: no upstream detail / stack in the exposed message.
    expect(r.get().error).not.toContain("ECONNREFUSED");
    expect(r.get().error).not.toContain("at ");
    r.unmount();
  });

  it("does not fetch when disabled", async () => {
    const r = render({ enabled: false, pollIntervalMs: 10_000 });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(r.calls().length).toBe(0);
    expect(r.get().status).toBe("idle");
    r.unmount();
  });

  it("maps windowMs + provider/host/gpu ids onto the query string", async () => {
    const r = render({
      pollIntervalMs: 10_000,
      windowMs: 60_000,
      providerIds: ["openai", "anthropic"],
      hostIds: ["host-1"],
      gpuIds: ["gpu-0"],
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const [url] = r.calls()[0] as [string, RequestInit];
    const parsed = new URL(url, "http://localhost");
    expect(parsed.searchParams.get("windowMs")).toBe("60000");
    expect(parsed.searchParams.get("providers")).toBe("openai,anthropic");
    expect(parsed.searchParams.get("hosts")).toBe("host-1");
    expect(parsed.searchParams.get("gpus")).toBe("gpu-0");
    r.unmount();
  });

  it("omits windowMs (gateway default) when no window is supplied", async () => {
    const r = render({ pollIntervalMs: 10_000 });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const [url] = r.calls()[0] as [string, RequestInit];
    const parsed = new URL(url, "http://localhost");
    expect(parsed.searchParams.get("windowMs")).toBeNull();
    r.unmount();
  });
});
