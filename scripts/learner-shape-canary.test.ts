import { describe, expect, it } from "vitest";
import { checkLearnerRequest, PINNED_MODEL } from "./learner-shape-canary";

/** A second-turn request in the shape Claude Code sends when pinned to Haiku 4.5. */
function haikuRequest(): Record<string, unknown> {
  return {
    model: PINNED_MODEL,
    max_tokens: 32000,
    stream: true,
    system: [{ type: "text", text: "placeholder system" }],
    tools: [{ name: "mcp__canary__echo", description: "placeholder", input_schema: {} }],
    metadata: { user_id: "placeholder" },
    thinking: { type: "enabled", budget_tokens: 31999 },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    messages: [
      { role: "user", content: [{ type: "text", text: "placeholder prompt" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "mcp__canary__echo", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "placeholder" },
          { type: "text", text: "placeholder follow-up" },
        ],
      },
    ],
  };
}

function messagesOf(body: Record<string, unknown>): Record<string, unknown>[] {
  return body.messages as Record<string, unknown>[];
}

describe("checkLearnerRequest", () => {
  it("encodes the rules of the model the learner defaults to", () => {
    // The checks are Haiku 4.5's acceptance rules; a new default model needs new rules.
    expect(PINNED_MODEL).toBe("claude-haiku-4-5");
  });

  it("accepts the Haiku-shaped request", () => {
    expect(checkLearnerRequest(haikuRequest())).toEqual([]);
  });

  it("accepts string content, disabled thinking, and no thinking", () => {
    const body = haikuRequest();
    messagesOf(body)[0].content = "placeholder prompt";
    body.thinking = { type: "disabled" };
    expect(checkLearnerRequest(body)).toEqual([]);
    delete body.thinking;
    expect(checkLearnerRequest(body)).toEqual([]);
  });

  it("accepts a non-effort output_config", () => {
    const body = { ...haikuRequest(), output_config: { format: { type: "json_schema" } } };
    expect(checkLearnerRequest(body)).toEqual([]);
  });

  it("rejects a non-object body", () => {
    expect(checkLearnerRequest(undefined)).toEqual(["body is not a JSON object"]);
    expect(checkLearnerRequest([])).toEqual(["body is not a JSON object"]);
  });

  it("flags a model other than the pinned one", () => {
    const body = { ...haikuRequest(), model: "claude-opus-5-5" };
    expect(checkLearnerRequest(body)).toEqual([
      `model is "claude-opus-5-5", expected "${PINNED_MODEL}"`,
    ]);
    expect(checkLearnerRequest(body, "claude-opus-5-5")).toEqual([]);
  });

  it("flags unknown top-level keys", () => {
    const body = { ...haikuRequest(), speed: "fast" };
    expect(checkLearnerRequest(body)).toEqual(['unexpected top-level key "speed"']);
  });

  it("flags system-role messages and extra message keys", () => {
    const body = haikuRequest();
    messagesOf(body).splice(1, 0, {
      role: "system",
      content: "placeholder",
      output_config: { effort: "medium" },
    });
    expect(checkLearnerRequest(body)).toEqual([
      'messages[1].role is "system"',
      'messages[1] has unexpected key "output_config"',
    ]);
  });

  it("flags non-object messages and a non-array messages field", () => {
    const body = haikuRequest();
    messagesOf(body).push("placeholder" as unknown as Record<string, unknown>);
    expect(checkLearnerRequest(body)).toEqual(["messages[3] is not an object"]);
    expect(checkLearnerRequest({ ...haikuRequest(), messages: {} })).toEqual([
      "messages is not an array",
    ]);
  });

  it("flags adaptive thinking", () => {
    const body = { ...haikuRequest(), thinking: { type: "adaptive" } };
    expect(checkLearnerRequest(body)).toEqual(['thinking.type is "adaptive"']);
  });

  it("flags malformed thinking", () => {
    expect(checkLearnerRequest({ ...haikuRequest(), thinking: "enabled" })).toEqual([
      "thinking is not an object",
    ]);
    expect(checkLearnerRequest({ ...haikuRequest(), thinking: { type: "enabled" } })).toEqual([
      "thinking.budget_tokens is not an integer",
    ]);
  });

  it("flags thinking budgets outside [1024, max_tokens)", () => {
    const low = { ...haikuRequest(), thinking: { type: "enabled", budget_tokens: 1023 } };
    expect(checkLearnerRequest(low)).toEqual(["thinking.budget_tokens 1023 is below 1024"]);
    const high = { ...haikuRequest(), thinking: { type: "enabled", budget_tokens: 32000 } };
    expect(checkLearnerRequest(high)).toEqual([
      "thinking.budget_tokens 32000 is not below max_tokens 32000",
    ]);
    const floor = { ...haikuRequest(), thinking: { type: "enabled", budget_tokens: 1024 } };
    expect(checkLearnerRequest(floor)).toEqual([]);
  });

  it("flags output_config.effort", () => {
    const body = { ...haikuRequest(), output_config: { effort: "medium" } };
    expect(checkLearnerRequest(body)).toEqual(["output_config.effort is set"]);
  });

  it("flags missing or oversized max_tokens", () => {
    const body = haikuRequest();
    delete body.max_tokens;
    expect(checkLearnerRequest(body)).toEqual(["max_tokens is missing"]);
    const big = { ...haikuRequest(), max_tokens: 64001 };
    expect(checkLearnerRequest(big)).toEqual(["max_tokens 64001 exceeds 64000"]);
  });

  it("flags tool_result blocks that are not leading", () => {
    const body = haikuRequest();
    const last = messagesOf(body)[2];
    last.content = [...(last.content as unknown[])].reverse();
    expect(checkLearnerRequest(body)).toEqual([
      "messages[2] has a tool_result after non-tool_result content",
    ]);
  });

  it("flags a tool_result with no earlier tool_use", () => {
    const body = haikuRequest();
    const last = messagesOf(body)[2];
    (last.content as Record<string, unknown>[])[0].tool_use_id = "toolu_missing";
    expect(checkLearnerRequest(body)).toEqual([
      "messages[2] has a tool_result with no earlier tool_use",
    ]);
  });

  it("reports every violation of the unpinned Opus shape", () => {
    const body = {
      ...haikuRequest(),
      model: "claude-opus-5-5",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    };
    messagesOf(body).push({ role: "system", content: "placeholder" });
    expect(checkLearnerRequest(body)).toHaveLength(4);
  });
});
