/**
 * Atomic detail panel — the opt-in GPU / atom detail overlay (Step 11).
 *
 * Shown only when the viewer explicitly opens the detail view from the
 * tooltip. It is a DOM overlay over the unchanged canvas (the camera flies in
 * through `scene/detailFlight.ts`), so it adds no always-visible chrome and
 * touches no frozen overlay. Every number comes from {@link DetailModel}
 * (real telemetry; "no data" when unobserved). Job panels are rendered only
 * when a real value backs them.
 *
 * Pure React + CSS (no `three`) — safe under jsdom. Escape or the close button
 * leaves the detail view.
 */
import { useEffect, useRef, useState } from "react";
import type { DetailModel } from "../scene/detailState";

const PANEL: React.CSSProperties = {
  position: "absolute",
  top: 36,
  right: 12,
  bottom: 12,
  width: 320,
  maxWidth: "calc(100% - 24px)",
  overflowY: "auto",
  padding: "12px 14px",
  border: "1px solid rgba(34, 211, 238, 0.35)",
  borderRadius: 12,
  background: "rgba(6, 10, 24, 0.82)",
  color: "#e2e8f0",
  font: "12px/1.45 system-ui, sans-serif",
  boxShadow: "0 0 24px -6px rgba(34, 211, 238, 0.35), 0 12px 32px -12px rgba(0, 0, 0, 0.8)",
  backdropFilter: "blur(10px)",
  pointerEvents: "auto",
  zIndex: 6,
};
const SECTION: React.CSSProperties = { marginTop: 12 };
const H: React.CSSProperties = {
  margin: "0 0 4px",
  font: "600 10px/1.2 system-ui, sans-serif",
  letterSpacing: 1.2,
  textTransform: "uppercase",
  color: "#67e8f9",
};
const GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr",
  columnGap: 10,
  rowGap: 2,
  margin: 0,
};

function Rows({ rows }: { rows: ReadonlyArray<{ label: string; value: string }> }) {
  return (
    <dl style={GRID}>
      {rows.map((r) => (
        <div key={r.label} style={{ display: "contents" }}>
          <dt style={{ color: "#94a3b8" }}>{r.label}</dt>
          <dd style={{ margin: 0, textAlign: "right", wordBreak: "break-word" }}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AtomicDetailPanel({
  model,
  onClose,
}: {
  model: DetailModel | null;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const open = model != null;
  // Embedded use (e.g. the 590 px /home canvas): start compact so the panel never hides
  // the atom; the viewer can expand it. Wide hosts (and fullscreen) start expanded.
  const [collapsed, setCollapsed] = useState<boolean | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const measured = useRef(false);
  // Ref callback (not an effect): measure the host once per open, reset on close.
  const attach = (el: HTMLElement | null): void => {
    sectionRef.current = el;
    if (!el) {
      measured.current = false;
      return;
    }
    if (measured.current) return;
    measured.current = true;
    const host = el.closest<HTMLElement>("[data-atomic-host]");
    setCollapsed((host?.clientWidth ?? 1200) < 900);
  };
  const compact = collapsed === true;
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!model) return null;
  const total = Math.max(1, model.totalNucleons);

  return (
    <section
      className="atomic-detail"
      data-atomic-detail="true"
      data-atom-id={model.atomId}
      role="dialog"
      aria-label={`${model.title} detail`}
      data-collapsed={compact ? "true" : "false"}
      ref={attach}
      style={compact ? { ...PANEL, bottom: "auto", width: 220, overflowY: "visible" } : PANEL}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          aria-hidden="true"
          style={{ width: 10, height: 10, borderRadius: 5, background: model.laneHue }}
        />
        <strong style={{ flex: 1, fontSize: 14 }}>{model.title}</strong>
        <span style={{ color: "#94a3b8" }}>{model.kind}</span>
      </div>
      <div style={{ marginTop: 2, color: "#cbd5e1" }} data-detail="activity">
        Activity: {model.activity}
      </div>
      <button
        type="button"
        data-atomic-detail-toggle="true"
        aria-expanded={!compact}
        onClick={() => setCollapsed(!compact)}
        style={{
          marginTop: 6,
          padding: "2px 8px",
          borderRadius: 6,
          border: "1px solid rgba(34, 211, 238, 0.35)",
          background: "transparent",
          color: "#67e8f9",
          cursor: "pointer",
          font: "600 11px system-ui, sans-serif",
        }}
      >
        {compact ? "Show details" : "Hide details"}
      </button>
      {compact ? (
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          style={{
            marginTop: 6,
            marginLeft: 6,
            padding: "2px 8px",
            borderRadius: 6,
            border: "1px solid rgba(34, 211, 238, 0.45)",
            background: "rgba(8, 47, 73, 0.6)",
            color: "#e0f2fe",
            cursor: "pointer",
            font: "600 11px system-ui, sans-serif",
          }}
        >
          Back (Esc)
        </button>
      ) : null}
      {compact ? null : (
        <>
          <div style={SECTION} data-detail="nucleus">
            <h3 style={H}>Nucleus · models</h3>
            <div
              role="img"
              aria-label="Nucleon share by model"
              style={{
                display: "flex",
                height: 8,
                borderRadius: 4,
                overflow: "hidden",
                background: "#334155",
                marginBottom: 6,
              }}
            >
              {model.models.map((m) => (
                <span
                  key={m.model}
                  style={{ width: `${(m.nucleons / total) * 100}%`, background: m.color }}
                />
              ))}
            </div>
            {model.neutralNucleus ? (
              <div style={{ color: "#94a3b8" }}>
                No model observed: neutral two-tone nucleus (nothing is guessed).
              </div>
            ) : (
              <dl style={GRID}>
                {model.models.map((m) => (
                  <div key={m.model} style={{ display: "contents" }}>
                    <dt style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span
                        aria-hidden="true"
                        style={{ width: 8, height: 8, borderRadius: 4, background: m.color }}
                      />
                      {m.model}
                    </dt>
                    <dd style={{ margin: 0, textAlign: "right", color: "#94a3b8" }}>
                      {m.nucleons}/{model.totalNucleons} nucleons · {m.basis}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>

          <div style={SECTION} data-detail="orbital">
            <h3 style={H}>Orbitals · lane</h3>
            <Rows rows={model.orbital} />
          </div>

          {model.deviceFacts.length > 0 ? (
            <div style={SECTION} data-detail="device">
              <h3 style={H}>Device (measured)</h3>
              <Rows rows={model.deviceFacts} />
            </div>
          ) : null}

          {model.jobs.length > 0 ? (
            <div style={SECTION} data-detail="jobs">
              <h3 style={H}>Jobs</h3>
              <dl style={GRID}>
                {model.jobs.map((j) => (
                  <div key={j.key} style={{ display: "contents" }} data-job={j.key}>
                    <dt style={{ color: j.key === "failed" ? "#fca5a5" : "#94a3b8" }}>{j.label}</dt>
                    <dd style={{ margin: 0, textAlign: "right" }}>
                      {j.value} <span style={{ color: "#64748b" }}>({j.basis})</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          <p style={{ ...SECTION, color: "#64748b", fontSize: 10 }}>{model.provenance}</p>
          <button
            ref={compact ? undefined : closeRef}
            type="button"
            onClick={onClose}
            style={{
              marginTop: 10,
              width: "100%",
              padding: "6px 10px",
              borderRadius: 8,
              border: "1px solid rgba(34, 211, 238, 0.45)",
              background: "rgba(8, 47, 73, 0.6)",
              color: "#e0f2fe",
              cursor: "pointer",
              font: "600 12px system-ui, sans-serif",
            }}
          >
            Back to topology (Esc)
          </button>
        </>
      )}
    </section>
  );
}
