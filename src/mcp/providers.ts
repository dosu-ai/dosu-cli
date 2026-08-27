/**
 * Provider interface and registry.
 */

import type { Config } from "../config/config";

/**
 * Provider is the base interface for MCP tool providers.
 */
export type ProviderConfigurationKind = "project" | "global-connector" | "unsupported";

export interface ProviderInstallOptions {
  scope: "project" | "global";
  showSecret?: boolean;
  /** Verified Git root used for project-scoped configuration. */
  projectRoot?: string;
}

interface ProviderRemoveOptions {
  scope: "project" | "global";
  /** Verified Git root used for project-scoped configuration. */
  projectRoot?: string;
}

export interface Provider {
  name(): string;
  id(): string;
  configurationKind(): ProviderConfigurationKind;
  install(cfg: Config, opts: ProviderInstallOptions): void;
  remove(opts: ProviderRemoveOptions): void;
}

/**
 * SetupProvider extends Provider with detection and metadata for dosu setup.
 */
export interface SetupProvider extends Provider {
  detectPaths(): string[];
  isInstalled(): boolean;
  isConfigured(): boolean;
  globalConfigPath(): string;
  projectConfigPath(projectRoot: string): string | null;
  isProjectConfigured(projectRoot: string): boolean;
  priority(): number;
}

function enforceDeclaredScope<T extends Provider>(provider: T): T {
  const assertScope = (scope: "project" | "global", operation: string): void => {
    const kind = provider.configurationKind();
    if (kind === "unsupported") {
      throw new Error(`${provider.name()} does not support Dosu MCP configuration`);
    }
    if (kind === "project" && scope !== "project") {
      throw new Error(
        `${provider.name()} is project-scoped and cannot perform global ${operation}`,
      );
    }
    if (kind === "global-connector" && scope !== "global") {
      throw new Error(
        `${provider.name()} is an explicit global connector and cannot perform project ${operation}`,
      );
    }
  };

  return {
    ...provider,
    install(cfg, opts): void {
      assertScope(opts.scope, "installation");
      provider.install(cfg, opts);
    },
    remove(opts): void {
      assertScope(opts.scope, "removal");
      provider.remove(opts);
    },
  };
}

import { AntigravityProvider } from "./providers/antigravity";
// Import all providers (factory functions)
import { ClaudeProvider } from "./providers/claude";
import { ClaudeDesktopProvider } from "./providers/claude-desktop";
import { ClineProvider } from "./providers/cline";
import { ClineCliProvider } from "./providers/cline-cli";
import { CodexProvider } from "./providers/codex";
import { CopilotProvider } from "./providers/copilot";
import { CursorProvider } from "./providers/cursor";
import { FactoryProvider } from "./providers/factory";
import { GeminiProvider } from "./providers/gemini";
import { ManualProvider } from "./providers/manual";
import { MCPorterProvider } from "./providers/mcporter";
import { OpenCodeProvider } from "./providers/opencode";
import { VSCodeProvider } from "./providers/vscode";
import { WindsurfProvider } from "./providers/windsurf";
import { ZedProvider } from "./providers/zed";

/**
 * Returns all available providers.
 */
export function allProviders(): Provider[] {
  return [
    ClaudeProvider(),
    ClaudeDesktopProvider(),
    CursorProvider(),
    VSCodeProvider(),
    GeminiProvider(),
    CodexProvider(),
    WindsurfProvider(),
    ZedProvider(),
    ClineProvider(),
    ClineCliProvider(),
    CopilotProvider(),
    OpenCodeProvider(),
    AntigravityProvider(),
    MCPorterProvider(),
    FactoryProvider(),
    ManualProvider(),
  ].map(enforceDeclaredScope);
}

/**
 * Returns all providers that implement SetupProvider, sorted by priority.
 */
export function allSetupProviders(): SetupProvider[] {
  const providers = allProviders().filter(
    (p): p is SetupProvider => "detectPaths" in p && "isInstalled" in p,
  );
  return providers.sort((a, b) => a.priority() - b.priority());
}

/**
 * Returns a provider for the given tool ID.
 */
export function getProvider(toolID: string): Provider {
  const provider = allProviders().find((p) => p.id() === toolID);
  if (!provider) throw new Error(`unknown tool: ${toolID}`);
  return provider;
}
