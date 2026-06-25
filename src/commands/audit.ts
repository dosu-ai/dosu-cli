/**
 * `dosu audit` — consume a coding-agent's `.dosu/audit.json`, ensure the repo is
 * connected + indexed in Dosu, then fire server-side doc-generation tasks
 * NON-BLOCKING. The resulting PR is surfaced on a later CLI run via the
 * pending-tasks notifier (see `src/version/pending-tasks-check.ts`).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";
import { createTypedClient, type TypedClient } from "../client/trpc";
import type { Config } from "../config/config";
import { getBackendURL } from "../config/constants";
import { logger } from "../debug/logger";
import { type DetectedRepo, detectGitRepo, stepConnectGitHubRepo } from "../setup/github-step";
import { addPendingTask } from "../version/pending-tasks-check";
import { requireAPIKey, requireLoginConfig } from "./auth";
import { printResult } from "./output";

const INDEX_POLL_INTERVAL_MS = 2_000;
const INDEX_POLL_TIMEOUT_MS = 120_000;

/** A data source as returned by `dataSource.list` (subset we rely on). */
interface DataSourceLike {
  data_source_id?: string;
  provider_slug?: string;
  name?: string;
  is_indexed?: boolean;
  status?: string;
}

/** A capability as returned by `GET /v1/cli/tasks`. */
interface Capability {
  id: string;
  label: string;
  description: string;
  doc_type: string;
}

interface CapabilitiesResponse {
  tasks: Capability[];
}

/** A single finding inside `.dosu/audit.json`. */
interface AuditItem {
  task: string;
  type: string;
  file: string;
  status: "missing" | "outdated" | "present_ok";
  action: "create" | "update" | "skip";
  can_help: boolean;
  confidence: "high" | "medium" | "low";
  rationale: string;
  evidence: string[];
}

interface AuditFindings {
  version: number;
  generated_at: string;
  repo: { remote: string; slug: string };
  items: AuditItem[];
}

function requireConfig(): Config & { api_key: string; org_id: string } {
  const cfg = requireLoginConfig();
  if (!cfg.api_key) {
    console.error(pc.red("API key not configured. Run 'dosu setup' first."));
    process.exit(1);
  }
  if (!cfg.org_id) {
    console.error(pc.red("Missing org config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return cfg as Config & { api_key: string; org_id: string };
}

async function backendGet(path: string, apiKey: string): Promise<unknown> {
  const backendURL = getBackendURL();
  if (!backendURL) {
    console.error(pc.red("Backend URL not configured."));
    process.exit(1);
  }
  const resp = await fetch(`${backendURL}${path}`, {
    headers: { "X-Dosu-API-Key": apiKey },
  });
  if (!resp.ok) {
    let detail = `Request failed with status ${resp.status}`;
    try {
      const errBody = (await resp.json()) as { detail?: string };
      detail = errBody.detail ?? detail;
    } catch {}
    throw new Error(detail);
  }
  return await resp.json();
}

async function backendPost(
  path: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const backendURL = getBackendURL();
  if (!backendURL) {
    console.error(pc.red("Backend URL not configured."));
    process.exit(1);
  }
  const resp = await fetch(`${backendURL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Dosu-API-Key": apiKey },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let detail = `Request failed with status ${resp.status}`;
    try {
      const errBody = (await resp.json()) as { detail?: string };
      detail = errBody.detail ?? detail;
    } catch {}
    throw new Error(detail);
  }
  return await resp.json();
}

async function listDataSources(client: TypedClient, orgId: string): Promise<DataSourceLike[]> {
  const result = (await client.dataSource.list.query({
    org_id: orgId,
    excluded_provider_slugs: [],
  })) as DataSourceLike[] | null;
  return result ?? [];
}

function findMatch(sources: DataSourceLike[], detected: DetectedRepo): DataSourceLike | undefined {
  return sources.find((ds) => ds.provider_slug === "github" && ds.name === detected.slug);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `dataSource.list` until the matched data source for `detected` is
 * indexed. Returns the indexed data source, or `null` on timeout.
 */
async function waitForIndexed(
  client: TypedClient,
  orgId: string,
  detected: DetectedRepo,
  quiet = false,
): Promise<DataSourceLike | null> {
  const spinner = quiet ? null : p.spinner();
  spinner?.start("Waiting for Dosu to finish indexing the repo...");
  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < INDEX_POLL_TIMEOUT_MS) {
      const sources = await listDataSources(client, orgId);
      const match = findMatch(sources, detected);
      if (match?.is_indexed === true) {
        spinner?.stop("Repo indexed");
        return match;
      }
      await sleep(INDEX_POLL_INTERVAL_MS);
    }
  } catch (err: unknown) {
    /* v8 ignore next 2 -- transient list failures bubble up rarely */
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("audit", `dataSource.list during index poll failed: ${msg}`);
  }
  spinner?.stop("Still indexing");
  return null;
}

/**
 * Resolve the data_source_id for the detected repo, connecting + indexing it if
 * necessary. Exits the process on any blocking condition. Returns the
 * data_source_id on success.
 */
async function ensureSyncedRepo(
  cfg: Config & { org_id: string },
  client: TypedClient,
  detected: DetectedRepo,
  explicitDataSourceId: string | undefined,
  nonInteractive: boolean,
): Promise<string> {
  if (explicitDataSourceId) {
    return explicitDataSourceId;
  }

  let sources = await listDataSources(client, cfg.org_id);
  let match = findMatch(sources, detected);

  if (!match) {
    // In non-interactive (agent-driven) mode never prompt or open a browser —
    // fail with a clear message the caller can relay and exit non-zero.
    if (nonInteractive) {
      console.error(
        pc.red(`${detected.slug} isn't connected to Dosu. Run 'dosu setup' to connect it first.`),
      );
      process.exit(1);
    }
    const connect = await p.confirm({
      message: `${detected.slug} isn't connected to Dosu. Connect and sync it now?`,
    });
    if (p.isCancel(connect) || !connect) {
      console.error(
        pc.red(`Repo not connected. Run 'dosu setup' to connect ${detected.slug}, then retry.`),
      );
      process.exit(1);
    }
    const result = await stepConnectGitHubRepo(cfg, detected);
    if (!result.has_connected_repo) {
      console.error(pc.red(`Could not connect ${detected.slug}. Run 'dosu setup' and retry.`));
      process.exit(1);
    }
    sources = await listDataSources(client, cfg.org_id);
    match = findMatch(sources, detected);
    if (!match) {
      console.error(pc.red(`Could not find ${detected.slug} after connecting. Retry shortly.`));
      process.exit(1);
    }
  }

  if (match.is_indexed !== true) {
    const indexed = await waitForIndexed(client, cfg.org_id, detected, nonInteractive);
    if (!indexed) {
      if (nonInteractive) {
        console.error(pc.red(`${detected.slug} is still indexing. Re-run once indexing finishes.`));
        process.exit(1);
      }
      p.log.info(
        `${detected.slug} is still indexing. Re-run 'dosu audit' in a few minutes once it's ready.`,
      );
      process.exit(0);
    }
    match = indexed;
  }

  if (!match.data_source_id) {
    console.error(pc.red("Matched data source has no id. Run 'dosu setup' and retry."));
    process.exit(1);
  }
  return match.data_source_id;
}

function loadFindings(findingsPath: string): AuditFindings {
  const fail = (): never => {
    console.error(
      pc.red("Run the Dosu audit in your coding agent first (it writes .dosu/audit.json)."),
    );
    process.exit(1);
  };
  if (!existsSync(findingsPath)) {
    fail();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(findingsPath, "utf-8"));
  } catch {
    fail();
  }
  // Guard against valid-JSON-but-wrong-shape (e.g. `null`, a primitive, or a
  // missing/!==1 version, or non-array items) — accessing fields would throw.
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as AuditFindings).version !== 1 ||
    !Array.isArray((parsed as AuditFindings).items)
  ) {
    fail();
  }
  return parsed as AuditFindings;
}

/** Intersect findings with capabilities, keyed by `item.task` === capability `id`. */
function intersectActionable(items: AuditItem[], capabilities: Capability[]): AuditItem[] {
  const known = new Set(capabilities.map((c) => c.id));
  return items.filter((item) => known.has(item.task));
}

function isPreselected(item: AuditItem): boolean {
  return item.can_help && item.action !== "skip";
}

export function auditCommand(): Command {
  const cmd = new Command("audit")
    .description("Generate docs from a coding-agent audit (.dosu/audit.json)")
    .option("--data-source-id <id>", "Skip auto-match and use this data source ID")
    .option("--findings <path>", "Path to the audit findings JSON")
    .option(
      "--tasks <ids>",
      "Comma-separated task ids to generate (non-interactive; for agent-driven use)",
    )
    .option("--yes", "Skip the prompt and select all suggested items")
    .option("--json", "Output as JSON")
    .action(
      async (opts: {
        dataSourceId?: string;
        findings?: string;
        tasks?: string;
        yes?: boolean;
        json?: boolean;
      }) => {
        const cfg = requireConfig();
        const apiKey = requireAPIKey(cfg);

        // 1. Enforce a synced repo (block otherwise).
        const detected = detectGitRepo();
        if (!detected) {
          console.error(pc.red("Not a GitHub repo. Run 'dosu audit' from a GitHub repository."));
          process.exit(1);
        }

        // `--tasks` is the agent-driven path: fire a specific subset without any
        // interactive prompt. Treat it as non-interactive so the connect/index
        // steps never block on a clack prompt or open a browser.
        const nonInteractive = Boolean(opts.tasks);

        const client = createTypedClient(cfg);
        const dataSourceId = await ensureSyncedRepo(
          cfg,
          client,
          detected,
          opts.dataSourceId,
          nonInteractive,
        );

        // 2. Load findings.
        const findingsPath = opts.findings ?? join(process.cwd(), ".dosu", "audit.json");
        const findings = loadFindings(findingsPath);

        // 3. Fetch capabilities.
        const capsResp = (await backendGet("/v1/cli/tasks", apiKey)) as CapabilitiesResponse;
        const capabilities = capsResp.tasks ?? [];

        // 4. Intersect findings with capabilities.
        const actionable = intersectActionable(findings.items, capabilities);
        if (actionable.length === 0) {
          if (opts.json) {
            printResult({ task_ids: [] }, opts);
            return;
          }
          p.log.info("Nothing to generate — no audit findings match Dosu's capabilities.");
          return;
        }

        // 5. Select items.
        let selected: AuditItem[];
        if (opts.tasks) {
          // Agent-driven: fire exactly the requested task ids (the agent already
          // presented the picks to the user). Warn on any that aren't offerable.
          const want = new Set(
            opts.tasks
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
          );
          selected = actionable.filter((item) => want.has(item.task));
          const unknown = [...want].filter((t) => !actionable.some((item) => item.task === t));
          if (unknown.length > 0) {
            logger.warn("audit", `Ignoring tasks not offered by the audit: ${unknown.join(", ")}`);
          }
        } else if (opts.yes) {
          selected = actionable.filter(isPreselected);
        } else {
          const choice = await p.multiselect({
            message: "Which docs should Dosu generate?",
            options: actionable.map((item) => ({
              value: item.task,
              label: `${item.file} ${pc.dim(`(${item.type})`)}`,
              hint: `${item.status} — ${item.rationale}`,
            })),
            initialValues: actionable.filter(isPreselected).map((item) => item.task),
            required: false,
          });
          if (p.isCancel(choice)) {
            p.log.info("Cancelled.");
            return;
          }
          const chosen = new Set(choice as string[]);
          selected = actionable.filter((item) => chosen.has(item.task));
        }

        if (selected.length === 0) {
          if (opts.json) {
            printResult({ task_ids: [] }, opts);
            return;
          }
          p.log.info("Nothing selected.");
          return;
        }

        // 6. Fire tasks NON-BLOCKING.
        const taskIds: string[] = [];
        for (const item of selected) {
          const result = (await backendPost(`/v1/cli/task/${item.task}`, apiKey, {
            data_source_id: dataSourceId,
            repo: detected.slug,
            findings: item,
          })) as { task_id?: string };
          const taskId = result?.task_id;
          if (!taskId) {
            logger.warn("audit", `No task_id returned for ${item.task}`);
            continue;
          }
          taskIds.push(taskId);
          // 7. Cache the pending task so a later CLI run surfaces the PR.
          addPendingTask({
            task_id: taskId,
            doc_types: [item.type],
            repo: detected.slug,
          });
        }

        if (opts.json) {
          printResult({ task_ids: taskIds }, opts);
          return;
        }
        p.log.success(
          "Dosu is generating your docs — you'll be notified here when the PR is ready.",
        );
      },
    );

  return cmd;
}
