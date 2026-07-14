/**
 * `dosu integrations` — integration status and management.
 */

import { Command } from "commander";
import pc from "picocolors";
import { createTypedClient } from "../client/trpc";
import { requireLoginConfig } from "./auth";
import { printResult, printTable } from "./output";

function requireConfig() {
  const cfg = requireLoginConfig();
  if (!cfg.active_account?.target?.org_id) {
    console.error(pc.red("Missing org config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return cfg;
}

/** Platforms supported by `nango.getConnection` */
const NANGO_PLATFORMS = [
  "confluence",
  "notion",
  "coda",
  "gitlab",
  "gitlab-pat",
  "confluence-basic",
] as const;

/** All display platforms including those checked via other means */
const DISPLAY_PLATFORMS = [
  "github",
  "gitlab",
  "slack",
  "confluence",
  "notion",
  "coda",
  "teams",
] as const;

export function integrationsCommand(): Command {
  const cmd = new Command("integrations").description("Manage integrations");

  cmd
    .command("list")
    .description("List all integrations and their connection status")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      const results: Array<{ platform: string; connected: boolean }> = [];
      for (const platform of DISPLAY_PLATFORMS) {
        // Only nango-supported platforms can be queried via getConnection
        const nangoProvider = NANGO_PLATFORMS.find((p) => p === platform);
        if (nangoProvider) {
          try {
            const conn = await client.nango.getConnection.query({
              provider: nangoProvider,
              providerConfigKey: nangoProvider,
              // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
              orgId: cfg.active_account!.target!.org_id!,
            });
            results.push({ platform, connected: conn !== null });
          } catch {
            results.push({ platform, connected: false });
          }
        } else {
          // github, slack, teams — not queryable via nango
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
    .argument("<platform>", `Platform: ${DISPLAY_PLATFORMS.join(", ")}`)
    .option("--json", "Output as JSON")
    .action(async (platform: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);
      const nangoProvider = NANGO_PLATFORMS.find((p) => p === platform);

      if (!nangoProvider) {
        if (opts.json) {
          printResult({ platform, connected: false, note: "not queryable via nango" }, opts);
          return;
        }
        console.log(`${platform}: ${pc.dim("not connected (not queryable)")}`);
        return;
      }

      try {
        const conn = await client.nango.getConnection.query({
          provider: nangoProvider,
          providerConfigKey: nangoProvider,
          // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
          orgId: cfg.active_account!.target!.org_id!,
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
      const client = createTypedClient(cfg);

      // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
      const channels = await client.slackChannel.getAll.query(cfg.active_account!.target!.org_id!);

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
        channels.map((c: { channel_id: string; name?: string | null }) => [
          c.channel_id,
          c.name ?? "(unnamed)",
        ]),
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
      const client = createTypedClient(cfg);

      await client.slackChannel.join.mutate(channelId);

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
      const client = createTypedClient(cfg);

      // getCollaborators takes a number (repo ID), not an org_id object
      // This requires a repo ID — for now we pass 0 as placeholder
      // TODO: accept --repo-id argument
      const collaborators = await client.githubRepository.getCollaborators.query(0);

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
        collaborators.map((c) => [c.user_name ?? "—", c.full_name ?? "—", c.email ?? "—"]),
        { rawData: collaborators },
      );
    });

  return cmd;
}
