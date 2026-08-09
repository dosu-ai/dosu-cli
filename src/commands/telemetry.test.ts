import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTelemetrySettings } from "../telemetry/settings";
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
  it("reports unset, fail-closed lanes as JSON without exposing credentials", async () => {
    process.env.DOSU_POSTHOG_PROJECT_TOKEN = "phc_public-project-token";
    process.env.DOSU_SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
    process.env.DOSU_WEB_APP_URL = "https://app.dosu.test";

    await run("status", "--json");

    const status = JSON.parse(output());
    expect(status).toMatchObject({
      schema_version: 1,
      analytics: {
        decision: "unset",
        effective: false,
        command_destination_configured: true,
        setup_destination_configured: true,
      },
      errors: { decision: "unset", effective: false, destination_configured: true },
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
      analytics: {
        command_destination_configured: false,
        setup_destination_configured: false,
      },
      errors: { destination_configured: false },
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
      analytics: {
        command_destination_configured: false,
        setup_destination_configured: true,
      },
    });
  });

  it("enables one lane and disables all lanes persistently", async () => {
    await run("enable", "analytics");
    expect(loadTelemetrySettings()).toMatchObject({ analytics: true });
    expect(loadTelemetrySettings().errors).toBeUndefined();

    await run("disable");
    expect(loadTelemetrySettings()).toMatchObject({ analytics: false, errors: false });
    expect(output()).toContain("Telemetry analytics enabled.");
    expect(output()).toContain("Telemetry analytics and error diagnostics disabled.");
  });

  it("shows the master environment override and debug mode in human status", async () => {
    await run("enable");
    process.env.DO_NOT_TRACK = "1";
    process.env.DOSU_TELEMETRY_DEBUG = "1";

    await run("status");

    expect(output()).toContain("Usage analytics: enabled (effective off)");
    expect(output()).toContain("Environment override: DO_NOT_TRACK");
    expect(output()).toContain("Debug mode: on");
  });

  it("creates and rotates the anonymous telemetry id", async () => {
    await run("reset");
    const first = loadTelemetrySettings().install_id;
    expect(first).toMatch(/^[0-9a-f-]{36}$/);

    await run("reset");
    const second = loadTelemetrySettings().install_id;
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
    expect(output()).toContain("does not delete events already retained");
  });

  it("rejects an unknown telemetry lane", async () => {
    await expect(run("enable", "logs")).rejects.toThrow(
      "telemetry lane must be one of: analytics, errors, all",
    );
  });

  it("reports a settings write failure instead of claiming success", async () => {
    writeFileSync(join(tempDir, "dosu-cli"), "not a directory");

    await expect(run("enable", "analytics")).rejects.toThrow("Could not save telemetry settings");
    expect(output()).not.toContain("enabled");
  });
});
