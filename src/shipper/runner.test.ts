import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectKey } from "../sessions/project";
import type { AgentSession } from "../sessions/scan";
import { createShipStep } from "./runner";
import type { Target } from "./target";

vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function session(id: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    harness: "claude",
    path: `/tmp/${id}.jsonl`,
    updated: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

type Send = Target["send"];
type Sent = Parameters<Send>[0];
type Answer = Awaited<ReturnType<Send>>;

const SHIPPED = { records: 7, prefix_sha256: "a".repeat(64) };
const stored: Answer = { status: "shipped", taskId: "stored:abc", shipped: SHIPPED };

interface StepOverrides {
  send?: Send;
  isIncognito?: (s: AgentSession) => boolean;
  readTranscript?: (s: AgentSession) => string | null;
  resolveProject?: (s: AgentSession) => ProjectKey | null;
  resolveBranch?: (s: AgentSession, at?: string) => string | null;
}

/** A ship step against a fake server that records what it was sent. */
function makeStep(overrides: StepOverrides = {}) {
  const send = vi.fn<Send>(overrides.send ?? (async () => stored));
  const target: Target = { name: "team", url: "https://sessions.test", send };
  const step = createShipStep({
    target,
    isIncognito: overrides.isIncognito ?? (() => false),
    readTranscript: overrides.readTranscript ?? (() => '{"type":"user"}\n'),
    resolveProject:
      overrides.resolveProject ?? (() => ({ project: "github.com/acme/app", rule: "origin" })),
    resolveBranch: overrides.resolveBranch ?? (() => null),
  });
  const sent = (n = 0): Sent => send.mock.calls[n]?.[0] as Sent;
  return { step, send, sent };
}

describe("createShipStep", () => {
  it("sends the raw transcript with what this machine knows, and records the server's answer", async () => {
    const { step, sent } = makeStep({ resolveBranch: () => "feat/x" });

    const [result] = await step([session("s1", { parentId: "p1" })]);

    expect(sent()).toEqual({
      agent: "claude-code",
      session_id: "s1",
      transcript: '{"type":"user"}\n',
      format: "jsonl",
      project: "github.com/acme/app",
      branch: "feat/x",
      parent_session_id: "p1",
    });
    expect(result).toEqual({
      session: expect.objectContaining({ id: "s1" }),
      outcome: "shipped",
      taskId: "stored:abc",
      project: "github.com/acme/app",
      records: 7,
      prefixSha256: SHIPPED.prefix_sha256,
    });
  });

  it("sends back what shipped before, so the server writes only the tail", async () => {
    const { step, sent } = makeStep();

    await step([session("s1")], () => ({ records: 3, prefix_sha256: "b".repeat(64) }));

    expect(sent().shipped).toEqual({ records: 3, prefix_sha256: "b".repeat(64) });
  });

  it("names a fork's parent twice: as its parent, and as the history it copied", async () => {
    const { step, sent } = makeStep();

    await step([session("fork", { forkOf: { id: "parent", path: "/tmp/parent.jsonl" } })]);

    expect(sent().parent_session_id).toBe("parent");
    expect(sent().fork_of).toBe("parent");
  });

  it("sends 'unknown' when neither the working directory nor DOSU_PROJECT is known", async () => {
    const { step, sent } = makeStep({ resolveProject: () => null });

    await step([session("s1")]);

    expect(sent().project).toBe("unknown");
  });

  it("leaves the branch out when nothing knows it", async () => {
    const { step, sent } = makeStep();

    await step([session("s1")]);

    expect(sent().branch).toBeUndefined();
  });

  it("OpenCode's export is JSON; everything else is JSONL", async () => {
    const { step, sent } = makeStep();

    await step([session("o1", { harness: "opencode" }), session("c1", { harness: "codex" })]);

    expect([sent(0).agent, sent(0).format]).toEqual(["opencode", "json"]);
    expect([sent(1).agent, sent(1).format]).toEqual(["codex", "jsonl"]);
  });

  it("never ships an incognito session", async () => {
    const { step, send } = makeStep({ isIncognito: (s) => s.id === "s2" });

    const results = await step([session("s1"), session("s2"), session("s3")]);

    expect(results.map((r) => [r.session.id, r.outcome])).toEqual([
      ["s1", "shipped"],
      ["s2", "incognito"],
      ["s3", "shipped"],
    ]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("reads the user's switches before each upload, and holds the rest of the batch to them", async () => {
    // Put in incognito once s1 has gone out, and shipping turned off as s3 is being read.
    let reads = 0;
    const hold = vi.fn((s: AgentSession) => {
      reads += 1;
      if (s.id === "s1") return null;
      if (s.id === "s3" && reads > 4) return "stop" as const;
      return s.id === "s2" ? ("agent" as const) : null;
    });
    const readTranscript = vi.fn((_s: AgentSession) => "{}\n");
    const { step, send } = makeStep({ readTranscript });

    const results = await step(
      [session("s1"), session("s2"), session("s3"), session("s4")],
      undefined,
      hold,
    );

    expect(results.map((r) => [r.session.id, r.outcome, r.byAgent])).toEqual([
      ["s1", "shipped", undefined],
      ["s2", "incognito", true],
    ]);
    expect(send).toHaveBeenCalledTimes(1);
    // s2 was never read, and nothing after s3's check was.
    expect(readTranscript.mock.calls.map(([s]) => s.id)).toEqual(["s1", "s3"]);
  });

  it("reports each result as it settles, before the next session is read", async () => {
    const order: string[] = [];
    const { step } = makeStep({
      readTranscript: (s) => {
        order.push(`read ${s.id}`);
        return "{}\n";
      },
    });

    const results = await step([session("s1"), session("s2")], undefined, undefined, (r) =>
      order.push(`${r.outcome} ${r.session.id}`),
    );

    expect(results).toHaveLength(2);
    expect(order).toEqual(["read s1", "shipped s1", "read s2", "shipped s2"]);
  });

  it("a transcript that cannot be read is unsupported, not a failure", async () => {
    const { step, send } = makeStep({ readTranscript: () => null });

    const results = await step([session("s1"), session("s2")]);

    expect(results.map((r) => r.outcome)).toEqual(["unsupported", "unsupported"]);
    expect(results[0]?.message).toBe("transcript could not be read");
    expect(send).not.toHaveBeenCalled();
  });

  it("a harness with no normalizer is unsupported and never reads its transcript", async () => {
    const readTranscript = vi.fn(() => "{}\n");
    const { step, send } = makeStep({ readTranscript });

    const [result] = await step([session("s1", { harness: "vim" as AgentSession["harness"] })]);

    expect(result?.outcome).toBe("unsupported");
    expect(result?.message).toBe("no normalizer for vim sessions yet");
    expect(readTranscript).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("what the server calls trivial settles as trivial, without a shipped prefix", async () => {
    const { step } = makeStep({ send: async () => ({ status: "trivial", shipped: SHIPPED }) });

    const [result] = await step([session("s1")]);

    expect(result).toEqual({ session: expect.objectContaining({ id: "s1" }), outcome: "trivial" });
  });

  it("settles a refused upload (422) as rejected and carries on with the batch", async () => {
    const { step } = makeStep({
      send: async ({ session_id }) =>
        session_id === "s1"
          ? { status: "rejected", httpStatus: 422, message: "invalid: bad role" }
          : stored,
    });

    const results = await step([session("s1"), session("s2")]);

    expect(results.map((r) => r.outcome)).toEqual(["rejected", "shipped"]);
    expect(results[0]).toMatchObject({ httpStatus: 422, message: "invalid: bad role" });
  });

  it("a server failure stops the batch so unprocessed sessions retry after backoff", async () => {
    const { step, send } = makeStep({
      send: async () => ({ status: "failed", message: "server https://sessions.test: HTTP 502" }),
    });

    const results = await step([session("s1"), session("s2")]);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      outcome: "failed",
      message: expect.stringContaining("502"),
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("createShipStep branch", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** A Claude Code log on disk, read for real (the default transcript reader and start peek). */
  function claudeLog(name: string, lines: Record<string, unknown>[]): AgentSession {
    dir ??= realpathSync(mkdtempSync(join(tmpdir(), "dosu-ship-")));
    const path = join(dir, `${name}.jsonl`);
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    return session(name, { path });
  }

  it("sends the branch the transcript recorded rather than asking git", async () => {
    const send = vi.fn(async () => stored);
    const resolveBranch = vi.fn(() => "feat/resolved");
    const step = createShipStep({
      target: { name: "t", url: "u", send },
      isIncognito: () => false,
      resolveProject: () => null,
      resolveBranch,
    });
    const log = claudeLog("recorded", [
      { type: "user", gitBranch: "feat/recorded", timestamp: "2026-09-01T00:00:00.000Z" },
    ]);

    await step([log]);

    expect(resolveBranch).not.toHaveBeenCalled();
    expect((send.mock.calls[0] as unknown as [Sent])[0].branch).toBe("feat/recorded");
  });

  it("asks git about the session's first prompt when the log recorded no branch", async () => {
    const send = vi.fn(async () => stored);
    const byTime: Record<string, string> = { "2026-09-02T08:00:00.000Z": "feat/at-start" };
    const step = createShipStep({
      target: { name: "t", url: "u", send },
      isIncognito: () => false,
      resolveProject: () => null,
      resolveBranch: (_s, at) => (at ? (byTime[at] ?? null) : null),
    });
    const log = claudeLog("plain", [
      {
        type: "user",
        timestamp: "2026-09-02T08:00:00.000Z",
        message: { role: "user", content: "hi" },
      },
      { type: "assistant", timestamp: "2026-09-02T08:00:05.000Z" },
    ]);

    await step([log]);

    expect((send.mock.calls[0] as unknown as [Sent])[0].branch).toBe("feat/at-start");
  });
});
