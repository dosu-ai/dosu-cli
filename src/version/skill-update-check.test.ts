import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readSkillInstallState: vi.fn(),
  installBundledSkills: vi.fn(),
}));

vi.mock("../commands/skill", () => ({
  readSkillInstallState: mocks.readSkillInstallState,
  installBundledSkills: mocks.installBundledSkills,
}));
vi.mock("./version", () => ({ VERSION: "2.0.0" }));

import { checkForSkillUpdates } from "./skill-update-check";

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.readSkillInstallState.mockReset();
  mocks.installBundledSkills.mockReset();
  mocks.installBundledSkills.mockReturnValue({ success: true, version: "2.0.0", paths: [] });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkForSkillUpdates", () => {
  it("does nothing when skills were never installed through the CLI", () => {
    mocks.readSkillInstallState.mockReturnValue(null);

    checkForSkillUpdates();

    expect(mocks.installBundledSkills).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("does nothing when the installed bundle matches the running version", () => {
    mocks.readSkillInstallState.mockReturnValue({
      version: "2.0.0",
      agents: ["claude-code"],
      installedAt: 1,
    });

    checkForSkillUpdates();

    expect(mocks.installBundledSkills).not.toHaveBeenCalled();
  });

  it("rewrites the skills for the previously installed agents after an upgrade", () => {
    mocks.readSkillInstallState.mockReturnValue({
      version: "1.9.0",
      agents: ["claude-code", "cursor"],
      installedAt: 1,
    });

    checkForSkillUpdates();

    expect(mocks.installBundledSkills).toHaveBeenCalledWith(["claude-code", "cursor"]);
    const output = errorSpy.mock.calls[0][0] as string;
    expect(output).toContain("Dosu 2.0.0");
    expect(output).toContain("refreshed the bundled agent skills");
  });

  it("also refreshes after a downgrade so skills match the running binary", () => {
    mocks.readSkillInstallState.mockReturnValue({
      version: "3.0.0",
      agents: ["codex"],
      installedAt: 1,
    });

    checkForSkillUpdates();

    expect(mocks.installBundledSkills).toHaveBeenCalledWith(["codex"]);
  });

  it("stays silent with notify: false (the TUI owns the screen)", () => {
    mocks.readSkillInstallState.mockReturnValue({
      version: "1.9.0",
      agents: ["cursor"],
      installedAt: 1,
    });

    checkForSkillUpdates({ notify: false });

    expect(mocks.installBundledSkills).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("prints nothing when the refresh fails, leaving the marker for a retry", () => {
    mocks.readSkillInstallState.mockReturnValue({
      version: "1.9.0",
      agents: ["cursor"],
      installedAt: 1,
    });
    mocks.installBundledSkills.mockReturnValue({ success: false });

    checkForSkillUpdates();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("never throws out of the pre-action hook", () => {
    mocks.readSkillInstallState.mockImplementation(() => {
      throw new Error("disk on fire");
    });

    expect(() => checkForSkillUpdates()).not.toThrow();
  });
});
