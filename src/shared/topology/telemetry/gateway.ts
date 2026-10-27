/**
 * Fleet telemetry gateway (T005 / M2, OR-ATOM-001 v2).
 *
 * Server-side aggregator that merges provider snapshots into ONE bounded
 * `FleetTelemetrySnapshot`. Guarantees:
 * - NO browser fan-out: the gateway runs where the data lives (server) and
 *   callers ask for one snapshot, never per-atom.
 * - NO per-atom queries: one bounded query per registered provider.
 * - Bounded, short-TTL in-memory cache with LRU eviction.
 * - Per-provider timeout + AbortSignal cancellation.
 * - Stale marking (>3 sampling intervals → stale:true, see mergeSnapshots)
 *   and neutralizeStale() for decay-to-neutral.
 * - Zod-validated inputs/outputs; invalid provider snapshots are dropped
 *   wholesale, never partially merged.
 *
 * The gateway never reads credentials, never logs request bodies, and never
 * returns raw PII: all facts are normalized, provenance-carrying numbers.
 */

import { filterResourcesByQuery, mergeSnapshots } from "./mergeSnapshots";
import {
  FUTURE_TOLERANCE_MS_DEFAULT,
  MAX_SNAPSHOT_RESOURCES,
  parseProviderSnapshot,
  parseQuery,
} from "./provenance";
import type {
  FleetTelemetryProvider,
  FleetTelemetryQuery,
  FleetTelemetrySnapshot,
  TelemetryProviderStatus,
} from "./types";

export const GATEWAY_CACHE_TTL_MS_DEFAULT = 10_000;
export const GATEWAY_CACHE_MAX_ENTRIES_DEFAULT = 16;
export const GATEWAY_PROVIDER_TIMEOUT_MS_DEFAULT = 5_000;
export const GATEWAY_MAX_PROVIDERS_DEFAULT = 16;

export class TelemetryQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelemetryQueryError";
  }
}

export class TelemetryAbortedError extends Error {
  constructor(message = "telemetry query aborted") {
    super(message);
    this.name = "TelemetryAbortedError";
  }
}

export class TelemetryGatewayError extends Error {
  readonly providerId: string;
  constructor(providerId: string, message: string) {
    super(message);
    this.name = "TelemetryGatewayError";
    this.providerId = providerId;
  }
}

export interface FleetTelemetryGatewayOptions {
  /** Cache TTL in ms (short by design). Default 10_000. */
  cacheTtlMs?: number;
  /** Max cached snapshots before LRU eviction. Default 16. */
  cacheMaxEntries?: number;
  /** Per-provider timeout in ms. Default 5_000. */
  providerTimeoutMs?: number;
  /** Max registered providers. Default 16. */
  maxProviders?: number;
  /**
   * Bounded clock-skew tolerance for future-stamped samples at merge, in ms
   * (default FUTURE_TOLERANCE_MS_DEFAULT). Injectable for tests.
   */
  futureToleranceMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable warning sink (server logs; must not receive bodies). */
  onWarning?: (warning: string) => void;
}

export interface GatewayRunDiagnostics {
  ranAt: number;
  fromCache: boolean;
  providerLatencyMs: Record<string, number>;
  warnings: string[];
  droppedInvalidSnapshots: number;
  droppedFutureSnapshots: number;
  droppedConflictingRows: number;
  truncated: boolean;
}

interface CacheEntry {
  at: number;
  snapshot: FleetTelemetrySnapshot;
}

function stableQueryKey(query: FleetTelemetryQuery, providerIds: string[]): string {
  const providers = [...providerIds].sort().join(",");
  const hosts = [...(query.hostIds ?? [])].sort().join(",");
  const gpus = [...(query.gpuIds ?? [])].sort().join(",");
  return `${providers}|${hosts}|${gpus}|${query.windowMs}`;
}

/** Reject when the promise outlives `timeoutMs`; clears its timer on win. */
async function withTimeout<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new TelemetryGatewayError(label, `timeout after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class FleetTelemetryGateway {
  private readonly providers = new Map<string, FleetTelemetryProvider>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;
  private readonly cacheMaxEntries: number;
  private readonly providerTimeoutMs: number;
  private readonly maxProviders: number;
  private readonly futureToleranceMs: number;
  private readonly nowFn: () => number;
  private readonly warn: (w: string) => void;
  lastDiagnostics: GatewayRunDiagnostics | null = null;

  constructor(opts: FleetTelemetryGatewayOptions = {}) {
    this.cacheTtlMs = opts.cacheTtlMs ?? GATEWAY_CACHE_TTL_MS_DEFAULT;
    this.cacheMaxEntries = opts.cacheMaxEntries ?? GATEWAY_CACHE_MAX_ENTRIES_DEFAULT;
    this.providerTimeoutMs = opts.providerTimeoutMs ?? GATEWAY_PROVIDER_TIMEOUT_MS_DEFAULT;
    this.maxProviders = opts.maxProviders ?? GATEWAY_MAX_PROVIDERS_DEFAULT;
    this.futureToleranceMs = opts.futureToleranceMs ?? FUTURE_TOLERANCE_MS_DEFAULT;
    this.nowFn = opts.now ?? (() => Date.now());
    this.warn = opts.onWarning ?? (() => {});
  }

  /** Register a provider. Throws on duplicate id or when over the cap. */
  register(provider: FleetTelemetryProvider): void {
    if (typeof provider.id !== "string" || provider.id.trim() === "") {
      throw new Error("FleetTelemetryGateway: provider.id is required");
    }
    if (this.providers.has(provider.id)) {
      throw new Error(`FleetTelemetryGateway: duplicate provider id "${provider.id}"`);
    }
    if (this.providers.size >= this.maxProviders) {
      throw new Error(`FleetTelemetryGateway: max providers (${this.maxProviders}) reached`);
    }
    this.providers.set(provider.id, provider);
  }

  unregister(providerId: string): boolean {
    return this.providers.delete(providerId);
  }

  get providerIds(): string[] {
    return [...this.providers.keys()];
  }

  /** Liveness probe for every provider (bounded, per-provider timeout). */
  async probe(signal?: AbortSignal): Promise<Record<string, TelemetryProviderStatus>> {
    this.throwIfAborted(signal);
    const entries = [...this.providers.values()];
    const results = await Promise.all(
      entries.map(async (p) => {
        try {
          const status = await withTimeout(p.probe(signal), this.providerTimeoutMs, p.id);
          return [p.id, status] as const;
        } catch {
          return [
            p.id,
            { available: false, checkedAt: this.nowFn(), message: "probe failed" },
          ] as const;
        }
      })
    );
    return Object.fromEntries(results);
  }

  /**
   * One bounded, merged snapshot for the query. Invalid queries throw
   * TelemetryQueryError. Provider failures degrade to warnings (the
   * snapshot is still built from healthy providers); a hard abort throws
   * TelemetryAbortedError.
   */
  async snapshot(query: unknown, signal?: AbortSignal): Promise<FleetTelemetrySnapshot> {
    this.throwIfAborted(signal);
    const parsed = parseQuery(query);
    if (parsed === null) {
      throw new TelemetryQueryError("invalid FleetTelemetryQuery (see querySchema)");
    }

    const now = this.nowFn();
    const warnings: string[] = [];

    // providerIds select registered BACKENDS; unknown ids warn, they do not
    // throw. An explicit empty list selects NO providers.
    const wanted = parsed.providerIds ?? this.providerIds;
    const selected = wanted
      .map((id) => {
        const p = this.providers.get(id);
        if (!p) {
          warnings.push(`unknown provider id: ${id}`);
          return null;
        }
        return p;
      })
      .filter((p): p is FleetTelemetryProvider => p !== null);

    const cacheKey = stableQueryKey(
      parsed,
      selected.map((p) => p.id)
    );
    const cached = this.cache.get(cacheKey);
    if (cached && now - cached.at < this.cacheTtlMs) {
      this.lastDiagnostics = {
        ranAt: now,
        fromCache: true,
        providerLatencyMs: {},
        warnings: [...warnings],
        droppedInvalidSnapshots: 0,
        droppedFutureSnapshots: 0,
        droppedConflictingRows: 0,
        truncated: false,
      };
      return cached.snapshot;
    }

    const providerLatencyMs: Record<string, number> = {};
    const rawSnapshots: FleetTelemetrySnapshot[] = [];
    let droppedInvalidSnapshots = 0;

    await Promise.all(
      selected.map(async (p) => {
        const started = this.nowFn();
        try {
          if (signal?.aborted) throw new TelemetryAbortedError();
          const raw = await withTimeout(p.snapshot(parsed, signal), this.providerTimeoutMs, p.id);
          providerLatencyMs[p.id] = this.nowFn() - started;
          const parsedSnap = parseProviderSnapshot(raw);
          if (parsedSnap.ok) {
            rawSnapshots.push(parsedSnap.snapshot);
          } else {
            droppedInvalidSnapshots += 1;
            warnings.push(`provider ${p.id}: snapshot rejected by schema, dropped`);
          }
        } catch (err) {
          if (err instanceof TelemetryAbortedError) throw err;
          providerLatencyMs[p.id] = this.nowFn() - started;
          const msg = err instanceof Error ? err.message : "unknown error";
          warnings.push(`provider ${p.id}: ${msg}`);
        }
      })
    );

    // An abort that arrived during provider execution must win over a
    // half-collected snapshot (AC: cancellation).
    this.throwIfAborted(signal);

    const merged = mergeSnapshots(rawSnapshots, now, {
      futureToleranceMs: this.futureToleranceMs,
    });
    const resources = filterResourcesByQuery(merged.snapshot.resources, parsed);
    const snapshot: FleetTelemetrySnapshot = {
      schemaVersion: 1,
      capturedAt: now,
      resources,
    };

    // Bounded cache: evict the oldest entry (Map insertion order) past the cap.
    this.cache.set(cacheKey, { at: now, snapshot });
    if (this.cache.size > this.cacheMaxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }

    const diagnostics: GatewayRunDiagnostics = {
      ranAt: now,
      fromCache: false,
      providerLatencyMs,
      warnings: [
        ...warnings,
        ...(merged.truncated ? [`resources truncated to ${MAX_SNAPSHOT_RESOURCES}`] : []),
      ],
      droppedInvalidSnapshots,
      droppedFutureSnapshots: merged.droppedFuture,
      droppedConflictingRows: merged.droppedConflicts,
      truncated: merged.truncated,
    };
    this.lastDiagnostics = diagnostics;
    for (const w of diagnostics.warnings) this.warn(w);
    return snapshot;
  }

  /** Drop cached snapshots (tests + config changes). */
  clearCache(): void {
    this.cache.clear();
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new TelemetryAbortedError();
  }
}
