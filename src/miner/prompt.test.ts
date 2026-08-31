import { describe, expect, it } from "vitest";
import type { AgentSession } from "../sessions/scan";
import { buildMinerPrompt, MINER_SYSTEM_PROMPT } from "./prompt";

const sessions: AgentSession[] = [
  { id: "aaa", harness: "claude", path: "/x/a.jsonl", updated: "2026-08-27T00:00:00.000Z" },
  { id: "bbb", harness: "cursor", path: "/x/b.jsonl", updated: "2026-08-27T01:00:00.000Z" },
];

describe("MINER_SYSTEM_PROMPT", () => {
  it("encodes the non-negotiable rules", () => {
    expect(MINER_SYSTEM_PROMPT).toContain("read_knowledge");
    expect(MINER_SYSTEM_PROMPT).toContain("durable");
    expect(MINER_SYSTEM_PROMPT).toContain("EXCLUDE in-flight state");
    expect(MINER_SYSTEM_PROMPT).toContain("Never infer or guess a repo");
    expect(MINER_SYSTEM_PROMPT).toContain("source_agent and session_id");
    expect(MINER_SYSTEM_PROMPT).toContain("Never quote credentials");
  });
});

describe("buildMinerPrompt", () => {
  it("scopes the run to the given sessions", () => {
    const prompt = buildMinerPrompt(sessions);

    expect(prompt).toContain("2 coding-agent session(s)");
    expect(prompt).toContain("- aaa (claude)");
    expect(prompt).toContain("- bbb (cursor)");
  });
});
