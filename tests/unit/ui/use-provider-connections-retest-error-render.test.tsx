// Regression: the provider "Test" button (handleRetestConnection) must never
// pass the server's sanitized error ENVELOPE object ({ message, type, code })
// straight into notify.error(). Rendering that object as a React child throws
// "Minified React error #31" (Objects are not valid as a React child), which
// crashes the whole /dashboard/providers/<id> view instead of showing the
// error text. The handler must unwrap to a string via errorText(). Observed
// live on omniroute.celestium.life when the test endpoint returned an error
// body for a cooling/failed connection.
//
// NOTE ON LOCATION: lives under tests/unit/ui/ (collected by vitest.config.ts's
// `tests/unit/**/*.test.tsx`) because the `(dashboard)/**/__tests__` glob never
// actually matches — see use-provider-connections-cursor-refresh.test.tsx.
import React, { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "vllm" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/providers/vllm",
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const notify = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
};
vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: () => notify,
}));

const VLLM_CONNECTION = {
  id: "conn-vllm-1",
  provider: "vllm",
  name: "esnixi-5090",
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => "application/json" },
  } as Response;
}

function installFetchMock(testResponse: { status: number; body: unknown }) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    if ((url === "/api/providers" || url.startsWith("/api/providers?")) && method === "GET") {
      return jsonResponse(200, { connections: [VLLM_CONNECTION] });
    }
    if (url === "/api/provider-nodes" && method === "GET") {
      return jsonResponse(200, { nodes: [] });
    }
    if (/\/api\/providers\/[^/]+\/test$/.test(url) && method === "POST") {
      return jsonResponse(testResponse.status, testResponse.body);
    }
    return jsonResponse(200, {});
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const { useProviderConnections } =
  await import("@/app/(dashboard)/dashboard/providers/[id]/hooks/useProviderConnections");
type HookResult = ReturnType<typeof useProviderConnections>;

describe("useProviderConnections — handleRetestConnection error render (React #31 guard)", () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    notify.error.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function mountHook() {
    let result: HookResult | null = null;
    function TestWrapper() {
      const hookResult = useProviderConnections("vllm", false, false);
      useEffect(() => {
        result = hookResult;
      }, [hookResult]);
      return <span />;
    }
    await act(async () => {
      root.render(<TestWrapper />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return () => result as HookResult;
  }

  it("unwraps the sanitized error ENVELOPE object to its message string", async () => {
    installFetchMock({
      status: 500,
      body: { error: { message: "Test failed upstream", type: "server_error", code: "X1" } },
    });
    const getResult = await mountHook();

    await act(async () => {
      await getResult().handleRetestConnection(VLLM_CONNECTION.id);
    });

    expect(notify.error).toHaveBeenCalledTimes(1);
    const arg = notify.error.mock.calls[0][0];
    // The crux: must be a string, never the raw {message,type,code} object.
    expect(typeof arg).toBe("string");
    expect(arg).toBe("Test failed upstream");
  });

  it("still handles a plain string error body", async () => {
    installFetchMock({ status: 403, body: { error: "Invalid management token" } });
    const getResult = await mountHook();

    await act(async () => {
      await getResult().handleRetestConnection(VLLM_CONNECTION.id);
    });

    expect(notify.error).toHaveBeenCalledWith("Invalid management token");
  });

  it("falls back to the i18n key when the error body is empty/unparseable", async () => {
    installFetchMock({ status: 500, body: {} });
    const getResult = await mountHook();

    await act(async () => {
      await getResult().handleRetestConnection(VLLM_CONNECTION.id);
    });

    expect(notify.error).toHaveBeenCalledWith("failedRetestConnection");
  });
});
