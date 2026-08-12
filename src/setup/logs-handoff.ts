/**
 * Post-setup log-mining handoff — detect local agent histories (Cursor /
 * Claude Code / Codex) and launch the user's coding agent with the
 * log-to-dosu-knowledge prompt. Replaces the old codebase-audit CTA.
 *
 * The confirm happens inside the clack session (before `p.outro`); the actual
 * launch must happen after it so the agent gets a clean terminal — hence the
 * offer/launch split.
 */

import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import {
  type KickoffAgent,
  kickoffAgentLabel,
  launchKickoffAgent,
  resolveKickoffAgent,
} from "./agent-kickoff";
import { info } from "./styles";

export type LogSource = "cursor" | "claude" | "codex";

const LOG_SOURCES: readonly LogSource[] = ["cursor", "claude", "codex"] as const;

const SOURCE_LABELS: Record<LogSource, string> = {
  cursor: "Cursor",
  claude: "Claude Code",
  codex: "Codex",
};

export interface LogSourceHit {
  source: LogSource;
  /** Approximate session file count (capped). */
  sessionCount: number;
  /** True when counting stopped at the cap. */
  capped: boolean;
}

export interface LogsHandoffPlan {
  agent: KickoffAgent;
  sources: LogSource[];
}

const COUNT_CAP = 500;

function countJsonlFiles(
  root: string,
  cap: number = COUNT_CAP,
): { count: number; capped: boolean } {
  if (!existsSync(root)) return { count: 0, capped: false };
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        count += 1;
        if (count >= cap) return { count, capped: true };
      }
    }
  }
  return { count, capped: false };
}

/** Detect which agent log roots have history under `$HOME`. */
export function detectLogSources(home: string = process.env.HOME || homedir()): LogSourceHit[] {
  const roots: Record<LogSource, string> = {
    cursor: join(home, ".cursor", "projects"),
    claude: join(home, ".claude", "projects"),
    codex: join(home, ".codex", "sessions"),
  };

  const hits: LogSourceHit[] = [];
  for (const source of LOG_SOURCES) {
    const root = roots[source];
    // Cursor stores transcripts under projects/<id>/agent-transcripts
    if (source === "cursor") {
      if (!existsSync(root)) continue;
      let count = 0;
      let capped = false;
      try {
        for (const proj of readdirSync(root)) {
          const transcripts = join(root, proj, "agent-transcripts");
          try {
            if (!statSync(transcripts).isDirectory()) continue;
          } catch {
            continue;
          }
          const result = countJsonlFiles(transcripts, COUNT_CAP - count);
          count += result.count;
          if (result.capped || count >= COUNT_CAP) {
            capped = true;
            count = Math.min(count, COUNT_CAP);
            break;
          }
        }
      } catch {
        continue;
      }
      if (count > 0) hits.push({ source, sessionCount: count, capped });
      continue;
    }

    const result = countJsonlFiles(root);
    if (result.count > 0) {
      hits.push({ source, sessionCount: result.count, capped: result.capped });
    }
  }
  return hits;
}

export function formatLogSourceSummary(hits: readonly LogSourceHit[]): string {
  return hits
    .map(
      (hit) =>
        `${SOURCE_LABELS[hit.source]} (${hit.sessionCount}${hit.capped ? "+" : ""} sessions)`,
    )
    .join(", ");
}

export function buildLogsHandoffPrompt(sources: readonly LogSource[]): string {
  const sourceList = sources.join(", ");
  return [
    "Please bootstrap my knowledge with Dosu from my local agent logs.",
    "1. Run the log-to-dosu-knowledge skill. Do not ask scope questions — use skill defaults.",
    `2. Only mine these sources: ${sourceList}.`,
    "3. Inventory sessions, extract durable learnings (not the user's prompts), and write each with write_knowledge on a single dosu/log-backfill/[UTC-timestamp] branch for this run.",
    "4. Never ask how to attribute notes to branches (main / per-session / checkout). Always use that synthetic BACKFILL_BRANCH so the server auto-promotes.",
    "5. Open the HTML report (generate_report.py --open) and tell me what was cached plus expected token savings.",
  ].join("\n");
}

function printManualLogsNudge(sources: readonly LogSource[] = LOG_SOURCES): void {
  const prompt = buildLogsHandoffPrompt(sources);
  p.log.message(`Mine local agent logs into Dosu:\n\n${info(prompt)}`);
}

export interface OfferLogsHandoffOptions {
  preferredAgents?: readonly string[];
  /** Override home for tests. */
  home?: string;
}

/**
 * Detect log sources and offer a single continue to mine them all. Returns a
 * plan to launch after outro, or null when skipped / declined / no logs.
 */
export async function offerLogsHandoff(
  options: OfferLogsHandoffOptions = {},
): Promise<LogsHandoffPlan | null> {
  const hits = detectLogSources(options.home);
  if (hits.length === 0) return null;

  const sources = hits.map((hit) => hit.source);
  const agent = resolveKickoffAgent(options.preferredAgents ?? []);
  if (!agent) {
    printManualLogsNudge(sources);
    return null;
  }

  p.log.success(`MCP setup successful! Found logs: ${formatLogSourceSummary(hits)}`);

  const label = kickoffAgentLabel(agent);
  const go = await p.confirm({
    message: `We're about to mine these into Dosu with ${label}. Continue?`,
    initialValue: true,
  });
  if (p.isCancel(go) || !go) {
    printManualLogsNudge(sources);
    return null;
  }

  return { agent, sources };
}

/** Launch the chosen agent with the log-mining prompt. */
export function launchLogsAgent(plan: LogsHandoffPlan): void {
  const prompt = buildLogsHandoffPrompt(plan.sources);
  const ok = launchKickoffAgent(plan.agent, prompt, {
    onCursorSoftLaunch: () => printManualLogsNudge(plan.sources),
  });
  if (!ok) {
    printManualLogsNudge(plan.sources);
  }
}
