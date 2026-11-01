"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface CatalogResult {
  id: string;
  name: string;
  description: string;
  domain: string;
  revision: string;
  tags: string[];
  source: string;
  score: number;
  reason: {
    nameMatch: number;
    descriptionMatch: number;
    tagMatch: number;
    domainAffinity: number;
  } | null;
}

interface Skillset {
  id: string;
  name: string;
  description: string | null;
  skillCount: number;
}

interface LoadedSkill {
  id: string;
  name: string;
  description: string;
  domain: string;
  revision: string;
  tags: string[];
  source: string;
  content?: string;
  found?: boolean;
  error?: string;
}

const SOURCE_ICON: Record<string, string> = {
  builtin: "◆",
  imported: "▸",
  github: "⎔",
};

export function SkillHubPageClient() {
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [skillset, setSkillset] = useState("");
  const [results, setResults] = useState<CatalogResult[]>([]);
  const [skillsets, setSkillsets] = useState<Skillset[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Lazy loading: page 1 loads on filter change; further pages are appended
  // automatically when the scroll sentinel nears the viewport.
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0); // bumped on filter change; in-flight requests guard on it
  const nextPageRef = useRef(1); // next page to fetch for the current filter
  const [selected, setSelected] = useState<LoadedSkill | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  // Whole-skill-service master switch (settings.skillsEnabled). null = unknown
  // until the first GET resolves; the switch renders disabled until then.
  const [serviceEnabled, setServiceEnabled] = useState<boolean | null>(null);
  const [togglingService, setTogglingService] = useState(false);

  // Master switch — load the current skillsEnabled value on mount.
  useEffect(() => {
    fetch("/api/skills/service/toggle")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { enabled?: boolean } | null) => {
        if (data && typeof data.enabled === "boolean") setServiceEnabled(data.enabled);
      })
      .catch(() => undefined);
  }, []);

  const toggleService = (next: boolean) => {
    if (togglingService) return;
    setTogglingService(true);
    const previous = serviceEnabled;
    setServiceEnabled(next); // optimistic
    fetch("/api/skills/service/toggle", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          setServiceEnabled(previous);
          setError(
            body?.error?.message || `Failed to ${next ? "enable" : "disable"} skill service`
          );
        }
      })
      .catch((err: unknown) => {
        setServiceEnabled(previous);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setTogglingService(false));
  };

  // Browse / search — fetch page 1 on change (lazy loading). Subsequent pages
  // are appended via the IntersectionObserver sentinel. `loading` starts true
  // (initial skeleton) and is only flipped off in the promise callback; no
  // synchronous setState in the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    const reqId = ++requestRef.current;
    nextPageRef.current = 1;
    let cancelled = false;
    const params = new URLSearchParams();
    params.set("query", activeQuery);
    params.set("limit", activeQuery ? "20" : "100");
    params.set("page", "1");
    if (skillset) params.set("skillset", skillset);
    fetch(`/api/skills/catalog?${params.toString()}`)
      .then((res) => res.json())
      .then((data: { count?: number; results?: CatalogResult[]; error?: string }) => {
        if (cancelled || reqId !== requestRef.current) return;
        if (data.error && (!data.results || data.results.length === 0)) {
          setError(data.error);
          setResults([]);
          setTotal(0);
          setHasMore(false);
        } else {
          setError(null);
          setResults(data.results || []);
          const count = data.count ?? (data.results?.length || 0);
          setTotal(count);
          nextPageRef.current = 2;
          setHasMore((data.results?.length || 0) < count);
        }
      })
      .catch((err: unknown) => {
        if (cancelled || reqId !== requestRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setResults([]);
        setHasMore(false);
      })
      .finally(() => {
        if (!cancelled && reqId === requestRef.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeQuery, skillset]);

  // Keep a ref of results length so loadMore can compute hasMore without
  // re-reading state that it would need in its dependency list.
  const resultsRef = useRef(0);
  useEffect(() => {
    resultsRef.current = results.length;
  }, [results]);

  // Append the next page of results (lazy loading). Guarded by reqId so a filter
  // change mid-flight invalidates the request, and by loading/hasMore/loadingMore.
  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasMore) return;
    const reqId = requestRef.current;
    const page = nextPageRef.current;
    setLoadingMore(true);
    const params = new URLSearchParams();
    params.set("query", activeQuery);
    params.set("limit", activeQuery ? "20" : "100");
    params.set("page", String(page));
    if (skillset) params.set("skillset", skillset);
    fetch(`/api/skills/catalog?${params.toString()}`)
      .then((res) => res.json())
      .then((data: { count?: number; results?: CatalogResult[]; error?: string }) => {
        if (reqId !== requestRef.current) return; // filter changed since
        const pageResults = data.results || [];
        if (pageResults.length > 0) {
          setResults((prev) => [...prev, ...pageResults]);
          const loaded = resultsRef.current + pageResults.length;
          const count = data.count ?? loaded;
          setHasMore(loaded < count);
          nextPageRef.current = page + 1;
        } else {
          setHasMore(false);
        }
      })
      .catch(() => {
        if (reqId === requestRef.current) setHasMore(false); // stop retrying
      })
      .finally(() => {
        if (reqId === requestRef.current) setLoadingMore(false);
      });
  }, [activeQuery, skillset, hasMore, loading, loadingMore]);

  // Infinite scroll: append the next page when the sentinel nears the viewport.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) loadMore();
        }
      },
      { rootMargin: "400px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  // Skillsets — load once on mount.
  useEffect(() => {
    fetch("/api/skills/catalog/skillsets")
      .then((res) => res.json())
      .then((data: { skillsets?: Skillset[] }) => setSkillsets(data.skillsets || []))
      .catch(() => setSkillsets([]));
  }, []);

  const loadContent = (id: string) => {
    setLoadingContent(true);
    fetch("/api/skills/catalog", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "load", id }),
    })
      .then((res) => res.json())
      .then((data: LoadedSkill) => {
        if (!data || !data.found) {
          setError(data?.error || "Failed to load skill");
        } else {
          setSelected(data);
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoadingContent(false));
  };

  const resetFilters = () => {
    setQuery("");
    setActiveQuery("");
    setSkillset("");
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold text-foreground">Skill Hub</h1>
            <p className="text-sm text-muted-foreground">
              Discover, inspect and run the skill catalog
            </p>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-border bg-bg-subtle px-3 py-2">
            <div className="flex flex-col">
              <span className="text-sm font-medium text-foreground">Skill service</span>
              <span className="text-xs text-muted-foreground">
                {serviceEnabled === null
                  ? "Loading…"
                  : serviceEnabled
                    ? "Enabled"
                    : "Disabled — skills are unavailable"}
              </span>
            </div>
            <button
              data-testid="skill-service-switch"
              type="button"
              role="switch"
              aria-checked={serviceEnabled === true}
              aria-label="Toggle skill service"
              disabled={togglingService || serviceEnabled === null}
              onClick={() => toggleService(serviceEnabled !== true)}
              className={`relative h-6 w-11 rounded-full transition-colors disabled:cursor-wait disabled:opacity-60 ${
                serviceEnabled ? "bg-amber-500" : "bg-border"
              }`}
            >
              <span
                className={`absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition-transform ${
                  serviceEnabled ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>
        </div>
        {serviceEnabled === false && (
          <div
            role="status"
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400"
          >
            Skill service is off: skill execution is blocked, and catalog refresh and per-skill
            toggling return 503. Browsing and inspecting skills keeps working. Flip the switch back
            on to restore the full service.
          </div>
        )}
      </div>

      {/* Search bar */}
      <div className="flex flex-col gap-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setActiveQuery(query.trim());
          }}
          className="flex gap-2"
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              activeQuery
                ? "Search skills by name, description, tag…"
                : "Type to search, or browse the full catalog"
            }
            className="flex-1 rounded-lg border border-border bg-bg-subtle px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="submit"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Search
          </button>
          {(activeQuery || skillset) && (
            <button
              type="button"
              onClick={resetFilters}
              className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:bg-bg-subtle"
            >
              Reset
            </button>
          )}
        </form>

        {/* Skillset filter chips */}
        {skillsets.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setSkillset("")}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                skillset === ""
                  ? "bg-primary text-primary-foreground"
                  : "border border-border text-muted-foreground hover:bg-bg-subtle"
              }`}
            >
              All
            </button>
            {skillsets.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSkillset(s.id)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  skillset === s.id
                    ? "bg-primary text-primary-foreground"
                    : "border border-border text-muted-foreground hover:bg-bg-subtle"
                }`}
              >
                {s.name}
                {s.skillCount > 0 && <span className="ml-1 opacity-60">{s.skillCount}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-lg border border-border bg-bg-subtle"
            />
          ))}
        </div>
      ) : results.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          No skills
          {activeQuery ? ` matching “${activeQuery}”` : skillset ? ` in “${skillset}”` : " found"}.
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {total} skill{total === 1 ? "" : "s"}
          </p>
          {results.map((r) => (
            <div
              key={r.id}
              onClick={() => loadContent(r.id)}
              className="group cursor-pointer rounded-lg border border-border p-3 transition hover:border-ring"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {SOURCE_ICON[r.source] || "•"}
                  </span>
                  <span className="text-sm font-medium text-foreground">{r.name}</span>
                  {r.source !== "builtin" && (
                    <span className="rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                      {r.source}
                    </span>
                  )}
                </div>
                <span className="rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {r.domain}
                </span>
              </div>
              {r.description && (
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{r.description}</p>
              )}
              {r.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {r.tags.slice(0, 6).map((tag) => (
                    <span
                      key={tag}
                      className="rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] text-muted-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {/* Lazy-load sentinel: loads the next page automatically when near. */}
          {hasMore ? (
            <div ref={sentinelRef} className="flex items-center justify-center py-4">
              {loadingMore ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary" />
                  Loading more skills…
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {results.length} of {total} loaded — scroll for more
                </span>
              )}
            </div>
          ) : (
            <div ref={sentinelRef} aria-hidden />
          )}
        </div>
      )}

      {/* Preview pane */}
      {selected && (
        <div className="rounded-lg border border-border bg-bg-subtle/30">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">{selected.name}</span>
              <span className="text-[10px] text-muted-foreground">{selected.revision}</span>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </div>
          <div className="max-h-96 overflow-auto p-4">
            {loadingContent ? (
              <div className="h-24 animate-pulse rounded bg-bg-subtle" />
            ) : selected.content ? (
              <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">
                {selected.content}
              </pre>
            ) : (
              <p className="text-xs text-muted-foreground">No content available for this skill.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
