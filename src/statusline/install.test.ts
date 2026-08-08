import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeUserSettingsPath,
  inspectStatusline,
  installStatuslineSettings,
  statusLineScriptPath,
  statuslineBackupPath,
  statuslineScriptsDir,
  uninstallStatusline,
  writeStatuslineScripts,
} from "./install";
import { knowledgeStateDir } from "./state";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dosu-statusline-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: settings JSON is inherently untyped
function readSettings(): any {
  return JSON.parse(readFileSync(claudeUserSettingsPath(home), "utf-8"));
}

/** A settings file with the retired standalone Python hook wired in. */
function legacySettings(): Record<string, unknown> {
  return {
    hooks: {
      PostToolUse: [
        {
          matcher: "mcp__.*dosu.*__read_knowledge",
          hooks: [
            {
              type: "command",
              command: join(statuslineScriptsDir(home), "dosu-knowledge-hook.py"),
              timeout: 10,
            },
          ],
        },
      ],
    },
  };
}

describe("writeStatuslineScripts", () => {
  it("writes the renderer executable", () => {
    writeStatuslineScripts(home);
    const path = statusLineScriptPath(home);
    expect(statSync(path).mode & 0o755).toBe(0o755);
    expect(readFileSync(path, "utf-8")).toContain("#!/usr/bin/env python3");
  });

  it("is idempotent on re-run", () => {
    writeStatuslineScripts(home);
    writeStatuslineScripts(home);
    expect(existsSync(statusLineScriptPath(home))).toBe(true);
  });
});

describe("installStatuslineSettings", () => {
  it("creates settings.json with statusLine when absent", () => {
    const result = installStatuslineSettings(home);
    expect(result.statusLine).toBe("installed");
    expect(readSettings().statusLine).toEqual({
      type: "command",
      command: statusLineScriptPath(home),
      padding: 1,
    });
  });

  it("refreshes its own statusLine on re-run", () => {
    installStatuslineSettings(home);
    expect(installStatuslineSettings(home).statusLine).toBe("updated");
  });

  it("preserves unrelated hooks and settings", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      claudeUserSettingsPath(home),
      JSON.stringify({
        permissions: { allow: ["Bash"] },
        hooks: {
          PostToolUse: [
            { matcher: "*", hooks: [{ type: "command", command: "dosu hooks post-tool-use" }] },
          ],
        },
      }),
    );
    installStatuslineSettings(home);
    const cfg = readSettings();
    expect(cfg.permissions).toEqual({ allow: ["Bash"] });
    expect(cfg.hooks.PostToolUse).toHaveLength(1);
    expect(cfg.hooks.PostToolUse[0].hooks[0].command).toBe("dosu hooks post-tool-use");
  });

  it("removes a legacy standalone-hook entry left by a hand install", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(claudeUserSettingsPath(home), JSON.stringify(legacySettings()));
    installStatuslineSettings(home);
    expect(readSettings().hooks).toBeUndefined();
  });

  it("does not overwrite a foreign statusLine without force", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      claudeUserSettingsPath(home),
      JSON.stringify({ statusLine: { type: "command", command: "~/my-statusline.sh" } }),
    );
    const result = installStatuslineSettings(home);
    expect(result.statusLine).toBe("conflict");
    expect(result.existingCommand).toBe("~/my-statusline.sh");
    expect(readSettings().statusLine.command).toBe("~/my-statusline.sh");
  });

  it("replaces a foreign statusLine with force, backing up the original", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      claudeUserSettingsPath(home),
      JSON.stringify({ statusLine: { type: "command", command: "~/my-statusline.sh" } }),
    );
    const result = installStatuslineSettings(home, { force: true });
    expect(result.statusLine).toBe("replaced");
    expect(result.existingCommand).toBe("~/my-statusline.sh");
    expect(readSettings().statusLine.command).toBe(statusLineScriptPath(home));
    const backup = JSON.parse(readFileSync(statuslineBackupPath(home), "utf-8"));
    expect(backup.command).toBe("~/my-statusline.sh");
  });

  it("reports a command-less foreign statusLine as JSON", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(claudeUserSettingsPath(home), JSON.stringify({ statusLine: { type: "static" } }));
    const result = installStatuslineSettings(home);
    expect(result.statusLine).toBe("conflict");
    expect(result.existingCommand).toBe('{"type":"static"}');
  });

  it("refuses to modify an unparseable settings file", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(claudeUserSettingsPath(home), "{not json");
    expect(() => installStatuslineSettings(home)).toThrow(/not valid JSON/);
    expect(readFileSync(claudeUserSettingsPath(home), "utf-8")).toBe("{not json");
  });

  it("treats an empty settings file as empty config", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(claudeUserSettingsPath(home), "  ");
    expect(installStatuslineSettings(home).statusLine).toBe("installed");
  });

  it("warns on disableAllHooks and allowManagedHooksOnly", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      claudeUserSettingsPath(home),
      JSON.stringify({ disableAllHooks: true, allowManagedHooksOnly: true }),
    );
    const result = installStatuslineSettings(home);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toMatch(/disableAllHooks/);
    expect(result.warnings[1]).toMatch(/allowManagedHooksOnly/);
  });
});

describe("uninstallStatusline", () => {
  it("removes our statusLine, renderer, and state", () => {
    writeStatuslineScripts(home);
    installStatuslineSettings(home);
    mkdirSync(knowledgeStateDir(home), { recursive: true });
    writeFileSync(join(knowledgeStateDir(home), "abc.knowledge.json"), "{}");

    const result = uninstallStatusline(home);
    expect(result.statusLineRemoved).toBe(true);
    expect(result.statusLineRestored).toBe(false);
    expect(readSettings().statusLine).toBeUndefined();
    expect(existsSync(statusLineScriptPath(home))).toBe(false);
    expect(existsSync(knowledgeStateDir(home))).toBe(false);
  });

  it("removes a legacy standalone-hook entry", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(claudeUserSettingsPath(home), JSON.stringify(legacySettings()));
    uninstallStatusline(home);
    expect(readSettings().hooks).toBeUndefined();
  });

  it("restores a backed-up statusLine after a forced replace", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      claudeUserSettingsPath(home),
      JSON.stringify({ statusLine: { type: "command", command: "~/my-statusline.sh" } }),
    );
    installStatuslineSettings(home, { force: true });
    const result = uninstallStatusline(home);
    expect(result.statusLineRestored).toBe(true);
    expect(readSettings().statusLine.command).toBe("~/my-statusline.sh");
  });

  it("leaves a statusLine the user replaced since install", () => {
    installStatuslineSettings(home);
    const cfg = readSettings();
    cfg.statusLine = { type: "command", command: "~/new-statusline.sh" };
    writeFileSync(claudeUserSettingsPath(home), JSON.stringify(cfg));
    const result = uninstallStatusline(home);
    expect(result.statusLineRemoved).toBe(false);
    expect(readSettings().statusLine.command).toBe("~/new-statusline.sh");
  });

  it("preserves other PostToolUse groups", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      claudeUserSettingsPath(home),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: "*", hooks: [{ type: "command", command: "dosu hooks post-tool-use" }] },
          ],
        },
      }),
    );
    installStatuslineSettings(home);
    uninstallStatusline(home);
    const cfg = readSettings();
    expect(cfg.hooks.PostToolUse).toHaveLength(1);
    expect(cfg.hooks.PostToolUse[0].hooks[0].command).toBe("dosu hooks post-tool-use");
  });

  it("is a no-op on a machine with nothing installed", () => {
    const result = uninstallStatusline(home);
    expect(result.statusLineRemoved).toBe(false);
    expect(existsSync(claudeUserSettingsPath(home))).toBe(false);
  });

  it("never clobbers an unparseable settings file but still removes our files", () => {
    writeStatuslineScripts(home);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(claudeUserSettingsPath(home), "{not json");
    const result = uninstallStatusline(home);
    expect(result.statusLineRemoved).toBe(false);
    expect(readFileSync(claudeUserSettingsPath(home), "utf-8")).toBe("{not json");
    expect(existsSync(statusLineScriptPath(home))).toBe(false);
  });

  it("ignores a corrupt backup and just removes our statusLine", () => {
    installStatuslineSettings(home);
    mkdirSync(statuslineScriptsDir(home), { recursive: true });
    writeFileSync(statuslineBackupPath(home), "{corrupt");
    const result = uninstallStatusline(home);
    expect(result.statusLineRemoved).toBe(true);
    expect(result.statusLineRestored).toBe(false);
    expect(readSettings().statusLine).toBeUndefined();
  });
});

describe("inspectStatusline", () => {
  it("reports nothing installed on a clean machine", () => {
    expect(inspectStatusline(home)).toEqual({
      scriptInstalled: false,
      statusLineConfigured: false,
      settingsParseError: false,
      warnings: [],
    });
  });

  it("reports a full install", () => {
    writeStatuslineScripts(home);
    installStatuslineSettings(home);
    const info = inspectStatusline(home);
    expect(info.scriptInstalled).toBe(true);
    expect(info.statusLineConfigured).toBe(true);
  });

  it("reports a settings parse error", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(claudeUserSettingsPath(home), "{not json");
    expect(inspectStatusline(home).settingsParseError).toBe(true);
  });
});
