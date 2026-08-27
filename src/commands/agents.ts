/** `dosu agents` — manage configurable Dosu agents. */

import { Command, InvalidArgumentError, Option } from "commander";
import pc from "picocolors";
import { createTypedClient } from "../client/trpc";
import type { CliJson } from "../generated/dosu-api-types";
import { boundedText, jsonValue, onOrOff, uuidV4 } from "./arguments";
import { requireOrgConfig } from "./auth";
import { confirmAction } from "./confirmation";
import { formatDate, printInfo, printResult, printTable } from "./output";

function validateConfigPath(path: string): string {
  if (path.length > 200) {
    throw new InvalidArgumentError("must be at most 200 characters");
  }
  const parts = path.split(".");
  if (
    parts.some(
      (part) =>
        !part || part.trim() !== part || ["__proto__", "constructor", "prototype"].includes(part),
    )
  ) {
    throw new InvalidArgumentError("must be a dot-separated config leaf path");
  }
  return path;
}

export function agentsCommand(): Command {
  const cmd = new Command("agents").description("Manage Dosu agents");

  cmd
    .command("list")
    .description("List configurable agents in the selected organization")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const { cfg, orgId } = requireOrgConfig();
      const agents = await createTypedClient(cfg).agents.list.query({ org_id: orgId });
      if (opts.json) return printResult(agents, opts);
      printTable(
        ["ID", "Name", "Provider", "Library", "Status"],
        agents.map((agent) => [
          agent.deployment_id.slice(0, 8),
          agent.name,
          agent.provider_slug,
          agent.space_id.slice(0, 8),
          agent.enabled ? "active" : "disabled",
        ]),
        { rawData: agents },
      );
    });

  cmd
    .command("info")
    .description("Show an agent")
    .argument("<agent-id>", "Agent ID", uuidV4)
    .option("--json", "Output as JSON")
    .action(async (agentId: string, opts: { json?: boolean }) => {
      const { cfg } = requireOrgConfig();
      const agent = await createTypedClient(cfg).agents.get.query(agentId);
      if (opts.json) return printResult(agent, opts);
      printInfo(
        [
          ["ID", agent.deployment_id],
          ["Name", agent.name],
          ["Provider", agent.provider_slug],
          ["Library", agent.space_id],
          ["Status", agent.enabled ? "active" : "disabled"],
          ["Guidelines", agent.response_guidelines ?? undefined],
          ["Updated", formatDate(agent.updated_at)],
        ],
        { rawData: agent },
      );
    });

  cmd
    .command("create")
    .description("Create a safe Mention-only agent from an existing data source")
    .requiredOption("--library <id>", "Library ID", uuidV4)
    .requiredOption("--source <id>", "Data source ID", uuidV4)
    .option("--name <name>", "Agent name", boundedText(80))
    .option("--guidelines <text>", "Response guidelines")
    .option("--json", "Output as JSON")
    .action(
      async (opts: {
        library: string;
        source: string;
        name?: string;
        guidelines?: string;
        json?: boolean;
      }) => {
        if (opts.guidelines && opts.guidelines.length > 20_000) {
          throw new InvalidArgumentError("--guidelines must be at most 20000 characters");
        }
        const { cfg, orgId } = requireOrgConfig();
        const agent = await createTypedClient(cfg).agents.create.mutate({
          data_source_id: opts.source,
          name: opts.name,
          org_id: orgId,
          response_guidelines: opts.guidelines,
          space_id: opts.library,
        });
        if (opts.json) return printResult(agent, opts);
        console.log(pc.green(`Created agent '${agent.name}' (${agent.deployment_id}).`));
      },
    );

  cmd
    .command("update")
    .description("Update an agent (requires confirmation)")
    .argument("<agent-id>", "Agent ID", uuidV4)
    .option("--name <name>", "New name", boundedText(80))
    .addOption(new Option("--enabled <on|off>", "Enable or disable the agent").argParser(onOrOff))
    .addOption(
      new Option("--guidelines <text>", "Replace response guidelines").conflicts("clearGuidelines"),
    )
    .addOption(
      new Option("--clear-guidelines", "Clear response guidelines").conflicts("guidelines"),
    )
    .option("--confirm", "Apply without the interactive prompt")
    .option("--json", "Output as JSON")
    .action(
      async (
        agentId: string,
        opts: {
          name?: string;
          enabled?: boolean;
          guidelines?: string;
          clearGuidelines?: boolean;
          confirm?: boolean;
          json?: boolean;
        },
      ) => {
        if (
          opts.name === undefined &&
          opts.enabled === undefined &&
          opts.guidelines === undefined &&
          !opts.clearGuidelines
        ) {
          throw new InvalidArgumentError(
            "specify --name, --enabled, --guidelines, or --clear-guidelines",
          );
        }
        if (opts.guidelines && opts.guidelines.length > 20_000) {
          throw new InvalidArgumentError("--guidelines must be at most 20000 characters");
        }
        const responseGuidelines = opts.clearGuidelines ? null : opts.guidelines;
        if (
          !(await confirmAction({
            confirmed: opts.confirm,
            json: opts.json,
            message: "Update this agent?",
            preview: {
              action: "update_agent",
              id: agentId,
              name: opts.name,
              enabled: opts.enabled,
              response_guidelines: responseGuidelines,
            },
          }))
        )
          return;
        const { cfg } = requireOrgConfig();
        const agent = await createTypedClient(cfg).agents.update.mutate({
          deployment_id: agentId,
          enabled: opts.enabled,
          name: opts.name,
          response_guidelines: responseGuidelines,
        });
        if (opts.json) return printResult(agent, opts);
        console.log(pc.green(`Updated agent '${agent.name}'.`));
      },
    );

  cmd
    .command("delete")
    .description("Delete an agent (requires confirmation)")
    .argument("<agent-id>", "Agent ID", uuidV4)
    .option("--confirm", "Apply without the interactive prompt")
    .option("--json", "Output as JSON")
    .action(async (agentId: string, opts: { confirm?: boolean; json?: boolean }) => {
      if (
        !(await confirmAction({
          confirmed: opts.confirm,
          json: opts.json,
          message: "Delete this agent?",
          preview: { action: "delete_agent", id: agentId },
        }))
      )
        return;
      const { cfg } = requireOrgConfig();
      const result = await createTypedClient(cfg).agents.delete.mutate(agentId);
      if (opts.json) return printResult(result, opts);
      console.log(pc.green(`Deleted agent ${agentId}.`));
    });

  cmd
    .command("move")
    .description("Move an agent to another library (requires confirmation)")
    .argument("<agent-id>", "Agent ID", uuidV4)
    .requiredOption("--library <id>", "Destination library ID", uuidV4)
    .option("--confirm", "Apply without the interactive prompt")
    .option("--json", "Output as JSON")
    .action(
      async (agentId: string, opts: { library: string; confirm?: boolean; json?: boolean }) => {
        if (
          !(await confirmAction({
            confirmed: opts.confirm,
            json: opts.json,
            message: "Move this agent to another library?",
            preview: { action: "move_agent", id: agentId, library_id: opts.library },
          }))
        )
          return;
        const { cfg } = requireOrgConfig();
        const result = await createTypedClient(cfg).agents.move.mutate({
          deployment_id: agentId,
          space_id: opts.library,
        });
        if (opts.json) return printResult(result, opts);
        console.log(pc.green(`Moved agent '${result.name}' to library ${result.space_id}.`));
      },
    );

  const config = cmd.command("config").description("Read or patch agent configuration");
  config
    .command("get")
    .description("Show agent configuration")
    .argument("<agent-id>", "Agent ID", uuidV4)
    .option("--json", "Output as JSON")
    .action(async (agentId: string, opts: { json?: boolean }) => {
      const { cfg } = requireOrgConfig();
      const result = await createTypedClient(cfg).agents.getConfig.query(agentId);
      if (opts.json) return printResult(result, opts);
      printResult(result.config, opts);
    });

  config
    .command("set")
    .description("Set one existing config leaf (requires confirmation)")
    .argument("<agent-id>", "Agent ID", uuidV4)
    .argument("<path>", "Dot-separated config leaf path", validateConfigPath)
    .requiredOption("--value <json>", "New value as JSON", jsonValue)
    .option("--confirm", "Apply without the interactive prompt")
    .option("--json", "Output as JSON")
    .action(
      async (
        agentId: string,
        path: string,
        opts: { value: CliJson; confirm?: boolean; json?: boolean },
      ) => {
        if (
          !(await confirmAction({
            confirmed: opts.confirm,
            json: opts.json,
            message: `Set agent config '${path}'?`,
            preview: { action: "set_agent_config", id: agentId, path, value: opts.value },
          }))
        )
          return;
        const { cfg } = requireOrgConfig();
        const client = createTypedClient(cfg);
        const current = await client.agents.getConfig.query(agentId);
        const result = await client.agents.setConfig.mutate({
          deployment_id: agentId,
          expected_updated_at: current.updated_at,
          path,
          value: opts.value,
        });
        if (opts.json) return printResult(result, opts);
        console.log(pc.green(`Updated agent config '${path}'.`));
      },
    );

  return cmd;
}
