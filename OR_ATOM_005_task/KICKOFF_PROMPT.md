# Menagerie kickoff — OR-ATOM-005

Implement **OR-ATOM-005: Real Fleet GPU Telemetry & Model Attribution**, using `CONTEXT.md` and the included current screenshot.

**HARD FREEZE:** Do not change camera, zoom, framing, layout, positioning, labels, controls, current nucleus/orbital/electrical visual styling, or the working 2D fallback. The visual state in the screenshot is the accepted baseline. This is a **data integration** pass, not a visual redesign.

Inspect the CURRENT LOCAL OmniRoute worktree before coding. The published repository may be behind. The Fleet Telemetry Gateway, native OmniRoute adapter and authenticated `/api/telemetry/fleet` route already exist; reuse them. The gap is actual external GPU/runtime source adapters, stable provider→runtime→GPU model associations, one bounded frontend consumer, and binding measured TPS/queue/model data into existing visual encodings.

Start with parallel **read-only** investigations: (1) existing central Grafana/Prometheus/InfluxDB2 sources over the authorized fleet/WireGuard setup; (2) vLLM/llama.cpp/MLX/Ollama runtime metrics and stable device identifiers; (3) topology-domain/renderer integration; (4) security/testing. Ask workers for concise source-backed findings, not massive file dumps. Use isolated file ownership for subsequent implementation work.

Choose the simplest genuinely existing central metrics source; Grafana's datasource-query API is fine if it unifies your actual datasources. **Never** scrape dashboard HTML or issue browser-to-host/per-GPU queries. Credentials stay server-side and queries are allowlisted. Do not install a new fleet telemetry stack unless an audited gap warrants it, and do not make infrastructure changes without explicit approval.

Implement T5.0–T5.5. Preserve the single visibility-gated request lifecycle socket; poll one normalized fleet snapshot only while Atomic is visible. Canonical join keys must establish host/runtime/GPU UUID/model/provider associations. Do not invent GPU atoms or distribute aggregate runtime TPS across multiple GPUs without evidence.

Map: **measured output tokens/sec → nucleus spin; measured runtime scheduler pending jobs → vibration; proven model residency/assignments → up to three nucleus colors; existing lifecycle events → lane/electrical effects.** Keep provider limiter queues and retrospective call-log TPS explicitly distinct from actual GPU scheduler queue and instantaneous device throughput. Unknown/stale remains unknown, not zero.

Test with 0/1/multiple GPUs, multiple runtimes, missing attribution, model hot swaps, stale samples, auth failures and telemetry outages. Validate the UI with a real workload if authorized and available, capture screenshots, and verify the **camera/layout/labels/effects are unchanged**. Run tests and report connected data sources versus blockers truthfully.

**Continue autonomously through code, tests and evidence. Do not stop after the audit or plan. Do not revisit visual layout.**
