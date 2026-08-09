/**
 * Provider interface and registry.
 */

import type { Config } from "../config/config";
import type { ProjectFileMutationReceipt } from "./config-helpers";

/**
 * Provider is the base interface for MCP tool providers.
 */
export interface ProviderInstallOptions {
  showSecret?: boolean;
  /** Canonical Git worktree root for project-scoped configuration. */
  projectRoot?: string;
  /** Explicit user authorization to replace an owned project entry with a different target. */
  allowProjectRetarget?: boolean;
}

export interface Provider {
  name(): string;
  id(): string;
  supportsLocal(): boolean;
  install(
    cfg: Config,
    global: boolean,
    opts?: ProviderInstallOptions,
  ): ProjectFileMutationReceipt | undefined;
  remove(global: boolean, opts?: ProviderInstallOptions): ProjectFileMutationReceipt | undefined;
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
  ];
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
 * Returns only providers that are detected on the system.
 */
export function detectInstalledProviders(): SetupProvider[] {
  return allSetupProviders().filter((p) => p.isInstalled());
}

/**
 * Returns a provider for the given tool ID.
 */
export function getProvider(toolID: string): Provider {
  const provider = allProviders().find((p) => p.id() === toolID);
  if (!provider) throw new Error(`unknown tool: ${toolID}`);
  return provider;
}
