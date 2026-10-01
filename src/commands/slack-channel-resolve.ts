/** Turn a user's Slack channel reference (UUID, Slack ID, or name) into the Dosu channel row. */

import pc from "picocolors";
import type { TypedClient } from "../client/trpc";
import type { CliSlackChannel } from "../generated/dosu-api-types";
import { isUuid } from "./arguments";

// Slack's own channel IDs: C… for public channels, G… for older private ones.
const SLACK_CHANNEL_ID_RE = /^[CG][A-Z0-9]{8,}$/;
const PAGE_SIZE = 100;
// Report scan progress every this many pages when walking every channel in an org.
const PROGRESS_EVERY_PAGES = 10;
const MAX_CANDIDATES = 10;

/** How a command names the channel argument in its errors. */
export type ChannelArg = {
  /** The argument itself: `--channel` or `<channel>`. */
  name: string;
  /** How to pass a UUID instead: `--channel <uuid>`. */
  uuidUsage: string;
};

export function channelLabel(channel: CliSlackChannel): string {
  const name = channel.name ? `#${channel.name}` : channel.channel_id;
  return channel.team_name ? `${name} (${channel.team_name})` : name;
}

/** Every channel that `listPaged` returns for `search`, walking all pages. */
async function listAllChannels(
  client: TypedClient,
  orgId: string,
  search: string | undefined,
  json: boolean | undefined,
): Promise<CliSlackChannel[]> {
  const channels: CliSlackChannel[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await client.slackChannel.listPaged.query({
      orgId,
      limit: PAGE_SIZE,
      ...(search !== undefined && { search }),
      ...(cursor && { cursor }),
    });
    channels.push(...page.items);
    cursor = page.nextCursor;
    pages += 1;
    if (cursor && !json && pages % PROGRESS_EVERY_PAGES === 0) {
      console.error(pc.dim(`Scanned ${channels.length} Slack channels…`));
    }
  } while (cursor);
  return channels;
}

// Candidates go to stderr with the error so a `--json` caller's stdout stays empty.
function printCandidates(candidates: CliSlackChannel[]): void {
  const shown = candidates.slice(0, MAX_CANDIDATES);
  for (const c of shown) {
    const name = c.name ? `#${c.name}` : "-";
    console.error(`  ${c.id}  ${c.channel_id}  ${name}  ${c.team_name ?? "-"}`);
  }
  if (candidates.length > shown.length) {
    console.error(pc.dim(`  …and ${candidates.length - shown.length} more.`));
  }
}

/**
 * Resolve a channel reference to the Dosu channel UUID the routers take. A UUID passes through
 * unchecked (the caller's mutation 404s on an unknown one); a Slack ID or name is looked up in
 * `orgId`. Exits 1 with candidates on stderr when the reference matches zero or several rows.
 */
export async function resolveChannel(
  client: TypedClient,
  orgId: string,
  input: string,
  arg: ChannelArg,
  json: boolean | undefined,
): Promise<{ id: string; channel: CliSlackChannel | null }> {
  const value = input.trim();
  if (isUuid(value)) return { id: value, channel: null };

  if (SLACK_CHANNEL_ID_RE.test(value)) {
    // `search` filters names only, so a Slack ID means walking every channel in the org.
    const match = (await listAllChannels(client, orgId, undefined, json)).find(
      (c) => c.channel_id === value,
    );
    if (!match) {
      console.error(pc.red(`No Slack channel with ID ${value} in this organization.`));
      console.error("Run `dosu integrations slack-channels` to list channels, or pass a name.");
      process.exit(1);
    }
    return { id: match.id, channel: match };
  }

  const name = value.replace(/^#/, "");
  if (!name) {
    console.error(pc.red(`${arg.name} must not be empty.`));
    process.exit(1);
  }
  // The search is an unescaped substring match ordered by id, so the exact name can sit on any
  // page; collect them all and match locally.
  const candidates = await listAllChannels(client, orgId, name, json);
  const exact = candidates.filter((c) => c.name?.toLowerCase() === name.toLowerCase());
  if (exact.length === 1) return { id: exact[0].id, channel: exact[0] };

  if (exact.length === 0) {
    console.error(pc.red(`No Slack channel named #${name} in this organization.`));
  } else {
    console.error(
      pc.red(`${exact.length} Slack channels are named #${name} (in different workspaces).`),
    );
  }
  const shown = exact.length > 0 ? exact : candidates;
  if (shown.length > 0) {
    console.error(exact.length > 0 ? "Matches:" : "Similar channels:");
    printCandidates(shown);
  }
  console.error(`Pass the channel's UUID with ${arg.uuidUsage}.`);
  process.exit(1);
}
