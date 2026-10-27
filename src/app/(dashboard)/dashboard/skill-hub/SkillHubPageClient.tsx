"use client";

import { useEffect, useState } from "react";

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

  // Browse / search — fetch on change. `loading` starts true (initial skeleton)
  // and is only flipped off in the promise callback; no synchronous setState in
  // the effect body (react-hooks/set-state-in-effect). Re-fetches replace the
  // previous results in place — the catalog is local and fast.
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    params.set("query", activeQuery);
    params.set("limit", activeQuery ? "20" : "100");
    if (skillset) params.set("skillset", skillset);
    fetch(`/api/skills/catalog?${params.toString()}`)
      .then((res) => res.json())
      .then((data: { count?: number; results?: CatalogResult[]; error?: string }) => {
        if (cancelled) return;
        if (data.error && (!data.results || data.results.length === 0)) {
          setError(data.error);
          setResults([]);
          setTotal(0);
        } else {
          setError(null);
          setResults(data.results || []);
          setTotal(data.count ?? (data.results?.length || 0));
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setResults([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeQuery, skillset]);

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
