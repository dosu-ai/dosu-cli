import { posix, win32 } from "node:path";

export type ProviderId =
  | "claude"
  | "claude-desktop"
  | "cursor"
  | "vscode"
  | "gemini"
  | "codex"
  | "windsurf"
  | "zed"
  | "cline"
  | "cline-cli"
  | "copilot"
  | "opencode"
  | "antigravity"
  | "mcporter"
  | "factory"
  | "manual";

interface LegacyTargetBase {
  id: string;
  provider: ProviderId;
  path: string;
  /** Every project bundle that must be proven before deleting a historically shared target. */
  requiredProviders?: readonly ProviderId[];
}

export type LegacyTarget =
  | (LegacyTargetBase & { kind: "json_mcp"; topKey: string })
  | (LegacyTargetBase & { kind: "codex_toml" })
  | (LegacyTargetBase & { kind: "rule_file"; ruleKind: "claude" | "cursor" })
  | (LegacyTargetBase & { kind: "rule_section" });

export interface LegacyTargetEnvironment {
  platform: "darwin" | "linux" | "win32";
  homeDir: string;
  env: Record<string, string | undefined>;
}

export interface LegacyTargetResolution {
  targets: LegacyTarget[];
  warnings: string[];
}

export function resolveLegacyTargets(
  providerIds: readonly ProviderId[],
  environment: LegacyTargetEnvironment,
): LegacyTargetResolution {
  const pathApi = environment.platform === "win32" ? win32 : posix;
  const join = (...parts: string[]) => pathApi.join(...parts);
  const home = environment.homeDir;
  const env = environment.env;
  const targets: LegacyTarget[] = [];
  const warnings: string[] = [];
  const effectiveProviders = new Set(providerIds);
  const sharedGeminiRuleProviders = (["gemini", "antigravity"] as const).filter((provider) =>
    effectiveProviders.has(provider),
  );
  if (!pathApi.isAbsolute(home)) {
    return {
      targets,
      warnings: ["Home directory is not absolute; preserving every legacy target"],
    };
  }

  const envPaths = new Map<string, string | null | undefined>();
  const absoluteEnvPath = (name: string): string | undefined => {
    if (envPaths.has(name)) return envPaths.get(name) ?? undefined;
    const value = env[name];
    if (!value) {
      envPaths.set(name, undefined);
      return undefined;
    }
    if (!pathApi.isAbsolute(value)) {
      warnings.push(`${name} is not absolute; preserving targets that depend on it`);
      envPaths.set(name, null);
      return undefined;
    }
    envPaths.set(name, value);
    return value;
  };
  const hasInvalidEnvPath = (name: string): boolean => envPaths.get(name) === null;
  let appSupportResolved = false;
  let appSupportValue: string | undefined;
  const appSupport = (): string | undefined => {
    if (appSupportResolved) return appSupportValue;
    appSupportResolved = true;
    if (environment.platform === "darwin") {
      appSupportValue = join(home, "Library", "Application Support");
    } else if (environment.platform === "linux") {
      const xdg = absoluteEnvPath("XDG_CONFIG_HOME");
      appSupportValue = hasInvalidEnvPath("XDG_CONFIG_HOME")
        ? undefined
        : xdg || join(home, ".config");
    } else {
      appSupportValue = absoluteEnvPath("APPDATA");
    }
    return appSupportValue;
  };

  const addJson = (provider: ProviderId, id: string, path: string, topKey: string) => {
    targets.push({ provider, id, kind: "json_mcp", path, topKey });
  };
  const addRuleSection = (
    provider: ProviderId,
    id: string,
    path: string,
    requiredProviders?: readonly ProviderId[],
  ) => {
    targets.push({
      provider,
      id,
      kind: "rule_section",
      path,
      ...(requiredProviders ? { requiredProviders } : {}),
    });
  };

  let warnedMissingCodeAppData = false;
  for (const provider of providerIds) {
    switch (provider) {
      case "claude": {
        addJson(provider, "claude:mcp", join(home, ".claude.json"), "mcpServers");
        const configured = absoluteEnvPath("CLAUDE_CONFIG_DIR");
        if (!hasInvalidEnvPath("CLAUDE_CONFIG_DIR")) {
          const configDir = configured || join(home, ".claude");
          targets.push({
            provider,
            id: "claude:rule",
            kind: "rule_file",
            path: join(configDir, "rules", "dosu.md"),
            ruleKind: "claude",
          });
        }
        break;
      }
      case "claude-desktop":
        if (appSupport()) {
          addJson(
            provider,
            "claude-desktop:mcp",
            join(appSupportValue as string, "Claude", "claude_desktop_config.json"),
            "mcpServers",
          );
        } else {
          warnings.push("APPDATA is unavailable; preserving Claude Desktop target");
        }
        break;
      case "cursor":
        addJson(provider, "cursor:mcp", join(home, ".cursor", "mcp.json"), "mcpServers");
        targets.push({
          provider,
          id: "cursor:rule",
          kind: "rule_file",
          path: join(home, ".cursor", "rules", "dosu.mdc"),
          ruleKind: "cursor",
        });
        break;
      case "vscode":
        if (appSupport()) {
          addJson(
            provider,
            "vscode:mcp",
            join(appSupportValue as string, "Code", "User", "mcp.json"),
            "servers",
          );
        } else {
          warnedMissingCodeAppData = true;
        }
        break;
      case "gemini":
        addJson(provider, "gemini:mcp", join(home, ".gemini", "settings.json"), "mcpServers");
        addRuleSection(
          provider,
          "gemini:rule",
          join(home, ".gemini", "GEMINI.md"),
          sharedGeminiRuleProviders,
        );
        break;
      case "codex": {
        const configured = absoluteEnvPath("CODEX_HOME");
        if (!hasInvalidEnvPath("CODEX_HOME")) {
          const codexHome = configured || join(home, ".codex");
          targets.push({
            provider,
            id: "codex:mcp",
            kind: "codex_toml",
            path: join(codexHome, "config.toml"),
          });
          addRuleSection(provider, "codex:rule", join(codexHome, "AGENTS.md"));
        }
        break;
      }
      case "windsurf":
        addJson(
          provider,
          "windsurf:mcp",
          join(home, ".codeium", "windsurf", "mcp_config.json"),
          "mcpServers",
        );
        break;
      case "zed":
        if (appSupport()) {
          addJson(
            provider,
            "zed:mcp",
            join(
              appSupportValue as string,
              environment.platform === "linux" ? "zed" : "Zed",
              "settings.json",
            ),
            "context_servers",
          );
        } else {
          warnings.push("APPDATA is unavailable; preserving Zed target");
        }
        break;
      case "cline":
        if (appSupport()) {
          addJson(
            provider,
            "cline:mcp",
            join(
              appSupportValue as string,
              "Code",
              "User",
              "globalStorage",
              "saoudrizwan.claude-dev",
              "settings",
              "cline_mcp_settings.json",
            ),
            "mcpServers",
          );
        } else {
          warnedMissingCodeAppData = true;
        }
        break;
      case "cline-cli": {
        const configured = absoluteEnvPath("CLINE_DIR");
        if (!hasInvalidEnvPath("CLINE_DIR")) {
          const clineDir = configured || join(home, ".cline");
          addJson(
            provider,
            "cline-cli:mcp",
            join(clineDir, "data", "settings", "cline_mcp_settings.json"),
            "mcpServers",
          );
        }
        break;
      }
      case "copilot": {
        const xdg = absoluteEnvPath("XDG_CONFIG_HOME");
        if (!hasInvalidEnvPath("XDG_CONFIG_HOME")) {
          addJson(
            provider,
            "copilot:mcp",
            xdg ? join(xdg, "mcp-config.json") : join(home, ".copilot", "mcp-config.json"),
            "mcpServers",
          );
        }
        break;
      }
      case "opencode":
        addJson(
          provider,
          "opencode:mcp",
          join(home, ".config", "opencode", "opencode.json"),
          "mcp",
        );
        addRuleSection(provider, "opencode:rule", join(home, ".config", "opencode", "AGENTS.md"));
        break;
      case "antigravity":
        addJson(
          provider,
          "antigravity:mcp",
          join(home, ".gemini", "antigravity", "mcp_config.json"),
          "mcpServers",
        );
        addRuleSection(
          provider,
          "antigravity:rule",
          join(home, ".gemini", "GEMINI.md"),
          sharedGeminiRuleProviders,
        );
        break;
      case "mcporter":
        addJson(
          provider,
          "mcporter:json:mcp",
          join(home, ".mcporter", "mcporter.json"),
          "mcpServers",
        );
        addJson(
          provider,
          "mcporter:jsonc:mcp",
          join(home, ".mcporter", "mcporter.jsonc"),
          "mcpServers",
        );
        break;
      case "factory":
        addJson(provider, "factory:mcp", join(home, ".factory", "mcp.json"), "mcpServers");
        break;
      case "manual":
        break;
    }
  }

  if (warnedMissingCodeAppData) {
    warnings.push("APPDATA is unavailable; preserving VS Code/Cline targets");
  }

  const seen = new Set<string>();
  return {
    targets: targets.filter((target) => {
      const key = `${target.kind}\0${target.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    warnings,
  };
}
