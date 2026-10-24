/**
 * Ponytail Plugin — lazy senior dev mode.
 *
 * Ported from dietrichgebert/ponytail (MIT). Two hooks:
 *  - onRequest: injects a mode-filtered Ponytail system message into the request body.
 *  - onStreamComplete: appends a JSONL "band" row per completed stream (fire-and-forget).
 *
 * Config reaches the child in-band via ctx.config / payload.config (the manager
 * wrapper injects the live DB config). No env vars, no file reads for config.
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const RUNTIME_MODES = ["off", "lite", "full", "ultra"];
const DEFAULT_MODE = "full";

// ── Embedded SKILL.md body (frontmatter stripped) — the lazy senior dev rules ──
const SKILL_BODY =
  '# Ponytail\n\nYou are a lazy senior developer. The best code is the code never written. You solve the whole problem with the least new code. End your reply with one or two lines: what you skipped or did not check, and any risk the user must know.\n\nActive for the whole session until the user says "stop ponytail" or "normal mode". Switch level: \\`/ponytail lite|full|ultra\\`.\n\n## Before you write\n\nRead the task and the code it touches. List every place your change must reach: callers, tests, fixtures, config, exports. Check what your change could break for users: data it would destroy or expose, callers that stop working. That is scope. Extra features are not.\n\n## The smallest complete change\n\nTake the first option that fully works:\n\n1. Does it need to exist? Skip features, options and flexibility nobody asked for, and name them in one line. A vague request ("build me X") gets the smallest version that does the core job.\n2. Already in this codebase (a helper, component, service, pattern)? Use it the way the surrounding code does.\n3. Standard library or a platform feature? Use it, unless the project has its own. A house component beats a native widget.\n4. An installed dependency? Use it. Never add a dependency for a few lines.\n5. Can it be one line a reader gets at a glance? One line.\n6. Otherwise: the minimum code that works.\n\n- Be lazy about the solution, never about the change itself: finish every part the task needs, including the callers, tests and fixtures your change breaks.\n- No abstraction, wrapper, type conversion, option, config, boilerplate or "for later" code nobody asked for. Keep values in the form the platform already gives you. Deletion beats addition. Keep the structure the codebase already has: its layers, interfaces and conventions.\n- The shortest working diff wins, once you know everything it must touch. A one-liner that needs decoding is not short.\n- Comment only the why the code cannot show, in one line.\n- Bug fix: before you edit, grep every caller of the function you touch, then fix the root cause once in the shared code.\n- Code you move or merge keeps its error handling and validation.\n- Between options of equal size, take the one that is correct on edge cases.\n- Lazy code without its check is unfinished: new non-trivial logic (a branch, a loop, a parser, money or security, or a whole new script or app) leaves one small test or an assert-based self-check. Trivial changes need none.\n- A shortcut with a known limit gets a code comment in this form: \\`shortcut: <the limit>, <when to upgrade>\\`.\n\nNever cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility, the calibration real hardware needs, anything the user asked for.\n\n## Levels\n\n| Level | Behavior |\n|-------|----------|\n| **lite** | Build what was asked. Name the smaller option in one line and let the user pick. |\n| **full** | The rules above. Default. |\n| **ultra** | Also question the request: before building, push back on any part the need does not justify. |';

function normalizeMode(mode) {
  if (typeof mode !== "string") return null;
  const n = mode.trim().toLowerCase();
  return RUNTIME_MODES.includes(n) ? n : null;
}

/**
 * Keep only the mode-specific lines for the effective mode.
 *
 * Only the intensity-table rows and the worked-example bullets are mode-specific,
 * and both are keyed by a mode name (lite/full/ultra). Any other line — including
 * a rule bullet that merely *starts* with a mode word — is a normal rule and must
 * be kept verbatim. (Ported from ponytail-instructions.js:filterSkillBodyForMode.)
 */
function filterSkillBodyForMode(bodyText, mode) {
  const effectiveMode = normalizeMode(mode) || DEFAULT_MODE;
  return String(bodyText || "")
    .split(/\r?\n/)
    .filter((line) => {
      const tableLabel = line.match(/^\|\s*\*\*(.+?)\*\*\s*\|/);
      if (tableLabel) {
        const labelMode = normalizeMode(tableLabel[1].trim());
        if (labelMode) return labelMode === effectiveMode;
      }
      const exampleLabel = line.match(/^-[ ]*([^:]+):[ ]*"/);
      if (exampleLabel) {
        const labelMode = normalizeMode(exampleLabel[1].trim());
        if (labelMode) return labelMode === effectiveMode;
      }
      return true;
    })
    .join("\n");
}

function buildSystemMessage(mode) {
  const body = filterSkillBodyForMode(SKILL_BODY, mode);
  return (
    "PONYTAIL MODE ACTIVE — level: " +
    mode +
    "\n\n" +
    body +
    "\n\n(Injected by the OmniRoute ponytail plugin.)"
  );
}

/**
 * onRequest — inject the Ponytail system message into body.messages.
 *
 * Appends to an existing leading system message when present, else prepends one.
 * Mode "off" or inject=false → no-op. Returns { body } so emitHookBlocking chains
 * the mutation. Never throws.
 */
export function onRequest(ctx) {
  try {
    const config = (ctx && ctx.config) || {};
    const mode = normalizeMode(config.mode) || DEFAULT_MODE;
    if (mode === "off" || config.inject === false) return;
    const body = ctx && ctx.body;
    if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return;

    const msg = buildSystemMessage(mode);
    const existing = body.messages.find((m) => m && typeof m === "object" && m.role === "system");
    if (existing && typeof existing.content === "string") {
      existing.content = existing.content + "\n\n" + msg;
    } else {
      body.messages = [{ role: "system", content: msg }, ...body.messages];
    }
    return { body };
  } catch {
    // onRequest is blocking; a throwing plugin would abort the request. Swallow.
    return;
  }
}

function ledgerPath(config) {
  const dir =
    (typeof config.ledgerDir === "string" && config.ledgerDir.trim()) ||
    join(tmpdir(), "omniroute", "ponytail");
  return join(dir, "band.jsonl");
}

/**
 * onStreamComplete — fire-and-forget. Append a JSONL band row; POST it to the
 * webhook. Sync fs append so rows survive a SIGTERM during deactivate.
 * Cost is omitted — the payload carries no pricing data. Never throws.
 */
export function onStreamComplete(payload) {
  try {
    const config = (payload && payload.config) || {};
    if (config.ledger === false) return;

    const p = payload || {};
    const row = {
      ts: new Date().toISOString(),
      model: p.model ?? null,
      provider: p.provider ?? null,
      status: typeof p.status === "number" ? p.status : null,
      requestId: p.requestId ?? null,
      usage: p.usage ?? null,
      ttftMs: p.timing && typeof p.timing.ttft === "number" ? p.timing.ttft : null,
      latencyMs: p.timing && typeof p.timing.latencyMs === "number" ? p.timing.latencyMs : null,
    };

    const path = ledgerPath(config);
    if (!existsSync(join(path, ".."))) mkdirSync(join(path, ".."), { recursive: true });
    appendFileSync(path, JSON.stringify(row) + "\n", "utf-8");

    const url = typeof config.webhookUrl === "string" ? config.webhookUrl.trim() : "";
    if (url) {
      const headers = { "content-type": "application/json" };
      if (typeof config.webhookToken === "string" && config.webhookToken.trim()) {
        headers.authorization = "Bearer " + config.webhookToken.trim();
      }
      fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(row),
      }).catch(() => {});
    }
  } catch {
    // onStreamComplete is NOTIFICATION_HOOKS — a throw is dropped by the runner,
    // but never throw so we can't drop the delivery mid-append.
  }
}
