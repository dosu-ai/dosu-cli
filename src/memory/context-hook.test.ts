import { describe, expect, it, vi } from "vitest";
import { INCOGNITO_MARKER } from "../sync/incognito";
import { contextHookOutput } from "./context-hook";

const DIGEST = "## Task Memory (Dosu)\n\n### Facts\n- a fact — memory_id: m1";

function payload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "UserPromptSubmit",
    session_id: "sess-1",
    prompt: "reset the local database and rerun the migration tests",
    cwd: "/Users/me/dosu",
    transcript_path: "/Users/me/.claude/projects/x/sess-1.jsonl",
    ...over,
  });
}

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

const base = {
  apiKey: "sk_user_x",
  deploymentId: "dep-1",
  backendUrl: "https://api.test/",
  isIncognito: () => false,
};

describe("contextHookOutput", () => {
  it("turns a digest into Claude Code's additionalContext", async () => {
    const fetchImpl = respond(200, { digest: DIGEST, reason: "injected", memory_ids: ["m1"] });
    const out = await contextHookOutput(payload(), {
      ...base,
      fetchImpl,
      branchOf: () => "feat/x",
    });
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: DIGEST },
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/memory/context");
    expect((init.headers as Record<string, string>)["X-Dosu-API-Key"]).toBe("sk_user_x");
    expect(JSON.parse(init.body as string)).toEqual({
      deployment_id: "dep-1",
      prompt: "reset the local database and rerun the migration tests",
      session_id: "sess-1",
      branch: "feat/x",
      agent: "claude-code",
      repo: "/Users/me/dosu",
    });
  });

  it("adds nothing when the server declines", async () => {
    const fetchImpl = respond(200, { digest: null, reason: "not_worth_it", memory_ids: [] });
    expect(await contextHookOutput(payload(), { ...base, fetchImpl })).toBe("");
  });

  // The user's prompt is waiting on this hook. Anything that goes wrong must look, to them,
  // exactly like Dosu not being installed.
  it.each([
    ["a server error", respond(500, { detail: "boom" })],
    ["an auth failure", respond(401, { detail: "no key" })],
    [
      "a network failure",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    ],
    [
      "a timeout",
      vi.fn(async () => {
        throw new DOMException("timed out", "TimeoutError");
      }),
    ],
    ["a body that is not JSON", vi.fn(async () => new Response("<html>", { status: 200 }))],
  ])("fails open on %s", async (_label, fetchImpl) => {
    expect(await contextHookOutput(payload(), { ...base, fetchImpl })).toBe("");
  });

  it("ignores payloads that are not a prompt submission", async () => {
    const fetchImpl = respond(200, { digest: DIGEST });
    expect(await contextHookOutput("not json", { ...base, fetchImpl })).toBe("");
    expect(
      await contextHookOutput(payload({ hook_event_name: "Stop" }), { ...base, fetchImpl }),
    ).toBe("");
    expect(await contextHookOutput(payload({ prompt: "" }), { ...base, fetchImpl })).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never sends the prompt of a session taken off the record", async () => {
    // The prompt is logged server-side as the retrieval query, so incognito has to stop the
    // request itself, not just the transcript upload.
    const fetchImpl = respond(200, { digest: DIGEST });
    const marked = await contextHookOutput(payload(), {
      ...base,
      fetchImpl,
      isIncognito: () => true,
    });
    // `/dosu-incognito` expands to a body carrying this token, which is what the hook sees.
    const typed = await contextHookOutput(payload({ prompt: `${INCOGNITO_MARKER} then fix it` }), {
      ...base,
      fetchImpl,
    });
    expect(marked).toBe("");
    expect(typed).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
