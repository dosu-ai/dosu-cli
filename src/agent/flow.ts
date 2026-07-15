/**
 * Agent-mediated setup orchestration.
 *
 * Compared with the interactive wizard in `src/setup/flow.ts`, this:
 *
 * 1. Never prompts the user via `@clack/prompts` — every step is
 *    non-interactive and emits a single NDJSON event to stdout.
 * 2. Never holds a localhost OAuth callback open — auth happens via the
 *    login-ticket flow in `../auth/ticket.ts` so the CLI process exits
 *    in <2s and returns control to the agent's shell tool.
 * 3. Composes building blocks (Client, providers, config) from the same
 *    modules the wizard uses, so the actual install / API key / config
 *    behavior stays consistent.
 */

import { exchangeTicket, mintTicket } from "../auth/ticket";
import { Client, type Deployment } from "../client/client";
import {
  type Config,
  loadConfig,
  replaceLoginSession,
  saveConfig,
  updateTarget,
} from "../config/config";
import { logger } from "../debug/logger";
import { MCP_PROVIDER_SLUG } from "../mcp/constants";
import { allSetupProviders, type SetupProvider } from "../mcp/providers";
import { isStdioOnly } from "../setup/flow";
import { emitError, emitNeedUserAction, emitStep } from "./output";

export interface AgentSetupOptions {
  tool: string;
  loginTicket?: string;
  deploymentID?: string;
}

const NPX_INVOCATION = "npx @dosu/cli@latest";

/**
 * Run agent-mediated setup end-to-end. Returns the process exit code the
 * caller should use:
 *
 * - `0` — normal success **or** `need_user_action` / `pending` (the
 *   agent shell should not see these as failures; the JSON tells the
 *   agent what to do next).
 * - `1` — recoverable error the agent / user can act on (printed via
 *   `emitError` with `agent_next_steps`).
 * - `2` — CLI usage error (unknown tool, invalid combination of flags).
 */
export async function runAgentSetup(opts: AgentSetupOptions): Promise<number> {
  // 0. Resolve the requested tool up front. We do this before any auth so
  //    the agent gets a usage error immediately instead of after a login
  //    round-trip.
  const provider = allSetupProviders().find((p) => p.id() === opts.tool.toLowerCase());
  if (!provider) {
    const available = allSetupProviders()
      .filter((p) => !isStdioOnly(p))
      .map((p) => p.id())
      .join(", ");
    emitError({
      step: "setup",
      reason: "unknown_tool",
      agent_next_steps: `'${opts.tool}' is not a supported tool. Choose one of: ${available}. Re-run with --tool <id>.`,
    });
    return 2;
  }
  if (isStdioOnly(provider)) {
    emitError({
      step: "setup",
      reason: "tool_unsupported_in_agent_mode",
      agent_next_steps: `${provider.name()} is not supported by agent setup. Tell the user to run 'dosu mcp add ${provider.id()}' manually after signing in.`,
    });
    return 2;
  }

  // 1. Auth: redeem a ticket if one was provided, otherwise verify any
  //    existing session, otherwise mint a fresh ticket and exit so the
  //    agent can hand the URL to the user.
  let cfg = loadConfig();
  if (opts.loginTicket) {
    const redeemed = await redeemTicket(opts.loginTicket, cfg);
    if (redeemed.code !== 0 || redeemed.exit) return redeemed.code;
    cfg = redeemed.cfg;
  } else {
    const verified = await verifyOrMint(cfg, opts);
    if (verified.code !== 0 || verified.exit) return verified.code;
    cfg = verified.cfg;
  }

  // 2. Resolve the deployment. Agent mode never prompts — if there are
  //    multiple options the agent must surface that to the user.
  const client = new Client(cfg);
  const deploymentResult = await resolveDeployment(client, cfg, opts);
  if (deploymentResult.code !== 0) return deploymentResult.code;
  cfg = deploymentResult.cfg;

  // 3. Mint/reuse the API key (idempotent — same logic as the wizard).
  const keyResult = await ensureAPIKey(client, cfg);
  if (keyResult.code !== 0) return keyResult.code;
  cfg = keyResult.cfg;

  // 4. Install Dosu MCP into the requested tool.
  try {
    provider.install(cfg, /* global */ true);
    emitStep({
      step: "mcp_install",
      tool: provider.id(),
      tool_name: provider.name(),
      config_path: provider.globalConfigPath(),
    });
  } catch (err: unknown) {
    emitError({
      step: "mcp_install",
      reason: "install_failed",
      agent_next_steps: `Failed to install Dosu MCP into ${provider.name()}: ${
        err instanceof Error ? err.message : String(err)
      }. Tell the user to retry or run 'dosu mcp add ${provider.id()}' manually.`,
    });
    return 1;
  }

  emitStep({
    step: "done",
    agent_next_steps: `Dosu MCP is configured for ${provider.name()}. Tell the user setup is complete and they can ask their agent a Dosu question. Run 'dosu status' to verify.`,
  });
  return 0;
}

async function redeemTicket(
  ticket: string,
  cfg: Config,
): Promise<{ code: number; cfg: Config; exit?: boolean }> {
  try {
    const result = await exchangeTicket(ticket);
    if (result.status === "expired") {
      emitError({
        step: "auth",
        reason: "ticket_expired",
        agent_next_steps:
          "Ticket expired or already redeemed. Re-run the agent setup command without --login-ticket to mint a fresh one.",
      });
      return { code: 1, cfg };
    }
    if (result.status === "pending") {
      // The flow stops here — there's nothing to do until the user signs in
      // and a later invocation can redeem the ticket. We exit cleanly (0)
      // so the agent treats this as "waiting" rather than "failed".
      emitStep({
        step: "auth",
        status: "pending",
        agent_next_steps:
          "User hasn't completed sign-in yet. Ask the user to confirm they've signed in, then run the same command again.",
      });
      return { code: 0, cfg, exit: true };
    }
    replaceLoginSession(cfg, {
      access_token: result.access_token ?? "",
      refresh_token: result.refresh_token ?? "",
      expires_at: Math.floor(Date.now() / 1000) + (result.expires_in ?? 3600),
    });
    saveConfig(cfg);
    logger.info("agent.flow", "Ticket redeemed; session saved");
    emitStep({ step: "auth", email: result.email });
    return { code: 0, cfg };
  } catch (err: unknown) {
    emitError({
      step: "auth",
      reason: "ticket_exchange_failed",
      agent_next_steps: `Failed to exchange ticket: ${
        err instanceof Error ? err.message : String(err)
      }. Re-run without --login-ticket to start over.`,
    });
    return { code: 1, cfg };
  }
}

/**
 * Either:
 *  - confirm the existing session works (returns `{code:0, exit:false}` and
 *    the agent flow continues), or
 *  - mint a fresh ticket, emit `need_user_action`, and signal that the
 *    process should exit cleanly (`{code:0, exit:true}`).
 */
async function verifyOrMint(
  cfg: Config,
  opts: AgentSetupOptions,
): Promise<{ code: number; cfg: Config; exit?: boolean }> {
  if (cfg.active_account?.session.access_token) {
    try {
      const client = new Client(cfg);
      const resp = await client.doRequestRaw("GET", "/v1/mcp/deployments");
      if (resp.status === 200) {
        emitStep({ step: "auth" });
        return { code: 0, cfg };
      }
      try {
        await client.refreshToken();
        const fresh = loadConfig();
        emitStep({ step: "auth" });
        return { code: 0, cfg: fresh };
      } catch {
        // fall through to mint
      }
    } catch {
      // fall through to mint
    }
  }

  try {
    const minted = await mintTicket();
    emitNeedUserAction({
      step: "auth",
      url: minted.url,
      ticket: minted.ticket,
      resume_command: buildResumeCommand(opts.tool, minted.ticket, opts.deploymentID),
      expires_in: minted.expires_in,
      agent_next_steps:
        "Give the URL to the user so they can sign in. Wait for the user to confirm they've signed in, then run resume_command to finish setup.",
    });
    return { code: 0, cfg, exit: true };
  } catch (err: unknown) {
    emitError({
      step: "auth",
      reason: "ticket_mint_failed",
      agent_next_steps: `Could not mint a login ticket: ${
        err instanceof Error ? err.message : String(err)
      }. Check connectivity and retry.`,
    });
    return { code: 1, cfg };
  }
}

async function resolveDeployment(
  client: Client,
  cfg: Config,
  opts: AgentSetupOptions,
): Promise<{ code: number; cfg: Config }> {
  // Explicit --deployment wins — look it up and lock it in.
  if (opts.deploymentID) {
    try {
      const deployments = await client.getDeployments();
      const d = deployments.find((dep) => dep.deployment_id === opts.deploymentID);
      if (!d) {
        emitError({
          step: "deployment",
          reason: "not_found",
          agent_next_steps: `Deployment '${opts.deploymentID}' is not accessible. Run 'dosu deployments list --json' to see options and try again with a valid id.`,
        });
        return { code: 1, cfg };
      }
      updateTarget(cfg, {
        deployment_id: d.deployment_id,
        deployment_name: d.name,
        org_id: d.org_id,
        space_id: d.space_id,
      });
      cfg.mode = undefined;
      saveConfig(cfg);
      emitStep({
        step: "deployment",
        deployment_id: d.deployment_id,
        name: d.name,
      });
      return { code: 0, cfg };
    } catch (err: unknown) {
      emitError({
        step: "deployment",
        reason: "fetch_failed",
        agent_next_steps: `Failed to load deployments: ${
          err instanceof Error ? err.message : String(err)
        }.`,
      });
      return { code: 1, cfg };
    }
  }

  // Already locked in from a previous run — reuse it.
  if (cfg.active_account?.target?.deployment_id) {
    emitStep({
      step: "deployment",
      deployment_id: cfg.active_account?.target?.deployment_id,
      name: cfg.active_account?.target?.deployment_name,
    });
    return { code: 0, cfg };
  }

  // No explicit --deployment and nothing locked in — try to find a unique
  // MCP-backed deployment to auto-pick. An account can have many non-MCP
  // deployments (in-app chat, knowledge stores, GitHub/Slack integrations)
  // which are not valid targets for agent setup, so we filter to
  // `dosu_mcp` slug before counting.
  try {
    const allDeployments = await client.getDeployments();
    if (allDeployments.length === 0) {
      emitError({
        step: "deployment",
        reason: "no_deployments",
        agent_next_steps:
          "No Dosu deployments are accessible to this account. Tell the user to create one at https://app.dosu.dev before retrying.",
      });
      return { code: 1, cfg };
    }

    const mcpDeployments = allDeployments.filter((d) => d.provider_slug === MCP_PROVIDER_SLUG);

    if (mcpDeployments.length === 0) {
      emitError({
        step: "deployment",
        reason: "no_mcp_deployment",
        agent_next_steps:
          "Account has deployments but none of them back an MCP server. Tell the user to create an MCP deployment at https://app.dosu.dev, or pass --deployment <id> to target a specific deployment.",
      });
      return { code: 1, cfg };
    }

    if (mcpDeployments.length === 1) {
      const d = mcpDeployments[0];
      updateTarget(cfg, {
        deployment_id: d.deployment_id,
        deployment_name: d.name,
        org_id: d.org_id,
        space_id: d.space_id,
      });
      cfg.mode = undefined;
      saveConfig(cfg);
      emitStep({
        step: "deployment",
        deployment_id: d.deployment_id,
        name: d.name,
      });
      return { code: 0, cfg };
    }

    // Multiple MCP-backed deployments — agent must ask the user. We attach
    // the filtered candidates inline so the driving agent doesn't need to
    // call `dosu deployments list --json` and re-filter on its own.
    const candidates = mcpDeployments.map((d) => ({
      deployment_id: d.deployment_id,
      name: d.name,
      org_id: d.org_id,
      org_name: d.org_name,
    }));
    emitError({
      step: "deployment",
      reason: "multiple_deployments",
      candidates,
      agent_next_steps: `User has ${mcpDeployments.length} MCP deployments. Show these options to the user and re-run the same command with \`--deployment <id>\`:\n${formatCandidates(mcpDeployments)}`,
    });
    return { code: 1, cfg };
  } catch (err: unknown) {
    emitError({
      step: "deployment",
      reason: "fetch_failed",
      agent_next_steps: `Failed to load deployments: ${
        err instanceof Error ? err.message : String(err)
      }.`,
    });
    return { code: 1, cfg };
  }
}

function formatCandidates(deployments: Deployment[]): string {
  return deployments.map((d) => `  - ${d.name} (${d.org_name}) — ${d.deployment_id}`).join("\n");
}

async function ensureAPIKey(client: Client, cfg: Config): Promise<{ code: number; cfg: Config }> {
  const target = cfg.active_account?.target;
  const deploymentID = target?.deployment_id;
  if (!deploymentID) {
    emitError({
      step: "api_key",
      reason: "no_deployment",
      agent_next_steps:
        "Internal error: tried to mint an API key without a deployment. Re-run setup from scratch.",
    });
    return { code: 1, cfg };
  }

  try {
    if (target.api_key) {
      const valid = await client.validateAPIKey(target.api_key, deploymentID);
      if (valid) {
        emitStep({ step: "api_key", reused: true });
        return { code: 0, cfg };
      }
    }
    const resp = await client.createAPIKey(deploymentID, "dosu-cli");
    updateTarget(cfg, { api_key: resp.api_key });
    saveConfig(cfg);
    emitStep({ step: "api_key", reused: false });
    return { code: 0, cfg };
  } catch (err: unknown) {
    emitError({
      step: "api_key",
      reason: "create_failed",
      agent_next_steps: `Failed to create an API key: ${
        err instanceof Error ? err.message : String(err)
      }.`,
    });
    return { code: 1, cfg };
  }
}

/**
 * Build the exact command the agent should run after the user signs in.
 * Mirrors the marketing one-liner so the agent can copy/paste it back.
 */
export function buildResumeCommand(tool: string, ticket: string, deploymentID?: string): string {
  const parts = [NPX_INVOCATION, "setup", "--agent", "--tool", tool, "--login-ticket", ticket];
  if (deploymentID) {
    parts.push("--deployment", deploymentID);
  }
  return parts.join(" ");
}

/** Provider listing for `--tool` validation. Exported for tests. */
export function listAgentSupportedToolIDs(): string[] {
  return allSetupProviders()
    .filter((p: SetupProvider) => !isStdioOnly(p))
    .map((p) => p.id());
}
