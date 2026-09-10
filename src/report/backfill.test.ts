import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "../config/config.test-utils";
import { fetchRemoteNotes, mergeRemoteNotes } from "./backfill";
import { WRITTEN_NOTES_LIMIT } from "./notes";
import type { WrittenNote } from "./types";

const mockQuery = vi.fn();
const mockCreateTypedClient = vi.fn();
vi.mock("../client/trpc", () => ({
  createTypedClient: (...args: unknown[]) => mockCreateTypedClient(...args),
}));

const authedConfig = () =>
  makeTestConfig({
    access_token: "at",
    refresh_token: "rt",
    expires_at: Date.now() / 1000 + 3600,
    org_id: "11111111-1111-4111-8111-111111111111",
    org_name: "Acme",
  });

beforeEach(() => {
  mockQuery.mockReset();
  mockCreateTypedClient.mockReset();
  mockCreateTypedClient.mockReturnValue({ notes: { listMine: { query: mockQuery } } });
});

describe("fetchRemoteNotes", () => {
  it("returns empty without an org id and never builds a client", async () => {
    const cfg = makeTestConfig({ access_token: "at", refresh_token: "rt", expires_at: 0 });
    expect(await fetchRemoteNotes(cfg)).toEqual([]);
    expect(mockCreateTypedClient).not.toHaveBeenCalled();
  });

  it("returns empty without an access token", async () => {
    const cfg = authedConfig();
    if (cfg.active_account) cfg.active_account.session.access_token = "";
    expect(await fetchRemoteNotes(cfg)).toEqual([]);
    expect(mockCreateTypedClient).not.toHaveBeenCalled();
  });

  it("maps backend notes into WrittenNote shape, keeping optional fields only when present", async () => {
    mockQuery.mockResolvedValue({
      notes: [
        {
          id: "n1",
          title: "OAuth refresh",
          body: "Retry after 401.",
          repo: "git@x/y",
          branch: "main",
          session_id: "run-uuid-1",
          created_at: "2026-09-01T00:00:00+00:00",
        },
        {
          id: "n2",
          title: "Bare",
          body: "No anchor.",
          repo: null,
          branch: null,
          session_id: null,
          created_at: "2026-09-02T00:00:00+00:00",
        },
      ],
    });

    const notes = await fetchRemoteNotes(authedConfig());
    expect(mockQuery).toHaveBeenCalledWith({
      org_id: "11111111-1111-4111-8111-111111111111",
      limit: WRITTEN_NOTES_LIMIT,
    });
    expect(notes).toEqual([
      {
        title: "OAuth refresh",
        content: "Retry after 401.",
        status: "written",
        at: "2026-09-01T00:00:00+00:00",
        // The backend session_id is the miner's run id, never local transcript
        // attribution — it must come through as run_id.
        run_id: "run-uuid-1",
        repo: "git@x/y",
        branch: "main",
      },
      { title: "Bare", content: "No anchor.", status: "written", at: "2026-09-02T00:00:00+00:00" },
    ]);
  });

  it("fails open when the backend errors (missing procedure, offline)", async () => {
    mockQuery.mockRejectedValue(new Error("404 NOT_FOUND"));
    expect(await fetchRemoteNotes(authedConfig())).toEqual([]);
  });

  it("fails open when the client cannot be constructed", async () => {
    mockCreateTypedClient.mockImplementation(() => {
      throw new Error("Web app URL not configured");
    });
    expect(await fetchRemoteNotes(authedConfig())).toEqual([]);
  });
});

function note(title: string, at: string, extra: Partial<WrittenNote> = {}): WrittenNote {
  return { title, content: `${title} body`, status: "written", at, ...extra };
}

describe("mergeRemoteNotes", () => {
  it("keeps the local entry when the same note exists remotely", () => {
    const local = [note("A", "2026-09-02T00:00:00Z", { transcript_id: "local-sess" })];
    const remote = [note("A", "2026-09-01T00:00:00Z", { transcript_id: "remote-sess" })];
    const merged = mergeRemoteNotes(local, remote);
    expect(merged).toHaveLength(1);
    expect(merged[0].transcript_id).toBe("local-sess");
  });

  it("interleaves remote-only history in chronological order", () => {
    const local = [note("New local", "2026-09-03T00:00:00Z")];
    const remote = [
      note("Old remote", "2026-09-01T00:00:00Z"),
      note("Mid remote", "2026-09-02T00:00:00Z"),
    ];
    expect(mergeRemoteNotes(local, remote).map((n) => n.title)).toEqual([
      "Old remote",
      "Mid remote",
      "New local",
    ]);
  });

  it("sorts unparsable timestamps first and keeps the newest under the cap", () => {
    const local = Array.from({ length: WRITTEN_NOTES_LIMIT }, (_, i) =>
      note(`local-${i}`, `2026-08-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`),
    );
    const remote = [note("garbled", "not-a-date"), note("newest", "2026-09-09T00:00:00Z")];
    const merged = mergeRemoteNotes(local, remote);
    expect(merged).toHaveLength(WRITTEN_NOTES_LIMIT);
    expect(merged.at(-1)?.title).toBe("newest");
    expect(merged.some((n) => n.title === "garbled")).toBe(false);
  });
});
