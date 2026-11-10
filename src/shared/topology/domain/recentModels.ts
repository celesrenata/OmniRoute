/**
 * Real observed model ids per provider, derived from call-log rows.
 *
 * Pure and deterministic: no clock reads (callers pass `now`), no I/O.
 * Only rows that actually completed successfully inside the window count:
 * test probes, in-flight rows, errored rows and unparseable timestamps are
 * dropped, so a provider with no qualifying traffic yields nothing (never a
 * fabricated model).
 */

/** Minimal call-log row shape consumed here (a subset of `/api/usage/call-logs`). */
export interface RecentCallLogRow {
  id?: string;
  timestamp?: string;
  status?: number;
  model?: string;
  provider?: string;
  path?: string;
  sourceFormat?: string | null;
  targetFormat?: string | null;
  error?: string | null;
  active?: boolean;
  completed?: boolean;
  [key: string]: unknown;
}

/** Observation window for call-log derived models. */
export const RECENT_MODELS_WINDOW_MS = 15 * 60_000;
/** Max model ids surfaced per provider (matches the nucleus MAX_MODEL_GROUPS). */
export const RECENT_MODELS_MAX = 3;
/** Human-readable basis, carried on the `Observed` record. */
export const RECENT_MODELS_BASIS = "successful call-log rows, last 15 min, top 3 by count";

/**
 * Connection tests write real call-log rows with fixed markers. Those are
 * health probes, not user traffic, and never describe a served model.
 */
export function isConnectionTestRow(row: RecentCallLogRow): boolean {
  return (
    row.model === "connection-test" ||
    row.sourceFormat === "test" ||
    row.targetFormat === "test" ||
    row.path === "/api/providers/test"
  );
}

/** Per-provider tally of successful model use inside the window. */
export interface ProviderModelTally {
  /** Top models (<= {@link RECENT_MODELS_MAX}), count desc then id asc. */
  models: string[];
  /** Canonical model id -> successful row count. */
  counts: Record<string, number>;
  /** Newest counted row timestamp (epoch ms). */
  newestAt: number;
}

export interface DeriveOptions {
  now: number;
  windowMs?: number;
}

/** trim + lowercase; `""` when absent. */
export function canonicalModelId(model: unknown): string {
  return typeof model === "string" ? model.trim().toLowerCase() : "";
}

function rowCountsAsSuccess(row: RecentCallLogRow): boolean {
  if (row.active || row.completed === false) return false;
  if (row.error) return false;
  const status = row.status;
  return typeof status === "number" && Number.isFinite(status) && status >= 100 && status < 400;
}

function rankModels(counts: Record<string, number>): string[] {
  return Object.keys(counts)
    .sort((a, b) => counts[b] - counts[a] || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, RECENT_MODELS_MAX);
}

/**
 * Group qualifying rows by lowercased provider key. Order-independent: the
 * result depends only on the multiset of rows.
 */
export function deriveRecentProviderModels(
  rows: readonly RecentCallLogRow[] | null | undefined,
  options: DeriveOptions
): Map<string, ProviderModelTally> {
  const windowMs = options.windowMs ?? RECENT_MODELS_WINDOW_MS;
  const now = options.now;
  const tallies = new Map<string, { counts: Record<string, number>; newestAt: number }>();
  for (const row of rows ?? []) {
    if (!row || typeof row !== "object") continue;
    if (isConnectionTestRow(row) || !rowCountsAsSuccess(row)) continue;
    const provider = typeof row.provider === "string" ? row.provider.trim().toLowerCase() : "";
    const model = canonicalModelId(row.model);
    if (!provider || !model) continue;
    const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
    if (!Number.isFinite(at) || at > now || now - at > windowMs) continue;
    let tally = tallies.get(provider);
    if (!tally) {
      tally = { counts: {}, newestAt: at };
      tallies.set(provider, tally);
    }
    tally.counts[model] = (tally.counts[model] ?? 0) + 1;
    if (at > tally.newestAt) tally.newestAt = at;
  }
  const result = new Map<string, ProviderModelTally>();
  for (const [provider, tally] of tallies) {
    result.set(provider, {
      models: rankModels(tally.counts),
      counts: tally.counts,
      newestAt: tally.newestAt,
    });
  }
  return result;
}

/**
 * Merge the tallies of every provider key that identifies `entry` (provider id
 * or alias). `null` when nothing qualifies.
 */
export function recentModelsForEntry(
  tallies: ReadonlyMap<string, ProviderModelTally>,
  entry: { provider: string; aliases?: string[] }
): { models: string[]; newestAt: number } | null {
  const keys = new Set<string>([entry.provider.toLowerCase()]);
  for (const alias of entry.aliases ?? []) keys.add(alias.toLowerCase());
  const counts: Record<string, number> = {};
  let newestAt = -Infinity;
  for (const key of keys) {
    const tally = tallies.get(key);
    if (!tally) continue;
    for (const [model, n] of Object.entries(tally.counts)) counts[model] = (counts[model] ?? 0) + n;
    if (tally.newestAt > newestAt) newestAt = tally.newestAt;
  }
  const models = rankModels(counts);
  return models.length > 0 ? { models, newestAt } : null;
}

/**
 * Stable signature of the derived models (ignores timestamps) so a host can
 * keep the previous rows reference and avoid snapshot churn on every poll.
 */
export function recentModelsSignature(
  rows: readonly RecentCallLogRow[] | null | undefined,
  now: number = Date.now()
): string {
  const tallies = deriveRecentProviderModels(rows, { now });
  return Array.from(tallies.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([provider, tally]) => `${provider}=${tally.models.join(",")}`)
    .join(";");
}

/**
 * Recent real call times per provider (directive 40 feeder traces, call-log basis).
 *
 * Window for the call-rate signal, independent of the 15-min model window: the feeder rate
 * is "calls in the last minute", so only that minute's timestamps are carried.
 */
export const RECENT_CALLS_WINDOW_MS = 60_000;
/** Max timestamps carried per provider (a bounded, honest sample; ~2 calls/s for a minute). */
export const RECENT_CALLS_MAX = 120;
/** Human-readable basis, carried on the `Observed` record. */
export const RECENT_CALLS_BASIS = "completed call-log rows (any status), last 60 s";

function rowCountsAsCall(row: RecentCallLogRow): boolean {
  // A finished real request: not a health probe, not still in flight.
  return !isConnectionTestRow(row) && !row.active && row.completed !== false;
}

/**
 * Completed, non-test call times (epoch ms of completion, newest first) per lowercased provider
 * inside the window. Pure: callers pass `now`.
 *
 * `/api/usage/call-logs` used to list a just-finished request twice (fixed server-side in
 * `buildCallLogListRows`, which pairs the in-memory entry with its persisted row by correlationId).
 * This collapse is kept as a DEFENSIVE guard for rows without a correlationId, and for older
 * servers: the in-memory entry
 * (`detailState: "in-memory"`, timestamp = start, `duration`) and, once written, the persisted
 * row (timestamp = completion) under a different id. The pair is collapsed here: an in-memory
 * row whose start + duration lands within 250 ms of a persisted row of the same provider,
 * connection, model and duration is the same call. Rows are also de-duplicated by id.
 */
export function deriveRecentCallTimes(
  rows: readonly RecentCallLogRow[] | null | undefined,
  options: DeriveOptions
): Map<string, number[]> {
  const windowMs = options.windowMs ?? RECENT_CALLS_WINDOW_MS;
  const now = options.now;
  type Call = { provider: string; at: number; key: string; inMemory: boolean };
  const calls: Call[] = [];
  const seen = new Set<string>();
  for (const row of rows ?? []) {
    if (!row || typeof row !== "object" || !rowCountsAsCall(row)) continue;
    const provider = typeof row.provider === "string" ? row.provider.trim().toLowerCase() : "";
    if (!provider) continue;
    const ts = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
    if (!Number.isFinite(ts)) continue;
    if (typeof row.id === "string" && row.id) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
    }
    const inMemory = row.detailState === "in-memory";
    const duration =
      typeof row.duration === "number" && Number.isFinite(row.duration) ? row.duration : 0;
    const at = inMemory ? ts + Math.max(0, duration) : ts;
    if (at > now || now - at > windowMs) continue;
    const key = `${provider}|${String(row.connectionId ?? "")}|${canonicalModelId(row.model)}|${duration}`;
    calls.push({ provider, at, key, inMemory });
  }
  const persisted = new Map<string, number[]>();
  for (const c of calls)
    if (!c.inMemory) (persisted.get(c.key) ?? persisted.set(c.key, []).get(c.key)!).push(c.at);
  const out = new Map<string, number[]>();
  for (const c of calls) {
    if (c.inMemory && (persisted.get(c.key) ?? []).some((t) => Math.abs(t - c.at) <= 250)) continue;
    let list = out.get(c.provider);
    if (!list) {
      list = [];
      out.set(c.provider, list);
    }
    list.push(c.at);
  }
  for (const [k, list] of out) out.set(k, list.sort((a, b) => b - a).slice(0, RECENT_CALLS_MAX));
  return out;
}

/** Merge the call times of every key identifying `entry`; `null` when there are none. */
export function recentCallsForEntry(
  times: ReadonlyMap<string, number[]>,
  entry: { provider: string; aliases?: string[] }
): number[] | null {
  const keys = new Set<string>([entry.provider.toLowerCase()]);
  for (const alias of entry.aliases ?? []) keys.add(alias.toLowerCase());
  const all: number[] = [];
  for (const key of keys) all.push(...(times.get(key) ?? []));
  if (all.length === 0) return null;
  return all.sort((a, b) => b - a).slice(0, RECENT_CALLS_MAX);
}

/**
 * Signature of the recent calls (provider, count, newest timestamp). It changes only when a
 * real call arrives or one leaves the window, so a host can refresh the snapshot for real
 * activity without churning on every poll.
 */
export function recentCallsSignature(
  rows: readonly RecentCallLogRow[] | null | undefined,
  now: number = Date.now()
): string {
  return Array.from(deriveRecentCallTimes(rows, { now }).entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([provider, t]) => `${provider}=${t.length}@${t[0]}`)
    .join(";");
}
