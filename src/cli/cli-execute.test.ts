import { Command } from "commander";
import pc from "picocolors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandError } from "./command-error";

const mocks = vi.hoisted(() => ({
  thrown: undefined as unknown,
  loggerError: vi.fn<(mod: string, message: string) => void>(),
}));

// preAction's background checks touch the real home; keep them inert.
vi.mock("../version/update-check", () => ({ checkForUpdates: vi.fn() }));
vi.mock("../version/mcp-refresh-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version/mcp-refresh-check")>()),
  checkForMcpRefresh: vi.fn(),
}));

// A stand-in `project` command whose action throws whatever the test planted.
vi.mock("../commands/project", () => ({
  projectCommand: () =>
    new Command("project").command("link").action(() => {
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
  it("prints a CommandError with its details, then exits 1", async () => {
    const error = new CommandError("NOT_LOGGED_IN", "Not logged in.", ["  a", "  b"]);
    mocks.thrown = error;

    await run("project", "link");

    expect(events).toEqual([
      `stderr:${pc.red("Not logged in.")}`,
      `stderr:${pc.dim("  a")}`,
      `stderr:${pc.dim("  b")}`,
      "exit:1",
    ]);
    expect(mocks.loggerError).toHaveBeenCalledWith("cli", "CommandError: Not logged in.");
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

    await run("project", "link");

    const diagnostics =
      "code=INTERNAL_SERVER_ERROR path=workspaces.listForOrg status=500 request_id=iad1::req-1";
    expect(events).toEqual(["stderr:Internal server error", `stderr:${diagnostics}`, "exit:1"]);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "cli",
      `TRPCClientError: Internal server error (${diagnostics})`,
    );
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

    await run("project", "link");

    expect(events.at(-1)).toBe("exit:1");
  });

  it("does not exit when the command succeeds", async () => {
    await run("mcp", "list");

    expect(exit).not.toHaveBeenCalled();
  });
});
