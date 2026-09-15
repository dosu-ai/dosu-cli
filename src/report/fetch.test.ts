import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config";

const mockQuery = vi.fn();
const mockCreateTypedClient = vi.fn(() => ({ notes: { listMine: { query: mockQuery } } }));
vi.mock("../client/trpc", () => ({
  createTypedClient: () => mockCreateTypedClient(),
}));

import { fetchReportNotes, REPORT_NOTES_LIMIT } from "./fetch";

function authedConfig(): Config {
  return {
    schema_version: 2,
    active_account: {
      user_id: "u1",
      session: { access_token: "tok", refresh_token: "r", expires_at: 0 },
      target: { org_id: "11111111-1111-4111-8111-111111111111" },
    },
  } as unknown as Config;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockCreateTypedClient.mockClear();
});

describe("fetchReportNotes", () => {
  it("maps backend notes, keeping optional fields only when present", async () => {
    mockQuery.mockResolvedValue({
      notes: [
        {
          id: "n1",
          title: "OAuth refresh",
          body: "Retry after 401.",
          repo: "git@x/y",
          branch: "main",
          transcript_id: "conv-1",
          created_at: "2026-09-01T00:00:00+00:00",
        },
        {
          id: "n2",
          title: "Bare",
          body: "No provenance.",
          repo: null,
          branch: null,
          transcript_id: null,
          created_at: "2026-09-02T00:00:00+00:00",
        },
      ],
    });

    const { notes, truncated } = await fetchReportNotes(authedConfig());
    expect(mockQuery).toHaveBeenCalledWith({
      org_id: "11111111-1111-4111-8111-111111111111",
      limit: REPORT_NOTES_LIMIT,
    });
    expect(truncated).toBe(false);
    expect(notes).toEqual([
      {
        title: "OAuth refresh",
        content: "Retry after 401.",
        at: "2026-09-01T00:00:00+00:00",
        transcript_id: "conv-1",
        repo: "git@x/y",
        branch: "main",
      },
      { title: "Bare", content: "No provenance.", at: "2026-09-02T00:00:00+00:00" },
    ]);
  });

  it("follows next_cursor until the last page and concatenates in order", async () => {
    const cursorFor = (n: number) => ({
      created_at: `2026-09-0${n}T00:00:00+00:00`,
      id: `n${n}`,
    });
    const page = (n: number, next?: { created_at: string; id: string }) => ({
      notes: [
        {
          id: `n${n}`,
          title: `Note ${n}`,
          body: "b",
          repo: null,
          branch: null,
          transcript_id: null,
          created_at: `2026-09-0${n}T00:00:00+00:00`,
        },
      ],
      ...(next ? { next_cursor: next } : {}),
    });
    mockQuery
      .mockResolvedValueOnce(page(3, cursorFor(3)))
      .mockResolvedValueOnce(page(2, cursorFor(2)))
      .mockResolvedValueOnce(page(1));

    const { notes, truncated } = await fetchReportNotes(authedConfig());
    expect(notes.map((n) => n.title)).toEqual(["Note 3", "Note 2", "Note 1"]);
    expect(truncated).toBe(false);
    expect(mockQuery).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: cursorFor(3) }));
    expect(mockQuery).toHaveBeenNthCalledWith(3, expect.objectContaining({ cursor: cursorFor(2) }));
  });

  it("flags truncation when a pre-pagination server returns a full page with no cursor", async () => {
    mockQuery.mockResolvedValue({
      notes: Array.from({ length: REPORT_NOTES_LIMIT }, (_, i) => ({
        id: `n${i}`,
        title: `Note ${i}`,
        body: "b",
        repo: null,
        branch: null,
        transcript_id: null,
        created_at: "2026-09-01T00:00:00+00:00",
      })),
    });

    const { notes, truncated } = await fetchReportNotes(authedConfig());
    expect(notes).toHaveLength(REPORT_NOTES_LIMIT);
    expect(truncated).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("rejects with an actionable message when signed out or missing an org", async () => {
    await expect(fetchReportNotes({ schema_version: 2 } as Config)).rejects.toThrow(
      /Not signed in/,
    );
    const noToken = authedConfig();
    // biome-ignore lint/style/noNonNullAssertion: shaped above
    noToken.active_account!.session.access_token = "";
    await expect(fetchReportNotes(noToken)).rejects.toThrow(/Not signed in/);
    expect(mockCreateTypedClient).not.toHaveBeenCalled();
  });

  it("propagates backend failures unchanged (online-only by design)", async () => {
    mockQuery.mockRejectedValue(new Error("404 NOT_FOUND"));
    await expect(fetchReportNotes(authedConfig())).rejects.toThrow("404 NOT_FOUND");
  });
});
