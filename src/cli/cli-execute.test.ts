import { Command } from "commander";
import pc from "picocolors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandError } from "./command-error";

const mocks = vi.hoisted(() => ({
  thrown: undefined as unknown,
  telemetry: {
    start: vi.fn<(command: string) => void>(),
    complete: vi.fn<(exitCode?: number) => Promise<void>>(),
    fail: vi.fn<(error: unknown) => Promise<void>>(),
  },
  loggerError: vi.fn<(mod: string, message: string) => void>(),
}));

// preAction's background checks touch the real home; keep them inert.
vi.mock("../version/update-check", () => ({ checkForUpdates: vi.fn() }));
vi.mock("../version/skill-update-check", () => ({ checkForSkillUpdates: vi.fn() }));
vi.mock("../version/pending-tasks-check", () => ({ checkForReadyTasks: vi.fn() }));
vi.mock("../version/mcp-refresh-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version/mcp-refresh-check")>()),
  checkForMcpRefresh: vi.fn(),
}));

vi.mock("../telemetry/settings", () => ({
  loadTelemetrySettings: () => ({ install_id: "11111111-1111-4111-8111-111111111111" }),
  isTelemetryEnabled: () => true,
  getOrCreateInstallID: () => "11111111-1111-4111-8111-111111111111",
}));
vi.mock("../telemetry/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../telemetry/telemetry")>()),
  createCommandTelemetry: () => mocks.telemetry,
}));

// A stand-in `deployments` command whose action throws whatever the test planted.
vi.mock("../commands/deployments", () => ({
  deploymentsCommand: () =>
    new Command("deployments").command("list").action(() => {
      throw mocks.thrown;
    }).parent,
}));

vi.mock("../debug/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../debug/logger")>();
  return {
    ...actual,
    logger: { ...actual.logger, init: vi.fn(), error: mocks.loggerError },
  };
});

import { execute } from "./cli";

let originalArgv: string[];
let events: string[];
let stderr: ReturnType<typeof vi.spyOn>;
let stdout: ReturnType<typeof vi.spyOn>;
let exit: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  originalArgv = process.argv;
  events = [];
  mocks.thrown = undefined;
  mocks.telemetry.start.mockReset();
  mocks.telemetry.complete.mockReset().mockResolvedValue(undefined);
  mocks.telemetry.fail.mockReset().mockImplementation(async () => {
    events.push("telemetry.fail");
  });
  mocks.loggerError.mockReset();
  stderr = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    events.push(`stderr:${args.map((a) => (typeof a === "string" ? a : "<value>")).join(" ")}`);
  });
  stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    events.push(`exit:${code}`);
  }) as never);
});

afterEach(() => {
  process.argv = originalArgv;
  stderr.mockRestore();
  stdout.mockRestore();
  exit.mockRestore();
});

async function run(...args: string[]): Promise<void> {
  process.argv = ["node", "dosu", ...args];
  await execute();
}

describe("execute failure boundary", () => {
  it("prints a CommandError, records one failure event, then exits 1", async () => {
    const error = new CommandError("DEPLOYMENT_AMBIGUOUS", "Ambiguous prefix", ["  a", "  b"]);
    mocks.thrown = error;

    await run("deployments", "list");

    expect(mocks.telemetry.start).toHaveBeenCalledWith("deployments list", expect.anything());
    expect(mocks.telemetry.fail).toHaveBeenCalledExactlyOnceWith(error);
    expect(mocks.telemetry.complete).not.toHaveBeenCalled();
    expect(events).toEqual([
      `stderr:${pc.red("Ambiguous prefix")}`,
      `stderr:${pc.dim("  a")}`,
      `stderr:${pc.dim("  b")}`,
      "telemetry.fail",
      "exit:1",
    ]);
    expect(mocks.loggerError).toHaveBeenCalledWith("cli", "CommandError: Ambiguous prefix");
  });

  it("prints a thrown tRPC error with its request ID and keeps it in the debug log", async () => {
    mocks.thrown = Object.assign(new Error("Internal server error"), {
      name: "TRPCClientError",
      data: {
        code: "INTERNAL_SERVER_ERROR",
        path: "workspaces.listForOrg",
        httpStatus: 500,
        requestId: "iad1::req-1",
      },
    });

    await run("deployments", "list");

    const diagnostics =
      "code=INTERNAL_SERVER_ERROR path=workspaces.listForOrg status=500 request_id=iad1::req-1";
    expect(events).toEqual([
      "stderr:Internal server error",
      `stderr:${diagnostics}`,
      "telemetry.fail",
      "exit:1",
    ]);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "cli",
      `TRPCClientError: Internal server error (${diagnostics})`,
    );
  });

  it("routes a real prerequisite failure through the same boundary", async () => {
    // vitest.setup.ts points the config at an empty temporary directory: nobody is logged in.
    await run("review", "list", "--json");

    expect(mocks.telemetry.fail).toHaveBeenCalledOnce();
    expect(mocks.telemetry.fail.mock.calls[0]?.[0]).toMatchObject({ code: "NOT_LOGGED_IN" });
    expect(events.at(-1)).toBe("exit:1");
    expect(events[0]).toBe(`stderr:${pc.red("Not logged in. Run 'dosu login' first.")}`);
  });

  it("still exits 1 when a thrown value cannot even be logged", async () => {
    mocks.thrown = {
      toString() {
        throw new Error("hostile");
      },
    };
    mocks.loggerError.mockImplementation(() => {
      throw new Error("log write failed");
    });

    await run("deployments", "list");

    expect(mocks.telemetry.fail).toHaveBeenCalledOnce();
    expect(events.at(-1)).toBe("exit:1");
  });

  it("does not exit or report a failure when the command succeeds", async () => {
    await run("mcp", "list");

    expect(exit).not.toHaveBeenCalled();
    expect(mocks.telemetry.fail).not.toHaveBeenCalled();
    expect(mocks.telemetry.complete).toHaveBeenCalledExactlyOnceWith(0);
  });
});
