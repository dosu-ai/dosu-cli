/** Env isolation for the miner subprocess: the child env is built by allowlist from a stripped
 * base, since any inherited ANTHROPIC_ or CLAUDE_CODE_ variable could reroute or misbill it. */

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

/** Build the miner subprocess env: the caller's env minus every Anthropic/Claude-Code variable,
 * plus the gateway wiring. */
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
