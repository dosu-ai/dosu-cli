import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  action: vi.fn<() => void>(),
  checkForReadyTasks: vi.fn<() => void>(),
  checkForSkillUpdates: vi.fn<() => void>(),
  checkForUpdates: vi.fn<() => Promise<void>>(),
  loggerInit: vi.fn<() => void>(),
}));

vi.mock("../version/update-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version/update-check")>()),
  checkForUpdates: mocks.checkForUpdates,
}));

vi.mock("../version/skill-update-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version/skill-update-check")>()),
  checkForSkillUpdates: mocks.checkForSkillUpdates,
}));

vi.mock("../version/pending-tasks-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version/pending-tasks-check")>()),
  checkForReadyTasks: mocks.checkForReadyTasks,
}));

vi.mock("../debug/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../debug/logger")>();
  return {
    ...actual,
    logger: {
      ...actual.logger,
      init: mocks.loggerInit,
    },
  };
});

import { createProgram } from "./cli";

let originalNodeEnv: string | undefined;
let originalCI: string | undefined;
let originalArgv: string[];
let originalExitCode: typeof process.exitCode;

function restoreEnv(name: "NODE_ENV" | "CI", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function runCommand(name: "logs" | "upgrade"): Promise<void> {
  process.argv = ["node", "dosu", name];
  const program = createProgram();
  const command = program.commands.find((candidate) => candidate.name() === name);
  if (!command) throw new Error(`Missing ${name} command`);

  command.action(mocks.action);
  program.exitOverride();
  await program.parseAsync(process.argv);
}

beforeEach(() => {
  originalNodeEnv = process.env.NODE_ENV;
  originalCI = process.env.CI;
  originalArgv = process.argv;
  originalExitCode = process.exitCode;

  process.env.NODE_ENV = "production";
  delete process.env.CI;
  process.exitCode = undefined;

  vi.resetAllMocks();
  mocks.checkForUpdates.mockResolvedValue(undefined);
});

afterEach(() => {
  restoreEnv("NODE_ENV", originalNodeEnv);
  restoreEnv("CI", originalCI);
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
});

describe("createProgram background checks", () => {
  it("awaits the registry check before skill, task, and command execution", async () => {
    const events: string[] = [];
    let finishRegistryCheck: (() => void) | undefined;
    let commandFinished = false;

    mocks.checkForUpdates.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          events.push("registry:start");
          finishRegistryCheck = () => {
            events.push("registry:end");
            resolve();
          };
        }),
    );
    mocks.checkForSkillUpdates.mockImplementation(() => events.push("skill"));
    mocks.checkForReadyTasks.mockImplementation(() => events.push("task"));
    mocks.action.mockImplementation(() => events.push("action"));

    const command = runCommand("logs").then(() => {
      commandFinished = true;
    });

    await vi.waitFor(() => expect(mocks.checkForUpdates).toHaveBeenCalledOnce());
    expect(events).toEqual(["registry:start"]);
    expect(mocks.checkForSkillUpdates).not.toHaveBeenCalled();
    expect(mocks.checkForReadyTasks).not.toHaveBeenCalled();
    expect(mocks.action).not.toHaveBeenCalled();
    expect(commandFinished).toBe(false);

    if (!finishRegistryCheck) throw new Error("Registry check did not start");
    finishRegistryCheck();
    await command;

    expect(events).toEqual(["registry:start", "registry:end", "skill", "task", "action"]);
  });

  it("skips all background checks for upgrade but still runs its action", async () => {
    await runCommand("upgrade");

    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.checkForSkillUpdates).not.toHaveBeenCalled();
    expect(mocks.checkForReadyTasks).not.toHaveBeenCalled();
    expect(mocks.action).toHaveBeenCalledOnce();
  });

  it("skips the registry check in CI but still runs skill, task, and command execution", async () => {
    const events: string[] = [];
    process.env.CI = "true";
    mocks.checkForSkillUpdates.mockImplementation(() => events.push("skill"));
    mocks.checkForReadyTasks.mockImplementation(() => events.push("task"));
    mocks.action.mockImplementation(() => events.push("action"));

    await runCommand("logs");

    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
    expect(events).toEqual(["skill", "task", "action"]);
  });
});
