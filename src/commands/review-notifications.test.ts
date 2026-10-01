import { TRPCClientError } from "@trpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();
const mockMutate = vi.fn();

function createMockProxy(path: string[] = []): unknown {
  return new Proxy(() => {}, {
    get(_, prop: string) {
      if (prop === "query") return (input: unknown) => mockQuery(path.join("."), input);
      if (prop === "mutate") return (input: unknown) => mockMutate(path.join("."), input);
      return createMockProxy([...path, prop]);
    },
  });
}

vi.mock("../client/trpc", () => ({
  createTypedClient: vi.fn().mockImplementation(() => createMockProxy()),
}));

const mockLoadConfig = vi.fn();
vi.mock("../config/config", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

import { type FlatTestConfig, makeTestConfig } from "../config/config.test-utils";
import type {
  CliReviewNotification,
  CliSlackChannel,
  ReviewNotificationGetOutput,
  SlackChannelListPagedOutput,
} from "../generated/dosu-api-types";
import { reviewCommand } from "./review";

const SELECTED_ORG = "00000000-0000-4000-8000-000000000001";
// The target's org differs from the selected one: lookups must use the org `get` returns.
const TARGET_ORG = "00000000-0000-4000-8000-0000000000aa";
const LIBRARY = "00000000-0000-4000-8000-000000000002";
const AGENT = "00000000-0000-4000-8000-000000000003";
const CHANNEL_A = "00000000-0000-4000-8000-00000000000a";
const CHANNEL_B = "00000000-0000-4000-8000-00000000000b";
const CHANNEL_C = "00000000-0000-4000-8000-00000000000c";

const validFlatConfig: FlatTestConfig = {
  access_token: "t",
  refresh_token: "r",
  expires_at: 0,
  org_id: SELECTED_ORG,
};

function channel(overrides: Partial<CliSlackChannel> = {}): CliSlackChannel {
  return {
    archived: false,
    channel_id: "C0000000A",
    channel_type: "channel",
    description: null,
    enterprise_id: null,
    id: CHANNEL_A,
    installation_id: "00000000-0000-4000-8000-0000000000f1",
    is_private: false,
    name: "eng-reviews",
    org_id: TARGET_ORG,
    team_id: "T1",
    team_name: "Acme",
    topic: null,
    ...overrides,
  };
}

const SCOPES = [
  {
    flag: "--library",
    id: LIBRARY,
    scope: "space" as const,
    noun: "Library",
    fields: { notify_doc_reviews: true, notify_message_reviews: false },
  },
  {
    flag: "--agent",
    id: AGENT,
    scope: "deployment" as const,
    noun: "Agent",
    fields: { notify_doc_reviews: false, notify_message_reviews: true },
  },
];
type ScopeCase = (typeof SCOPES)[number];

function row(s: ScopeCase, overrides: Partial<CliReviewNotification> = {}): CliReviewNotification {
  return {
    channel: channel(),
    created_at: "2026-09-30T00:00:00Z",
    created_by: null,
    deployment_id: s.scope === "deployment" ? s.id : null,
    disabled_reason: null,
    id: "00000000-0000-4000-8000-0000000000e1",
    org_id: TARGET_ORG,
    scope: s.scope,
    slack_channel_id: CHANNEL_A,
    space_id: s.scope === "space" ? s.id : null,
    updated_at: "2026-09-30T00:00:00Z",
    ...s.fields,
    ...overrides,
  };
}

function state(overrides: Partial<ReviewNotificationGetOutput> = {}): ReviewNotificationGetOutput {
  return {
    canEdit: true,
    notification: null,
    notificationsEnabled: true,
    orgId: TARGET_ORG,
    slackInstalled: true,
    ...overrides,
  };
}

function trpcError(code: string, message: string): TRPCClientError<never> {
  const err = new TRPCClientError<never>(message);
  Object.assign(err, { data: { code } });
  return err;
}

/** Route queries by procedure path; `get` answers come from a queue (before/after a write). */
function serve({
  gets,
  pages = [],
}: {
  gets: ReviewNotificationGetOutput[];
  pages?: SlackChannelListPagedOutput[];
}) {
  const getQueue = [...gets];
  const pageQueue = [...pages];
  mockQuery.mockImplementation(async (path: string) => {
    if (path === "reviewNotification.get")
      return getQueue.length > 1 ? getQueue.shift() : gets.at(-1);
    if (path === "slackChannel.listPaged") {
      const page = pageQueue.shift();
      if (!page) throw new Error("unexpected listPaged call");
      return page;
    }
    throw new Error(`unexpected query ${path}`);
  });
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
// biome-ignore lint/suspicious/noExplicitAny: process.exit mock type mismatch
let exitSpy: any;

function stdout(): string {
  return logSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

function stderr(): string {
  return errorSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

async function run(...args: string[]) {
  const command = reviewCommand();
  command.exitOverride();
  for (const sub of command.commands) {
    sub.exitOverride();
    for (const leaf of sub.commands) leaf.exitOverride();
  }
  await command.parseAsync(["node", "test", "notifications", ...args]);
}

function listPagedCalls(): unknown[] {
  return mockQuery.mock.calls
    .filter(([path]) => path === "slackChannel.listPaged")
    .map((c) => c[1]);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockMutate.mockReset();
  mockMutate.mockResolvedValue(true);
  mockLoadConfig.mockReturnValue(makeTestConfig(validFlatConfig));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
  process.env.DOSU_WEB_APP_URL_OVERRIDE = "https://app.example.test";
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  exitSpy.mockRestore();
  delete process.env.DOSU_WEB_APP_URL_OVERRIDE;
});

describe("target flags", () => {
  it("requires --library or --agent", async () => {
    await expect(run("get")).rejects.toThrow("exit");
    expect(stderr()).toContain("Pass --library <library-id> or --agent <agent-id>.");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects both at once", async () => {
    await expect(run("get", "--library", LIBRARY, "--agent", AGENT)).rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID target before any request", async () => {
    await expect(run("get", "--library", "not-a-uuid")).rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe.each(SCOPES)("$noun scope", (s) => {
  describe("get", () => {
    it("reports no channel and how to set one", async () => {
      serve({ gets: [state()] });
      await run("get", s.flag, s.id);
      expect(mockQuery).toHaveBeenCalledWith("reviewNotification.get", {
        scope: s.scope,
        targetId: s.id,
      });
      expect(stdout()).toContain(`No Slack channel is set for this ${s.noun}.`);
      expect(stdout()).toContain(`dosu review notifications set ${s.flag} ${s.id} --channel`);
      expect(stdout()).not.toMatch(/space|deployment/);
    });

    it("prints the raw state with --json", async () => {
      const result = state({ notification: row(s) });
      serve({ gets: [result] });
      await run("get", s.flag, s.id, "--json");
      expect(JSON.parse(stdout())).toEqual(result);
    });

    it("shows the channel, workspace, privacy, and what it delivers", async () => {
      serve({ gets: [state({ notification: row(s) })] });
      await run("get", s.flag, s.id);
      const out = stdout();
      expect(out).toContain("#eng-reviews (Acme)");
      expect(out).toMatch(/Private\s+no/);
      expect(out).toContain(s.scope === "space" ? "doc reviews" : "draft replies");
      expect(out).toContain("active");
    });

    it.each([
      ["not_in_channel", "/invite @Dosu"],
      ["is_archived", "archived or gone"],
      ["channel_not_found", "archived or gone"],
      ["channel_missing", "archived or gone"],
      ["missing_scope", "lost access to the channel (missing_scope)"],
    ])("explains disabled_reason %s", async (reason, text) => {
      serve({ gets: [state({ notification: row(s, { disabled_reason: reason }) })] });
      await run("get", s.flag, s.id);
      expect(stdout()).toContain("disabled:");
      expect(stdout()).toContain(text);
    });

    it("flags a saved channel whose row is gone", async () => {
      serve({ gets: [state({ notification: row(s, { channel: null }) })] });
      await run("get", s.flag, s.id);
      expect(stdout()).toContain(`missing (${CHANNEL_A})`);
      expect(stdout()).toContain("Run `set` with another channel");
    });

    it("points at the Slack install page when Slack is not installed", async () => {
      serve({ gets: [state({ slackInstalled: false })] });
      await run("get", s.flag, s.id);
      expect(stdout()).toContain("https://app.example.test/slack");
      expect(stdout()).not.toContain("Set one with");
    });

    it("warns when notifications are not enabled for the org", async () => {
      serve({ gets: [state({ notificationsEnabled: false, notification: row(s) })] });
      await run("get", s.flag, s.id);
      expect(stdout()).toContain("Slack Notifications are not enabled for this organization");
    });
  });

  describe("set", () => {
    it("saves a channel by UUID and reports the saved channel", async () => {
      serve({ gets: [state(), state({ notification: row(s) })] });
      await run("set", s.flag, s.id, "--channel", CHANNEL_A, "--confirm");
      expect(mockMutate).toHaveBeenCalledWith("reviewNotification.upsert", {
        scope: s.scope,
        targetId: s.id,
        slackChannelId: CHANNEL_A,
      });
      expect(listPagedCalls()).toHaveLength(0);
      expect(stdout()).toContain(`Review notifications for this ${s.noun} now go to #eng-reviews`);
    });

    it("replaces the current channel and shows current → new", async () => {
      const next = channel({ id: CHANNEL_B, name: "docs", channel_id: "C0000000B" });
      serve({
        gets: [
          state({ notification: row(s) }),
          state({ notification: row(s, { channel: next, slack_channel_id: CHANNEL_B }) }),
        ],
      });
      await run("set", s.flag, s.id, "--channel", CHANNEL_B, "--confirm", "--json");
      expect(mockMutate).toHaveBeenCalledWith(
        "reviewNotification.upsert",
        expect.objectContaining({ slackChannelId: CHANNEL_B }),
      );
      expect(JSON.parse(stdout())).toMatchObject({
        success: true,
        notification: { slack_channel_id: CHANNEL_B },
      });
    });

    it("reconnects a disabled channel by saving it again", async () => {
      serve({
        gets: [
          state({ notification: row(s, { disabled_reason: "not_in_channel" }) }),
          state({ notification: row(s) }),
        ],
      });
      await run("set", s.flag, s.id, "--channel", CHANNEL_A, "--confirm", "--json");
      expect(mockMutate).toHaveBeenCalledWith(
        "reviewNotification.upsert",
        expect.objectContaining({ slackChannelId: CHANNEL_A }),
      );
      expect(JSON.parse(stdout()).notification.disabled_reason).toBeNull();
    });

    it("does not write without confirmation in non-interactive mode", async () => {
      serve({ gets: [state()] });
      await run("set", s.flag, s.id, "--channel", CHANNEL_A, "--json");
      expect(mockMutate).not.toHaveBeenCalled();
      expect(JSON.parse(stdout())).toMatchObject({
        confirmRequired: true,
        applied: false,
        target: s.noun.toLowerCase(),
        targetId: s.id,
        slackChannelId: CHANNEL_A,
      });
    });

    it("resolves a Slack channel ID by walking the target org's channels", async () => {
      const match = channel({ id: CHANNEL_B, channel_id: "C0000000B", name: "docs" });
      serve({
        gets: [state(), state({ notification: row(s, { channel: match }) })],
        pages: [
          { items: [channel()], nextCursor: CHANNEL_A },
          { items: [match], nextCursor: null },
        ],
      });
      await run("set", s.flag, s.id, "--channel", "C0000000B", "--confirm");
      expect(listPagedCalls()).toEqual([
        { orgId: TARGET_ORG, limit: 100 },
        { orgId: TARGET_ORG, limit: 100, cursor: CHANNEL_A },
      ]);
      expect(mockMutate).toHaveBeenCalledWith(
        "reviewNotification.upsert",
        expect.objectContaining({ slackChannelId: CHANNEL_B }),
      );
    });

    it("fails on an unknown Slack channel ID", async () => {
      serve({ gets: [state()], pages: [{ items: [channel()], nextCursor: null }] });
      await expect(run("set", s.flag, s.id, "--channel", "C9999999Z", "--confirm")).rejects.toThrow(
        "exit",
      );
      expect(stderr()).toContain("No Slack channel with ID C9999999Z");
      expect(mockMutate).not.toHaveBeenCalled();
    });

    it("resolves #name to an exact match found on a later page", async () => {
      const exact = channel({ id: CHANNEL_C, name: "Docs", channel_id: "C0000000C" });
      serve({
        gets: [state(), state({ notification: row(s, { channel: exact }) })],
        pages: [
          { items: [channel({ name: "docs-archive" })], nextCursor: CHANNEL_A },
          { items: [exact], nextCursor: null },
        ],
      });
      await run("set", s.flag, s.id, "--channel", "#docs", "--confirm");
      expect(listPagedCalls()).toEqual([
        { orgId: TARGET_ORG, limit: 100, search: "docs" },
        { orgId: TARGET_ORG, limit: 100, search: "docs", cursor: CHANNEL_A },
      ]);
      expect(mockMutate).toHaveBeenCalledWith(
        "reviewNotification.upsert",
        expect.objectContaining({ slackChannelId: CHANNEL_C }),
      );
    });

    it("refuses a name shared across workspaces and lists the matches", async () => {
      serve({
        gets: [state()],
        pages: [
          {
            items: [
              channel({ id: CHANNEL_A, name: "docs", team_name: "Acme" }),
              channel({ id: CHANNEL_B, name: "docs", team_name: "Acme EU" }),
            ],
            nextCursor: null,
          },
        ],
      });
      await expect(run("set", s.flag, s.id, "--channel", "docs", "--confirm")).rejects.toThrow(
        "exit",
      );
      const err = stderr();
      expect(err).toContain("2 Slack channels are named #docs");
      expect(err).toContain(CHANNEL_A);
      expect(err).toContain("Acme EU");
      expect(err).toContain("--channel <uuid>");
      expect(stdout()).toBe("");
      expect(mockMutate).not.toHaveBeenCalled();
    });

    it("lists similar channels when no name matches exactly", async () => {
      serve({
        gets: [state()],
        pages: [{ items: [channel({ name: "docs-team" })], nextCursor: null }],
      });
      await expect(run("set", s.flag, s.id, "--channel", "#docs", "--confirm")).rejects.toThrow(
        "exit",
      );
      expect(stderr()).toContain("No Slack channel named #docs");
      expect(stderr()).toContain("#docs-team");
      expect(mockMutate).not.toHaveBeenCalled();
    });

    it("stops before prompting when the user is not an org admin", async () => {
      serve({ gets: [state({ canEdit: false })] });
      await expect(run("set", s.flag, s.id, "--channel", CHANNEL_A, "--confirm")).rejects.toThrow(
        "exit",
      );
      expect(stderr()).toContain("Only organization admins can change Slack Notifications.");
      expect(mockMutate).not.toHaveBeenCalled();
    });

    it("stops with the install URL when Slack is not installed", async () => {
      serve({ gets: [state({ slackInstalled: false })] });
      await expect(run("set", s.flag, s.id, "--channel", "#docs", "--confirm")).rejects.toThrow(
        "exit",
      );
      expect(stderr()).toContain("https://app.example.test/slack");
      expect(listPagedCalls()).toHaveLength(0);
      expect(mockMutate).not.toHaveBeenCalled();
    });

    it("stops when notifications are not enabled for the org", async () => {
      serve({ gets: [state({ notificationsEnabled: false })] });
      await expect(run("set", s.flag, s.id, "--channel", CHANNEL_A, "--confirm")).rejects.toThrow(
        "exit",
      );
      expect(stderr()).toContain("Slack Notifications are not enabled for this organization.");
      expect(mockMutate).not.toHaveBeenCalled();
    });

    it("turns not_in_channel into the /invite hint", async () => {
      serve({ gets: [state()] });
      mockMutate.mockRejectedValueOnce(
        trpcError("PRECONDITION_FAILED", "Failed to join Slack channel: not_in_channel"),
      );
      await expect(run("set", s.flag, s.id, "--channel", CHANNEL_A, "--confirm")).rejects.toThrow(
        "exit",
      );
      expect(stderr()).toContain(`Dosu can't join ${CHANNEL_A}.`);
      expect(stderr()).toContain(
        `re-run \`dosu review notifications set ${s.flag} ${s.id} --channel ${CHANNEL_A}\``,
      );
    });

    it.each([
      ["FORBIDDEN", "Only organization admins can change Slack Notifications."],
      ["FORBIDDEN", "Slack Notifications are not enabled for this organization."],
      ["NOT_FOUND", "Slack channel not found."],
      ["BAD_GATEWAY", "Failed to join Slack channel: ratelimited"],
    ])("passes a %s error through verbatim", async (code, message) => {
      serve({ gets: [state()] });
      mockMutate.mockRejectedValueOnce(trpcError(code, message));
      await expect(run("set", s.flag, s.id, "--channel", CHANNEL_A, "--confirm")).rejects.toThrow(
        message,
      );
    });
  });

  describe("clear", () => {
    it("removes the channel after confirmation", async () => {
      serve({ gets: [state({ notification: row(s) })] });
      await run("clear", s.flag, s.id, "--confirm", "--json");
      expect(mockMutate).toHaveBeenCalledWith("reviewNotification.remove", {
        scope: s.scope,
        targetId: s.id,
      });
      expect(JSON.parse(stdout())).toEqual({ success: true, removed: true });
    });

    it("is a no-op success when nothing is set", async () => {
      serve({ gets: [state()] });
      await run("clear", s.flag, s.id, "--confirm", "--json");
      expect(mockMutate).not.toHaveBeenCalled();
      expect(JSON.parse(stdout())).toEqual({ success: true, removed: false });
    });

    it("does not remove without confirmation in non-interactive mode", async () => {
      serve({ gets: [state({ notification: row(s) })] });
      await run("clear", s.flag, s.id, "--json");
      expect(mockMutate).not.toHaveBeenCalled();
      expect(JSON.parse(stdout())).toMatchObject({ confirmRequired: true, applied: false });
    });

    it("stops before prompting when the user is not an org admin", async () => {
      serve({ gets: [state({ canEdit: false, notification: row(s) })] });
      await expect(run("clear", s.flag, s.id, "--confirm")).rejects.toThrow("exit");
      expect(stderr()).toContain("Only organization admins can change Slack Notifications.");
      expect(mockMutate).not.toHaveBeenCalled();
    });
  });
});

describe("edge cases", () => {
  const library = SCOPES[0];

  it("reports progress on stderr while scanning a large org for a Slack ID", async () => {
    const filler = { items: [channel()], nextCursor: CHANNEL_A };
    serve({
      gets: [state(), state({ notification: row(library) })],
      pages: [
        ...Array.from({ length: 10 }, () => filler),
        { items: [channel({ id: CHANNEL_B, channel_id: "C0000000B" })], nextCursor: null },
      ],
    });
    await run("set", "--library", LIBRARY, "--channel", "C0000000B", "--confirm");
    expect(stderr()).toContain("Scanned 10 Slack channels…");
  });

  it("caps the candidate list and counts the rest", async () => {
    const similar = Array.from({ length: 12 }, (_, i) => channel({ name: `docs-${i}` }));
    serve({ gets: [state()], pages: [{ items: similar, nextCursor: null }] });
    await expect(
      run("set", "--library", LIBRARY, "--channel", "docs", "--confirm"),
    ).rejects.toThrow("exit");
    expect(stderr()).toContain("#docs-9");
    expect(stderr()).not.toContain("#docs-10");
    expect(stderr()).toContain("…and 2 more.");
  });

  it("rejects an empty #name before any lookup", async () => {
    serve({ gets: [state()] });
    await expect(run("set", "--library", LIBRARY, "--channel", "#", "--confirm")).rejects.toThrow(
      "exit",
    );
    expect(stderr()).toContain("--channel must not be empty.");
    expect(listPagedCalls()).toHaveLength(0);
  });

  it("labels an unnamed private channel by its Slack ID", async () => {
    const unnamed = channel({ name: null, team_name: null, is_private: true });
    serve({ gets: [state({ notification: row(library, { channel: unnamed }) })] });
    await run("get", "--library", LIBRARY);
    expect(stdout()).toMatch(/Channel\s+C0000000A/);
    expect(stdout()).toMatch(/Private\s+yes/);
  });

  it("prints human receipts for clear and a no-op clear", async () => {
    serve({ gets: [state({ notification: row(library, { channel: null }) })] });
    await run("clear", "--library", LIBRARY, "--confirm");
    expect(stdout()).toContain("Review notifications for this Library no longer go to Slack.");

    logSpy.mockClear();
    serve({ gets: [state()] });
    await run("clear", "--library", LIBRARY, "--confirm");
    expect(stdout()).toContain("No Slack channel is set for this Library; nothing to clear.");
  });

  it("shows current → new before a human-mode set", async () => {
    serve({
      gets: [state({ notification: row(library) }), state({ notification: null })],
    });
    await run("set", "--library", LIBRARY, "--channel", CHANNEL_B, "--confirm");
    expect(stdout()).toContain(`#eng-reviews (Acme) → ${CHANNEL_B}`);
    expect(stdout()).toContain(`now go to ${CHANNEL_B}`);
  });
});
