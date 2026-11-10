/**
 * Fleet inventory: local endpoints are regrouped as one entry per node + GPU,
 * shared providers are split by served model / connection, pools light every
 * member, cloud providers are untouched, and activity is attributed honestly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  VENDOR_COLORS,
  deviceForBaseUrl,
  groupEntriesByDevice,
  memberClaims,
} from "../../../src/shared/topology/domain/fleetInventory";
import { normalizeTopology } from "../../../src/shared/topology/domain/normalizeTopology";
import { resolveAtomDescriptors } from "../../../src/plugins/atomic-topology";

const connections = [
  {
    id: "c-5090",
    provider: "vllm",
    isActive: true,
    providerSpecificData: { baseUrl: "http://192.168.133.3:2701/v1" },
  },
  {
    id: "c-4070",
    provider: "vllm",
    isActive: true,
    providerSpecificData: { baseUrl: "http://10.1.1.12:2701/v1" },
  },
  {
    id: "c-m5",
    provider: "llama-cpp",
    isActive: true,
    providerSpecificData: { baseUrl: "http://192.168.133.2:7777/v1" },
  },
  { id: "c-rr12", provider: "arcf-12", isActive: true },
  { id: "c-rr13", provider: "arcf-13", isActive: true },
  {
    id: "c-ollama",
    provider: "ollama-local",
    isActive: false,
    providerSpecificData: { baseUrl: "http://10.1.1.12:2701/v1" },
  },
  { id: "c-bedrock", provider: "bedrock", isActive: true },
];
const providerNodes = [
  { id: "arcf-12", prefix: "arcforge", baseUrl: "http://10.1.1.12:8101" },
  { id: "arcf-13", prefix: "arcforge", baseUrl: "http://10.1.1.13:8101" },
  { id: "emb-12", prefix: "arcforge", baseUrl: "http://10.1.1.12:8100/v1" },
  { id: "emb-13", prefix: "arcforge", baseUrl: "http://10.1.1.13:8100/v1" },
];
const entries = [
  { id: "vllm", provider: "vllm", status: "active" as const },
  { id: "llama-cpp", provider: "llama-cpp", status: "active" as const },
  { id: "arcf-12", provider: "arcf-12", status: "active" as const },
  { id: "arcf-13", provider: "arcf-13", status: "idle" as const },
  { id: "arcforge", provider: "arcforge", status: "idle" as const, aliases: ["emb-12"] },
  { id: "bedrock", provider: "bedrock", status: "active" as const },
];
const grouped = groupEntriesByDevice(entries, { connections, providerNodes });
const byId = new Map(grouped.map((e) => [e.provider, e]));

test("endpoints resolve to declared devices by host + port", () => {
  assert.equal(deviceForBaseUrl("http://192.168.133.3:2701/v1")?.id, "esnixi-rtx5090");
  assert.equal(deviceForBaseUrl("http://10.1.1.12:2701/v1")?.id, "gremlin-1-rtx4070tis");
  assert.equal(deviceForBaseUrl("http://10.1.1.12:8100/v1")?.id, "gremlin-1-arc");
  assert.equal(deviceForBaseUrl("http://10.1.1.15:8101")?.id, "gremlin-4-arc");
  assert.equal(deviceForBaseUrl("https://bedrock.example.com/v1"), null);
});

test("one entry per node + GPU, vendor coloured; cloud providers untouched", () => {
  assert.ok(byId.has("bedrock"), "cloud provider kept");
  assert.ok(!byId.has("vllm") && !byId.has("llama-cpp") && !byId.has("arcf-12"));
  const e5090 = byId.get("gpu-esnixi-rtx5090") as { name: string; device: { color: string } };
  const e4070 = byId.get("gpu-gremlin-1-rtx4070tis") as { name: string; device: { color: string } };
  const m5 = byId.get("gpu-stabulous-m5max") as { name: string; device: { vendor: string } };
  const arc1 = byId.get("gpu-gremlin-1-arc") as { name: string; device: { color: string } };
  assert.equal(e5090.name, "Esnixi · RTX 5090");
  assert.equal(e4070.name, "Gremlin-1 · RTX 4070 Ti SUPER");
  assert.equal(m5.name, "Stabulous · M5 Max");
  assert.equal(arc1.name, "Gremlin-1 · Intel Arc");
  assert.equal(e5090.device.color, VENDOR_COLORS.nvidia);
  assert.equal(e4070.device.color, VENDOR_COLORS.nvidia);
  assert.equal(arc1.device.color, VENDOR_COLORS.intel);
  assert.equal(m5.device.vendor, "apple");
  assert.ok(byId.has("gpu-gremlin-2-arc"));
});

test("a shared provider is split by served model; a pool lights every member", () => {
  const m5090 = (byId.get("gpu-esnixi-rtx5090") as { members: never[] }).members;
  const m4070 = (byId.get("gpu-gremlin-1-rtx4070tis") as { members: never[] }).members;
  assert.ok(memberClaims(m5090, "vllm", "qwen3.8-27b-nvfp4"));
  assert.ok(!memberClaims(m5090, "vllm", "granite-4.2-8b"));
  assert.ok(memberClaims(m4070, "vllm", "granite-4.2-8b"));
  assert.ok(memberClaims(m4070, "vllm", "anything", "c-4070"), "connection id wins");
  const arc1 = (byId.get("gpu-gremlin-1-arc") as { members: never[] }).members;
  const arc2 = (byId.get("gpu-gremlin-2-arc") as { members: never[] }).members;
  assert.ok(memberClaims(arc1, "arcforge", "qwen3-embedding-0.6b"));
  assert.ok(memberClaims(arc2, "arcforge", "qwen3-embedding-0.6b"));
  assert.ok(memberClaims(arc1, "arcf-12") && !memberClaims(arc2, "arcf-12"));
});

test("snapshot: in-flight vLLM traffic lights only the GPU that served it", () => {
  const snap = normalizeTopology({
    providers: grouped,
    activeRequests: [{ provider: "vllm", model: "granite-4.2-8b" }],
    lastProvider: "vllm",
    capturedAt: 1_000,
  });
  const node = (id: string) => snap.nodes.find((n) => n.id === `provider:${id}`)!;
  assert.equal(node("gpu-gremlin-1-rtx4070tis").traffic, "active");
  assert.equal(node("gpu-esnixi-rtx5090").traffic, "idle", "shared provider id never claims last");
  assert.equal(node("gpu-gremlin-1-rtx4070tis").device?.vendor, "nvidia");
});

test("lifecycle events route to the device that served them", () => {
  const snap = normalizeTopology({
    providers: grouped,
    activeRequests: [],
    lifecycleEvents: [
      {
        phase: "completed",
        requestId: "r1",
        provider: "vllm",
        model: "qwen3.8-27b-nvfp4",
        observedAt: 5,
      },
      { phase: "completed", requestId: "r2", provider: "arcforge", model: "x", observedAt: 6 },
    ],
    capturedAt: 10,
  });
  const ev = snap.lifecycle ?? [];
  assert.equal(ev.find((e) => e.requestId === "r1")?.provider, "gpu-esnixi-rtx5090");
  assert.equal(ev.find((e) => e.requestId === "r2")?.provider, "arcforge", "pooled: not guessed");
});

test("call-log rows are attributed by connection id", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const snap = normalizeTopology({
    providers: grouped,
    activeRequests: [],
    recentCallLogs: [
      {
        provider: "vllm",
        model: "qwen3.8-27b-nvfp4",
        status: 200,
        connectionId: "c-5090",
        timestamp: new Date(now - 1000).toISOString(),
      },
    ],
    capturedAt: now,
  });
  const n5090 = snap.nodes.find((n) => n.id === "provider:gpu-esnixi-rtx5090")!;
  const n4070 = snap.nodes.find((n) => n.id === "provider:gpu-gremlin-1-rtx4070tis")!;
  assert.deepEqual(n5090.observedModels?.value, ["qwen3.8-27b-nvfp4"]);
  assert.equal(n4070.observedModels, undefined);
});

test("atomic descriptors carry the vendor colour", () => {
  const snap = normalizeTopology({ providers: grouped, activeRequests: [], capturedAt: 1 });
  const d = resolveAtomDescriptors(snap).find((x) => x.id === "provider:gpu-gremlin-2-arc");
  assert.equal(d?.vendorColor, VENDOR_COLORS.intel);
  const bedrock = resolveAtomDescriptors(snap).find((x) => x.providerId === "bedrock");
  assert.equal(bedrock?.vendorColor, undefined);
});
