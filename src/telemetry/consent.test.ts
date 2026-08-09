import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  isCancel: vi.fn(),
}));

vi.mock("./settings", () => ({
  loadTelemetrySettings: vi.fn(),
  setTelemetryConsents: vi.fn(),
  telemetryDisabledByEnvironment: vi.fn(),
}));

import * as p from "@clack/prompts";
import { promptForTelemetryConsent } from "./consent";
import {
  loadTelemetrySettings,
  setTelemetryConsents,
  telemetryDisabledByEnvironment,
} from "./settings";

const mockSelect = vi.mocked(p.select);
const mockIsCancel = vi.mocked(p.isCancel);
const mockLoadTelemetrySettings = vi.mocked(loadTelemetrySettings);
const mockSetTelemetryConsents = vi.mocked(setTelemetryConsents);
const mockTelemetryDisabledByEnvironment = vi.mocked(telemetryDisabledByEnvironment);

describe("promptForTelemetryConsent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadTelemetrySettings.mockReturnValue({ schema_version: 1 });
    mockSetTelemetryConsents.mockReturnValue(true);
    mockTelemetryDisabledByEnvironment.mockReturnValue(undefined);
    mockIsCancel.mockReturnValue(false);
  });

  it("presents four explicit choices with a concise privacy notice", async () => {
    mockSelect.mockResolvedValue("neither");

    await promptForTelemetryConsent();

    expect(mockSelect).toHaveBeenCalledOnce();
    const prompt = mockSelect.mock.calls[0]?.[0];
    expect(prompt?.options).toEqual([
      { label: "Don't share telemetry", value: "neither" },
      { label: "Share usage analytics and error diagnostics", value: "analytics-and-errors" },
      { label: "Share usage analytics only", value: "analytics-only" },
      { label: "Share error diagnostics only", value: "errors-only" },
    ]);
    expect(prompt?.initialValue).toBe("neither");

    const message = String(prompt?.message).toLowerCase();
    for (const requiredCopy of [
      "prompts",
      "raw command lines",
      "free-form argument",
      "coarse setup choices",
      "source",
      "file contents",
      "local paths",
      "environment",
      "credentials",
      "raw error messages",
      "debug.log",
      "change",
      "random installation id",
      "linked to your dosu account",
      "email",
    ]) {
      expect(message).toContain(requiredCopy);
    }
  });

  it.each([
    ["analytics-and-errors", { analytics: true, errors: true }],
    ["analytics-only", { analytics: true, errors: false }],
    ["errors-only", { analytics: false, errors: true }],
    ["neither", { analytics: false, errors: false }],
  ] as const)("persists the %s choice", async (choice, expected) => {
    mockSelect.mockResolvedValue(choice);

    await promptForTelemetryConsent();

    expect(mockSetTelemetryConsents).toHaveBeenCalledOnce();
    expect(mockSetTelemetryConsents).toHaveBeenCalledWith(expected);
  });

  it("persists neither choice when the prompt is cancelled", async () => {
    mockSelect.mockResolvedValue(Symbol("cancel"));
    mockIsCancel.mockReturnValue(true);

    await promptForTelemetryConsent();

    expect(mockSetTelemetryConsents).toHaveBeenCalledOnce();
    expect(mockSetTelemetryConsents).toHaveBeenCalledWith({ analytics: false, errors: false });
  });

  it("prompts only for the missing lane and preserves an explicit decision", async () => {
    mockLoadTelemetrySettings.mockReturnValue({ schema_version: 1, analytics: true });
    mockSelect.mockResolvedValue("enable");

    await promptForTelemetryConsent();

    expect(mockSelect).toHaveBeenCalledOnce();
    expect(mockSetTelemetryConsents).toHaveBeenCalledWith({ errors: true });
    const prompt = mockSelect.mock.calls[0]?.[0];
    expect(prompt?.options).toEqual([
      { label: "Don't share error diagnostics", value: "disable" },
      { label: "Share error diagnostics", value: "enable" },
    ]);
    expect(prompt?.initialValue).toBe("disable");
  });

  it("discloses account linkage when asking only for missing analytics consent", async () => {
    mockLoadTelemetrySettings.mockReturnValue({ schema_version: 1, errors: false });
    mockSelect.mockResolvedValue("enable");

    await promptForTelemetryConsent();

    const message = String(mockSelect.mock.calls[0]?.[0]?.message).toLowerCase();
    expect(message).toContain("random installation id");
    expect(message).toContain("account");
    expect(message).toContain("email");
    expect(message).toContain("coarse setup choices");
    expect(message).toContain("never raw command lines");
    expect(mockSetTelemetryConsents).toHaveBeenCalledWith({ analytics: true });
  });

  it("does nothing when both consent decisions are already explicit", async () => {
    mockLoadTelemetrySettings.mockReturnValue({
      schema_version: 1,
      analytics: true,
      errors: false,
    });

    await promptForTelemetryConsent();

    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockSetTelemetryConsents).not.toHaveBeenCalled();
  });

  it("does not prompt or persist choices under a master privacy override", async () => {
    mockTelemetryDisabledByEnvironment.mockReturnValue("DO_NOT_TRACK");

    await promptForTelemetryConsent();

    expect(mockLoadTelemetrySettings).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockSetTelemetryConsents).not.toHaveBeenCalled();
  });
});
