/** `dosu integrations`: integration status and management. */

import { Argument, Command } from "commander";
import pc from "picocolors";
import { createTypedClient, type TypedClient } from "../client/trpc";
import type { NangoGetConnectionInput } from "../generated/dosu-api-types";
import { positiveInteger } from "./arguments";
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

type NangoProvider = NangoGetConnectionInput["provider"];

const DISPLAY_PLATFORMS = [
  "github",
  "gitlab",
  "azure_devops",
  "slack",
  "confluence",
  "notion",
  "coda",
  "teams",
] as const;
type DisplayPlatform = (typeof DISPLAY_PLATFORMS)[number];

type ConnectionProbeResult =
  | { queryable: false; connected: null; connection: null }
  | { queryable: true; connected: boolean; connection: unknown };

/** Nango probes per platform: connected if ANY probe returns a row (OAuth listed first to
 * short-circuit); `nango.getConnection` exact-matches both `provider` and `providerConfigKey`. */
const NANGO_PROBES: Partial<
  Record<DisplayPlatform, readonly { provider: NangoProvider; providerConfigKey: string }[]>
> = {
  gitlab: [
    { provider: "gitlab", providerConfigKey: "gitlab" },
    { provider: "gitlab", providerConfigKey: "gitlab-pat" },
  ],
  confluence: [
    { provider: "confluence", providerConfigKey: "confluence" },
    { provider: "confluence", providerConfigKey: "confluence-basic" },
  ],
  notion: [{ provider: "notion", providerConfigKey: "notion" }],
  coda: [{ provider: "coda", providerConfigKey: "coda" }],
  azure_devops: [
    { provider: "microsoft-entra-id", providerConfigKey: "microsoft-entra-id" },
    { provider: "azure_devops", providerConfigKey: "azure-devops" },
  ],
};

/** Probe a platform's Nango connection state; platforms absent from `NANGO_PROBES` report
 * `queryable: false`. tRPC failures propagate so outages are not misreported as disconnected. */
async function probeConnection(
  client: TypedClient,
  orgId: string,
  platform: DisplayPlatform,
): Promise<ConnectionProbeResult> {
  const probes = NANGO_PROBES[platform];
  if (!probes) {
    return { queryable: false, connected: null, connection: null };
  }
  for (const probe of probes) {
    const conn = await client.nango.getConnection.query({
      provider: probe.provider,
      providerConfigKey: probe.providerConfigKey,
      orgId,
    });
    if (conn != null) {
      return { queryable: true, connected: true, connection: conn };
    }
  }
  return { queryable: true, connected: false, connection: null };
}

export function integrationsCommand(): Command {
  const cmd = new Command("integrations").description("Manage integrations");

  cmd
    .command("list")
    .description("List all integrations and their connection status")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      // Probe platforms in parallel; Promise.all preserves DISPLAY_PLATFORMS order for the table.
      const results = await Promise.all(
        DISPLAY_PLATFORMS.map(async (platform) => {
          const { connected } = await probeConnection(
            client,
            // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
            cfg.active_account!.target!.org_id!,
            platform,
          );
          return { platform, connected };
        }),
      );

      if (opts.json) {
        printResult(results, opts);
        return;
      }

      printTable(
        ["Platform", "Status"],
        results.map((r) => [
          r.platform,
          r.connected === null
            ? pc.dim("status unavailable")
            : r.connected
              ? pc.green("connected")
              : pc.dim("not connected"),
        ]),
        { rawData: results },
      );
    });

  cmd
    .command("status")
    .description("Check connection status of a specific platform")
    .addArgument(new Argument("<platform>", "Integration platform").choices([...DISPLAY_PLATFORMS]))
    .option("--json", "Output as JSON")
    .action(async (platform: DisplayPlatform, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);
      const { queryable, connected, connection } = await probeConnection(
        client,
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        cfg.active_account!.target!.org_id!,
        platform,
      );

      if (!queryable) {
        // github, slack, teams — not queryable via nango
        if (opts.json) {
          printResult(
            { platform, connected: null, note: "connection status unavailable via CLI" },
            opts,
          );
          return;
        }
        console.log(`${platform}: ${pc.dim("connection status unavailable via CLI")}`);
        return;
      }

      if (opts.json) {
        printResult({ platform, connected, connection }, opts);
        return;
      }
      console.log(`${platform}: ${connected ? pc.green("connected") : pc.dim("not connected")}`);
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
    .addArgument(
      new Argument("<repository-id>", "Numeric GitHub repository ID").argParser(positiveInteger),
    )
    .option("--json", "Output as JSON")
    .action(async (repositoryId: number, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      const collaborators = await client.githubRepository.getCollaborators.query(repositoryId);

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
        collaborators.map((c) => [c.user_name ?? "-", c.full_name ?? "-", c.email ?? "-"]),
        { rawData: collaborators },
      );
    });

  return cmd;
}
