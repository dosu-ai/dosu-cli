import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionLineage } from "./lineage";
import { makeOpencodeDb, opencodeDocument } from "./opencode.test-utils";
import { type AgentSession, piSessionById, sessionAtPath } from "./scan";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dosu-lineage-test-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function write(path: string, lines: unknown[]): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

function at(harness: AgentSession["harness"], id: string, path: string): AgentSession {
  const session = sessionAtPath(harness, id, path);
  if (!session) throw new Error(`no transcript at ${path}`);
  return session;
}

describe("sessionLineage", () => {
  describe("Codex", () => {
    const day = () => join(home, ".codex", "sessions", "2026", "10", "02");
    const SOURCE = "01a0ff74-a68d-7ad0-83ee-80cf02c29b14";
    const FORK = "01a0ff7a-277c-74f1-b64b-59ffa01a7d14";
    const CHILD = "01a0ff74-c903-73c2-b6b1-7546b84710ff";
    const stem = (time: string, thread: string) => `rollout-2026-10-02T${time}-${thread}`;
    const rollout = (name: string, payload: Record<string, unknown>) =>
      write(join(day(), `${name}.jsonl`), [{ type: "session_meta", payload }]);

    it("names the rollout a fork was made from, and a subagent's parent", () => {
      const source = rollout(stem("18-50-30", SOURCE), { id: SOURCE, thread_source: "user" });
      const fork = rollout(stem("18-56-30", FORK), { id: FORK, forked_from_id: SOURCE });
      rollout(stem("18-50-38", CHILD), {
        id: CHILD,
        parent_thread_id: SOURCE,
        thread_source: "subagent",
      });
      const lineage = sessionLineage([
        at("codex", stem("18-56-30", FORK), fork),
        at("codex", stem("18-50-38", CHILD), join(day(), `${stem("18-50-38", CHILD)}.jsonl`)),
      ]);

      expect(lineage(`codex/${stem("18-56-30", FORK)}`)).toEqual({
        forkOf: { id: stem("18-50-30", SOURCE), path: source },
      });
      expect(lineage(`codex/${stem("18-50-38", CHILD)}`)).toEqual({
        parentId: stem("18-50-30", SOURCE),
      });
      // The source was reached through the fork: its links are read in turn.
      expect(lineage(`codex/${stem("18-50-30", SOURCE)}`)).toEqual({});
      expect(lineage("codex/unknown")).toBeUndefined();
    });

    it("gives a fork whose source rollout is gone no link", () => {
      const fork = rollout(stem("18-56-30", FORK), { id: FORK, forked_from_id: SOURCE });

      expect(sessionLineage([at("codex", "f", fork)])("codex/f")).toEqual({});
    });
  });

  describe("Claude Code", () => {
    const project = () => join(home, ".claude", "projects", "-work");

    it("names the session a branch was copied from, as Claude Code tags each copied record", () => {
      write(join(project(), "orig.jsonl"), [{ type: "user", sessionId: "orig", uuid: "u1" }]);
      const branch = write(join(project(), "branch.jsonl"), [
        { type: "user", sessionId: "branch", uuid: "u1", forkedFrom: { sessionId: "orig" } },
        { type: "user", sessionId: "branch", uuid: "u2" },
      ]);

      const lineage = sessionLineage([at("claude", "branch", branch)]);

      expect(lineage("claude/branch")).toEqual({
        forkOf: { id: "orig", path: join(project(), "orig.jsonl") },
      });
      expect(lineage("claude/orig")).toEqual({});
    });

    it("ignores a branch tag naming the transcript itself, and a quoted one", () => {
      const self = write(join(project(), "self.jsonl"), [
        { type: "user", sessionId: "self", forkedFrom: { sessionId: "self" } },
      ]);
      const quoting = write(join(project(), "quoting.jsonl"), [
        { type: "user", message: { content: '{"forkedFrom":{"sessionId":"orig"}}' } },
      ]);

      expect(sessionLineage([at("claude", "self", self)])("claude/self")).toEqual({});
      expect(sessionLineage([at("claude", "quoting", quoting)])("claude/quoting")).toEqual({});
    });

    it("leads from a subagent to the session it worked for", () => {
      const parent = write(join(project(), "p1.jsonl"), [
        { type: "user", forkedFrom: { sessionId: "orig" } },
      ]);
      const child = write(join(project(), "p1", "subagents", "agent-a1.jsonl"), [{}]);

      const lineage = sessionLineage([at("claude", "agent-a1", child)]);

      expect(lineage("claude/agent-a1")).toEqual({ parentId: "p1" });
      expect(lineage("claude/p1")).toEqual({
        forkOf: { id: "orig", path: join(dirname(parent), "orig.jsonl") },
      });
    });
  });

  it("follows pi's forks through their headers, the scan's or a lookup by id's", () => {
    const dir = join(home, ".pi", "agent", "sessions", "--work--");
    const source = write(join(dir, "2026-10-02T10-00-00_src.jsonl"), [
      { type: "session", id: "src" },
    ]);
    write(join(dir, "2026-10-02T11-00-00_fork.jsonl"), [
      { type: "session", id: "fork", parentSession: source },
    ]);

    const fork = piSessionById("fork", { homeDir: home, env: {} });
    expect(fork?.forkOf).toEqual({ id: "src", path: source });
    const lineage = sessionLineage(fork ? [fork] : []);
    expect(lineage("pi/fork")).toEqual({ forkOf: { id: "src", path: source } });
    expect(lineage("pi/src")).toEqual({});
    expect(piSessionById("nope", { homeDir: home, env: {} })).toBeNull();
  });

  it("follows an OpenCode child up the rows its database names", () => {
    const db = join(home, "opencode.db");
    const made = makeOpencodeDb(db, [
      opencodeDocument({ id: "ses_root" }),
      opencodeDocument({ id: "ses_mid", parentID: "ses_root" }),
      opencodeDocument({ id: "ses_leaf", parentID: "ses_mid" }),
    ]);
    if (!made) return; // no sqlite builtin
    const leaf: AgentSession = {
      id: "ses_leaf",
      harness: "opencode",
      path: db,
      updated: "",
      parentId: "ses_mid",
    };

    const lineage = sessionLineage([leaf]);

    expect(lineage("opencode/ses_leaf")).toEqual({ parentId: "ses_mid" });
    expect(lineage("opencode/ses_mid")).toEqual({ parentId: "ses_root" });
  });

  it("keeps the links a Cursor session carries, and reads nothing", () => {
    const cursor: AgentSession = {
      id: "c1",
      harness: "cursor",
      path: join(home, "missing.jsonl"),
      updated: "",
      parentId: "c0",
    };

    expect(sessionLineage([cursor])("cursor/c1")).toEqual({ parentId: "c0" });
  });
});
