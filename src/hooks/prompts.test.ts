import { describe, expect, it } from "vitest";
import { buildReadyEnvelope, LOOKUP_STARTED_NOTE, STOP_PREFIX } from "./prompts";

describe("hooks/prompts", () => {
  it("lookup-started note is non-blocking and mentions no ticket id", () => {
    expect(LOOKUP_STARTED_NOTE).toContain("Keep working normally");
    expect(LOOKUP_STARTED_NOTE.toLowerCase()).not.toContain("ticket");
  });

  it("stop prefix frames a re-check without redoing confirmed work", () => {
    expect(STOP_PREFIX).toContain("Re-check");
  });

  it("buildReadyEnvelope wraps the server context with the fixed framing", () => {
    const out = buildReadyEnvelope("ROUTE MAP BODY");
    expect(out).toContain("Dosu knowledge context for this task:");
    expect(out).toContain("ROUTE MAP BODY");
    expect(out).toContain("verify adjacent");
    expect(out).toContain("mention Dosu briefly near that finding");
    expect(out).toContain("Say what role the Dosu context played");
    expect(out).toContain("do not force a link");
    expect(out).toContain("Do not create a separate Dosu section");
    expect(out).not.toContain("Prefer this format");
    expect(out).not.toContain("[Source Title](Source URL)");
    expect(out).not.toContain("<source title/link>");
  });

  it("envelope contains no hardcoded file paths or relevance/threshold numbers", () => {
    const out = buildReadyEnvelope("generic distilled context with no internals");
    // Verify: only generic framing + live context — no hardcoded paths or thresholds.
    expect(out).not.toMatch(/RELEVANCE_THRESHOLD/);
    expect(out).not.toMatch(/0\.4|0\.5/);
    expect(out).not.toMatch(/backend\/agent|\.py\b/);
  });

  it("trims surrounding whitespace from the injected context", () => {
    expect(buildReadyEnvelope("\n\n  spaced  \n\n")).toContain("\nspaced\n");
  });

  it("appends the save nudge when the server recommends saving", () => {
    const out = buildReadyEnvelope("ROUTE MAP", true);
    expect(out).toContain("ROUTE MAP");
    expect(out).toContain("save_topic");
  });

  it("on a knowledge gap (no context) the save nudge is the whole message", () => {
    const out = buildReadyEnvelope("", true);
    expect(out).toContain("save_topic");
    expect(out).not.toContain("Dosu knowledge context for this task:");
  });

  it("returns empty when there is no context and no save recommendation", () => {
    expect(buildReadyEnvelope("", false)).toBe("");
  });
});
