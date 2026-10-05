/** `dosu review notifications`: the Slack channel that receives a Library's or Agent's reviews. */

import { isTRPCClientError } from "@trpc/client";
import { Command, Option } from "commander";
import pc from "picocolors";
import { createTypedClient, type TypedClient } from "../client/trpc";
import { getWebAppURL } from "../config/constants";
import type {
  ReviewNotificationGetInput,
  ReviewNotificationGetOutput,
} from "../generated/dosu-api-types";
import { uuidV4 } from "./arguments";
import { requireLoginConfig } from "./auth";
import { confirmAction } from "./confirmation";
import { printInfo, printResult } from "./output";
import { channelLabel, resolveChannel } from "./slack-channel-resolve";

type Scope = ReviewNotificationGetInput["scope"];

type TargetOpts = { library?: string; agent?: string };

type Target = {
  scope: Scope;
  targetId: string;
  /** User-facing noun: the router's `space`/`deployment` never reach the terminal. */
  noun: "Library" | "Agent";
  /** The flag pair that re-selects this target in hints (`--library <id>`). */
  flag: string;
};

const RECONNECT_HELP = `
A channel that stopped receiving notifications (archived, Dosu removed, access lost) shows its
reason in \`get\`. Re-run \`set\` with the same channel to reconnect it.

--channel accepts a Dosu channel UUID, a Slack channel ID (C… / G…), or a name (#name or name).
Only organization admins can change Slack Notifications.`;

function targetOptions(cmd: Command): Command {
  return cmd
    .addOption(
      new Option("--library <library-id>", "Library ID (UUID)")
        .argParser(uuidV4)
        .conflicts("agent"),
    )
    .addOption(
      new Option("--agent <agent-id>", "Agent ID (UUID), from `dosu agents list`")
        .argParser(uuidV4)
        .conflicts("library"),
    );
}

function resolveTarget(opts: TargetOpts): Target {
  if (opts.library) {
    return {
      scope: "space",
      targetId: opts.library,
      noun: "Library",
      flag: `--library ${opts.library}`,
    };
  }
  if (opts.agent) {
    return {
      scope: "deployment",
      targetId: opts.agent,
      noun: "Agent",
      flag: `--agent ${opts.agent}`,
    };
  }
  console.error(pc.red("Pass --library <library-id> or --agent <agent-id>."));
  process.exit(1);
}

function installUrl(): string {
  return `${getWebAppURL()}/slack`;
}

// Mirrors disabledReasonKey in dosu's ReviewNotificationsSection.tsx so the CLI and the App
// explain a delivery failure the same way.
function describeDisabledReason(reason: string): string {
  if (reason === "not_in_channel") {
    return "Dosu is not in the channel. Run `/invite @Dosu` in it, then re-run `set`.";
  }
  if (reason === "is_archived" || reason === "channel_not_found" || reason === "channel_missing") {
    return "The channel is archived or gone. Run `set` with another channel.";
  }
  return `Dosu lost access to the channel (${reason}). Re-run \`set\` to reconnect.`;
}

function errorCode(err: unknown): string | undefined {
  return isTRPCClientError(err) ? (err.data as { code?: string } | null)?.code : undefined;
}

async function getNotification(
  client: TypedClient,
  target: Target,
): Promise<ReviewNotificationGetOutput> {
  return client.reviewNotification.get.query({ scope: target.scope, targetId: target.targetId });
}

// Stop before prompting when the write cannot succeed. Each check reads `get`, which is what
// turns the router's generic 403/404s into actionable messages.
function assertWritable(state: ReviewNotificationGetOutput): void {
  if (!state.canEdit) {
    console.error(pc.red("Only organization admins can change Slack Notifications."));
    process.exit(1);
  }
  if (!state.slackInstalled) {
    console.error(pc.red("The Dosu Slack app is not installed for this organization."));
    console.error(`Install it at ${installUrl()}, then re-run this command.`);
    process.exit(1);
  }
  if (!state.notificationsEnabled) {
    console.error(pc.red("Slack Notifications are not enabled for this organization."));
    process.exit(1);
  }
}

function printNotification(target: Target, state: ReviewNotificationGetOutput): void {
  const { notification } = state;
  if (!notification) {
    console.log(pc.dim(`No Slack channel is set for this ${target.noun}.`));
  } else {
    const delivers = [
      notification.notify_doc_reviews && "doc reviews",
      notification.notify_message_reviews && "draft replies",
    ].filter(Boolean);
    printInfo([
      [target.noun, target.targetId],
      [
        "Channel",
        notification.channel
          ? channelLabel(notification.channel)
          : pc.yellow(`missing (${notification.slack_channel_id})`),
      ],
      [
        "Private",
        notification.channel?.is_private == null
          ? undefined
          : notification.channel.is_private
            ? "yes"
            : "no",
      ],
      ["Notifies", delivers.length > 0 ? delivers.join(", ") : "nothing"],
      [
        "Status",
        notification.disabled_reason
          ? pc.red(`disabled: ${describeDisabledReason(notification.disabled_reason)}`)
          : notification.channel
            ? pc.green("active")
            : pc.red("disabled: the channel no longer exists. Run `set` with another channel."),
      ],
    ]);
  }

  if (!state.slackInstalled) {
    console.log(pc.yellow(`The Dosu Slack app is not installed. Install it at ${installUrl()}.`));
  }
  if (!state.notificationsEnabled) {
    console.log(
      pc.yellow("Slack Notifications are not enabled for this organization; nothing is delivered."),
    );
  }
  if (!notification && state.canEdit && state.slackInstalled && state.notificationsEnabled) {
    console.log(
      pc.dim(`Set one with: dosu review notifications set ${target.flag} --channel <channel>`),
    );
  }
}

export function reviewNotificationsCommand(): Command {
  const cmd = new Command("notifications").description(
    "Manage the Slack channel that receives a Library's or Agent's review notifications",
  );
  cmd.addHelpText("after", RECONNECT_HELP);

  targetOptions(
    cmd.command("get").description("Show the Slack channel that receives review notifications"),
  )
    .option("--json", "Output as JSON")
    .action(async (opts: TargetOpts & { json?: boolean }) => {
      const target = resolveTarget(opts);
      const client = createTypedClient(requireLoginConfig());
      const state = await getNotification(client, target);
      if (opts.json) {
        printResult(state, opts);
        return;
      }
      printNotification(target, state);
    });

  targetOptions(
    cmd
      .command("set")
      .description(
        "Send review notifications to a Slack channel (org admins; requires confirmation)",
      )
      .addHelpText("after", RECONNECT_HELP),
  )
    .requiredOption("--channel <channel>", "Channel UUID, Slack channel ID, or #name")
    .option("--confirm", "Apply without the interactive prompt")
    .option("--json", "Output as JSON")
    .action(async (opts: TargetOpts & { channel: string; confirm?: boolean; json?: boolean }) => {
      const target = resolveTarget(opts);
      const client = createTypedClient(requireLoginConfig());
      const state = await getNotification(client, target);
      assertWritable(state);

      // Look the channel up in the target's org (from `get`), which can differ from the org
      // selected locally.
      const { id: slackChannelId, channel } = await resolveChannel(
        client,
        state.orgId,
        opts.channel,
        { name: "--channel", uuidUsage: "--channel <uuid>" },
        opts.json,
      );
      const label = channel ? channelLabel(channel) : slackChannelId;
      const current = state.notification;
      const currentLabel = current?.channel
        ? channelLabel(current.channel)
        : (current?.slack_channel_id ?? "none");

      if (!opts.json) {
        printInfo([
          [target.noun, target.targetId],
          ["Channel", `${currentLabel} → ${label}`],
        ]);
      }
      if (
        !(await confirmAction({
          confirmed: opts.confirm,
          json: opts.json,
          message: `Send this ${target.noun}'s review notifications to ${label}?`,
          preview: {
            target: target.noun.toLowerCase(),
            targetId: target.targetId,
            current: current?.slack_channel_id ?? null,
            slackChannelId,
            channel,
          },
        }))
      )
        return;

      try {
        await client.reviewNotification.upsert.mutate({
          scope: target.scope,
          targetId: target.targetId,
          slackChannelId,
        });
      } catch (err) {
        // The router raises PRECONDITION_FAILED only when the bot is not in a private channel.
        if (errorCode(err) === "PRECONDITION_FAILED") {
          console.error(pc.red(`Dosu can't join ${label}.`));
          console.error(
            `Run \`/invite @Dosu\` in the channel, then re-run \`dosu review notifications set ${target.flag} --channel ${opts.channel}\`.`,
          );
          process.exit(1);
        }
        throw err;
      }

      const updated = await getNotification(client, target);
      if (opts.json) {
        printResult({ success: true, notification: updated.notification }, opts);
        return;
      }
      const saved = updated.notification?.channel;
      console.log(
        pc.green(
          `Review notifications for this ${target.noun} now go to ${saved ? channelLabel(saved) : label}.`,
        ),
      );
    });

  targetOptions(
    cmd
      .command("clear")
      .description(
        "Stop sending review notifications to Slack (org admins; requires confirmation)",
      ),
  )
    .option("--confirm", "Apply without the interactive prompt")
    .option("--json", "Output as JSON")
    .action(async (opts: TargetOpts & { confirm?: boolean; json?: boolean }) => {
      const target = resolveTarget(opts);
      const client = createTypedClient(requireLoginConfig());
      const state = await getNotification(client, target);
      const current = state.notification;

      if (!current) {
        if (opts.json) {
          printResult({ success: true, removed: false }, opts);
          return;
        }
        console.log(pc.dim(`No Slack channel is set for this ${target.noun}; nothing to clear.`));
        return;
      }
      if (!state.canEdit) {
        console.error(pc.red("Only organization admins can change Slack Notifications."));
        process.exit(1);
      }

      const label = current.channel ? channelLabel(current.channel) : current.slack_channel_id;
      if (
        !(await confirmAction({
          confirmed: opts.confirm,
          json: opts.json,
          message: `Stop sending this ${target.noun}'s review notifications to ${label}?`,
          preview: {
            target: target.noun.toLowerCase(),
            targetId: target.targetId,
            current: current.slack_channel_id,
            channel: current.channel,
          },
        }))
      )
        return;

      await client.reviewNotification.remove.mutate({
        scope: target.scope,
        targetId: target.targetId,
      });
      if (opts.json) {
        printResult({ success: true, removed: true }, opts);
        return;
      }
      console.log(pc.green(`Review notifications for this ${target.noun} no longer go to Slack.`));
    });

  return cmd;
}
