/** Provider interface and registry. */

import type { Config } from "../config/config";

/** Provider is the base interface for MCP tool providers. */
export interface ProviderInstallOptions {
  showSecret?: boolean;
}

export interface Provider {
  name(): string;
  id(): string;
  supportsLocal(): boolean;
  install(cfg: Config, global: boolean, opts?: ProviderInstallOptions): void;
  remove(global: boolean): void;
}

/** SetupProvider extends Provider with detection and metadata for dosu setup. */
export interface SetupProvider extends Provider {
  detectPaths(): string[];
  isInstalled(): boolean;
  isConfigured(): boolean;
  /** Whether the global Dosu entry already has the shape `install(cfg, true)` writes, ignoring
   * the deployment, API key, and machine-specific paths it points at (see `../mcp/shape.ts`).
   * Only `cfg`'s mode is read, so this works before sign-in. False when there is no entry. */
  isCurrent(cfg: Config | undefined): boolean;
  globalConfigPath(): string;
  priority(): number;
}

// Import all providers (factory functions)
import { ClaudeProvider } from "./providers/claude";
import { CodexProvider } from "./providers/codex";
import { CopilotProvider } from "./providers/copilot";
import { CursorProvider } from "./providers/cursor";
import { FactoryProvider } from "./providers/factory";
import { GeminiProvider } from "./providers/gemini";
import { ManualProvider } from "./providers/manual";
import { OpenCodeProvider } from "./providers/opencode";
import { PiProvider } from "./providers/pi";

/** Every agent the CLI configures. Each one's sessions can be learned from: it has a session
 * log on disk that @letta-ai/trajectory normalizes (claude-code, codex, cursor, gemini-cli,
 * copilot-cli, opencode, droid, pi). An agent with no adapter gets no entry here, since all the
 * CLI could do for it is write an MCP entry that never learns from its sessions. */
export function allProviders(): Provider[] {
  return [
    ClaudeProvider(),
    CursorProvider(),
    GeminiProvider(),
    CodexProvider(),
    CopilotProvider(),
    OpenCodeProvider(),
    FactoryProvider(),
    PiProvider(),
    ManualProvider(),
  ];
}

/** Returns all providers that implement SetupProvider, sorted by priority. */
export function allSetupProviders(): SetupProvider[] {
  const providers = allProviders().filter(
    (p): p is SetupProvider => "detectPaths" in p && "isInstalled" in p,
  );
  return providers.sort((a, b) => a.priority() - b.priority());
}

/** Returns a provider for the given tool ID. */
export function getProvider(toolID: string): Provider {
  const provider = allProviders().find((p) => p.id() === toolID);
  if (!provider) throw new Error(`unknown tool: ${toolID}`);
  return provider;
}
