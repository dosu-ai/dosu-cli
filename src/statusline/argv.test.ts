import { describe, expect, it } from "vitest";
import { agentFromArgv, isStatuslineRenderArgv } from "./argv";

describe("isStatuslineRenderArgv", () => {
  it("matches the render subcommand path after the runtime and script", () => {
    expect(
      isStatuslineRenderArgv([
        "bun",
        "index.ts",
        "knowledge",
        "statusline",
        "render",
        "--agent",
        "claude",
      ]),
    ).toBe(true);
    expect(isStatuslineRenderArgv(["node", "dosu", "knowledge", "statusline", "render"])).toBe(
      true,
    );
  });

  it("ignores every other invocation", () => {
    expect(isStatuslineRenderArgv(["node", "dosu"])).toBe(false);
    expect(isStatuslineRenderArgv(["node", "dosu", "knowledge", "statusline", "enable"])).toBe(
      false,
    );
    expect(isStatuslineRenderArgv(["node", "dosu", "knowledge", "sync"])).toBe(false);
  });
});

describe("agentFromArgv", () => {
  it("reads both flag spellings", () => {
    expect(agentFromArgv(["--agent", "claude"])).toBe("claude");
    expect(agentFromArgv(["--agent=cursor"])).toBe("cursor");
  });

  it("is empty when the flag is missing or dangling", () => {
    expect(agentFromArgv([])).toBe("");
    expect(agentFromArgv(["--agent"])).toBe("");
  });
});
