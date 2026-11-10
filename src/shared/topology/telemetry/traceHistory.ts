/**
 * Request-trace history for time-travel replay (OR-ATOM Step 12).
 *
 * Pure and deterministic: no clock reads, no I/O. A bounded timeline is built
 * ONLY from call-log rows that exist (`GET /api/usage/call-logs`):
 *
 *   - every in-window row yields a `request-started` record at the row's own
 *     timestamp;
 *   - a finished row also yields ONE terminal record: `request-failed` for an
 *     error row (status >= 400 or an error summary), `request-completed` for a
 *     2xx/3xx row. The terminal time is `timestamp + duration` when the row
 *     carries a measured duration, otherwise the row timestamp itself (the only
 *     time that exists; nothing is interpolated);
 *   - an in-flight row (`active`) or a row with no terminal status yields the
 *     started record only;
 *   - connection-test probe rows are dropped (health probes, not traffic);
 *   - nothing is ever produced outside the requested window.
 *
 * Records are `AtomicEvent`-compatible (`id`, `at`, `kind`, `providerId`,
 * `resourceId`, `modelId`, `lane`, `linkId`) plus the row's `status`, `tokens`
 * and measured `durationMs`, so the replay engine can inject them into the
 * existing event pool unchanged.
 */
import { deriveLaneFromModel, type TopologyLane } from "../domain/lane";
import { isConnectionTestRow, type RecentCallLogRow } from "../domain/recentModels";

export type TraceKind = "request-started" | "request-completed" | "request-failed";

/** Stable order for records that share a timestamp: start, then outcome. */
const KIND_ORDER: Record<TraceKind, number> = {
  "request-started": 0,
  "request-completed": 1,
  "request-failed": 1,
};

export interface TraceRecord {
  /** `${kind}:${rowId}` (unique per row + transition). */
  id: string;
  /** Epoch ms of the recorded observation. */
  at: number;
  kind: TraceKind;
  /** Provider id exactly as logged (lower-casing is the consumer's join concern). */
  providerId: string;
  /** The call-log row id (dedupe target; absent when the row had none). */
  resourceId?: string;
  modelId?: string;
  /** Lane classified conservatively from the model id; absent when it does not classify. */
  lane?: TopologyLane;
  /** Canonical link id `route:<providerId>`. */
  linkId: string;
  /** HTTP status of the row; absent when the row carried none. */
  status?: number;
  /** Recorded token counts, when the row carried finite numbers. */
  tokens?: { in: number; out: number };
  /** Measured request duration (ms), when the row carried one. */
  durationMs?: number;
}

export interface TraceWindow {
  sinceMs: number;
  untilMs: number;
}

export interface TraceTimeline extends TraceWindow {
  /** Ordered by `at`, then start-before-outcome, then id. */
  records: readonly TraceRecord[];
  /** Number of distinct rows that produced at least one record. */
  rowCount: number;
}

export const EMPTY_TIMELINE_RECORDS: readonly TraceRecord[] = Object.freeze([]);

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function rowFailed(row: RecentCallLogRow): boolean {
  const status = finiteNumber(row.status);
  return (status != null && status >= 400) || (typeof row.error === "string" && row.error !== "");
}

function rowSucceeded(row: RecentCallLogRow): boolean {
  const status = finiteNumber(row.status);
  return status != null && status >= 200 && status < 400;
}

function readTokens(row: RecentCallLogRow): { in: number; out: number } | undefined {
  const t = row.tokens as { in?: unknown; out?: unknown } | null | undefined;
  if (!t || typeof t !== "object") return undefined;
  const tin = finiteNumber(t.in);
  const tout = finiteNumber(t.out);
  if (tin == null || tout == null) return undefined;
  return { in: tin, out: tout };
}

/**
 * Build the replay timeline for `window` from call-log `rows`.
 * Rows are de-duplicated by id (pages and in-memory merges may repeat a row).
 */
export function buildTraceTimeline(
  rows: readonly RecentCallLogRow[] | null | undefined,
  window: TraceWindow
): TraceTimeline {
  const sinceMs = Number.isFinite(window.sinceMs) ? window.sinceMs : 0;
  const untilMs = Number.isFinite(window.untilMs) ? window.untilMs : sinceMs;
  const lo = Math.min(sinceMs, untilMs);
  const hi = Math.max(sinceMs, untilMs);
  const out: TraceRecord[] = [];
  const seen = new Set<string>();
  let rowCount = 0;
  for (const row of rows ?? []) {
    if (!row || typeof row !== "object") continue;
    if (isConnectionTestRow(row)) continue;
    const provider = typeof row.provider === "string" ? row.provider.trim() : "";
    if (!provider) continue;
    const start = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
    if (!Number.isFinite(start)) continue;
    const rowId = typeof row.id === "string" && row.id !== "" ? row.id : null;
    if (rowId) {
      if (seen.has(rowId)) continue;
      seen.add(rowId);
    }
    const key = rowId ?? `${provider}@${start}#${rowCount}`;
    const model = typeof row.model === "string" && row.model !== "" ? row.model : undefined;
    const lane = deriveLaneFromModel(model) ?? undefined;
    const status = finiteNumber(row.status);
    const tokens = readTokens(row);
    const duration = finiteNumber(row.duration);
    const durationMs = duration != null && duration >= 0 ? duration : undefined;
    const base = {
      providerId: provider,
      resourceId: rowId ?? undefined,
      modelId: model,
      lane,
      linkId: `route:${provider}`,
      ...(status != null && status > 0 ? { status } : {}),
      ...(tokens ? { tokens } : {}),
      ...(durationMs != null ? { durationMs } : {}),
    };
    let produced = false;
    if (start >= lo && start <= hi) {
      out.push({ ...base, id: `request-started:${key}`, at: start, kind: "request-started" });
      produced = true;
    }
    if (!row.active) {
      const terminal: TraceKind | null = rowFailed(row)
        ? "request-failed"
        : rowSucceeded(row)
          ? "request-completed"
          : null;
      if (terminal) {
        const end = start + (durationMs ?? 0);
        if (end >= lo && end <= hi) {
          out.push({ ...base, id: `${terminal}:${key}`, at: end, kind: terminal });
          produced = true;
        }
      }
    }
    if (produced) rowCount += 1;
  }
  out.sort(
    (a, b) =>
      a.at - b.at ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  return { sinceMs: lo, untilMs: hi, records: out, rowCount };
}

export interface KindCounts {
  started: number;
  completed: number;
  failed: number;
}

export const emptyKindCounts = (): KindCounts => ({ started: 0, completed: 0, failed: 0 });

/** Count records per provider and kind (what the live demo compares to the call logs). */
export function countByProvider(
  records: readonly Pick<TraceRecord, "providerId" | "kind">[]
): Record<string, KindCounts> {
  const out: Record<string, KindCounts> = {};
  for (const r of records) {
    const c = (out[r.providerId] ??= emptyKindCounts());
    if (r.kind === "request-started") c.started += 1;
    else if (r.kind === "request-completed") c.completed += 1;
    else c.failed += 1;
  }
  return out;
}

/** Records with `fromExclusive < at <= toInclusive` (binary search; `records` must be ordered). */
export function recordsBetween(
  records: readonly TraceRecord[],
  fromExclusive: number,
  toInclusive: number
): TraceRecord[] {
  const firstAfter = (t: number): number => {
    let lo = 0;
    let hi = records.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (records[mid].at <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return records.slice(firstAfter(fromExclusive), firstAfter(toInclusive));
}
