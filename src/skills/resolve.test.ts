import { TRPCClientError } from "@trpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TypedClient } from "../client/trpc";
import { MAX_PROCEDURE_CHARS, type ResolveInput, resolveLinkedProcedure } from "./resolve";
import type { ResolveFailure, ResolveReason, ResolveResult, ResolveSuccess } from "./types";

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

const client = createMockProxy() as unknown as TypedClient;

const DOC = "879cbca9-2fbf-45be-9a3e-1b74303238be";
const LIB = "11111111-1111-4111-8111-111111111111";
const OTHER_LIB = "22222222-2222-4222-8222-222222222222";
const STORE = "66e1c189-0000-4000-8000-000000000000";
const OTHER_STORE = "77777777-0000-4000-8000-000000000000";
const UPDATED_AT = "2026-09-10T01:08:02.487426+00:00";
const FIXED_NOW = new Date("2026-09-11T12:00:00.000Z");
const BODY = "# DB Enum Widening Checklist\n\n1. Confirm the enum is widened, never narrowed.\n";

type Handler = (input: unknown) => unknown;

/** Script return values (or thrown errors) per procedure path. Unscripted paths reject loudly. */
function script(handlers: Record<string, Handler>): void {
  mockQuery.mockImplementation(async (path: string, input: unknown) => {
    const handler = handlers[path];
    if (!handler) throw new Error(`unscripted procedure: ${path}`);
    return handler(input);
  });
}

function calledPaths(): string[] {
  return mockQuery.mock.calls.map((call) => call[0] as string);
}

function inputOf(index: number): unknown {
  return mockQuery.mock.calls[index]?.[1];
}

function version(v: number, published: boolean) {
  return {
    id: `pv-${v}`,
    version: v,
    published,
    pending_status: published ? null : "PENDING_REVIEW",
    created_at: `2026-09-0${v}T00:00:00.000Z`,
    origin: "manual_update",
    author: null,
    agent_activity_artifact: [],
    external_trigger_url: null,
    page: null,
  };
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC,
    title: "DB Enum Widening Checklist",
    body: BODY,
    version: 2,
    page_version_id: "pv-2",
    published: true,
    archived: false,
    knowledge_store_id: STORE,
    updated_at: UPDATED_AT,
    pending_status: null,
    ...overrides,
  };
}

const store = { id: STORE, space_id: LIB, org_id: "org-1", created_at: "", updated_at: "" };

/**
 * Happy-path scripting: store found, the given revision inventory, and `page.get`
 * echoing back whichever version was requested (with optional overrides).
 */
function scriptDocument(
  versions: unknown,
  pageOverrides: Record<string, unknown> = {},
  extra: Record<string, Handler> = {},
): void {
  script({
    "knowledgeStore.getBySpaceId": () => store,
    "page.listVersions": () => versions,
    "page.get": (input) => {
      const { version: v } = input as { version: number };
      return page({ version: v, page_version_id: `pv-${v}`, ...pageOverrides });
    },
    ...extra,
  });
}

/**
 * Builds a `TRPCClientError` whose `err.data.code` is readable, matching what
 * `httpLink` surfaces for a server error envelope. Omit `code` to mimic a wrapped
 * transport failure (no envelope, optional `cause`).
 */
function trpcError(code?: string, cause?: Error) {
  return new TRPCClientError("upstream failure", {
    cause,
    result:
      code === undefined
        ? undefined
        : { error: { code: -32000, message: "upstream failure", data: { code } } },
  });
}

function baseInput(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    document_id: DOC,
    library_id: LIB,
    active_library_id: LIB,
    now: () => FIXED_NOW,
    ...overrides,
  };
}

function expectOk(result: ResolveResult): ResolveSuccess {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}: ${result.message}`);
  return result;
}

function expectFail(result: ResolveResult, reason: ResolveReason): ResolveFailure {
  if (result.ok) throw new Error(`expected ${reason}, got ok (revision ${result.source.revision})`);
  expect(result.reason).toBe(reason);
  expect(result.message).toBeTypeOf("string");
  expect(result.agent_next_steps).toBeTypeOf("string");
  return result;
}

afterEach(() => {
  // The resolver must never broaden: no tag listing, no search, no mutations.
  const forbidden = calledPaths().filter(
    (p) => p === "page.listWithTags" || p.startsWith("search."),
  );
  expect(forbidden).toEqual([]);
  expect(mockMutate).not.toHaveBeenCalled();
  mockQuery.mockReset();
  mockMutate.mockReset();
});

describe("resolveLinkedProcedure", () => {
  describe("live tracking", () => {
    it("picks the highest published revision when the latest is a draft", async () => {
      scriptDocument([version(1, true), version(2, true), version(3, false)]);

      const result = expectOk(await resolveLinkedProcedure(client, baseInput()));

      expect(calledPaths()).toEqual([
        "knowledgeStore.getBySpaceId",
        "page.listVersions",
        "page.get",
      ]);
      expect(inputOf(0)).toEqual({ space_id: LIB });
      expect(inputOf(1)).toEqual({ page_id: DOC });
      expect(inputOf(2)).toEqual({ page_id: DOC, version: 2 });
      expect(result.source).toEqual({
        document_id: DOC,
        title: "DB Enum Widening Checklist",
        revision: 2,
        page_version_id: "pv-2",
        published: true,
        tracking: "live",
        library_id: LIB,
        knowledge_store_id: STORE,
        updated_at: UPDATED_AT,
        fetched_at: FIXED_NOW.toISOString(),
      });
      expect(result.body).toBe(BODY);
    });

    it("reflects a later publish on the next call without reinstall", async () => {
      let inventory = [version(1, true), version(2, true)];
      script({
        "knowledgeStore.getBySpaceId": () => store,
        "page.listVersions": () => inventory,
        "page.get": (input) => page({ version: (input as { version: number }).version }),
      });

      const first = expectOk(await resolveLinkedProcedure(client, baseInput()));
      expect(first.source.revision).toBe(2);

      inventory = [...inventory, version(3, true)];
      const second = expectOk(await resolveLinkedProcedure(client, baseInput()));
      expect(second.source.revision).toBe(3);
      expect(second.source.tracking).toBe("live");

      const getCalls = mockQuery.mock.calls.filter((c) => c[0] === "page.get").map((c) => c[1]);
      expect(getCalls).toEqual([
        { page_id: DOC, version: 2 },
        { page_id: DOC, version: 3 },
      ]);
    });

    it("treats revision: null as live", async () => {
      scriptDocument([version(1, true)]);

      const result = expectOk(await resolveLinkedProcedure(client, baseInput({ revision: null })));

      expect(calledPaths()).toContain("page.listVersions");
      expect(result.source.tracking).toBe("live");
      expect(result.source.revision).toBe(1);
    });

    it("returns document_not_found when the revision inventory is empty", async () => {
      scriptDocument([]);

      const failure = expectFail(
        await resolveLinkedProcedure(client, baseInput()),
        "document_not_found",
      );

      expect(failure.message).toBe(
        `Document ${DOC} was not found or is not accessible in this Library.`,
      );
      expect(failure.agent_next_steps).toBe(
        "Confirm the document id and that your account can access it. Do not substitute another document.",
      );
      expect(calledPaths()).toEqual(["knowledgeStore.getBySpaceId", "page.listVersions"]);
    });

    it("returns document_not_found when the revision inventory is not an array", async () => {
      scriptDocument(null);

      expectFail(await resolveLinkedProcedure(client, baseInput()), "document_not_found");
      expect(calledPaths()).not.toContain("page.get");
    });

    it("returns no_published_revision when only drafts exist", async () => {
      scriptDocument([version(1, false), version(2, false), version(3, false)]);

      const failure = expectFail(
        await resolveLinkedProcedure(client, baseInput()),
        "no_published_revision",
      );

      expect(failure.message).toBe(`Document ${DOC} has 3 revisions but none is published.`);
      expect(failure.agent_next_steps).toBe(
        "Publish a revision in Dosu, then retry. Draft revisions are never used.",
      );
      expect(failure.details).toEqual({ total_revisions: 3 });
      expect(calledPaths()).not.toContain("page.get");
    });

    it("uses the singular when a single draft exists", async () => {
      scriptDocument([version(1, false)]);

      const failure = expectFail(
        await resolveLinkedProcedure(client, baseInput()),
        "no_published_revision",
      );

      expect(failure.message).toBe(`Document ${DOC} has 1 revision but none is published.`);
      expect(failure.details).toEqual({ total_revisions: 1 });
    });

    it("returns document_not_found when page.get returns null for the chosen revision", async () => {
      scriptDocument([version(1, true)], {}, { "page.get": () => null });

      const failure = expectFail(
        await resolveLinkedProcedure(client, baseInput()),
        "document_not_found",
      );

      expect(failure.details).toBeUndefined();
      expect(calledPaths().filter((p) => p === "page.get")).toHaveLength(1);
    });
  });

  describe("pinned tracking", () => {
    it("fetches exactly the pinned revision and never lists versions", async () => {
      scriptDocument([version(1, true), version(2, true), version(3, true)]);

      const result = expectOk(await resolveLinkedProcedure(client, baseInput({ revision: 2 })));

      expect(calledPaths()).toEqual(["knowledgeStore.getBySpaceId", "page.get"]);
      expect(inputOf(1)).toEqual({ page_id: DOC, version: 2 });
      expect(result.source.revision).toBe(2);
      expect(result.source.tracking).toBe("pinned");
      expect(result.source.page_version_id).toBe("pv-2");
    });

    it("fails with revision_unavailable and never falls back when the pinned revision is null", async () => {
      script({
        "knowledgeStore.getBySpaceId": () => store,
        "page.get": () => null,
      });

      const failure = expectFail(
        await resolveLinkedProcedure(client, baseInput({ revision: 2 })),
        "revision_unavailable",
      );

      expect(failure.message).toBe(`Revision 2 of document ${DOC} is not available.`);
      expect(failure.agent_next_steps).toBe(
        "Do not fall back to the current revision. Re-link with a valid --revision or without --revision for live tracking.",
      );
      expect(failure.details).toEqual({ revision: 2 });
      expect(calledPaths()).toEqual(["knowledgeStore.getBySpaceId", "page.get"]);
    });

    it("refuses a pinned draft revision", async () => {
      scriptDocument([version(1, true), version(2, false)], { published: false });

      const failure = expectFail(
        await resolveLinkedProcedure(client, baseInput({ revision: 2 })),
        "revision_not_published",
      );

      expect(failure.message).toBe(`Revision 2 of document ${DOC} is not published.`);
      expect(failure.details).toEqual({ revision: 2 });
    });
  });

  describe("library and knowledge store checks", () => {
    it("fails with library_mismatch before any client call when the active Library differs", async () => {
      script({});

      const failure = expectFail(
        await resolveLinkedProcedure(client, baseInput({ active_library_id: OTHER_LIB })),
        "library_mismatch",
      );

      expect(mockQuery).not.toHaveBeenCalled();
      expect(failure.message).toBe(
        `This skill is linked to Library ${LIB} but the active Library is ${OTHER_LIB}.`,
      );
      expect(failure.agent_next_steps).toBe(
        "Select the Library this skill was linked in with 'dosu setup', or re-link with --force to bind it to the current Library.",
      );
      expect(failure.details).toEqual({ linked_library_id: LIB, active_library_id: OTHER_LIB });
    });

    it("fails with knowledge_store_missing when getBySpaceId returns null", async () => {
      script({ "knowledgeStore.getBySpaceId": () => null });

      const failure = expectFail(
        await resolveLinkedProcedure(client, baseInput()),
        "knowledge_store_missing",
      );

      expect(failure.message).toBe(
        "No knowledge store found for this Library. Run 'dosu setup' to reconfigure.",
      );
      expect(calledPaths()).toEqual(["knowledgeStore.getBySpaceId"]);
    });

    it("fails with library_mismatch when the page belongs to another knowledge store", async () => {
      scriptDocument([version(1, true)], { knowledge_store_id: OTHER_STORE });

      const failure = expectFail(
        await resolveLinkedProcedure(client, baseInput()),
        "library_mismatch",
      );

      expect(failure.message).toBe(
        `Document ${DOC} belongs to a different Library than the one this skill is linked to.`,
      );
      expect(failure.details).toEqual({
        linked_library_id: LIB,
        active_library_id: LIB,
        expected_knowledge_store_id: STORE,
        actual_knowledge_store_id: OTHER_STORE,
      });
    });
  });

  describe("page validation", () => {
    it("refuses an archived document", async () => {
      scriptDocument([version(1, true)], { archived: true });

      const failure = expectFail(
        await resolveLinkedProcedure(client, baseInput()),
        "document_archived",
      );

      expect(failure.message).toBe(`Document ${DOC} is archived.`);
      expect(failure.details).toBeUndefined();
    });

    it("refuses a null body", async () => {
      scriptDocument([version(1, true)], { body: null });

      const failure = expectFail(await resolveLinkedProcedure(client, baseInput()), "empty_body");

      expect(failure.message).toBe(`Revision 1 of document ${DOC} has an empty body.`);
      expect(failure.details).toEqual({ revision: 1 });
    });

    it("refuses a whitespace-only body", async () => {
      scriptDocument([version(1, true)], { body: "   \n\t " });

      expectFail(await resolveLinkedProcedure(client, baseInput()), "empty_body");
    });

    it("reports resolver_inconsistency when the returned version differs from the request", async () => {
      script({
        "knowledgeStore.getBySpaceId": () => store,
        "page.listVersions": () => [version(1, true), version(2, true)],
        "page.get": () => page({ version: 1, page_version_id: "pv-1" }),
      });

      const failure = expectFail(
        await resolveLinkedProcedure(client, baseInput()),
        "resolver_inconsistency",
      );

      expect(failure.message).toBe(
        `Requested revision 2 of document ${DOC} but received revision 1.`,
      );
      expect(failure.details).toEqual({ requested: 2, received: 1 });
    });
  });

  describe("size limit", () => {
    it("returns a body of exactly MAX_PROCEDURE_CHARS untouched", async () => {
      // Leading/trailing whitespace proves nothing is trimmed on the way out.
      const body = ` ${"x".repeat(MAX_PROCEDURE_CHARS - 2)} `;
      expect(body.length).toBe(MAX_PROCEDURE_CHARS);
      scriptDocument([version(1, true)], { body });

      const result = expectOk(await resolveLinkedProcedure(client, baseInput()));

      expect(result.body.length).toBe(MAX_PROCEDURE_CHARS);
      expect(result.body).toBe(body);
    });

    it("fails closed with procedure_too_large at MAX_PROCEDURE_CHARS + 1", async () => {
      const body = "x".repeat(MAX_PROCEDURE_CHARS + 1);
      scriptDocument([version(1, true)], { body });

      const failure = expectFail(
        await resolveLinkedProcedure(client, baseInput()),
        "procedure_too_large",
      );

      expect(failure.message).toBe(
        `The procedure is ${MAX_PROCEDURE_CHARS + 1} characters; the limit is ${MAX_PROCEDURE_CHARS}. Nothing was truncated.`,
      );
      expect(failure.agent_next_steps).toBe(
        "Ask the document owner to split or shorten the procedure, or link a smaller document.",
      );
      expect(failure.details).toEqual({
        actual: MAX_PROCEDURE_CHARS + 1,
        limit: MAX_PROCEDURE_CHARS,
      });
    });
  });

  describe("error mapping", () => {
    it("maps FORBIDDEN from page.get to access_denied", async () => {
      scriptDocument(
        [version(1, true)],
        {},
        {
          "page.get": () => {
            throw trpcError("FORBIDDEN");
          },
        },
      );

      const failure = expectFail(
        await resolveLinkedProcedure(client, baseInput()),
        "access_denied",
      );

      expect(failure.message).toBe(`Access to document ${DOC} was denied for the current account.`);
      expect(failure.agent_next_steps).toBe(
        "Log in with an account that belongs to this Library ('dosu login'), then retry.",
      );
    });

    it("maps UNAUTHORIZED from the knowledge store lookup to access_denied", async () => {
      script({
        "knowledgeStore.getBySpaceId": () => {
          throw trpcError("UNAUTHORIZED");
        },
      });

      expectFail(await resolveLinkedProcedure(client, baseInput()), "access_denied");
      expect(calledPaths()).toEqual(["knowledgeStore.getBySpaceId"]);
    });

    it("maps NOT_FOUND from listVersions to document_not_found", async () => {
      scriptDocument(
        [],
        {},
        {
          "page.listVersions": () => {
            throw trpcError("NOT_FOUND");
          },
        },
      );

      expectFail(await resolveLinkedProcedure(client, baseInput()), "document_not_found");
      expect(calledPaths()).not.toContain("page.get");
    });

    it("maps a TRPCClientError wrapping a fetch TypeError to network_error", async () => {
      scriptDocument(
        [version(1, true)],
        {},
        {
          "page.get": () => {
            throw trpcError(undefined, new TypeError("fetch failed"));
          },
        },
      );

      const failure = expectFail(
        await resolveLinkedProcedure(client, baseInput()),
        "network_error",
      );

      expect(failure.message).toBe(
        "The procedure could not be loaded; check your connection and retry.",
      );
      expect(failure.agent_next_steps).toBe(
        "Retry once the network is available. Do not proceed from memory.",
      );
    });

    it("maps a TRPCClientError with an unknown code to unexpected_error", async () => {
      scriptDocument(
        [version(1, true)],
        {},
        {
          "page.get": () => {
            throw trpcError("INTERNAL_SERVER_ERROR");
          },
        },
      );

      const failure = expectFail(
        await resolveLinkedProcedure(client, baseInput()),
        "unexpected_error",
      );

      expect(failure.message).toBe(
        `Unexpected error while resolving document ${DOC}: upstream failure`,
      );
      expect(failure.details).toEqual({ error: "upstream failure" });
    });

    it("maps a TRPCClientError with no envelope and no TypeError cause to unexpected_error", async () => {
      scriptDocument(
        [version(1, true)],
        {},
        {
          "page.get": () => {
            throw trpcError(undefined, new Error("socket hang up"));
          },
        },
      );

      expectFail(await resolveLinkedProcedure(client, baseInput()), "unexpected_error");
    });

    it("ignores a non-string code in error data", async () => {
      scriptDocument(
        [version(1, true)],
        {},
        {
          "page.get": () => {
            throw Object.assign(trpcError(), { data: { code: 403, httpStatus: 403 } });
          },
        },
      );

      expectFail(await resolveLinkedProcedure(client, baseInput()), "unexpected_error");
    });

    it("ignores null error data", async () => {
      scriptDocument(
        [version(1, true)],
        {},
        {
          "page.get": () => {
            throw Object.assign(trpcError(), { data: null });
          },
        },
      );

      expectFail(await resolveLinkedProcedure(client, baseInput()), "unexpected_error");
    });

    it("maps a bare TypeError to network_error", async () => {
      scriptDocument(
        [version(1, true)],
        {},
        {
          "page.get": () => {
            throw new TypeError("fetch failed");
          },
        },
      );

      expectFail(await resolveLinkedProcedure(client, baseInput()), "network_error");
    });

    it("maps an AbortError to network_error", async () => {
      scriptDocument(
        [version(1, true)],
        {},
        {
          "page.get": () => {
            throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
          },
        },
      );

      expectFail(await resolveLinkedProcedure(client, baseInput()), "network_error");
    });

    it("maps a plain Error to unexpected_error with its message", async () => {
      scriptDocument(
        [version(1, true)],
        {},
        {
          "page.get": () => {
            throw new Error("disk on fire");
          },
        },
      );

      const failure = expectFail(
        await resolveLinkedProcedure(client, baseInput()),
        "unexpected_error",
      );

      expect(failure.message).toBe(
        `Unexpected error while resolving document ${DOC}: disk on fire`,
      );
      expect(failure.details).toEqual({ error: "disk on fire" });
    });

    it("maps a thrown non-Error value to unexpected_error", async () => {
      scriptDocument(
        [version(1, true)],
        {},
        {
          "page.get": () => {
            throw "boom";
          },
        },
      );

      const failure = expectFail(
        await resolveLinkedProcedure(client, baseInput()),
        "unexpected_error",
      );

      expect(failure.details).toEqual({ error: "boom" });
    });
  });

  describe("clock", () => {
    it("stamps fetched_at with the wall clock when no clock is injected", async () => {
      scriptDocument([version(1, true)]);
      const before = Date.now();

      const result = expectOk(await resolveLinkedProcedure(client, baseInput({ now: undefined })));

      const fetchedAt = Date.parse(result.source.fetched_at);
      expect(fetchedAt).toBeGreaterThanOrEqual(before);
      expect(fetchedAt).toBeLessThanOrEqual(Date.now());
      expect(result.source.published).toBe(true);
      expect(result.source.updated_at).toBe(UPDATED_AT);
    });
  });
});
