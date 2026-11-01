import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { prepareClaudeRequest } from "../../open-sse/translator/helpers/claudeHelper.ts";

// Anthropic-shape upstreams enforce `^[a-zA-Z0-9_-]+$` on tool names. Bedrock is
// the strictest: a replayed history carrying a name with `.`/`:`/`/` (e.g. an MCP
// namespace produced by another provider) fails the whole request with
//
//   [400]: 1 validation error detected: Value at
//   'messages.<n>.member.content.<n>.member.toolUse.name' failed to satisfy
//   constraint: Member must satisfy regular expression pattern: [a-zA-Z0-9_-]+
//
// `prepareClaudeRequest` already sanitizes tool_use/tool_result *ids* for exactly
// this constraint; tool *names* were passed through verbatim.
describe("tool_use.name sanitization for Anthropic-shape upstreams", () => {
  const collectToolUse = (result: { messages?: Array<{ content?: unknown }> }) => {
    const blocks: Array<Record<string, string>> = [];
    for (const msg of result.messages ?? []) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block && typeof block === "object" && block.type === "tool_use") {
          blocks.push(block as Record<string, string>);
        }
      }
    }
    return blocks;
  };

  it("rewrites a replayed tool_use name that Bedrock would reject", () => {
    const input = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "mcp.github/create.issue", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }],
        },
      ],
    };

    const result = prepareClaudeRequest(input) as { messages?: Array<{ content?: unknown }> };
    const [block] = collectToolUse(result);

    assert.ok(block, "tool_use block should survive the pass");
    assert.equal(block.name, "mcp_github_create_issue");
    // The id pairing must be untouched by the name rewrite.
    assert.equal(block.id, "call_1");
  });

  it("leaves already-valid tool_use names untouched", () => {
    const input = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_2", name: "mcp__github__create_issue", input: {} },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_2", content: "ok" }],
        },
      ],
    };

    const result = prepareClaudeRequest(input) as { messages?: Array<{ content?: unknown }> };
    const [block] = collectToolUse(result);

    assert.equal(block?.name, "mcp__github__create_issue");
  });

  it("sanitizes names for every tool_use, not just the first message", () => {
    const input = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_a", name: "a.b", input: {} }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: "1" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_b", name: "c:d", input: {} }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_b", content: "2" }] },
      ],
    };

    const result = prepareClaudeRequest(input) as { messages?: Array<{ content?: unknown }> };
    const names = collectToolUse(result).map((block) => block.name);

    assert.deepEqual(names, ["a_b", "c_d"]);
  });
});
