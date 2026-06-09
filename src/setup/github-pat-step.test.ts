import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../debug/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    init: vi.fn(),
    getLogPath: vi.fn(() => "/tmp/test-debug.log"),
  },
}));

import type { Client } from "../client/client";
import {
  findExistingGithubDataSource,
  patStorageFailureMessage,
  type StorePatResult,
  storePat,
} from "./github-pat-step";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function abortError(): Error {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

describe("storePat", () => {
  let doRequest: ReturnType<typeof vi.fn>;
  let client: Pick<Client, "doRequest">;

  beforeEach(() => {
    doRequest = vi.fn();
    client = { doRequest } as unknown as Pick<Client, "doRequest">;
  });

  it("returns ok on 200 first try", async () => {
    doRequest.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const result = await storePat(client as Client, "ds-1", "ghp_x", {
      baseBackoffMs: 0,
    });
    expect(result).toEqual<StorePatResult>({ ok: true, status: 200, reason: "ok" });
    expect(doRequest).toHaveBeenCalledTimes(1);
  });

  it("passes the long timeout to doRequest", async () => {
    doRequest.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await storePat(client as Client, "ds-1", "ghp_x", { baseBackoffMs: 0 });
    const [, , , opts] = doRequest.mock.calls[0];
    expect(opts).toEqual({ timeoutMs: 60_000 });
  });

  it("retries on 403 then succeeds", async () => {
    doRequest
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const result = await storePat(client as Client, "ds-1", "ghp_x", {
      baseBackoffMs: 0,
    });
    expect(result.ok).toBe(true);
    expect(doRequest).toHaveBeenCalledTimes(2);
  });

  it("retries on 404 then succeeds", async () => {
    doRequest
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const result = await storePat(client as Client, "ds-1", "ghp_x", {
      baseBackoffMs: 0,
    });
    expect(result.ok).toBe(true);
    expect(doRequest).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts on persistent 403", async () => {
    doRequest.mockResolvedValue(new Response("forbidden", { status: 403 }));
    const result = await storePat(client as Client, "ds-1", "ghp_x", {
      baseBackoffMs: 0,
    });
    expect(result).toMatchObject({ ok: false, status: 403, reason: "permission" });
    expect(doRequest).toHaveBeenCalledTimes(3);
  });

  it("does not retry on 422 — validation errors are user-visible immediately", async () => {
    doRequest.mockResolvedValueOnce(new Response("bad pat", { status: 422 }));
    const result = await storePat(client as Client, "ds-1", "ghp_x", {
      baseBackoffMs: 0,
    });
    expect(result).toMatchObject({ ok: false, status: 422, reason: "validation" });
    expect(doRequest).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 500 — server failure surfaces as 'server'", async () => {
    doRequest.mockResolvedValueOnce(new Response("oops", { status: 500 }));
    const result = await storePat(client as Client, "ds-1", "ghp_x", {
      baseBackoffMs: 0,
    });
    expect(result).toMatchObject({ ok: false, status: 500, reason: "server" });
    expect(doRequest).toHaveBeenCalledTimes(1);
  });

  it("classifies 503 as 'unavailable' and extracts FastAPI detail", async () => {
    doRequest.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "KMS reauth needed" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await storePat(client as Client, "ds-1", "ghp_x", {
      baseBackoffMs: 0,
    });
    expect(result).toMatchObject({
      ok: false,
      status: 503,
      reason: "unavailable",
      detail: "KMS reauth needed",
    });
    expect(doRequest).toHaveBeenCalledTimes(1);
  });

  it("leaves detail undefined when the error body is not JSON", async () => {
    doRequest.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));
    const result = await storePat(client as Client, "ds-1", "ghp_x", {
      baseBackoffMs: 0,
    });
    expect(result.detail).toBeUndefined();
  });

  it("classifies AbortError as timeout after exhausting attempts", async () => {
    doRequest.mockRejectedValue(abortError());
    const result = await storePat(client as Client, "ds-1", "ghp_x", {
      baseBackoffMs: 0,
    });
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(doRequest).toHaveBeenCalledTimes(3);
  });

  it("classifies non-abort throws as network errors", async () => {
    doRequest.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const result = await storePat(client as Client, "ds-1", "ghp_x", {
      baseBackoffMs: 0,
    });
    expect(result).toMatchObject({ ok: false, reason: "network" });
    expect(doRequest).toHaveBeenCalledTimes(3);
  });

  it("succeeds on retry after transient AbortError", async () => {
    doRequest
      .mockRejectedValueOnce(abortError())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const result = await storePat(client as Client, "ds-1", "ghp_x", {
      baseBackoffMs: 0,
    });
    expect(result.ok).toBe(true);
    expect(doRequest).toHaveBeenCalledTimes(2);
  });

  it("honors maxAttempts override of 1 (no retry)", async () => {
    doRequest.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    const result = await storePat(client as Client, "ds-1", "ghp_x", {
      baseBackoffMs: 0,
      maxAttempts: 1,
    });
    expect(result.ok).toBe(false);
    expect(doRequest).toHaveBeenCalledTimes(1);
  });
});

describe("patStorageFailureMessage", () => {
  it("timeout mentions the 60s budget and the rerun command", () => {
    const msg = patStorageFailureMessage({ ok: false, status: null, reason: "timeout" });
    expect(msg).toContain("timed out");
    expect(msg).toContain("dosu setup");
    expect(msg).toContain("dosu logs --tail 30");
  });

  it("permission mentions 403 and the rerun command", () => {
    const msg = patStorageFailureMessage({ ok: false, status: 403, reason: "permission" });
    expect(msg).toContain("403");
    expect(msg).toContain("dosu setup");
  });

  it("validation tells the user to regenerate the PAT, not just rerun", () => {
    const msg = patStorageFailureMessage({ ok: false, status: 422, reason: "validation" });
    expect(msg).toContain("Generate a new PAT");
    expect(msg).toContain("repo");
  });

  it("not_found mentions visibility and the rerun command", () => {
    const msg = patStorageFailureMessage({ ok: false, status: 404, reason: "not_found" });
    expect(msg).toContain("404");
    expect(msg).toContain("dosu setup");
  });

  it("network mentions the network error and recovery", () => {
    const msg = patStorageFailureMessage({ ok: false, status: null, reason: "network" });
    expect(msg).toContain("network");
    expect(msg).toContain("dosu setup");
  });

  it("server falls back to the generic recovery line with status", () => {
    const msg = patStorageFailureMessage({ ok: false, status: 500, reason: "server" });
    expect(msg).toContain("500");
    expect(msg).toContain("dosu setup");
  });

  it("unavailable surfaces the backend detail when present", () => {
    const msg = patStorageFailureMessage({
      ok: false,
      status: 503,
      reason: "unavailable",
      detail: "KMS reauth needed — run gcloud auth application-default login",
    });
    expect(msg).toContain("KMS reauth needed");
  });

  it("unavailable without detail still gives a recoverable message", () => {
    const msg = patStorageFailureMessage({ ok: false, status: 503, reason: "unavailable" });
    expect(msg).toContain("503");
    expect(msg).toContain("dosu setup");
  });

  it("server surfaces detail when present even on generic 500-class errors", () => {
    const msg = patStorageFailureMessage({
      ok: false,
      status: 500,
      reason: "server",
      detail: "database connection refused",
    });
    expect(msg).toContain("database connection refused");
  });
});

describe("findExistingGithubDataSource", () => {
  function makeTrpc(
    sources: Array<{ data_source_id?: string; provider_slug?: string; repository_id?: number }>,
    spaceDeployments: Array<{ deployment_id: string }> = [{ deployment_id: "dep-1" }],
  ) {
    return {
      dataSource: { list: { query: vi.fn().mockResolvedValue(sources) } },
      workspaces: { listForSpace: { query: vi.fn().mockResolvedValue(spaceDeployments) } },
    };
  }

  it("returns the existing GitHub data source matching repository_id", async () => {
    const trpc = makeTrpc([
      { data_source_id: "ds-slack", provider_slug: "slack", repository_id: undefined },
      { data_source_id: "ds-gh", provider_slug: "github", repository_id: 12345 },
    ]);
    const result = await findExistingGithubDataSource(trpc, "org-1", "space-1", 12345);
    expect(result).toEqual({ data_source_id: "ds-gh", deployment_id: "dep-1" });
  });

  it("returns null when no data source matches the repo id", async () => {
    const trpc = makeTrpc([
      { data_source_id: "ds-gh", provider_slug: "github", repository_id: 99999 },
    ]);
    const result = await findExistingGithubDataSource(trpc, "org-1", "space-1", 12345);
    expect(result).toBeNull();
  });

  it("returns null when the matching data source has no deployment", async () => {
    const trpc = makeTrpc(
      [{ data_source_id: "ds-gh", provider_slug: "github", repository_id: 12345 }],
      [],
    );
    const result = await findExistingGithubDataSource(trpc, "org-1", "space-1", 12345);
    expect(result).toBeNull();
  });

  it("returns null on tRPC errors instead of throwing", async () => {
    const trpc = {
      dataSource: { list: { query: vi.fn().mockRejectedValue(new Error("network")) } },
      workspaces: { listForSpace: { query: vi.fn() } },
    };
    const result = await findExistingGithubDataSource(trpc, "org-1", "space-1", 12345);
    expect(result).toBeNull();
  });

  it("coerces stringified repository_id to number when filtering", async () => {
    // Backend's vw_data_source view may return repository_id as a stringified bigint.
    const trpc = makeTrpc([
      {
        data_source_id: "ds-gh",
        provider_slug: "github",
        repository_id: "12345" as unknown as number,
      },
    ]);
    const result = await findExistingGithubDataSource(trpc, "org-1", "space-1", 12345);
    expect(result?.data_source_id).toBe("ds-gh");
  });
});

// Suppress unused import warning — jsonResponse is reserved for future test cases
// that need richer JSON bodies. Vitest's TS config will flag it otherwise.
void jsonResponse;
