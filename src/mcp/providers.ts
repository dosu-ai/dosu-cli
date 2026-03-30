/**
 * Provider interface and registry.
 *
 * Equivalent to Go's internal/mcp/providers.go
 */

import type { Config } from "../config/config";

/**
 * Provider is the base interface for MCP tool providers.
 */
export interface Provider {
  name(): string;
  id(): string;
  supportsLocal(): boolean;
  install(cfg: Config, global: boolean): void;
  remove(global: boolean): void;
}

/**
 * SetupProvider extends Provider with detection and metadata for dosu setup.
 */
export interface SetupProvider extends Provider {
  detectPaths(): string[];
  isInstalled(): boolean;
  isConfigured(): boolean;
  globalConfigPath(): string;
  priority(): number;
}

// Import all providers (factory functions)
import { ClaudeProvider } from "./providers/claude";
import { ClaudeDesktopProvider } from "./providers/claude-desktop";
import { CursorProvider } from "./providers/cursor";
import { VSCodeProvider } from "./providers/vscode";
import { GeminiProvider } from "./providers/gemini";
import { CodexProvider } from "./providers/codex";
import { WindsurfProvider } from "./providers/windsurf";
import { ZedProvider } from "./providers/zed";
import { ClineProvider } from "./providers/cline";
import { ClineCliProvider } from "./providers/cline-cli";
import { CopilotProvider } from "./providers/copilot";
import { OpenCodeProvider } from "./providers/opencode";
import { AntigravityProvider } from "./providers/antigravity";
import { MCPorterProvider } from "./providers/mcporter";
import { ManualProvider } from "./providers/manual";

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
