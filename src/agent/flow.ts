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
import { installSkill, skillAgentIDsForProviders } from "../commands/skill";
import {
  type Config,
  loadConfig,
  MODE_OSS,
  replaceLoginSession,
  type SetupMode,
  saveConfig,
  updateTarget,
} from "../config/config";
import { logger } from "../debug/logger";
import { MCP_PROVIDER_SLUG } from "../mcp/constants";
import { recordProjectProxyEndpoint } from "../mcp/project-proxy";
import { preflightProjectProxy } from "../mcp/project-proxy-preflight";
import { allSetupProviders } from "../mcp/providers";
import { type ProviderId, resolveProjectProof } from "../migration";
import { fetchDosuRule } from "../rules/installer";
import {
  installProjectInstructions,
  providerUsesProjectInstructions,
} from "../setup/project-instructions";
import { requireProjectRoot } from "../setup/project-root";
import { runProjectScopeMigration } from "../setup/project-scope-migration";
import { type RequestedProjectTarget, resolveProjectPinnedTarget } from "../setup/project-target";
import { VERSION } from "../version/version";
import { emitError, emitNeedUserAction, emitStep } from "./output";

export interface AgentSetupOptions {
  tool: string;
  loginTicket?: string;
  deploymentID?: string;
  mode?: SetupMode | "cloud";
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
  const setupProviders = allSetupProviders();
  const provider = setupProviders.find(
    (candidate) => candidate.id() === opts.tool.toLowerCase() && candidate.supportsLocal(),
  );
  if (!provider) {
    const available = setupProviders
      .filter((candidate) => candidate.supportsLocal())
      .map((p) => p.id())
      .join(", ");
    emitError({
      step: "setup",
      reason: "unknown_tool",
      agent_next_steps: `'${opts.tool}' is not a supported tool. Choose one of: ${available}. Re-run with --tool <id>.`,
    });
    return 2;
  }
  let projectRoot: string;
  try {
    projectRoot = requireProjectRoot();
  } catch (err) {
    emitError({
      step: "setup",
      reason: "project_required",
      agent_next_steps: err instanceof Error ? err.message : String(err),
    });
    return 1;
  }
  let cfg = loadConfig();
  const requestedTarget = requestedProjectTarget(opts, cfg);
  const projectTarget = requestedTarget
    ? resolveProjectPinnedTarget(setupProviders, projectRoot, requestedTarget, [provider.id()])
    : resolveProjectPinnedTarget(setupProviders, projectRoot);
  if (!projectTarget.ok) {
    emitError({
      step: "project_target",
      reason: projectTarget.reason,
      providers: projectTarget.providers,
      paths: projectTarget.paths,
      agent_next_steps:
        projectTarget.reason === "ambiguous_project_config"
          ? "One or more project Dosu entries are foreign or invalid. Inspect the listed paths and remove or repair only those entries, then retry. No authentication or project write was attempted."
          : "The project's clients do not all match one Dosu target. Make every listed client use the same target before retrying. No authentication or project write was attempted.",
    });
    return 1;
  }
  // 1. Auth: redeem a ticket if one was provided, otherwise verify any
  //    existing session, otherwise mint a fresh ticket and exit so the
  //    agent can hand the URL to the user.
  if (opts.loginTicket) {
    const redeemed = await redeemTicket(opts.loginTicket, cfg);
    if (redeemed.code !== 0 || redeemed.exit) return redeemed.code;
    cfg = redeemed.cfg;
  } else {
    const verified = await verifyOrMint(cfg, opts);
    if (verified.code !== 0 || verified.exit) return verified.code;
    cfg = verified.cfg;
  }

  // Match the interactive contract: an explicit deployment always means
  // Cloud; otherwise an explicit mode overrides saved/global state and
  // authorizes retargeting this project's owned Dosu entry.
  if (opts.deploymentID) {
    cfg.mode = undefined;
    saveConfig(cfg);
  } else if (opts.mode) {
    cfg.mode = opts.mode === "oss" ? MODE_OSS : undefined;
    saveConfig(cfg);
  }

  // 2. Resolve the deployment. Agent mode never prompts — if there are
  //    multiple options the agent must surface that to the user.
  const client = new Client(cfg);
  let deploymentOptions = opts;
  if (!opts.deploymentID && opts.mode !== "oss") {
    if (projectTarget.target?.deploymentID) {
      deploymentOptions = { ...opts, deploymentID: projectTarget.target.deploymentID };
    } else if (projectTarget.target?.oss) {
      cfg.mode = MODE_OSS;
    }
  }
  const deploymentResult = await resolveDeployment(client, cfg, deploymentOptions);
  if (deploymentResult.code !== 0) return deploymentResult.code;
  cfg = deploymentResult.cfg;

  // 3. Mint/reuse the API key (idempotent — same logic as the wizard).
  const keyResult = await ensureAPIKey(client, cfg);
  if (keyResult.code !== 0) return keyResult.code;
  cfg = keyResult.cfg;
  recordProjectProxyEndpoint(cfg);
  saveConfig(cfg);

  const preflight = await preflightProjectProxy(cfg, projectRoot);
  if (!preflight.ok) {
    emitError({
      step: "mcp_preflight",
      reason: preflight.reason,
      agent_next_steps:
        "The exact project MCP command could not initialize, so no project files or legacy globals were changed. Check Node.js 22+ and npx, then retry.",
    });
    return 1;
  }

  // 4. Install Dosu MCP into the requested tool.
  try {
    provider.install(cfg, /* global */ false, {
      projectRoot,
      allowProjectRetarget: Boolean(opts.deploymentID || opts.mode),
    });
    emitStep({
      step: "mcp_install",
      tool: provider.id(),
      tool_name: provider.name(),
      config_path: provider.projectConfigPath(projectRoot) ?? "",
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

  // 5. Install the canonical project instructions plus the provider's thin adapter.
  // Keep the exact fetched body: legacy cleanup re-verifies the checked-in
  // project bundle against it before removing anything outside the project.
  let instructionContent = "";
  if (providerUsesProjectInstructions(provider.id())) {
    try {
      instructionContent = await fetchDosuRule();
      const installed = installProjectInstructions({
        projectRoot,
        providerIDs: [provider.id()],
        content: instructionContent,
      });
      emitStep({
        step: "rule_install",
        tool: provider.id(),
        tool_name: provider.name(),
        rule_path: installed.agentsMd.path,
        action: installed.agentsMd.action,
      });
    } catch (err: unknown) {
      emitError({
        step: "rule_install",
        reason: "install_failed",
        agent_next_steps: `Dosu MCP was installed, but its rule could not be installed for ${provider.name()}: ${
          err instanceof Error ? err.message : String(err)
        }. Re-run this setup command; installation is idempotent.`,
      });
      return 1;
    }
  }

  // 6. Install the remote Dosu skill only for the requested agent. Keep the
  // child process quiet so agent mode preserves its one-JSON-line-per-step
  // stdout contract.
  if (skillAgentIDsForProviders([provider.id()]).length > 0) {
    try {
      const skill = await installSkill([provider.id()], { quiet: true, projectRoot });
      if (!skill.success) {
        throw new Error("the skills installer failed");
      }
      emitStep({
        step: "skill_install",
        tool: provider.id(),
        tool_name: provider.name(),
        source: "dosu-ai/dosu-skill",
      });
    } catch (err: unknown) {
      emitError({
        step: "skill_install",
        reason: "install_failed",
        agent_next_steps: `Dosu MCP and its rule were installed, but the skill could not be installed for ${provider.name()}: ${
          err instanceof Error ? err.message : String(err)
        }. Re-run this setup command; installation is idempotent.`,
      });
      return 1;
    }
  }

  // 7. Re-prove and re-verify the complete project bundle before touching any
  // legacy global state. The successful runtime preflight above is the only
  // authority that permits the migration layer to remove exact owned entries.
  const project = resolveProjectProof(projectRoot);
  if (!project.ok) {
    emitError({
      step: "legacy_migration",
      reason: "project_reverification_failed",
      project_reason: project.reason,
      receipt_root: null,
      counts: { removed: 0, not_found: 0, preserved: 0, failed: 0, total: 0 },
      agent_next_steps:
        "Project setup succeeded, but the Git project could not be re-verified, so legacy global configuration was preserved. Re-run setup from the same project root.",
    });
    return 1;
  }

  const proxy =
    cfg.mode === MODE_OSS
      ? ({ packageVersion: VERSION, oss: true } as const)
      : {
          packageVersion: VERSION,
          deploymentID: cfg.active_account?.target?.deployment_id as string,
        };
  const migration = runProjectScopeMigration({
    project: project.proof,
    providerIDs: [provider.id() as ProviderId],
    proxy,
    instructionContent,
    runtimeVerified: true,
  });
  for (const warning of migration.warnings) logger.warn("agent.flow", warning);
  if (!migration.ok) {
    const cleanupProgress =
      migration.counts.removed > 0
        ? `${migration.counts.removed} proven global item(s) were already backed up and removed before cleanup stopped.`
        : "No global item was removed.";
    emitError({
      step: "legacy_migration",
      reason: migration.reason,
      receipt_root: migration.receiptRoot,
      counts: migration.counts,
      agent_next_steps:
        `Project setup succeeded, but safe legacy cleanup could not finish. ${cleanupProgress} ` +
        "Nothing ambiguous was deleted. Re-run setup; use the receipt path for recovery if needed.",
    });
    return 1;
  }
  emitStep({
    step: "legacy_migration",
    receipt_root: migration.receiptRoot,
    counts: migration.counts,
  });

  emitStep({
    step: "done",
    agent_next_steps: `Dosu project files were written for ${provider.name()}. Tell the user to restart or reload the client, approve the project's MCP server if prompted, and then ask a Dosu question. 'dosu status --json' verifies authentication, not the client runtime.`,
  });
  return 0;
}

function requestedProjectTarget(
  opts: AgentSetupOptions,
  cfg: Config,
): RequestedProjectTarget | undefined {
  if (opts.deploymentID) return { mode: "cloud", deploymentID: opts.deploymentID };
  if (opts.mode === "oss") return { mode: "oss" };
  if (opts.mode === "cloud") {
    return {
      mode: "cloud",
      deploymentID: cfg.active_account?.target?.deployment_id,
    };
  }
  return undefined;
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
      resume_command: buildResumeCommand(opts.tool, minted.ticket, opts.deploymentID, opts.mode),
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
          agent_next_steps:
            "The requested MCP is not accessible to the current Dosu account. " +
            "Make sure the user is logged in to the correct account. " +
            "Run 'dosu logout', then retry setup.",
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
          "No Dosu deployments are accessible to this account. The CLI may be signed in to a " +
          "different account than the user expects — have them run 'dosu logout' and retry, or " +
          "create a deployment at https://app.dosu.dev before retrying.",
      });
      return { code: 1, cfg };
    }

    const mcpDeployments = allDeployments.filter((d) => d.provider_slug === MCP_PROVIDER_SLUG);

    if (mcpDeployments.length === 0) {
      emitError({
        step: "deployment",
        reason: "no_mcp_deployment",
        agent_next_steps:
          "Account has deployments but none of them back an MCP server. The CLI may be signed in " +
          "to a different account than the user expects — have them run 'dosu logout' and retry, " +
          "create an MCP deployment at https://app.dosu.dev, or pass --deployment <id> to target " +
          "a specific deployment.",
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
export function buildResumeCommand(
  tool: string,
  ticket: string,
  deploymentID?: string,
  mode?: SetupMode | "cloud",
): string {
  const parts = [NPX_INVOCATION, "setup", "--agent", "--tool", tool, "--login-ticket", ticket];
  if (deploymentID) {
    parts.push("--deployment", deploymentID);
  }
  if (mode) {
    parts.push("--mode", mode);
  }
  return parts.join(" ");
}

/** Provider listing for `--tool` validation. Exported for tests. */
export function listAgentSupportedToolIDs(): string[] {
  return allSetupProviders()
    .filter((provider) => provider.supportsLocal())
    .map((provider) => provider.id());
}
