/**
 * M4 (OR-ATOM-001 v2) — `useLiveRequests` lifecycle stream integration.
 *
 * Pins the integration contract of the bounded live-request lifecycle stream
 * over the single visibility-gated live-requests WebSocket:
 * - the gate (`enabled`) opens at most ONE socket; a disabled panel opens none;
 * - started/completed/failed produce rows, streaming ticks do not;
 * - rows keep the source event timestamp as `observedAt` (provenance);
 * - duplicate replays (backlog + live) collapse to one row;
 * - out-of-order delivery is sorted into ascending `observedAt`;
 * - the pool is bounded (newest kept, oldest evicted) and no-op events
 *   (duplicates / stale) return the same array reference so consumers do not
 *   re-render on redundant frames.
 *
 * The WebSocket is a fake (no real browser/network); the hook is exercised
 * through `renderHook` so the real state transitions run.
 */
import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useLiveRequests } from "@/hooks/useLiveDashboard";

class FakeLiveSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeLiveSocket[] = [];
  static lastUrl: string | null = null;
  static reset() {
    FakeLiveSocket.instances = [];
    FakeLiveSocket.lastUrl = null;
  }

  readyState: number;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.readyState = FakeLiveSocket.CONNECTING;
    FakeLiveSocket.instances.push(this);
    FakeLiveSocket.lastUrl = url;
  }

  open() {
    if (this.readyState !== FakeLiveSocket.CONNECTING) return;
    this.readyState = FakeLiveSocket.OPEN;
    this.onopen?.();
  }

  /** Deliver a frame as the browser would (string payload, JSON inside). */
  receive(message: unknown) {
    if (this.readyState !== FakeLiveSocket.OPEN) return;
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** The "welcome" frame: accepted session + backlog replay of prior events. */
  welcome(backlog: unknown[] = []) {
    this.open();
    this.receive({ type: "welcome", data: backlog });
  }

  send(raw: string) {
    if (this.readyState !== FakeLiveSocket.OPEN) return;
    this.sent.push(raw);
    const parsed = JSON.parse(raw);
    if (parsed.type === "subscribe") {
      this.receive({ type: "welcome", data: [] });
    }
  }

  close() {
    if (this.readyState === FakeLiveSocket.CLOSING || this.readyState === FakeLiveSocket.CLOSED)
      return;
    this.readyState = FakeLiveSocket.CLOSED;
    this.onclose?.();
  }
}

vi.stubGlobal("WebSocket", FakeLiveSocket);

function event(
  name: string,
  data: Record<string, unknown>,
  timestamp: number,
  channel = "requests"
) {
  return { type: "event", event: name, channel, data, timestamp };
}

function renderRequests() {
  FakeLiveSocket.reset();
  const { result } = renderHook(() =>
    useLiveRequests({ wsUrl: "ws://fake.test/live-ws", autoReconnect: false })
  );
  const socket = FakeLiveSocket.instances[0];
  act(() => socket?.welcome());
  return { result, socket };
}

describe("useLiveRequests — single gated socket", () => {
  it("disabled panel opens no socket at all", () => {
    FakeLiveSocket.reset();
    const { unmount } = renderHook(() =>
      useLiveRequests({ wsUrl: "ws://fake.test/live-ws", enabled: false, autoReconnect: false })
    );
    expect(FakeLiveSocket.instances).toHaveLength(0);
    unmount();
  });

  it("enabled panel opens exactly ONE socket and subscribes to the requests channel", () => {
    const { result, socket } = renderRequests();
    expect(FakeLiveSocket.instances).toHaveLength(1);
    expect(socket).toBe(FakeLiveSocket.instances[0]);
    expect(FakeLiveSocket.lastUrl).toBe("ws://fake.test/live-ws");
    const sub = JSON.parse(socket!.sent[0]);
    expect(sub).toMatchObject({ type: "subscribe", channels: ["requests"] });
    expect(result.current.isConnected).toBe(true);
    expect(result.current.lifecycleEvents).toEqual([]);
  });
});

describe("useLiveRequests — lifecycle stream on the same socket", () => {
  it("records started/completed/failed with provenance timestamps; streaming ticks are ignored", () => {
    const { result, socket } = renderRequests();
    const s = socket!;
    act(() => {
      s.receive(
        event("request.started", { id: "req-1", provider: "openai", model: "gpt-4o" }, 1000)
      );
      s.receive(
        event("request.streaming", { id: "req-1", provider: "openai", model: "gpt-4o" }, 1100)
      );
      s.receive(
        event(
          "request.completed",
          { id: "req-1", provider: "openai", model: "gpt-4o", status: "success" },
          1200
        )
      );
      s.receive(
        event(
          "request.started",
          { id: "req-2", provider: "anthropic", model: "claude-sonnet-4" },
          1500
        )
      );
      s.receive(
        event(
          "request.failed",
          { id: "req-2", provider: "anthropic", model: "claude-sonnet-4", error: "503 upstream" },
          1600
        )
      );
    });
    expect(result.current.lifecycleEvents).toEqual([
      {
        phase: "started",
        requestId: "req-1",
        provider: "openai",
        model: "gpt-4o",
        observedAt: 1000,
      },
      {
        phase: "completed",
        requestId: "req-1",
        provider: "openai",
        model: "gpt-4o",
        outcome: "success",
        observedAt: 1200,
      },
      {
        phase: "started",
        requestId: "req-2",
        provider: "anthropic",
        model: "claude-sonnet-4",
        observedAt: 1500,
      },
      {
        phase: "failed",
        requestId: "req-2",
        provider: "anthropic",
        model: "claude-sonnet-4",
        outcome: "error",
        error: "503 upstream",
        observedAt: 1600,
      },
    ]);
    // Exactly one socket even across four distinct transitions.
    expect(FakeLiveSocket.instances).toHaveLength(1);
  });

  it("out-of-order delivery is sorted ascending by observedAt", () => {
    const { result, socket } = renderRequests();
    const s = socket!;
    act(() => {
      s.receive(event("request.started", { id: "c", provider: "p", model: "m" }, 3000));
      s.receive(event("request.started", { id: "a", provider: "p", model: "m" }, 1000));
      s.receive(event("request.started", { id: "b", provider: "p", model: "m" }, 2000));
    });
    expect(result.current.lifecycleEvents.map((e) => e.requestId)).toEqual(["a", "b", "c"]);
  });

  it("duplicate replays (backlog + live) collapse to one row; no-op events keep the same array reference", () => {
    const { result, socket } = renderRequests();
    const s = socket!;
    act(() => {
      s.receive(event("request.started", { id: "r1", provider: "p", model: "m" }, 1000));
    });
    const first = result.current.lifecycleEvents;
    act(() => {
      // Re-delivered live after it already arrived in the backlog.
      s.receive(event("request.started", { id: "r1", provider: "p", model: "m" }, 1000));
    });
    expect(result.current.lifecycleEvents).toHaveLength(1);
    expect(result.current.lifecycleEvents).toBe(first); // no re-render on a no-op
  });

  it("the pool is bounded to the newest 256 rows (oldest evicted), then evicted rows are stale-dropped as no-ops", () => {
    const { result, socket } = renderRequests();
    const s = socket!;
    act(() => {
      for (let i = 1; i <= 256; i++) {
        s.receive(event("request.started", { id: `r${i}`, provider: "p", model: "m" }, i));
      }
    });
    expect(result.current.lifecycleEvents).toHaveLength(256);
    expect(result.current.lifecycleEvents[0].requestId).toBe("r1");
    expect(result.current.lifecycleEvents[255].requestId).toBe("r256");

    act(() => {
      s.receive(event("request.started", { id: "r257", provider: "p", model: "m" }, 257));
    });
    expect(result.current.lifecycleEvents).toHaveLength(256);
    expect(result.current.lifecycleEvents[0].requestId).toBe("r2"); // r1 evicted
    expect(result.current.lifecycleEvents[255].requestId).toBe("r257");

    // r1 is now outside the window: a late re-delivery is dropped, same reference.
    const before = result.current.lifecycleEvents;
    act(() => {
      s.receive(event("request.started", { id: "r1", provider: "p", model: "m" }, 1));
    });
    expect(result.current.lifecycleEvents).toBe(before);
    expect(result.current.lifecycleEvents[0].requestId).toBe("r2");
  });

  it("welcome backlog and live frames both reduce into the same pool", () => {
    FakeLiveSocket.reset();
    const backlog = [
      {
        type: "event",
        event: "request.started",
        channel: "requests",
        data: { id: "bk", provider: "p", model: "m" },
        timestamp: 500,
      },
    ];
    const { result } = renderHook(() =>
      useLiveRequests({ wsUrl: "ws://fake.test/live-ws", autoReconnect: false })
    );
    const s = FakeLiveSocket.instances[0];
    act(() => s.welcome(backlog));
    const afterBacklog = result.current.lifecycleEvents;
    act(() => {
      s.receive(event("request.started", { id: "live", provider: "p", model: "m" }, 600));
    });
    expect(result.current.lifecycleEvents).toEqual([
      afterBacklog[0],
      { phase: "started", requestId: "live", provider: "p", model: "m", observedAt: 600 },
    ]);
    expect(FakeLiveSocket.instances).toHaveLength(1);
  });
});
