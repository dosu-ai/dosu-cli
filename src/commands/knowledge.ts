/** `dosu knowledge`: the local sync pipeline and its per-agent hook triggers. */

import { readFileSync } from "node:fs";
import { Command } from "commander";
import pc from "picocolors";
import { loadConfig } from "../config/config";
import { getBackendURL, isAbsoluteHttpUrl } from "../config/constants";
import { allHookAgents, getHookAgent, type HookAgent } from "../hooks/agents";
import { disableClaudeContextHook, enableClaudeContextHook } from "../hooks/context";
import { HookConfigError, hookCommand } from "../hooks/formats";
import { getIncognitoAgent, installedIncognitoCommands } from "../incognito/agents";
import { isOnPath } from "../mcp/detect";
import type { AgentSession } from "../sessions/scan";
import { listSessionBacklog } from "../sync/backlog";
import {
  isShippingEnabled,
  loadSyncState,
  outcomeCounts,
  sealAgentSession,
  setShipTranscripts,
  settledSessions,
  shippedSessions,
} from "../sync/state";
import { VERSION } from "../version/version";
import { resolveAgents } from "./agent-select";
import { incognitoCommand } from "./knowledge-incognito";
import { scopeCommand, skipBacklogCommand } from "./knowledge-scope";
import { statuslineCommand } from "./knowledge-statusline";
import { printResult, printTable } from "./output";
import { formatOutcomeCounts, syncCommand } from "./sync";

export function knowledgeCommand(): Command {
  const cmd = new Command("knowledge").description(
    "Capture finished agent sessions: sync, hooks, incognito, scope",
  );

  cmd
    .command("sessions")
    .description(
      "List local agent sessions with full project and session ids (the untruncated view of the Activity screen's tabs)",
    )
    .option("--queued", "Only sessions queued for shipping")
    .option("--open", "Only live sessions still inside the quiet period")
    .option("--shipped", "Only recently shipped sessions")
    .option("--rejected", "Only sessions the backend refused (retry with sync --retry-rejected)")
    .option("--unsupported", "Only sessions no normalizer could read yet")
    .option("--json", "Output as JSON")
    .action(
      (opts: {
        queued?: boolean;
        open?: boolean;
        shipped?: boolean;
        rejected?: boolean;
        unsupported?: boolean;
        json?: boolean;
      }) => {
        const all =
          !opts.queued && !opts.open && !opts.shipped && !opts.rejected && !opts.unsupported;
        const want = (flag: boolean | undefined) => all || Boolean(flag);
        const wantQueued = want(opts.queued);
        const wantOpen = want(opts.open);

        const backlog =
          wantQueued || wantOpen ? listSessionBacklog() : { queued: [], open: [], subagents: 0 };
        const state =
          want(opts.shipped) || want(opts.rejected) || want(opts.unsupported)
            ? loadSyncState()
            : null;
        const shipped = state && want(opts.shipped) ? shippedSessions(state) : [];
        const rejected = state && want(opts.rejected) ? settledSessions(state, "rejected") : [];
        const unsupported =
          state && want(opts.unsupported) ? settledSessions(state, "unsupported") : [];

        if (opts.json) {
          printResult(
            {
              ...(wantQueued ? { queued: backlog.queued } : {}),
              ...(wantOpen ? { open: backlog.open } : {}),
              ...((wantQueued || wantOpen) && backlog.subagents
                ? { pending_subagent_transcripts: backlog.subagents }
                : {}),
              ...(want(opts.shipped) ? { shipped } : {}),
              ...(want(opts.rejected) ? { rejected } : {}),
              ...(want(opts.unsupported) ? { unsupported } : {}),
              ...(all && state
                ? {
                    counts: outcomeCounts(state),
                    subagent_counts: outcomeCounts(state, "subagents"),
                  }
                : {}),
            },
            opts,
          );
          return;
        }

        const sessionRows = (sessions: AgentSession[]) =>
          sessions.map((s) => [s.harness, s.updated, s.project ?? "-", s.id]);
        // The ledger keys sessions as "harness/id" in one field; split it back into columns.
        const keyColumns = (key: string): [string, string] => {
          const slash = key.indexOf("/");
          return slash > 0 ? [key.slice(0, slash), key.slice(slash + 1)] : ["-", key];
        };
        const shippedRows = shipped.map((record) => {
          const [harness, id] = keyColumns(record.session);
          return [harness, record.at, record.project ?? record.workspace ?? "-", id];
        });
        const reasonRows = (entries: typeof rejected) =>
          entries.map((entry) => {
            const [harness, id] = keyColumns(entry.session);
            const reason = entry.message ?? (entry.http_status ? `HTTP ${entry.http_status}` : "-");
            return [harness, entry.at, reason, id];
          });

        let first = true;
        const section = (title: string, rows: string[][], headers: string[], emptyMsg: string) => {
          if (!first) console.log();
          first = false;
          console.log(pc.bold(`${title} (${rows.length})`));
          if (rows.length === 0) {
            console.log(pc.dim(`  ${emptyMsg}`));
            return;
          }
          printTable(headers, rows);
        };
        const sessionHeaders = (stamp: string) => ["Agent", stamp, "Project", "Session"];

        if (wantQueued) {
          section(
            "Queued",
            sessionRows(backlog.queued),
            sessionHeaders("Updated"),
            "Queue empty. Finished agent sessions appear here.",
          );
        }
        if (wantOpen) {
          section(
            "Open",
            sessionRows(backlog.open),
            sessionHeaders("Updated"),
            "No open sessions. Live agent sessions sit here until they go quiet.",
          );
        }
        const pendingSubagents = backlog.subagents ?? 0;
        if ((wantQueued || wantOpen) && pendingSubagents > 0) {
          console.log(
            pc.dim(
              `${pendingSubagents} subagent transcript${pendingSubagents === 1 ? "" : "s"} ships with these sessions.`,
            ),
          );
        }
        if (want(opts.shipped)) {
          section("Shipped", shippedRows, sessionHeaders("Shipped at"), "No sessions shipped yet.");
        }
        if (want(opts.rejected)) {
          section(
            "Rejected",
            reasonRows(rejected),
            ["Agent", "Settled at", "Reason", "Session"],
            "None. Sessions the backend refuses are listed here.",
          );
        }
        if (want(opts.unsupported)) {
          section(
            "Unsupported",
            reasonRows(unsupported),
            ["Agent", "Settled at", "Reason", "Session"],
            "None. Sessions no normalizer can read yet are listed here.",
          );
        }
        if (all && state) {
          console.log();
          console.log(pc.dim(`Settled sessions: ${formatOutcomeCounts(state)}`));
          const subagents = formatOutcomeCounts(state, "subagents");
          if (subagents) console.log(pc.dim(`Subagent transcripts: ${subagents}`));
        }
      },
    );

  cmd.addCommand(hooksCommand());
  cmd.addCommand(incognitoCommand());
  cmd.addCommand(scopeCommand());
  cmd.addCommand(skipBacklogCommand());
  cmd.addCommand(statuslineCommand());
  cmd.addCommand(syncCommand());
  cmd.addCommand(transcriptsCommand());
  cmd.addCommand(contextCommand(), { hidden: true });

  return cmd;
}

/** Read synchronously: under Bun, a file redirected onto stdin and read as a stream after the
 * CLI's startup awaits comes back empty, while a pipe does not. */
function readStdin(): string {
  return readFileSync(0, "utf-8");
}

/** `dosu knowledge context`: the prompt-submit hook (Claude Code by default; Codex with `--agent
 * codex --format codex`), and the lookup OpenCode and Pi plugins call with `--format plain`.
 * Hidden -- it is invoked by agents, not by people. Prints nothing and exits 0 unless there is a
 * digest to add, so a logged-out install, OSS mode, shipping switched off, an agent in incognito
 * or a down server all look like Dosu not being there. */
function contextCommand(): Command {
  return new Command("context")
    .description("Prompt-submit hook: add task memory to the agent's context")
    .option("--agent <source>", "Trajectory source the session ships as", "claude-code")
    .option(
      "--format <format>",
      "Output: claude or codex hook JSON, or plain digest text",
      "claude",
    )
    .action(async (opts: { agent: string; format: string }) => {
      const state = loadSyncState();
      // With an agent in incognito, the payload is read first: a session of its that only its own
      // processes can see is settled now, whatever holds below, so `incognito off` run from
      // another shell does not leave it to ship.
      let stdin: string | undefined;
      if (state.incognito_agents) {
        const { CONTEXT_FORMATS, outsideIncognitoSession } = await import("../memory/context-hook");
        stdin = readStdin();
        const format = CONTEXT_FORMATS.find((f) => f === opts.format);
        const outside = outsideIncognitoSession(stdin, {
          agent: opts.agent,
          format,
          incognito: state,
        });
        try {
          if (outside) sealAgentSession(outside, VERSION);
        } catch {
          // The hook stays harmless; the sync settles the session once a run lists it.
        }
      }
      const cfg = loadConfig();
      const target = cfg.active_account?.target;
      const backendUrl = getBackendURL();
      if (cfg.mode === "oss" || !target?.api_key || !target.deployment_id) return;
      if (!isAbsoluteHttpUrl(backendUrl)) return;
      if (!isShippingEnabled(state)) return;
      const { CONTEXT_FORMATS, contextHookOutput } = await import("../memory/context-hook");
      const format = CONTEXT_FORMATS.find((f) => f === opts.format);
      if (!format) return;
      const out = await contextHookOutput(stdin ?? readStdin(), {
        apiKey: target.api_key,
        deploymentId: target.deployment_id,
        backendUrl,
        agent: opts.agent,
        format,
        incognito: state,
      });
      if (out) process.stdout.write(out);
    });
}

/** Whether an agent counts as on this machine; detection reads other tools' files, so one that
 * throws is treated as absent. */
function agentInstalled(agent: HookAgent): boolean {
  try {
    return agent.isInstalled();
  } catch {
    return false;
  }
}

/** Prompt-time memory once shipping is on, per agent on the machine that can take it: Claude
 * Code's hook follows the shipping switch, so it is installed here; Codex's comes with its hooks,
 * and OpenCode's plugin and pi's extension carry their own. */
function reportPromptMemory(): void {
  let claudeFailure: string | null = null;
  try {
    enableClaudeContextHook();
  } catch (err) {
    // Shipping is on either way; only the prompt hook could not be written.
    claudeFailure = err instanceof Error ? err.message : String(err);
  }
  const agents = allHookAgents().filter((agent) => agent.promptMemory && agentInstalled(agent));
  const incognito = new Set(loadSyncState().incognito_agents ?? []);
  if (agents.length === 0) {
    const names = allHookAgents()
      .filter((agent) => agent.promptMemory)
      .map((agent) => agent.name())
      .join(", ");
    console.log(
      pc.yellow(
        `! Prompt-time memory not installed: no agent that supports it was found (${names}). Once one is installed, run 'dosu knowledge hooks enable <agent>'.`,
      ),
    );
    return;
  }
  for (const agent of agents) {
    if (incognito.has(agent.id())) {
      console.log(
        `👻 ${agent.name()} is incognito: no prompt-time memory, and none of its sessions ship ('dosu knowledge incognito off ${agent.id()}' turns it back on).`,
      );
      continue;
    }
    if (agent.id() === "claude" && claudeFailure) {
      console.log(`! Prompt-time memory not installed for ${agent.name()}: ${claudeFailure}`);
      continue;
    }
    try {
      if (agent.promptMemory?.()) {
        console.log(`✓ ${agent.name()} will receive task memory when a prompt warrants it.`);
        continue;
      }
      const remedy =
        agent.promptMemoryRemedy?.() ?? `'dosu knowledge hooks enable ${agent.id()}' adds it.`;
      console.log(pc.yellow(`! Prompt-time memory not installed for ${agent.name()}: ${remedy}`));
    } catch (err) {
      // The agent's own config could not be read; shipping is on either way.
      const reason = err instanceof Error ? err.message : String(err);
      console.log(
        pc.yellow(`! Prompt-time memory for ${agent.name()} could not be checked: ${reason}`),
      );
    }
  }
}

/** `dosu knowledge transcripts`: the switch for shipping finished session transcripts to Dosu
 * memory. On by default; you control what Dosu collects with this switch and the per-session
 * /dosu-incognito opt-out, and secrets are redacted locally before anything ships. */
function transcriptsCommand(): Command {
  const cmd = new Command("transcripts").description(
    "Control shipping finished session transcripts to Dosu memory (default: on)",
  );

  cmd
    .command("status")
    .description("Show whether transcript shipping is enabled, plus shipping progress")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const state = loadSyncState();
      const enabled = isShippingEnabled(state);
      const shipped = shippedSessions(state);
      if (opts.json) {
        printResult(
          {
            enabled,
            total_shipped: state.total_shipped ?? 0,
            counts: outcomeCounts(state),
            subagent_counts: outcomeCounts(state, "subagents"),
            shipped_sessions: shipped,
          },
          opts,
        );
        return;
      }
      console.log(
        enabled
          ? `${pc.green("●")} Transcript shipping is enabled (the default).`
          : "○ Transcript shipping is disabled.",
      );
      const total = state.total_shipped ?? 0;
      if (total > 0) {
        console.log(`  Shipped:         ${total} session${total === 1 ? "" : "s"}`);
      }
      const recent = shipped.slice(-5);
      if (recent.length > 0) {
        console.log("\nRecent shipments:");
        for (const record of recent) {
          console.log(
            `  ${record.session}${record.session_url ? ` \u00B7 ${record.session_url}` : ""}`,
          );
        }
      }
    });

  cmd
    .command("enable")
    .description("Ship finished sessions to Dosu memory (the default; redacted locally first)")
    .action(() => {
      setShipTranscripts(true);
      console.log("✓ Transcript shipping enabled.");
      reportPromptMemory();
      const incognito = installedIncognitoCommands();
      const listed = (loadSyncState().incognito_agents ?? []).map(
        (id) => getHookAgent(id)?.name() ?? id,
      );
      console.log(
        pc.dim(
          `Finished agent sessions are redacted locally, then shipped to Dosu memory on the next sync${
            listed.length > 0
              ? ` (not ${listed.join(", ")}'s, which ${listed.length === 1 ? "is" : "are"} incognito)`
              : ""
          }. ` +
            (incognito
              ? `Use ${incognito} in a session to keep it out.`
              : "To keep a single session out, install the agent's incognito command with 'dosu knowledge hooks enable <agent>'."),
        ),
      );
    });

  cmd
    .command("disable")
    .description("Stop shipping session transcripts to Dosu memory")
    .action(() => {
      setShipTranscripts(false);
      console.log("✓ Transcript shipping disabled.");
      try {
        disableClaudeContextHook();
      } catch {
        // An unparseable settings file is the user's to fix; shipping is already off.
      }
    });

  return cmd;
}

function resolveHookAgents(ids: string[]): HookAgent[] {
  return resolveAgents(ids, allHookAgents, getHookAgent);
}

function hooksCommand(): Command {
  const cmd = new Command("hooks").description(
    "Manage the session-end hooks that trigger knowledge sync",
  );

  cmd
    .command("status")
    .description("Show hook status for each supported agent")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const rows = allHookAgents().map((agent) => {
        let enabled = false;
        let note: string | undefined;
        try {
          enabled = agent.isEnabled();
          if (enabled) note = agent.statusNote?.() || undefined;
        } catch (err) {
          note = err instanceof Error ? err.message : String(err);
        }
        return {
          agent: agent.id(),
          name: agent.name(),
          installed: agent.isInstalled(),
          enabled,
          config_path: agent.configPath(),
          ...(note ? { note } : {}),
        };
      });

      if (opts.json) {
        printResult(rows, opts);
        return;
      }

      for (const row of rows) {
        const state = !row.installed
          ? pc.dim("not installed")
          : row.enabled
            ? pc.green("enabled")
            : "disabled";
        console.log(`  ${row.agent.padEnd(8)} ${row.name.padEnd(14)} ${state}`);
        if (row.note) console.log(pc.yellow(`    ${row.note}`));
      }
      console.log(
        pc.dim("\nUse 'dosu knowledge hooks enable|disable [agent...]' to change these."),
      );
    });

  cmd
    .command("enable [agents...]")
    .description("Install the sync hook for agents (default: all detected)")
    .action((ids: string[]) => {
      const agents = resolveHookAgents(ids);
      if (ids.length === 0) {
        // No agent named: only detected ones get hooks; never pass over the rest in silence.
        const skipped = allHookAgents().filter((agent) => !agent.isInstalled());
        if (skipped.length > 0) {
          console.log(
            pc.yellow(
              `! Skipped ${skipped.map((agent) => agent.name()).join(", ")}: not detected on this machine. Name an agent to install its hook anyway: dosu knowledge hooks enable <agent>`,
            ),
          );
        }
      }
      const devMode = process.env.DOSU_DEV === "true";
      // Dev hooks pin this working copy by absolute path, so PATH is moot.
      if (agents.length > 0 && !devMode && !dosuOnPath()) {
        console.log(
          pc.yellow(
            "Warning: 'dosu' is not on PATH; hooks run 'dosu knowledge sync' and will fail until it is.",
          ),
        );
      }
      if (agents.length > 0 && devMode) {
        console.log(pc.dim(`Dev mode: hooks will run ${hookCommand()}`));
      }
      for (const agent of agents) {
        try {
          agent.enable();
          console.log(`✓ ${agent.name()} \u00B7 hook enabled (${agent.configPath()})`);
          const note = agent.enableNote?.();
          if (note) console.log(pc.dim(`  ${note}`));
          const incognito = getIncognitoAgent(agent.id());
          if (incognito?.isEnabled()) {
            console.log(
              pc.dim(`  Run ${incognito.invocation()} in a session to keep it out of Dosu memory.`),
            );
          }
        } catch (err) {
          reportHookFailure(agent, err);
        }
      }
    });

  cmd
    .command("disable [agents...]")
    .description("Remove the sync hook from agents (default: all detected)")
    .action((ids: string[]) => {
      for (const agent of resolveHookAgents(ids)) {
        try {
          agent.disable();
          console.log(`✓ ${agent.name()} \u00B7 hook disabled`);
          const note = agent.disableNote?.();
          if (note) console.log(pc.dim(`  ${note}`));
        } catch (err) {
          reportHookFailure(agent, err);
        }
      }
    });

  return cmd;
}

function reportHookFailure(agent: HookAgent, err: unknown): void {
  const message =
    err instanceof HookConfigError ? err.message : err instanceof Error ? err.message : String(err);
  console.error(pc.red(`✗ ${agent.name()}: ${message}`));
  process.exitCode = 1;
}

/** Hooks invoke plain `dosu`; warn at enable time when that will not resolve. */
function dosuOnPath(): boolean {
  return isOnPath(process.platform === "win32" ? "dosu.cmd" : "dosu");
}
