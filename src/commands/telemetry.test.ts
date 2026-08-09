import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTelemetryEnabled, loadTelemetrySettings } from "../telemetry/settings";
import { telemetryCommand } from "./telemetry";

let tempDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
const originalEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "XDG_CONFIG_HOME",
  "DO_NOT_TRACK",
  "DOSU_TELEMETRY_DISABLED",
  "DOSU_TELEMETRY_DEBUG",
  "DOSU_POSTHOG_PROJECT_TOKEN",
  "DOSU_POSTHOG_PROJECT_TOKEN_OVERRIDE",
  "DOSU_SENTRY_DSN",
  "DOSU_SENTRY_DSN_OVERRIDE",
  "DOSU_DEV",
  "DOSU_WEB_APP_URL",
  "DOSU_WEB_APP_URL_OVERRIDE",
] as const;

async function run(...args: string[]): Promise<void> {
  await telemetryCommand().parseAsync(["node", "telemetry", ...args]);
}

function output(): string {
  return logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dosu-telemetry-command-"));
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.XDG_CONFIG_HOME = tempDir;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  for (const key of ENV_KEYS) {
    const original = originalEnv[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("telemetry command", () => {
  it("reports default-on telemetry and configured destinations without exposing credentials", async () => {
    process.env.DOSU_POSTHOG_PROJECT_TOKEN = "phc_public-project-token";
    process.env.DOSU_SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
    process.env.DOSU_WEB_APP_URL = "https://app.dosu.test";

    await run("status", "--json");

    expect(JSON.parse(output())).toMatchObject({
      schema_version: 1,
      enabled: true,
      destinations: {
        command_analytics: true,
        setup_analytics: true,
        error_diagnostics: true,
      },
      environment_override: null,
      telemetry_id: null,
    });
    expect(output()).not.toContain("phc_public-project-token");
    expect(output()).not.toContain("example.ingest.sentry.io");
  });

  it("reports invalid or management destinations as not configured", async () => {
    process.env.DOSU_POSTHOG_PROJECT_TOKEN = "phx_personal-secret";
    process.env.DOSU_SENTRY_DSN = "https://sntrys_secret@example.ingest.sentry.io/1";

    await run("status", "--json");

    expect(JSON.parse(output())).toMatchObject({
      destinations: {
        command_analytics: false,
        setup_analytics: false,
        error_diagnostics: false,
      },
    });
    expect(output()).not.toContain("personal-secret");
    expect(output()).not.toContain("sntrys_secret");
  });

  it("reports loopback setup separately from HTTPS command analytics in development", async () => {
    process.env.DOSU_DEV = "true";
    process.env.DOSU_WEB_APP_URL = "http://localhost:3001";
    process.env.DOSU_POSTHOG_PROJECT_TOKEN = "phc_public-project-token";

    await run("status", "--json");

    expect(JSON.parse(output())).toMatchObject({
      destinations: { command_analytics: false, setup_analytics: true },
    });
  });

  it("disables and enables all telemetry with one persisted switch", async () => {
    expect(isTelemetryEnabled()).toBe(true);

    await run("disable");
    expect(loadTelemetrySettings()).toEqual({ schema_version: 1, disabled: true });
    expect(isTelemetryEnabled()).toBe(false);

    await run("enable");
    expect(loadTelemetrySettings()).toEqual({ schema_version: 1 });
    expect(isTelemetryEnabled()).toBe(true);
    expect(output()).toContain("Telemetry disabled.");
    expect(output()).toContain("Telemetry enabled.");
  });

  it("shows the master environment override and debug mode in human status", async () => {
    process.env.DO_NOT_TRACK = "1";
    process.env.DOSU_TELEMETRY_DEBUG = "1";

    await run("status");

    expect(output()).toContain("Telemetry: disabled");
    expect(output()).toContain("Environment override: DO_NOT_TRACK");
    expect(output()).toContain("Debug mode: on");
  });

  it("creates and rotates the pseudonymous telemetry id", async () => {
    await run("reset");
    const first = loadTelemetrySettings().install_id;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);

    await run("reset");
    const second = loadTelemetrySettings().install_id;
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
    expect(output()).toContain("does not delete events already retained");
  });

  it("exposes no lane arguments", () => {
    const command = telemetryCommand();
    expect(command.commands.find((item) => item.name() === "enable")?.registeredArguments).toEqual(
      [],
    );
    expect(command.commands.find((item) => item.name() === "disable")?.registeredArguments).toEqual(
      [],
    );
  });

  it("reports a settings write failure instead of claiming success", async () => {
    writeFileSync(join(tempDir, "dosu-cli"), "not a directory");

    await expect(run("disable")).rejects.toThrow("Could not save telemetry settings");
    expect(output()).not.toContain("disabled");
  });
});
