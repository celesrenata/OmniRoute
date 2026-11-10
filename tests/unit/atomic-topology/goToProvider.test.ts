/**
 * Label click only focuses an atom; navigating to the provider page is an
 * explicit "Go to provider" action in the tooltip and the detail panel.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeTopology } from "../../../src/shared/topology/domain/normalizeTopology";
import { resolveAtomDescriptors } from "../../../src/plugins/atomic-topology";
import { AtomicTooltip } from "../../../src/plugins/atomic-topology/overlays/AtomicTooltip";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const descriptors = resolveAtomDescriptors(
  normalizeTopology({
    providers: [{ provider: "openai", status: "active" as const }],
    activeRequests: [],
    capturedAt: NOW,
  })
);
const provider = descriptors.find((d) => d.providerId === "openai")!;
const hub = descriptors.find((d) => d.kind === "hub")!;
const noop = () => {};

test("tooltip shows 'Go to provider' for a provider atom when the handler is wired", () => {
  const html = renderToStaticMarkup(
    createElement(AtomicTooltip, { descriptor: provider, capturedAt: NOW, onGoToProvider: noop })
  );
  assert.match(html, /data-atomic-goto-provider="true"/);
  assert.match(html, /Go to provider/);
});

test("tooltip has no 'Go to provider' for the hub or without a handler", () => {
  const hubHtml = renderToStaticMarkup(
    createElement(AtomicTooltip, { descriptor: hub, capturedAt: NOW, onGoToProvider: noop })
  );
  assert.doesNotMatch(hubHtml, /data-atomic-goto-provider/);
  const unwired = renderToStaticMarkup(
    createElement(AtomicTooltip, { descriptor: provider, capturedAt: NOW })
  );
  assert.doesNotMatch(unwired, /data-atomic-goto-provider/);
});

test("label selection focuses only; it never fires provider navigation", () => {
  const src = readFileSync(
    new URL("../../../src/plugins/atomic-topology/overlays/AtomicLabels.tsx", import.meta.url),
    "utf8"
  );
  const body = src.slice(src.indexOf("function useAtomSelection"));
  const fn = body.slice(0, body.indexOf("\n}\n"));
  assert.match(fn, /onFocusRequest\?\.\(descriptor\.id\)/);
  assert.doesNotMatch(fn, /onProviderClick\(/);
});
