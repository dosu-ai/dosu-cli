import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INCOGNITO_COMMAND_BODY } from "../incognito/agents";
import { makeOpencodeDb, opencodeDocument } from "../sessions/opencode.test-utils";
import type { AgentSession } from "../sessions/scan";
import { isIncognitoSession } from "./incognito";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-incognito-opencode-"));
  dbPath = join(dir, "opencode.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function session(id: string, parentId?: string): AgentSession {
  return {
    id,
    harness: "opencode",
    path: dbPath,
    updated: "2026-09-01T00:00:00.000Z",
    ...(parentId ? { parentId } : {}),
  };
}

describe("isIncognitoSession for opencode", () => {
  it("reads the marker /dosu-incognito expands to out of the session's own messages", () => {
    const created = makeOpencodeDb(dbPath, [
      opencodeDocument({ id: "ses_marked", user: INCOGNITO_COMMAND_BODY }),
      opencodeDocument({ id: "ses_plain" }),
    ]);
    if (!created) return; // no sqlite builtin

    expect(isIncognitoSession(session("ses_marked"))).toBe(true);
    expect(isIncognitoSession(session("ses_plain"))).toBe(false);
  });

  it("keeps a subagent's child sessions, at any depth, off the record with their parent", () => {
    const created = makeOpencodeDb(dbPath, [
      opencodeDocument({ id: "ses_root", user: INCOGNITO_COMMAND_BODY }),
      opencodeDocument({ id: "ses_child", parentID: "ses_root" }),
      opencodeDocument({ id: "ses_grandchild", parentID: "ses_child" }),
      opencodeDocument({ id: "ses_other" }),
      opencodeDocument({ id: "ses_other_child", parentID: "ses_other" }),
    ]);
    if (!created) return;

    expect(isIncognitoSession(session("ses_child", "ses_root"))).toBe(true);
    expect(isIncognitoSession(session("ses_grandchild", "ses_child"))).toBe(true);
    expect(isIncognitoSession(session("ses_other_child", "ses_other"))).toBe(false);
  });

  it("stops at a parent the DB no longer has, or one that names itself", () => {
    const created = makeOpencodeDb(dbPath, [
      opencodeDocument({ id: "ses_orphan", parentID: "ses_deleted" }),
      opencodeDocument({ id: "ses_loop", parentID: "ses_loop" }),
    ]);
    if (!created) return;

    expect(isIncognitoSession(session("ses_orphan", "ses_deleted"))).toBe(false);
    expect(isIncognitoSession(session("ses_loop", "ses_loop"))).toBe(false);
  });
});
