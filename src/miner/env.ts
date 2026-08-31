/**
 * Environment isolation for the mining-agent subprocess.
 *
 * The miner spawns a Claude Code / Agent SDK binary pointed at the Dosu LLM
 * gateway. That binary reads a wide family of environment variables, and any
 * inherited `ANTHROPIC_*` / `CLAUDE_CODE_*` value — a developer's own API
 * key, a proxy URL, a model override — would silently reroute the run or
 * bill the wrong account. So the child env is built by *allowlist from a
 * stripped base*, never by patching `process.env`.
 *
 * The same applies to config: a stored claude.ai login in `~/.claude`
 * outranks env auth inside the binary, so `CLAUDE_CONFIG_DIR` must point at
 * a fresh, empty directory for every run (gateway contract I1).
 */

export type MinerTrigger = "bootstrap" | "hook" | "manual";

export interface MinerEnvOptions {
  /** The user's Dosu API key (`sk_user_*`) — the only credential sent. */
  apiKey: string;
  /** Gateway base, e.g. `https://api.dosu.dev/v1/llm-gateway`. */
  gatewayURL: string;
  /** Fresh, empty directory for `CLAUDE_CONFIG_DIR`; one per run. */
  configDir: string;
  /** Attribution headers the gateway meters usage by (all optional server-side). */
  runID: string;
  trigger: MinerTrigger;
  cliVersion: string;
  deploymentID?: string;
  /** Base environment; defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
}

/** Prefixes whose variables must never reach the miner subprocess. */
const STRIPPED_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_"];

/** Exact names stripped in addition to the prefixes. */
const STRIPPED_NAMES = new Set(["CLAUDE_CONFIG_DIR", "CLAUDECODE", "AWS_BEARER_TOKEN_BEDROCK"]);

function isStripped(name: string): boolean {
  return STRIPPED_NAMES.has(name) || STRIPPED_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Build the miner subprocess environment: the caller's env minus every
 * Anthropic/Claude-Code variable, plus the gateway wiring.
 */
export function buildMinerEnv(options: MinerEnvOptions): NodeJS.ProcessEnv {
  const base = options.baseEnv ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !isStripped(name)) env[name] = value;
  }

  const headers = [
    `x-dosu-run-id: ${options.runID}`,
    `x-dosu-trigger: ${options.trigger}`,
    `x-dosu-cli-version: ${options.cliVersion}`,
  ];
  if (options.deploymentID) headers.push(`x-dosu-deployment-id: ${options.deploymentID}`);

  env.ANTHROPIC_BASE_URL = options.gatewayURL;
  env.ANTHROPIC_AUTH_TOKEN = options.apiKey;
  env.ANTHROPIC_CUSTOM_HEADERS = headers.join("\n");
  env.CLAUDE_CONFIG_DIR = options.configDir;
  // No update checks, error reporting, or telemetry from the subprocess —
  // the only network traffic a miner run should produce is gateway calls.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_TELEMETRY = "1";
  env.DISABLE_ERROR_REPORTING = "1";
  return env;
}
