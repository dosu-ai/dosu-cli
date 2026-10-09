import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
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

const mockConfirm = vi.fn();
vi.mock("@clack/prompts", () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
  isCancel: (value: unknown) => value === Symbol.for("clack:cancel"),
}));

const mockLoadConfig = vi.fn();
vi.mock("../config/config", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

import { type FlatTestConfig, makeTestConfig } from "../config/config.test-utils";
import { reviewCommand } from "./review";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
// biome-ignore lint/suspicious/noExplicitAny: process.exit mock type mismatch
let exitSpy: any;

const validFlatConfig: FlatTestConfig = {
  access_token: "t",
  refresh_token: "r",
  expires_at: 0,
  api_key: "sk_user_test",
  space_id: "sp1",
  deployment_id: "dep1",
};
const makeValidConfig = (overrides: Partial<FlatTestConfig> = {}) =>
  makeTestConfig({ ...validFlatConfig, ...overrides });
const validConfig = makeValidConfig();

// A tRPC NOT_FOUND error; with prefix-based routing it only signals an unknown doc-change id.
function notFound() {
  return new TRPCClientError("not found", {
    result: { error: { code: -32004, message: "not found", data: { code: "NOT_FOUND" } } },
  });
}

// A tRPC UNPROCESSABLE_CONTENT error: review.getChange 422s on a malformed (non-UUID) id.
function unprocessable() {
  return new TRPCClientError("invalid id", {
    result: {
      error: { code: -32600, message: "invalid id", data: { code: "UNPROCESSABLE_CONTENT" } },
    },
  });
}

function allOutput(): string {
  return stripVTControlCharacters(logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n"));
}

async function run(...args: string[]) {
  const cmd = reviewCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "test", ...args]);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockMutate.mockReset();
  mockLoadConfig.mockReset();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  exitSpy.mockRestore();
});

describe("review list", () => {
  const pendingItem = {
    id: "pv-abcdef12",
    kind: "doc_change",
    pageId: "pg-1",
    title: "API Guide",
    version: 3,
    type: "document",
    origin: "sync_upstream",
    externalTriggerUrl: "https://github.com/org/repo/pull/42",
    pendingStatus: "pending_review",
    createdAt: "2026-06-24T19:18:50.002Z",
  };

  const draftItem = {
    // listPending prefixes draft ids (ENG-547) — the CLI prints them verbatim so
    // they're copyable straight into the verbs, which strip the prefix.
    id: "draft_message:msg-abcdef12",
    kind: "draft_message",
    title: "Re: how do I configure X?",
    body: "You can configure X by…",
    threadId: "th-1",
    createdAt: "2026-06-25T10:00:00.000Z",
  };

  const library = { id: "sp1", name: "Docs Library", org_id: "org1", deleted_at: null };
  const deployment = {
    deployment_id: "dep1",
    name: "Docs MCP Server",
    space_id: "sp1",
    org_id: "org1",
    provider_slug: "dosu_mcp",
  };

  type Routes = Record<string, unknown>;

  /** Route queries by procedure path so the scope lookups can run in any order. A route value
   * that is an Error rejects; `listPending` defaults to an empty page. */
  function serve(overrides: Routes = {}) {
    const routes: Routes = {
      "knowledgeStore.getBySpaceId": { id: "ks1" },
      "libraries.info": library,
      "workspaces.get": deployment,
      "review.listPending": { items: [], truncated: false, total: 0 },
      ...overrides,
    };
    mockQuery.mockImplementation(async (path: string) => {
      if (!(path in routes)) throw new Error(`unexpected query ${path}`);
      const value = routes[path];
      if (value instanceof Error) throw value;
      return value;
    });
  }

  function queried(path: string): unknown[] {
    return mockQuery.mock.calls.filter((c: unknown[]) => c[0] === path).map((c: unknown[]) => c[1]);
  }

  function errorOutput(): string {
    return errorSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
  }

  function internalError() {
    return new TRPCClientError("boom", {
      result: {
        error: { code: -32603, message: "boom", data: { code: "INTERNAL_SERVER_ERROR" } },
      },
    });
  }

  afterEach(() => {
    // Listing is read-only: no list scenario may issue a mutation.
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("resolves the selected scope, then calls review.listPending for it", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    serve({ "review.listPending": { items: [pendingItem], truncated: false, total: 1 } });

    await run("list");

    expect(queried("knowledgeStore.getBySpaceId")).toEqual([{ space_id: "sp1" }]);
    expect(queried("libraries.info")).toEqual(["sp1"]);
    expect(queried("workspaces.get")).toEqual(["dep1"]);
    expect(queried("review.listPending")).toEqual([
      { knowledgeStoreId: "ks1", deploymentId: "dep1" },
    ]);
    // full id must print — verbs (diff/approve/reject/edit) need the whole id (#102)
    expect(allOutput()).toContain("pv-abcdef12");
    expect(allOutput()).toContain("doc_change");
    expect(allOutput()).toContain("API Guide");
    // origin enum is humanized to match the MCP tool / dashboard
    expect(allOutput()).toContain("Synced from source");
    expect(allOutput()).not.toContain("sync_upstream");
  });

  it("shows the Library and MCP deployment it searched above the table", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    serve({ "review.listPending": { items: [pendingItem], truncated: false, total: 1 } });

    await run("list");

    const out = allOutput();
    expect(out).toMatch(/Library\s+Docs Library \(sp1\)/);
    expect(out).toMatch(/MCP deployment\s+Docs MCP Server \(dep1\)/);
    expect(out.indexOf("Docs Library")).toBeLessThan(out.indexOf("API Guide"));
  });

  it("keeps items/truncated/total in --json and adds the scope object", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    serve({ "review.listPending": { items: [pendingItem], truncated: false, total: 1 } });

    await run("list", "--json");

    // --json emits the full ENG-605 envelope ({ items, truncated, total }) so
    // machine consumers see truncation, not just the visible slice.
    const output = JSON.parse(allOutput());
    expect(output.items).toHaveLength(1);
    expect(output.truncated).toBe(false);
    expect(output.total).toBe(1);
    expect(output.items[0].id).toBe("pv-abcdef12");
    expect(output.items[0].kind).toBe("doc_change");
    // --json is the machine surface — raw enum, not humanized
    expect(output.items[0].origin).toBe("sync_upstream");
    expect(output.scope).toEqual({
      library: { id: "sp1", name: "Docs Library" },
      deployment: { id: "dep1", name: "Docs MCP Server" },
      kinds: ["doc_change", "draft_message"],
      since: null,
      until: null,
    });
  });

  it.each([
    ["manual_update", 1, "User created"],
    ["manual_update", 2, "User updated"],
    ["llm_generated", 1, "AI generated"],
    ["api_update", 1, "Created via API"],
    ["future_origin", 1, "future_origin"], // unknown enum falls through to raw value
  ])("humanizes source %s (v%i) as %s", async (origin, version, expected) => {
    mockLoadConfig.mockReturnValue(validConfig);
    serve({
      "review.listPending": {
        items: [{ ...pendingItem, origin, version }],
        truncated: false,
        total: 1,
      },
    });

    await run("list");

    expect(allOutput()).toContain(expected);
  });

  it("falls back to (untitled) when title is missing", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    serve({
      "review.listPending": {
        items: [{ ...pendingItem, title: null }],
        truncated: false,
        total: 1,
      },
    });

    await run("list");

    expect(allOutput()).toContain("(untitled)");
  });

  it("renders draft_message items alongside doc changes", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    serve({
      "review.listPending": { items: [pendingItem, draftItem], truncated: false, total: 2 },
    });

    await run("list");

    const out = allOutput();
    expect(out).toContain("doc_change");
    expect(out).toContain("draft_message");
    expect(out).toContain("Re: how do I configure X?");
    // the full prefixed id must print so it can be pasted into approve/reject/edit
    expect(out).toContain("draft_message:msg-abcdef12");
    // drafts have no origin/version/pendingStatus — they render fixed labels
    expect(out).toContain("Draft reply");
    expect(out).toContain("draft");
  });

  it("falls back to (untitled) for a draft with an empty title", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    serve({
      "review.listPending": { items: [{ ...draftItem, title: "" }], truncated: false, total: 1 },
    });

    await run("list");

    expect(allOutput()).toContain("(untitled)");
  });

  it("names the scope when the queue is empty", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    serve();

    await run("list");

    const out = allOutput();
    expect(out).toMatch(/Library\s+Docs Library \(sp1\)/);
    expect(out).toMatch(/MCP deployment\s+Docs MCP Server \(dep1\)/);
    expect(out).toContain("No pending review items in this scope.");
    expect(out).toContain("dosu deployments switch");
  });

  it("prints IDs alone when optional names are unavailable, never a placeholder name", async () => {
    mockLoadConfig.mockReturnValue(
      makeValidConfig({ library_name: "Stale Cached Name", deployment_name: "Stale Dep" }),
    );
    serve({
      // A lookup failure other than NOT_FOUND leaves the name unknown; it is not a scope error.
      "libraries.info": internalError(),
      "workspaces.get": { ...deployment, name: "" },
      "review.listPending": { items: [pendingItem], truncated: false, total: 1 },
    });

    await run("list", "--json");

    const output = JSON.parse(allOutput());
    expect(output.scope.library).toEqual({ id: "sp1", name: null });
    expect(output.scope.deployment).toEqual({ id: "dep1", name: null });
    expect(JSON.stringify(output)).not.toContain("Stale");
  });

  it("reports a Library the server returns with an empty name as unnamed, not unavailable", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    serve({ "libraries.info": { ...library, name: "" } });

    await run("list", "--json");

    const output = JSON.parse(allOutput());
    expect(output.scope.library).toEqual({ id: "sp1", name: null });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("renders a scope without names in human output", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ library_name: "Stale Cached Name" }));
    serve({ "libraries.info": internalError(), "workspaces.get": { ...deployment, name: "" } });

    await run("list");

    const out = allOutput();
    expect(out).toMatch(/Library\s+sp1\n/);
    expect(out).toMatch(/MCP deployment\s+dep1\n/);
    expect(out).not.toContain("Stale");
    expect(out).not.toMatch(/null|undefined/);
  });

  it("lists doc changes only, and says so, when no MCP deployment is saved", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ deployment_id: undefined }));
    serve({ "review.listPending": { items: [pendingItem], truncated: false, total: 1 } });

    await run("list", "--json");

    expect(queried("workspaces.get")).toEqual([]);
    expect(queried("review.listPending")).toEqual([{ knowledgeStoreId: "ks1" }]);
    const output = JSON.parse(allOutput());
    expect(output.scope.deployment).toBeNull();
    expect(output.scope.kinds).toEqual(["doc_change"]);
  });

  it("explains missing draft replies in human output when no MCP deployment is saved", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ deployment_id: undefined }));
    serve();

    await run("list");

    expect(allOutput()).toMatch(/MCP deployment\s+none selected \(draft replies not listed\)/);
  });

  describe("--since / --until", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("resolves both bounds to ISO instants (an until date includes the whole day)", async () => {
      mockLoadConfig.mockReturnValue(validConfig);
      serve({ "review.listPending": { items: [pendingItem], truncated: false, total: 1 } });

      await run("list", "--since", "7d", "--until", "2026-09-24");

      expect(queried("review.listPending")).toEqual([
        {
          knowledgeStoreId: "ks1",
          deploymentId: "dep1",
          since: "2026-09-18T12:00:00.000Z",
          until: "2026-09-25T00:00:00.000Z",
        },
      ]);
      expect(allOutput()).toContain(
        "Pending review items created since 2026-09-18T12:00Z and before 2026-09-25T00:00Z:",
      );
      expect(allOutput()).toContain("API Guide");
    });

    it("records the window in the JSON scope", async () => {
      mockLoadConfig.mockReturnValue(validConfig);
      serve();

      await run("list", "--since", "24h", "--json");

      const output = JSON.parse(allOutput());
      expect(output.scope.since).toBe("2026-09-24T12:00:00.000Z");
      expect(output.scope.until).toBeNull();
    });

    it("sends only the bound that was given", async () => {
      mockLoadConfig.mockReturnValue(validConfig);
      serve();

      await run("list", "--until", "2026-09-01T14:00:00+02:00");

      expect(queried("review.listPending")).toEqual([
        { knowledgeStoreId: "ks1", deploymentId: "dep1", until: "2026-09-01T12:00:00.000Z" },
      ]);
      expect(allOutput()).toContain(
        "No pending review items in this scope before 2026-09-01T12:00Z.",
      );
    });

    it("names the range in the truncation footer", async () => {
      mockLoadConfig.mockReturnValue(validConfig);
      serve({ "review.listPending": { items: [pendingItem], truncated: true, total: 50 } });

      await run("list", "--since", "24h");

      expect(allOutput()).toContain(
        "Showing 1 of 50+ pending items since 2026-09-24T12:00Z (list truncated).",
      );
    });

    it("exits before any request when --since is not earlier than --until", async () => {
      mockLoadConfig.mockReturnValue(validConfig);

      await expect(run("list", "--since", "7d", "--until", "7d")).rejects.toThrow("exit");

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("--since must be earlier than --until."),
      );
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("rejects a malformed bound at parse time", async () => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await expect(run("list", "--since", "last week")).rejects.toThrow("exit");
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining("must be a duration"));
      } finally {
        stderr.mockRestore();
      }
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  it("keeps truncated/total in --json for a capped page", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    serve({ "review.listPending": { items: [pendingItem], truncated: true, total: 73 } });

    await run("list", "--json");

    const output = JSON.parse(allOutput());
    expect(output.truncated).toBe(true);
    expect(output.total).toBe(73);
    expect(output.scope.library.id).toBe("sp1");
  });

  describe("context errors", () => {
    it("stops before any request when not logged in", async () => {
      mockLoadConfig.mockReturnValue({ schema_version: 2 });

      await expect(run("list")).rejects.toThrow("exit");

      expect(errorOutput()).toContain("Not logged in. Run 'dosu login' first.");
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it("names the missing Library and the selection commands", async () => {
      mockLoadConfig.mockReturnValue(makeValidConfig({ space_id: undefined }));

      await expect(run("list", "--json")).rejects.toThrow("exit");

      const err = errorOutput();
      expect(err).toContain("No Library selected.");
      expect(err).toContain("dosu deployments list");
      expect(err).toContain("dosu deployments switch <deployment-id>");
      expect(err).toContain("dosu setup");
      expect(err).not.toMatch(/space/i);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(allOutput()).toBe("");
    });

    it("treats a deleted or inaccessible MCP deployment as an error, not an empty queue", async () => {
      mockLoadConfig.mockReturnValue(validConfig);
      serve({ "workspaces.get": null });

      await expect(run("list", "--json")).rejects.toThrow("exit");

      const err = errorOutput();
      expect(err).toContain("The selected MCP deployment (dep1) is unavailable");
      expect(err).toContain("dosu deployments list");
      expect(queried("review.listPending")).toEqual([]);
      expect(allOutput()).toBe("");
    });

    it("treats a deleted or inaccessible Library as an error", async () => {
      mockLoadConfig.mockReturnValue(validConfig);
      serve({ "libraries.info": notFound() });

      await expect(run("list")).rejects.toThrow("exit");

      expect(errorOutput()).toContain("The selected Library (sp1) is unavailable");
      expect(queried("review.listPending")).toEqual([]);
    });

    it("treats a Library without a readable knowledge store as unavailable", async () => {
      mockLoadConfig.mockReturnValue(validConfig);
      serve({ "knowledgeStore.getBySpaceId": null });

      await expect(run("list")).rejects.toThrow("exit");

      const err = errorOutput();
      expect(err).toContain("The selected Library (sp1) is unavailable");
      expect(err).not.toContain("knowledge store");
      expect(queried("review.listPending")).toEqual([]);
    });

    it("refuses a saved Library that is not the MCP deployment's Library", async () => {
      mockLoadConfig.mockReturnValue(validConfig);
      serve({ "workspaces.get": { ...deployment, space_id: "sp-other" } });

      await expect(run("list")).rejects.toThrow("exit");

      const err = errorOutput();
      expect(err).toContain("does not match");
      expect(err).toContain("dosu deployments switch dep1");
      expect(queried("review.listPending")).toEqual([]);
    });

    it("propagates an unexpected lookup failure instead of reporting an empty queue", async () => {
      mockLoadConfig.mockReturnValue(validConfig);
      serve({ "workspaces.get": internalError() });

      await expect(run("list")).rejects.toThrow("boom");

      expect(queried("review.listPending")).toEqual([]);
    });
  });
});

describe("review diff", () => {
  const changeView = {
    title: "API Guide",
    source: "Synced from source",
    version: 3,
    publishedVersion: 2,
    isNewDoc: false,
    hasChanges: true,
    diff: "Changes vs. current published version:\n@@ -1 +1 @@\n-old\n+new",
  };

  it("calls review.getChange with the opaque id and prints the diff", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(changeView);

    await run("diff", "pv-abcdef12");

    expect(mockQuery).toHaveBeenCalledWith("review.getChange", { id: "pv-abcdef12" });
    const output = allOutput();
    expect(output).toContain("API Guide");
    expect(output).toContain("Synced from source");
    expect(output).toContain("v2 → v3");
    expect(output).toContain("+new");
  });

  it("omits the published version arrow for a new doc", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      ...changeView,
      publishedVersion: null,
      isNewDoc: true,
      diff: "New document content:\nhello world",
    });

    await run("diff", "pv-1");

    const output = allOutput();
    expect(output).toContain("v3");
    expect(output).not.toContain("→");
    expect(output).toContain("New document content:");
  });

  it("passes the ChangeView through with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(changeView);

    await run("diff", "--json", "pv-abcdef12");

    const output = JSON.parse(allOutput());
    expect(output.title).toBe("API Guide");
    expect(output.hasChanges).toBe(true);
    expect(output.diff).toContain("@@");
  });

  it("prints a clear message for an unknown bare (doc) id", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockRejectedValueOnce(notFound()); // review.getChange → unknown doc

    await expect(run("diff", "missing")).rejects.toThrow("exit");
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("No review item found");
  });

  it("prints a clear message for a malformed (non-UUID) id instead of crashing", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockRejectedValueOnce(unprocessable()); // review.getChange → 422, not 404

    await expect(run("diff", "not-a-uuid")).rejects.toThrow("exit");
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("No review item found");
  });

  it("shows the body for a prefixed draft id (no getChange probe)", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ id: "msg-1", title: "Re: q", body: "the answer" }); // getMessage

    await run("diff", "draft_message:msg-1");

    // Prefix routing goes straight to the draft path — getChange is never probed.
    expect(mockQuery).toHaveBeenCalledWith("messages.getMessage", "msg-1");
    expect(mockQuery).not.toHaveBeenCalledWith("review.getChange", expect.anything());
    const out = allOutput();
    expect(out).toContain("Re: q");
    expect(out).toContain("Draft reply");
    expect(out).toContain("the answer");
  });

  it("passes the draft through with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ id: "msg-1", title: "Re: q", body: "the answer" });

    await run("diff", "--json", "draft_message:msg-1");

    const output = JSON.parse(allOutput());
    expect(output.kind).toBe("draft_message");
    expect(output.body).toBe("the answer");
  });
});

// A truthy ChangeView returned by review.getChange, for the approve/reject/revert
// doc paths that resolve a diff preview before mutating.
const docChange = { kind: "doc_change" };

describe("review edit", () => {
  it("calls page.updateReview with title and body", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce(undefined);

    await run("edit", "pv-abcdef12", "--title", "New Title", "--body", "# Body");

    expect(mockMutate).toHaveBeenCalledWith("page.updateReview", {
      page_version_id: "pv-abcdef12",
      title: "New Title",
      body: "# Body",
    });
    expect(allOutput()).toContain("Review edited: pv-abcde");
  });

  it("reads body from --body-file", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce(undefined);
    const dir = mkdtempSync(join(tmpdir(), "dosu-review-test-"));
    const file = join(dir, "body.md");
    try {
      writeFileSync(file, "# From file\n", "utf-8");
      await run("edit", "pv-abcdef12", "--body-file", file);
      expect(mockMutate).toHaveBeenCalledWith("page.updateReview", {
        page_version_id: "pv-abcdef12",
        title: undefined,
        body: "# From file\n",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips the prefix and saves a new draft revision for a draft id (body only)", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ id: "msg-1", title: "Re: q", body: "old" });
    mockMutate.mockResolvedValueOnce(undefined);

    await run("edit", "draft_message:msg-1", "--body", "new body");

    // saveDraft gets the BARE message id — the draft_message: prefix is stripped.
    expect(mockMutate).toHaveBeenCalledWith("messages.saveDraft", {
      messageId: "msg-1",
      body: "new body",
    });
    // confirmation shows the bare message id, not the shared draft_message: prefix
    expect(allOutput()).toContain("Review edited: msg-1");
  });

  it("rejects --title for a draft id (saveDraft is body-only)", async () => {
    mockLoadConfig.mockReturnValue(validConfig);

    await expect(run("edit", "draft_message:msg-1", "--title", "T", "--body", "b")).rejects.toThrow(
      "exit",
    );
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("--body only");
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("prints a clear message for an unknown draft id", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(null); // getMessage → not a draft

    await expect(run("edit", "draft_message:missing", "--body", "b")).rejects.toThrow("exit");
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("No review item found");
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("errors when neither title nor body is given", async () => {
    mockLoadConfig.mockReturnValue(validConfig);

    await expect(run("edit", "pv-abcdef12")).rejects.toThrow("exit");
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("Nothing to edit");
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("errors when both --body and --body-file are given", async () => {
    mockLoadConfig.mockReturnValue(validConfig);

    await expect(run("edit", "pv-abcdef12", "--body", "x", "--body-file", "f.md")).rejects.toThrow(
      "exit",
    );
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("only one of --body or --body-file");
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("errors gracefully when --body-file cannot be read", async () => {
    mockLoadConfig.mockReturnValue(validConfig);

    await expect(run("edit", "pv-abcdef12", "--body-file", "/no/such/file.md")).rejects.toThrow(
      "exit",
    );
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("Failed to read --body-file");
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("prints a clear message for a doc that left review before update", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockRejectedValueOnce(notFound()); // page.updateReview → no longer pending

    await expect(run("edit", "pv-missing", "--title", "T")).rejects.toThrow("exit");
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("No pending review item found");
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockResolvedValueOnce(undefined);

    await run("edit", "--json", "pv-abcdef12", "--title", "T");

    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.id).toBe("pv-abcdef12");
  });
});

describe("review context", () => {
  it("calls review.getThreadContext with thread_id", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ type: "messages" });

    await run("context", "thread-1");

    expect(mockQuery).toHaveBeenCalledWith("review.getThreadContext", {
      thread_id: "thread-1",
    });
  });

  it("outputs valid JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      type: "document",
      reviewPage: { id: "p1", title: "Doc" },
    });

    await run("context", "--json", "thread-1");

    const output = JSON.parse(allOutput());
    expect(output.type).toBe("document");
  });

  it("displays document type with review page info", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      type: "document",
      reviewPage: { id: "p1", title: "API Guide" },
      syncPrUrl: "https://github.com/org/repo/pull/42",
    });

    await run("context", "thread-1");

    const output = allOutput();
    expect(output).toContain("document");
    expect(output).toContain("API Guide");
    expect(output).toContain("github.com");
  });

  it("displays published page ID when title is missing", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      type: "document",
      reviewPage: { id: "p1" },
      publishedPage: { id: "pub-p1" },
      syncPrUrl: null,
    });

    await run("context", "thread-1");

    const output = allOutput();
    expect(output).toContain("pub-p1");
  });

  it("displays null publishedPage and no syncPrUrl", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      type: "messages",
      reviewPage: { id: "p1" },
      publishedPage: null,
      syncPrUrl: undefined,
    });

    await run("context", "thread-1");

    const output = allOutput();
    expect(output).toContain("messages");
    expect(output).toContain("p1");
    expect(output).not.toContain("Published Page");
    expect(output).not.toContain("Sync PR");
  });
});

const changeView = {
  id: "pv-1",
  kind: "doc_change",
  title: "API Guide",
  source: "Synced from source",
  version: 3,
  publishedVersion: 2,
  isNewDoc: false,
  hasChanges: true,
  diff: "@@ -1,2 +1,2 @@\n context line\n-old line\n+new line",
};

describe("review approve", () => {
  it("previews the diff and applies with --confirm", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(changeView); // review.getChange
    mockMutate.mockResolvedValueOnce({});

    await run("approve", "--confirm", "pv-1");

    expect(mockQuery).toHaveBeenCalledWith("review.getChange", { id: "pv-1" });
    expect(mockMutate).toHaveBeenCalledWith("page.updatePublicationStatus", {
      page_version_id: "pv-1",
      action: "accept",
    });
    // the diff preview is shown before applying
    const out = allOutput();
    expect(out).toContain("API Guide");
    expect(out).toContain("new line");
    expect(out).toContain("Review approve: pv-1");
  });

  it("does not mutate without --confirm in non-interactive mode", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(changeView);

    await run("approve", "pv-1");

    expect(mockMutate).not.toHaveBeenCalled();
    expect(allOutput()).toContain("Re-run with --confirm");
  });

  it("outputs JSON with --json --confirm", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(changeView);
    mockMutate.mockResolvedValueOnce({});

    await run("approve", "--json", "--confirm", "pv-1");

    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.id).toBe("pv-1");
    expect(output.action).toBe("accept");
  });

  it("returns the change preview as JSON without --confirm and does not mutate", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(changeView);

    await run("approve", "--json", "pv-1");

    const output = JSON.parse(allOutput());
    expect(output.confirmRequired).toBe(true);
    expect(output.applied).toBe(false);
    expect(output.diff).toContain("new line");
    expect(mockMutate).not.toHaveBeenCalled();
  });
});

describe("review reject", () => {
  it("applies with --confirm", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(changeView);
    mockMutate.mockResolvedValueOnce({});

    await run("reject", "--confirm", "pv-123456");

    expect(mockMutate).toHaveBeenCalledWith("page.updatePublicationStatus", {
      page_version_id: "pv-123456",
      action: "decline",
    });
    expect(allOutput()).toContain("Review reject: pv-12345");
  });

  it("shows 'No content changes' when hasChanges is false", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ ...changeView, hasChanges: false });

    await run("reject", "pv-1");

    expect(allOutput()).toContain("No content changes");
    expect(mockMutate).not.toHaveBeenCalled();
  });
});

describe("review approve/reject (draft messages)", () => {
  const draftRow = { id: "msg-1", title: "Re: how do I configure X?", body: "Configure it like…" };

  it("strips the prefix and publishes on approve --confirm", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(draftRow); // messages.getMessage
    mockMutate.mockResolvedValueOnce(undefined);

    await run("approve", "--confirm", "draft_message:msg-1");

    const out = allOutput();
    expect(out).toContain("Re: how do I configure X?"); // preview shown
    expect(out).toContain("Configure it like…");
    // publishMessage gets the BARE id, and getChange is never probed for a draft.
    expect(mockQuery).not.toHaveBeenCalledWith("review.getChange", expect.anything());
    expect(mockQuery).toHaveBeenCalledWith("messages.getMessage", "msg-1");
    expect(mockMutate).toHaveBeenCalledWith("messages.publishMessage", { postId: "msg-1" });
    expect(out).toContain("Review approve: msg-1");
  });

  it("strips the prefix and discards the draft on reject --confirm", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(draftRow);
    mockMutate.mockResolvedValueOnce(undefined);

    await run("reject", "--confirm", "draft_message:msg-1");

    expect(mockMutate).toHaveBeenCalledWith("messages.deleteMessage", "msg-1");
    expect(allOutput()).toContain("Review reject: msg-1");
  });

  it("returns a draft confirmRequired payload as JSON without --confirm", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(draftRow);

    await run("approve", "--json", "draft_message:msg-1");

    const output = JSON.parse(allOutput());
    expect(output.kind).toBe("draft_message");
    expect(output.title).toBe(draftRow.title);
    expect(output.body).toBe(draftRow.body);
    expect(output.confirmRequired).toBe(true);
    expect(output.applied).toBe(false);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("exits with a clear message when the draft id resolves to nothing", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(null); // messages.getMessage → missing

    await expect(run("approve", "--confirm", "draft_message:missing")).rejects.toThrow("exit");
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("No review item found");
    expect(mockMutate).not.toHaveBeenCalled();
  });
});

describe("review approve (interactive prompt)", () => {
  let ttyDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  });

  afterEach(() => {
    if (ttyDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
    } else {
      // restore the original "absent" state so later tests stay non-interactive
      Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
    }
  });

  it("applies when the user confirms y/N", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(changeView);
    mockMutate.mockResolvedValueOnce({});
    mockConfirm.mockResolvedValueOnce(true);

    await run("approve", "pv-1");

    expect(mockConfirm).toHaveBeenCalled();
    expect(mockMutate).toHaveBeenCalledWith("page.updatePublicationStatus", {
      page_version_id: "pv-1",
      action: "accept",
    });
  });

  it("aborts when the user declines", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(changeView);
    mockConfirm.mockResolvedValueOnce(false);

    await run("approve", "pv-1");

    expect(mockMutate).not.toHaveBeenCalled();
    expect(allOutput()).toContain("Aborted");
  });

  it("handles cancellation gracefully", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(changeView);
    mockConfirm.mockResolvedValueOnce(Symbol.for("clack:cancel"));

    await run("approve", "pv-1");

    expect(mockMutate).not.toHaveBeenCalled();
    expect(allOutput()).toContain("Cancelled");
  });

  it("renders a new-doc preview (no published version)", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({
      ...changeView,
      isNewDoc: true,
      publishedVersion: null,
      version: 1,
    });
    mockConfirm.mockResolvedValueOnce(false);

    await run("approve", "pv-1");

    expect(allOutput()).toContain("1 (new)");
  });
});

describe("review revert", () => {
  it("calls page.updatePublicationStatus with action=revert_to_pending", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(docChange); // review.getChange → doc
    mockMutate.mockResolvedValueOnce({});

    await run("revert", "pv-1");

    expect(mockMutate).toHaveBeenCalledWith("page.updatePublicationStatus", {
      page_version_id: "pv-1",
      action: "revert_to_pending",
    });
  });

  it("prints human-readable confirmation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(docChange);
    mockMutate.mockResolvedValueOnce({});
    await run("revert", "pv-123456");
    expect(allOutput()).toContain("Review revert: pv-12345");
  });

  it("outputs JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(docChange);
    mockMutate.mockResolvedValueOnce({});
    await run("revert", "--json", "pv-1");
    const output = JSON.parse(allOutput());
    expect(output.success).toBe(true);
    expect(output.action).toBe("revert_to_pending");
  });

  it("rejects revert for a prefixed draft id", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce({ id: "msg-1" }); // messages.getMessage exists

    await expect(run("revert", "draft_message:msg-1")).rejects.toThrow("exit");
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("not supported for draft replies");
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("exits with a clear message for an unknown bare (doc) id", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockRejectedValueOnce(notFound()); // review.getChange → unknown doc

    await expect(run("revert", "missing")).rejects.toThrow("exit");
    expect(errorSpy.mock.calls.flat().join(" ")).toContain("No review item found");
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("rethrows an error from the revert mutation", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockResolvedValueOnce(docChange); // review.getChange → doc
    mockMutate.mockRejectedValueOnce(new Error("boom"));

    await expect(run("revert", "pv-1")).rejects.toThrow("boom");
  });
});

// Errors other than NOT_FOUND are not kind-routing signals — they propagate.
describe("review error propagation", () => {
  it("rethrows a non-NOT_FOUND error from getChange (kind resolution)", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockQuery.mockRejectedValueOnce(new Error("boom")); // review.getChange

    await expect(run("approve", "--confirm", "pv-1")).rejects.toThrow("boom");
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("rethrows a non-NOT_FOUND error from page.updateReview", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockMutate.mockRejectedValueOnce(new Error("boom"));

    await expect(run("edit", "pv-1", "--body", "x")).rejects.toThrow("boom");
  });
});

describe("requireConfig", () => {
  it("exits when access_token is missing", async () => {
    mockLoadConfig.mockReturnValue(makeValidConfig({ access_token: "" }));
    await expect(run("context", "t1")).rejects.toThrow("exit");
  });
});
