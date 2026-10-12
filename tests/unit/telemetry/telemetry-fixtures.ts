/**
 * Shared fixtures for the fleet telemetry unit tests (T005 / M2).
 *
 * Everything here is deterministic and hermetic — no live infrastructure,
 * no DB, no network. The fake provider records its snapshot() invocations
 * so gateway cache behavior can be asserted.
 */

import type {
  FleetResourceObservation,
  FleetTelemetryProvider,
  FleetTelemetryQuery,
  FleetTelemetrySnapshot,
  Observed,
  TelemetryProviderStatus,
} from "../../../src/shared/topology/telemetry/types";

let clock = 1_000_000;

/** Deterministic clock shared by fixtures; tests may advance it. */
export function fixtureNow(): number {
  return clock;
}

export function advanceFixtureClock(ms: number): void {
  clock += ms;
}

export function resetFixtureClock(ms = 1_000_000): void {
  clock = ms;
}

/** A valid Observed<number> fixture with full provenance. */
export function observedValue(
  value: number | null,
  opts: {
    source?: Observed<number>["source"];
    sampledAt?: number;
    windowMs?: number;
    stale?: boolean;
    basis?: string;
  } = {}
): Observed<number> {
  const out: Observed<number> = {
    value,
    source: opts.source ?? "omniroute-live",
    sampledAt: opts.sampledAt ?? fixtureNow(),
  };
  if (opts.windowMs != null) out.windowMs = opts.windowMs;
  if (opts.stale != null) out.stale = opts.stale;
  if (opts.basis != null) out.basis = opts.basis;
  return out;
}

export function providerResource(
  providerId: string,
  fields: Partial<FleetResourceObservation> = {}
): FleetResourceObservation {
  const resource: FleetResourceObservation = {
    resourceId: `provider:${providerId}`,
    kind: "provider",
    providerId,
  };
  Object.assign(resource, fields);
  return resource;
}

export function gpuResource(
  hostId: string,
  deviceUuid: string,
  fields: Partial<FleetResourceObservation> = {}
): FleetResourceObservation {
  const resource: FleetResourceObservation = {
    resourceId: `gpu:${hostId}:${deviceUuid}`,
    kind: "gpu",
    hostId,
    deviceUuid,
  };
  Object.assign(resource, fields);
  return resource;
}

export function runtimeResource(
  hostId: string,
  runtimeId: string,
  fields: Partial<FleetResourceObservation> = {}
): FleetResourceObservation {
  const resource: FleetResourceObservation = {
    resourceId: `runtime:${hostId}:${runtimeId}`,
    kind: "runtime",
    hostId,
    runtimeId,
  };
  Object.assign(resource, fields);
  return resource;
}

export function fixtureSnapshot(
  resources: FleetResourceObservation[],
  capturedAt: number = fixtureNow()
): FleetTelemetrySnapshot {
  return { schemaVersion: 1, capturedAt, resources };
}

export interface FakeProviderOptions {
  id: string;
  kind?: FleetTelemetryProvider["kind"];
  /** Resource factory called on every snapshot() (fresh objects each time). */
  resources?: (query: FleetTelemetryQuery) => FleetResourceObservation[];
  /** Extra delay before resolving (ms); for timeout tests. */
  delayMs?: number;
  /** Always reject. */
  fail?: string;
  onSnapshot?: (query: FleetTelemetryQuery) => void;
}

/** A recording fake provider — snapshot/probe are counted. */
export function makeFakeProvider(options: FakeProviderOptions): {
  provider: FleetTelemetryProvider;
  get snapshotCalls(): number;
  get probeCalls(): number;
} {
  let snapshotCalls = 0;
  let probeCalls = 0;
  const provider: FleetTelemetryProvider = {
    id: options.id,
    kind: options.kind ?? "omniroute",
    async probe(): Promise<TelemetryProviderStatus> {
      probeCalls += 1;
      return { available: true, checkedAt: fixtureNow() };
    },
    async snapshot(query): Promise<FleetTelemetrySnapshot> {
      snapshotCalls += 1;
      if (options.fail) {
        throw new Error(options.fail);
      }
      if (options.delayMs != null) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      options.onSnapshot?.(query);
      const resources = options.resources ? options.resources(query) : [];
      return fixtureSnapshot(resources);
    },
  };
  return {
    provider,
    get snapshotCalls() {
      return snapshotCalls;
    },
    get probeCalls() {
      return probeCalls;
    },
  };
}
