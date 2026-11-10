// Minimal Prometheus exporter for Intel GPUs, driven by the HOST's own
// `intel_gpu_top -J` (run through chroot /host, so no third-party tooling ships
// in the image). Serves /metrics on $PORT (default 9496).
//
// Metrics (gauges, no labels besides `engine`; Prometheus adds hostname/uuid):
//   intel_gpu_busy_percent                busiest engine, 0..100
//   intel_gpu_engine_busy_percent{engine} per engine class, 0..100
//   intel_gpu_power_watts                 GPU power domain
//   intel_gpu_package_power_watts         package power domain
//   intel_gpu_frequency_mhz{type}         actual / requested
//   intel_gpu_rc6_percent                 idle residency
//   intel_gpu_exporter_up                 1 while samples are fresh
// A sample older than STALE_MS is never served (metrics disappear instead of lying).
import { spawn } from "node:child_process";
import http from "node:http";

const PORT = Number(process.env.PORT || 9496);
const DEVICE = process.env.INTEL_GPU_DEVICE || "pci:slot=0000:00:02.0";
const BIN = process.env.INTEL_GPU_TOP || "/run/current-system/sw/bin/intel_gpu_top";
const INTERVAL_MS = Number(process.env.SAMPLE_MS || 2000);
const STALE_MS = INTERVAL_MS * 5;

let latest = null;
let latestAt = 0;

function startSampler() {
  const child = spawn("chroot", ["/host", BIN, "-J", "-s", String(INTERVAL_MS), "-d", DEVICE], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const ch of chunk) {
      buf += ch;
      const i = buf.length - 1;
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          try {
            latest = JSON.parse(buf.slice(start, i + 1));
            latestAt = Date.now();
          } catch {
            // partial / malformed object: skip
          }
          buf = "";
          start = -1;
        }
      }
    }
    if (depth === 0 && start < 0 && buf.length > 4096) buf = "";
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  child.on("exit", (code) => {
    console.error(`intel_gpu_top exited (${code}); restarting in 5s`);
    setTimeout(startSampler, 5000);
  });
}

const num = (v) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

function render() {
  const out = [];
  const fresh = latest && Date.now() - latestAt <= STALE_MS;
  out.push("# TYPE intel_gpu_exporter_up gauge", `intel_gpu_exporter_up ${fresh ? 1 : 0}`);
  if (!fresh) return out.join("\n") + "\n";
  const s = latest;
  const engines = s.engines && typeof s.engines === "object" ? s.engines : {};
  let busiest = null;
  const engineLines = [];
  for (const [name, e] of Object.entries(engines)) {
    const busy = num(e?.busy);
    if (busy == null) continue;
    engineLines.push(`intel_gpu_engine_busy_percent{engine="${esc(name)}"} ${busy}`);
    busiest = busiest == null ? busy : Math.max(busiest, busy);
  }
  if (busiest != null) {
    out.push("# TYPE intel_gpu_busy_percent gauge", `intel_gpu_busy_percent ${busiest}`);
    out.push("# TYPE intel_gpu_engine_busy_percent gauge", ...engineLines);
  }
  const gpuW = num(s.power?.GPU);
  const pkgW = num(s.power?.Package);
  if (gpuW != null) out.push("# TYPE intel_gpu_power_watts gauge", `intel_gpu_power_watts ${gpuW}`);
  if (pkgW != null)
    out.push("# TYPE intel_gpu_package_power_watts gauge", `intel_gpu_package_power_watts ${pkgW}`);
  const fa = num(s.frequency?.actual);
  const fr = num(s.frequency?.requested);
  if (fa != null || fr != null) {
    out.push("# TYPE intel_gpu_frequency_mhz gauge");
    if (fa != null) out.push(`intel_gpu_frequency_mhz{type="actual"} ${fa}`);
    if (fr != null) out.push(`intel_gpu_frequency_mhz{type="requested"} ${fr}`);
  }
  const rc6 = num(s.rc6?.value);
  if (rc6 != null) out.push("# TYPE intel_gpu_rc6_percent gauge", `intel_gpu_rc6_percent ${rc6}`);
  return out.join("\n") + "\n";
}

http
  .createServer((req, res) => {
    if (req.url === "/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(render());
    } else if (req.url === "/healthz") {
      res.writeHead(200);
      res.end("ok\n");
    } else {
      res.writeHead(404);
      res.end();
    }
  })
  .listen(PORT, () => console.log(`intel-gpu-exporter on :${PORT} (${DEVICE})`));

startSampler();
