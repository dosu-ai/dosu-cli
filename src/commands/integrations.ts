/**
 * `dosu integrations` — integration status and management.
 */

import { Command } from "commander";
import pc from "picocolors";
import { TrpcClient } from "../client/trpc";
import { loadConfig } from "../config/config";
import { printResult, printTable } from "./output";

function requireConfig() {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    console.error(pc.red("Not configured. Run 'dosu setup' first."));
    process.exit(1);
  }
  if (!cfg.org_id) {
    console.error(pc.red("Missing org config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return cfg;
}

const PLATFORMS = ["github", "gitlab", "slack", "confluence", "notion", "coda", "teams"] as const;

export function integrationsCommand(): Command {
  const cmd = new Command("integrations").description("Manage integrations");

  cmd
    .command("list")
    .description("List all integrations and their connection status")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);

      const results: Array<{ platform: string; connected: boolean }> = [];
      for (const platform of PLATFORMS) {
        try {
          const conn = await trpc.query<unknown>("nango.getConnection", {
            provider: platform,
            providerConfigKey: platform,
            // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
            orgId: cfg.org_id!,
          });
          results.push({ platform, connected: conn !== null });
        } catch {
          results.push({ platform, connected: false });
        }
      }

      if (opts.json) {
        printResult(results, opts);
        return;
      }

      printTable(
        ["Platform", "Status"],
        results.map((r) => [
          r.platform,
          r.connected ? pc.green("connected") : pc.dim("not connected"),
        ]),
        { rawData: results },
      );
    });

  cmd
    .command("status")
    .description("Check connection status of a specific platform")
    .argument("<platform>", `Platform: ${PLATFORMS.join(", ")}`)
    .option("--json", "Output as JSON")
    .action(async (platform: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);

      try {
        const conn = await trpc.query<unknown>("nango.getConnection", {
          provider: platform,
          providerConfigKey: platform,
          // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
          orgId: cfg.org_id!,
        });

        const connected = conn !== null;
        if (opts.json) {
          printResult({ platform, connected, connection: conn }, opts);
          return;
        }
        console.log(`${platform}: ${connected ? pc.green("connected") : pc.dim("not connected")}`);
      } catch {
        if (opts.json) {
          printResult({ platform, connected: false }, opts);
          return;
        }
        console.log(`${platform}: ${pc.dim("not connected")}`);
      }
    });

  cmd
    .command("slack-channels")
    .description("List Slack channels")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);

      const channels = await trpc.query<
        Array<{ id: string; name: string; [key: string]: unknown }>
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
      >("slackChannel.getAll", { orgId: cfg.org_id! });

      if (opts.json) {
        printResult(channels, opts);
        return;
      }

      if (!channels || channels.length === 0) {
        console.log(pc.dim("No Slack channels found."));
        return;
      }

      printTable(
        ["ID", "Name"],
        channels.map((c) => [c.id, c.name]),
        { rawData: channels },
      );
    });

  cmd
    .command("slack-join")
    .description("Join a Slack channel")
    .argument("<channel-id>", "Slack channel ID")
    .option("--json", "Output as JSON")
    .action(async (channelId: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);

      await trpc.mutate("slackChannel.join", { channelId });

      if (opts.json) {
        printResult({ success: true, channelId }, opts);
        return;
      }
      console.log(pc.green(`Joined Slack channel ${channelId}.`));
    });

  cmd
    .command("github-collaborators")
    .description("List GitHub repository collaborators")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);

      const collaborators = await trpc.query<
        Array<{ email?: string; name?: string; username?: string }>
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
      >("githubRepository.getCollaborators", { orgId: cfg.org_id! });

      if (opts.json) {
        printResult(collaborators, opts);
        return;
      }

      if (!collaborators || collaborators.length === 0) {
        console.log(pc.dim("No collaborators found."));
        return;
      }

      printTable(
        ["Username", "Name", "Email"],
        collaborators.map((c) => [c.username ?? "—", c.name ?? "—", c.email ?? "—"]),
        { rawData: collaborators },
      );
    });

  return cmd;
}
