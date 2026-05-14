import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitError, emitJSONLine, emitNeedUserAction, emitStep } from "./output";

describe("agent/output", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function lastEmittedJSON(): unknown {
    expect(logSpy).toHaveBeenCalledTimes(1);
    const arg = logSpy.mock.calls[0]?.[0];
    expect(typeof arg).toBe("string");
    return JSON.parse(arg as string);
  }

  it("emitJSONLine writes a single JSON line to stdout", () => {
    emitJSONLine({ hello: "world" });
    expect(lastEmittedJSON()).toEqual({ hello: "world" });
  });

  it("emitNeedUserAction emits a structured handoff event", () => {
    emitNeedUserAction({
      step: "auth",
      url: "https://example.com",
      ticket: "tkt-1",
      resume_command: "dosu setup --agent --tool claude --login-ticket tkt-1",
      expires_in: 600,
      agent_next_steps: "Send the URL.",
    });

    expect(lastEmittedJSON()).toEqual({
      step: "auth",
      status: "need_user_action",
      url: "https://example.com",
      ticket: "tkt-1",
      resume_command: "dosu setup --agent --tool claude --login-ticket tkt-1",
      expires_in: 600,
      agent_next_steps: "Send the URL.",
    });
  });

  it("emitError emits a structured error with reason + next steps", () => {
    emitError({
      step: "deployment",
      reason: "multiple_deployments",
      agent_next_steps: "Ask the user to pick one.",
    });

    expect(lastEmittedJSON()).toEqual({
      step: "deployment",
      status: "error",
      reason: "multiple_deployments",
      agent_next_steps: "Ask the user to pick one.",
    });
  });

  it("emitStep defaults to status=ok and merges extra fields", () => {
    emitStep({
      step: "mcp_install",
      tool: "claude",
      config_path: "/tmp/claude.json",
    });

    expect(lastEmittedJSON()).toEqual({
      step: "mcp_install",
      status: "ok",
      tool: "claude",
      config_path: "/tmp/claude.json",
    });
  });

  it("emitStep allows overriding the status (e.g. for pending)", () => {
    emitStep({
      step: "auth",
      status: "pending",
      agent_next_steps: "Wait.",
    });

    expect(lastEmittedJSON()).toEqual({
      step: "auth",
      status: "pending",
      agent_next_steps: "Wait.",
    });
  });
});
