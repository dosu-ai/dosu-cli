/**
 * `dosu deployments` — list, inspect, and switch deployments.
 */

import { Command } from "commander";
import pc from "picocolors";
import { TrpcClient } from "../client/trpc";
import { loadConfig, saveConfig } from "../config/config";
import { formatDate, printInfo, printResult, printTable } from "./output";

function requireConfig() {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    console.error(pc.red("Not configured. Run 'dosu setup' first."));
    process.exit(1);
  }
  return cfg;
}

interface Workspace {
  deployment_id: string;
  name: string;
  description?: string;
  provider_slug?: string;
  enabled?: boolean;
  org_id?: string;
  org_name?: string;
  space_id?: string;
  created_at?: string;
  [key: string]: unknown;
}

export function deploymentsCommand(): Command {
  const cmd = new Command("deployments").description("Manage deployments");

  cmd
    .command("list")
    .description("List all deployments")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);

      let deployments: Workspace[];
      if (cfg.org_id) {
        deployments = await trpc.query<Workspace[]>("workspaces.listForOrg", {
          org_id: cfg.org_id,
        });
      } else {
        deployments = await trpc.query<Workspace[]>("workspaces.listAll", {});
      }

      if (opts.json) {
        printResult(deployments, opts);
        return;
      }

      if (!deployments || deployments.length === 0) {
        console.log(pc.dim("No deployments found."));
        return;
      }

      printTable(
        ["ID", "Name", "Org", "Status"],
        deployments.map((d) => [
          d.deployment_id.slice(0, 8),
          d.name ?? "(unnamed)",
          d.org_name ?? "—",
          d.enabled ? pc.green("active") : pc.dim("disabled"),
        ]),
        { rawData: deployments },
      );

      if (cfg.deployment_id) {
        console.log(`\n${pc.dim(`Current: ${cfg.deployment_name ?? cfg.deployment_id}`)}`);
      }
    });

  cmd
    .command("info")
    .description("Show current deployment details")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();

      if (!cfg.deployment_id) {
        console.error(
          pc.red("No deployment selected. Run 'dosu setup' or 'dosu deployments switch'."),
        );
        process.exit(1);
      }

      const trpc = new TrpcClient(cfg);
      const deployment = await trpc.query<Workspace>("workspaces.get", {
        id: cfg.deployment_id,
      });

      if (opts.json) {
        printResult(deployment, opts);
        return;
      }

      printInfo(
        [
          ["ID", deployment.deployment_id],
          ["Name", deployment.name],
          ["Description", deployment.description],
          ["Organization", deployment.org_name],
          ["Status", deployment.enabled ? "active" : "disabled"],
          ["Space ID", deployment.space_id],
          ["Created", formatDate(deployment.created_at)],
        ],
        { rawData: deployment },
      );
    });

  cmd
    .command("switch")
    .description("Switch to a different deployment")
    .argument("<id>", "Deployment ID")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);

      // Validate the deployment exists and user has access
      const deployment = await trpc.query<Workspace>("workspaces.get", { id });

      cfg.deployment_id = deployment.deployment_id;
      cfg.deployment_name = deployment.name;
      cfg.org_id = deployment.org_id;
      cfg.space_id = deployment.space_id;
      saveConfig(cfg);

      if (opts.json) {
        printResult(
          { success: true, deployment_id: deployment.deployment_id, name: deployment.name },
          opts,
        );
        return;
      }

      console.log(pc.green(`Switched to deployment: ${deployment.name}`));
    });

  return cmd;
}
