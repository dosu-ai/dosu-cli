/**
 * `dosu deployments` — list, inspect, and switch deployments.
 */

import { Command } from "commander";
import pc from "picocolors";
import { createTypedClient } from "../client/trpc";
import { saveConfig, updateTarget } from "../config/config";
import { requireLoginConfig } from "./auth";
import { formatDate, printInfo, printResult, printTable } from "./output";

function requireConfig() {
  return requireLoginConfig();
}

export function deploymentsCommand(): Command {
  const cmd = new Command("deployments").description("Manage deployments");

  cmd
    .command("list")
    .description("List all deployments")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      const deployments = cfg.active_account?.target?.org_id
        ? await client.workspaces.listForOrg.query(cfg.active_account?.target?.org_id)
        : await client.workspaces.listAll.query({});

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
        deployments.map(
          (d: { deployment_id: string; name?: string; org_id?: string; enabled?: boolean }) => [
            d.deployment_id.slice(0, 8),
            d.name ?? "(unnamed)",
            d.org_id ? d.org_id.slice(0, 8) : "—",
            d.enabled ? pc.green("active") : pc.dim("disabled"),
          ],
        ),
        { rawData: deployments },
      );

      if (cfg.active_account?.target?.deployment_id) {
        console.log(
          `\n${pc.dim(`Current: ${cfg.active_account?.target?.deployment_name ?? cfg.active_account?.target?.deployment_id}`)}`,
        );
      }
    });

  cmd
    .command("info")
    .description("Show current deployment details")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();

      if (!cfg.active_account?.target?.deployment_id) {
        console.error(
          pc.red("No deployment selected. Run 'dosu setup' or 'dosu deployments switch'."),
        );
        process.exit(1);
      }

      const client = createTypedClient(cfg);
      const deployment = await client.workspaces.get.query(
        cfg.active_account?.target?.deployment_id,
      );

      if (!deployment) {
        console.error(pc.red(`Deployment not found: ${cfg.active_account?.target?.deployment_id}`));
        process.exit(1);
      }

      if (opts.json) {
        printResult(deployment, opts);
        return;
      }

      const org = await client.organization.getOrganizationById.query(deployment.org_id);

      printInfo(
        [
          ["ID", deployment.deployment_id],
          ["Name", deployment.name],
          ["Description", deployment.description],
          ["Organization", org?.name ?? deployment.org_id],
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
      const client = createTypedClient(cfg);

      // Validate the deployment exists and user has access
      const deployment = await client.workspaces.get.query(id);

      if (!deployment) {
        console.error(pc.red(`Deployment not found: ${id}`));
        process.exit(1);
      }

      updateTarget(cfg, {
        deployment_id: deployment.deployment_id,
        deployment_name: deployment.name,
        org_id: deployment.org_id,
        space_id: deployment.space_id,
      });
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
