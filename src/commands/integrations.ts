/**
 * `dosu integrations` — integration status and management.
 */

import { Command } from "commander";
import pc from "picocolors";
import { createTypedClient, type TypedClient } from "../client/trpc";
import type { NangoGetConnectionInput } from "../generated/dosu-api-types";
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

/**
 * Nango probes per platform. A platform can be connectable under more than one
 * Nango provider, and a connection may exist under any of them; we report
 * connected if ANY probe returns a row.
 *
 * `nango.getConnection` exact-matches BOTH `provider` (the Nango DB provider
 * value) and `providerConfigKey` (the Nango integration id). These differ for
 * the alternate-auth integrations — the integration id is a distinct base, and
 * the DB provider stays the platform's canonical value. The primary auth method
 * (OAuth) is listed first so the common case short-circuits on the first probe;
 * the alternate (PAT / Basic) is the fallback:
 *   - GitLab: OAuth `{gitlab, gitlab}`, PAT `{gitlab, gitlab-pat}`
 *   - Confluence: OAuth `{confluence, confluence}`, Basic `{confluence, confluence-basic}`
 *   - Azure DevOps: OAuth `{microsoft-entra-id, microsoft-entra-id}`, PAT `{azure_devops, azure-devops}`
 * (Note `azure_devops` the DB provider vs `azure-devops` the integration id.)
 *
 * `gitlab-pat`/`confluence-basic` are also kept as standalone keys so
 * `status gitlab-pat` / `status confluence-basic` still work. Prod uses bare
 * integration ids (no env suffix), which is what the shipped CLI targets.
 */
const NANGO_PROBES: Record<
  string,
  readonly { provider: NangoProvider; providerConfigKey: string }[]
> = {
  gitlab: [
    { provider: "gitlab", providerConfigKey: "gitlab" },
    { provider: "gitlab", providerConfigKey: "gitlab-pat" },
  ],
  "gitlab-pat": [{ provider: "gitlab", providerConfigKey: "gitlab-pat" }],
  confluence: [
    { provider: "confluence", providerConfigKey: "confluence" },
    { provider: "confluence", providerConfigKey: "confluence-basic" },
  ],
  "confluence-basic": [{ provider: "confluence", providerConfigKey: "confluence-basic" }],
  notion: [{ provider: "notion", providerConfigKey: "notion" }],
  coda: [{ provider: "coda", providerConfigKey: "coda" }],
  azure_devops: [
    { provider: "microsoft-entra-id", providerConfigKey: "microsoft-entra-id" },
    { provider: "azure_devops", providerConfigKey: "azure-devops" },
  ],
};

/** All display platforms including those checked via other means */
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

/**
 * Probe a platform's Nango connection state. Platforms absent from
 * `NANGO_PROBES` (github, slack, teams) are reported as `queryable: false`.
 * Otherwise every probe is tried in order, short-circuiting on the first
 * connection found; a throwing probe is swallowed so the next one still runs.
 */
async function probeConnection(
  client: TypedClient,
  orgId: string,
  platform: string,
): Promise<{ queryable: boolean; connected: boolean; connection: unknown }> {
  const probes = NANGO_PROBES[platform];
  if (!probes) {
    return { queryable: false, connected: false, connection: null };
  }
  for (const probe of probes) {
    try {
      const conn = await client.nango.getConnection.query({
        provider: probe.provider,
        providerConfigKey: probe.providerConfigKey,
        orgId,
      });
      if (conn != null) {
        return { queryable: true, connected: true, connection: conn };
      }
    } catch {
      // Swallow and try the next probe.
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

      // Probe platforms in parallel — each is independent — so the command
      // isn't gated on the sum of every platform's network round-trips.
      // Promise.all preserves order, so the table still follows DISPLAY_PLATFORMS.
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
      const { queryable, connected, connection } = await probeConnection(
        client,
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        cfg.active_account!.target!.org_id!,
        platform,
      );

      if (!queryable) {
        // github, slack, teams — not queryable via nango
        if (opts.json) {
          printResult({ platform, connected: false, note: "not queryable via nango" }, opts);
          return;
        }
        console.log(`${platform}: ${pc.dim("not connected (not queryable)")}`);
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
