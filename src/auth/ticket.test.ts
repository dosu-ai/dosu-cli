import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetWebAppURL, mockGetBackendURL } = vi.hoisted(() => ({
  mockGetWebAppURL: vi.fn(() => "https://app.dosu.dev"),
  mockGetBackendURL: vi.fn(() => "https://api.dosu.dev"),
}));

vi.mock("../config/constants", () => ({
  getWebAppURL: mockGetWebAppURL,
  getBackendURL: mockGetBackendURL,
}));

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

import { getConfigDir } from "../config/config";
import { buildTicketAuthURL, exchangeTicket, mintTicket } from "./ticket";

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The parsed JSON body of the `index`th fetch call. */
function sentBody(mockFetch: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  const init = mockFetch.mock.calls[index]?.[1] as RequestInit;
  return JSON.parse(init.body as string);
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("buildTicketAuthURL", () => {
  it("builds an /cli/auth URL with the ticket as a query param", () => {
    expect(buildTicketAuthURL("abc-123")).toBe("https://app.dosu.dev/cli/auth?ticket=abc-123");
  });

  it("encodes special characters in the ticket", () => {
    expect(buildTicketAuthURL("a/b c")).toBe("https://app.dosu.dev/cli/auth?ticket=a%2Fb+c");
  });
});

describe("mintTicket", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the S256 challenge of a new verifier and returns the user code", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ ticket: "tkt-1", expires_in: 600, user_code: "BCDF-GHJK" }, 201),
    );

    const minted = await mintTicket();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.dosu.dev/v1/cli/auth/tickets",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = sentBody(mockFetch, 0);
    expect(body.code_challenge_method).toBe("S256");
    expect(body.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(minted).toEqual({
      ticket: "tkt-1",
      expires_in: 600,
      url: "https://app.dosu.dev/cli/auth?ticket=tkt-1",
      user_code: "BCDF-GHJK",
    });
  });

  it("sends a different challenge for every ticket", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ ticket: "tkt-a", expires_in: 600 }, 201))
      .mockResolvedValueOnce(jsonResponse({ ticket: "tkt-b", expires_in: 600 }, 201));

    await mintTicket();
    await mintTicket();

    expect(sentBody(mockFetch, 0).code_challenge).not.toBe(sentBody(mockFetch, 1).code_challenge);
  });

  it("works with a backend that returns no user code", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ticket: "tkt-old", expires_in: 600 }, 201));

    const minted = await mintTicket();

    expect(minted.ticket).toBe("tkt-old");
    expect(minted.user_code).toBeUndefined();
  });

  it("accepts a 200 response as well", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ticket: "tkt-2", expires_in: 600 }), {
        status: 200,
      }),
    );

    const minted = await mintTicket();
    expect(minted.ticket).toBe("tkt-2");
  });

  it("throws when the backend responds with an error status", async () => {
    mockFetch.mockResolvedValue(
      new Response("internal error", {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    await expect(mintTicket()).rejects.toThrow(/failed to mint ticket/);
  });

  it("reports the backend's detail when it refuses the ticket", async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ detail: "code_challenge_method must be S256" }, 400),
    );

    await expect(mintTicket()).rejects.toThrow(
      "failed to mint ticket (status 400): code_challenge_method must be S256",
    );
  });
});

describe("exchangeTicket", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Mint `ticket` through the real mint path; returns the challenge the backend received. */
  async function mintAs(ticket: string): Promise<string> {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ ticket, expires_in: 600, user_code: "BCDF-GHJK" }, 201),
    );
    await mintTicket();
    return sentBody(mockFetch, mockFetch.mock.calls.length - 1).code_challenge as string;
  }

  it("POSTs the ticket's verifier to /v1/cli/auth/tickets/<ticket>/exchange", async () => {
    const challenge = await mintAs("abc 123");
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "pending" }));

    const result = await exchangeTicket("abc 123");

    expect(mockFetch).toHaveBeenLastCalledWith(
      "https://api.dosu.dev/v1/cli/auth/tickets/abc%20123/exchange",
      expect.objectContaining({ method: "POST" }),
    );
    expect(s256(sentBody(mockFetch, 1).code_verifier as string)).toBe(challenge);
    expect(result.status).toBe("pending");
  });

  it("redeems from a later process with the verifier saved at mint", async () => {
    const challenge = await mintAs("tkt-later");
    vi.resetModules();
    const { exchangeTicket: exchangeInLaterProcess } = await import("./ticket");
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ status: "authenticated", access_token: "tok", refresh_token: "ref" }),
    );

    const result = await exchangeInLaterProcess("tkt-later");

    expect(result.status).toBe("authenticated");
    expect(s256(sentBody(mockFetch, 1).code_verifier as string)).toBe(challenge);
  });

  it("treats a ticket minted elsewhere as expired without calling the backend", async () => {
    const result = await exchangeTicket("someone-elses-ticket");

    expect(result).toEqual({ status: "expired" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns authenticated tokens once, then treats a replay as expired", async () => {
    await mintAs("good");
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        status: "authenticated",
        access_token: "tok",
        refresh_token: "ref",
        expires_in: 1800,
        email: "user@example.com",
      }),
    );

    const result = await exchangeTicket("good");

    expect(result).toEqual({
      status: "authenticated",
      access_token: "tok",
      refresh_token: "ref",
      expires_in: 1800,
      email: "user@example.com",
    });
    expect(await exchangeTicket("good")).toEqual({ status: "expired" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the verifier while sign-in is pending", async () => {
    await mintAs("waiting");
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ status: "pending" }))
      .mockResolvedValueOnce(jsonResponse({ status: "authenticated", access_token: "tok" }));

    expect((await exchangeTicket("waiting")).status).toBe("pending");
    expect((await exchangeTicket("waiting")).status).toBe("authenticated");
  });

  it("returns expired when backend reports the ticket is gone, and stops asking", async () => {
    await mintAs("missing");
    mockFetch.mockResolvedValueOnce(jsonResponse({ status: "expired" }));

    const result = await exchangeTicket("missing");
    expect(result.status).toBe("expired");
    expect(result.access_token).toBeUndefined();

    await exchangeTicket("missing");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws the backend's detail when it rejects the verifier, and stops asking", async () => {
    await mintAs("rejected");
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          detail:
            "Login verification failed. This login request has been cancelled; run `dosu login` again.",
        },
        400,
      ),
    );

    await expect(exchangeTicket("rejected")).rejects.toThrow(
      "ticket exchange failed (status 400): Login verification failed.",
    );
    expect(await exchangeTicket("rejected")).toEqual({ status: "expired" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the verifier after a server error so a retry can still redeem", async () => {
    await mintAs("flaky");
    mockFetch
      .mockResolvedValueOnce(new Response("boom", { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ status: "pending" }));

    await expect(exchangeTicket("flaky")).rejects.toThrow(
      "ticket exchange failed (status 502): boom",
    );
    expect((await exchangeTicket("flaky")).status).toBe("pending");
  });

  it("normalizes nulls in the response payload to undefined", async () => {
    await mintAs("partial");
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        status: "authenticated",
        access_token: "tok",
        refresh_token: null,
        expires_in: null,
        email: null,
      }),
    );

    const result = await exchangeTicket("partial");
    expect(result.refresh_token).toBeUndefined();
    expect(result.expires_in).toBeUndefined();
    expect(result.email).toBeUndefined();
  });

  it("stores the verifier owner-only and never next to its ticket", async () => {
    await mintAs("tkt-on-disk");

    const files = filesUnder(getConfigDir());
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file).not.toContain("tkt-on-disk");
      expect(readFileSync(file, "utf8")).not.toContain("tkt-on-disk");
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("drops the verifiers of logins that expired unfinished", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T00:00:00Z"));
    await mintAs("abandoned");
    vi.setSystemTime(new Date("2026-11-09T00:11:00Z"));
    await mintAs("fresh");

    expect(await exchangeTicket("abandoned")).toEqual({ status: "expired" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
