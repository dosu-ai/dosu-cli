import { describe, expect, it } from "vitest";
import type { AgentSession } from "../sessions/scan";
import { buildLearnerPrompt, buildLearnerSystemPrompt } from "./prompt";
import { LEARNER_CORE_RULES } from "./prompt-core";

const sessions: AgentSession[] = [
  { id: "aaa", harness: "claude", path: "/x/a.jsonl", updated: "2026-08-27T00:00:00.000Z" },
  { id: "bbb", harness: "cursor", path: "/x/b.jsonl", updated: "2026-08-27T01:00:00.000Z" },
];

describe("buildLearnerSystemPrompt", () => {
  const prompt = buildLearnerSystemPrompt(LEARNER_CORE_RULES);

  it("encodes the non-negotiable rules", () => {
    expect(prompt).toContain("read_knowledge");
    expect(prompt).toContain("durable");
    expect(prompt).toContain("EXCLUDE in-flight state");
    expect(prompt).toContain("Never infer or guess a repo");
    expect(prompt).not.toContain("metadata");
    expect(prompt).toContain("Never quote credentials");
  });

  it("embeds the given rules verbatim, including the extraction stance", () => {
    expect(prompt).toContain(LEARNER_CORE_RULES);
    expect(prompt).toContain("Under-extracting is the failure mode");
    expect(prompt).toContain("One note per distinct fact");
    expect(buildLearnerSystemPrompt("CUSTOM RULES")).toContain("CUSTOM RULES");
  });
});

describe("buildLearnerPrompt", () => {
  it("scopes the run to the given sessions", () => {
    const prompt = buildLearnerPrompt(sessions);

    expect(prompt).toContain("2 coding-agent session(s)");
    expect(prompt).toContain("- aaa (claude)");
    expect(prompt).toContain("- bbb (cursor)");
  });
});
