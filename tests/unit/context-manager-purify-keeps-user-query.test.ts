import { test } from "node:test";
import assert from "node:assert/strict";
import { compressContext } from "../../open-sse/services/contextManager.ts";

/**
 * Live regression (2026-10-29, https://omniroute.celestium.life).
 *
 * A long agent loop (user ask, then dozens of assistant tool_call -> tool result
 * pairs) grew past the context limit. Layer-3 purifyHistory() keeps a pure
 * suffix window of the tail, so the compressed transcript contained ONLY
 * system/assistant/tool roles — the user ask was dropped entirely:
 *
 *   role counts: {"system":1,"assistant":75,"tool":75}   <-- no "user"
 *
 * vLLM (Qwen chat template) rejects that with HTTP 400:
 *   [400]: chat template: No user query found in messages.
 *
 * The repeat 400s then locked the model out of the vllm connection, pushing
 * every request to the Bedrock fallback — the "locking up" the operator saw.
 *
 * purifyHistory() must therefore never return a transcript whose kept window
 * has no user turn: the most recent dropped user ask is re-inserted directly
 * below the leading system message.
 */

const USER_ASK = "fix the flake.lock update and rerun the checks";

function systemMessage() {
  return { role: "system", content: "You are an AI agent running in OpenCode." };
}

/** One assistant tool_call -> tool result pair, padded to force compression. */
function toolPair(i: number) {
  return [
    {
      role: "assistant",
      content: `step ${i}: ${"y".repeat(3_000)}`,
      tool_calls: [
        {
          id: `call_${i}`,
          type: "function",
          function: { name: "shell", arguments: JSON.stringify({ command: `echo ${i}` }) },
        },
      ],
    },
    { role: "tool", tool_call_id: `call_${i}`, content: `ok ${i} ${"z".repeat(3_000)}` },
  ];
}

function agentLoop(turns: number) {
  return Array.from({ length: turns }, (_, i) => toolPair(i)).flat();
}

function run(messages: Array<Record<string, unknown>>) {
  // ~120k chars of history against a 5k target forces Layer-3 purify_history.
  return compressContext(
    { model: "qwen3.8-27b-nvfp4", messages },
    { maxTokens: 5_000, reserveTokens: 0 }
  );
}

test("purify_history keeps a user turn when the tail window is all assistant/tool", () => {
  const body = {
    model: "qwen3.8-27b-nvfp4",
    messages: [systemMessage(), { role: "user", content: USER_ASK }, ...agentLoop(20)],
  };

  const out = run(body.messages) as {
    body: { messages: Array<Record<string, unknown>> };
    compressed: boolean;
  };

  assert.equal(out.compressed, true, "fixture must trigger compression");
  const messages = out.body.messages;
  const userTurns = messages.filter((m) => m.role === "user");

  assert.equal(userTurns.length, 1, "exactly one user turn must survive compression");
  assert.equal(userTurns[0].content, USER_ASK, "the dropped user ask must be restored verbatim");
  assert.equal(messages[0].role, "system", "system message must stay at index 0");
  assert.equal(messages[1].role, "user", "the restored user ask belongs below the system message");
});

test("purify_history restored user turn does not duplicate the compression notice", () => {
  const body = {
    model: "qwen3.8-27b-nvfp4",
    messages: [systemMessage(), { role: "user", content: USER_ASK }, ...agentLoop(20)],
  };

  const out = run(body.messages) as { body: { messages: Array<Record<string, unknown>> } };
  const messages = out.body.messages;

  const notices = messages.filter(
    (m) => typeof m.content === "string" && m.content.includes("[Context compressed:")
  );
  assert.equal(notices.length, 1, "the dropped-notice must appear exactly once");
  assert.equal(notices[0].role, "system", "the dropped-notice must stay on the system message");
});

test("purify_history leaves an in-window user turn alone (no duplicate injection)", () => {
  const body = {
    model: "qwen3.8-27b-nvfp4",
    messages: [
      systemMessage(),
      { role: "user", content: USER_ASK },
      ...agentLoop(20),
      { role: "user", content: "and then run the full test suite" },
    ],
  };

  const out = run(body.messages) as { body: { messages: Array<Record<string, unknown>> } };
  const messages = out.body.messages;
  const userTurns = messages.filter((m) => m.role === "user");

  assert.equal(userTurns.length, 1, "the surviving in-window user turn must not be duplicated");
  assert.equal(userTurns[0].content, "and then run the full test suite");
});

test("purify_history keeps every surviving tool result attached to its tool_call", () => {
  const body = {
    model: "qwen3.8-27b-nvfp4",
    messages: [systemMessage(), { role: "user", content: USER_ASK }, ...agentLoop(20)],
  };

  const out = run(body.messages) as { body: { messages: Array<Record<string, unknown>> } };
  const messages = out.body.messages;

  const declared = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls as Array<{ id?: string }>) {
        if (tc.id) declared.add(tc.id);
      }
    }
  }
  for (const msg of messages) {
    if (msg.role === "tool") {
      assert.ok(
        declared.has(msg.tool_call_id as string),
        `orphan tool result ${String(msg.tool_call_id)} survived compression`
      );
    }
  }
});
