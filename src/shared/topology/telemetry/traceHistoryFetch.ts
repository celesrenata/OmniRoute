/**
 * One-shot, paginated fetch of the call-log history for replay (OR-ATOM Step 12).
 *
 * Called ONLY when the viewer opens replay (never a background poll). Uses the
 * existing `GET /api/usage/call-logs` with the additive `since` / `until` query
 * parameters and `offset` paging. Bounded: at most {@link TRACE_MAX_PAGES} pages
 * of {@link TRACE_PAGE_SIZE} rows; `truncated` is reported when the cap is hit.
 */
import type { RecentCallLogRow } from "../domain/recentModels";
import { buildTraceTimeline, type TraceTimeline } from "./traceHistory";

export const TRACE_PAGE_SIZE = 200;
export const TRACE_MAX_PAGES = 10;

export interface TraceFetchResult {
  timeline: TraceTimeline;
  /** Distinct rows received (before window filtering). */
  fetchedRows: number;
  /** The page cap was reached while more rows may exist. */
  truncated: boolean;
}

export interface TraceFetchOptions {
  /** Replay window length (ms) ending at `nowMs`. */
  windowMs: number;
  nowMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export function traceHistoryUrl(
  sinceMs: number,
  untilMs: number,
  offset: number,
  limit = TRACE_PAGE_SIZE
): string {
  const q = new URLSearchParams({
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
    limit: String(limit),
    offset: String(offset),
    excludeTests: "1",
  });
  return `/api/usage/call-logs?${q.toString()}`;
}

/** Fetch every call-log row in `[now - windowMs, now]` and build the timeline. */
export async function fetchTraceHistory(options: TraceFetchOptions): Promise<TraceFetchResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const untilMs = options.nowMs;
  const sinceMs = untilMs - options.windowMs;
  const rows: RecentCallLogRow[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (let page = 0; page < TRACE_MAX_PAGES; page += 1) {
    const res = await doFetch(traceHistoryUrl(sinceMs, untilMs, page * TRACE_PAGE_SIZE), {
      cache: "no-store",
      signal: options.signal,
    });
    if (!res.ok) throw new Error(`call-logs ${res.status}`);
    const data: unknown = await res.json();
    if (!Array.isArray(data)) throw new Error("call-logs: unexpected response");
    let fresh = 0;
    for (const row of data as RecentCallLogRow[]) {
      // In-memory rows are merged into every page by the route; keep each row once.
      const id = typeof row?.id === "string" ? row.id : null;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      fresh += 1;
      rows.push(row);
    }
    if (data.length < TRACE_PAGE_SIZE || fresh === 0) break;
    if (page === TRACE_MAX_PAGES - 1) truncated = true;
  }
  return {
    timeline: buildTraceTimeline(rows, { sinceMs, untilMs }),
    fetchedRows: rows.length,
    truncated,
  };
}
