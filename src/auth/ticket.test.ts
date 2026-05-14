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

import { buildTicketAuthURL, exchangeTicket, mintTicket } from "./ticket";

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

  it("POSTs to /v1/cli/auth/tickets and returns ticket + url", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ticket: "tkt-1", expires_in: 600 }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const minted = await mintTicket();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.dosu.dev/v1/cli/auth/tickets",
      expect.objectContaining({ method: "POST" }),
    );
    expect(minted).toEqual({
      ticket: "tkt-1",
      expires_in: 600,
      url: "https://app.dosu.dev/cli/auth?ticket=tkt-1",
    });
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
});

describe("exchangeTicket", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /v1/cli/auth/tickets/<ticket>/exchange", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ status: "pending" }), { status: 200 }),
    );

    const result = await exchangeTicket("abc 123");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.dosu.dev/v1/cli/auth/tickets/abc%20123/exchange",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.status).toBe("pending");
  });

  it("returns authenticated tokens when the backend has them", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "authenticated",
          access_token: "tok",
          refresh_token: "ref",
          expires_in: 1800,
          email: "user@example.com",
        }),
        { status: 200 },
      ),
    );

    const result = await exchangeTicket("good");

    expect(result).toEqual({
      status: "authenticated",
      access_token: "tok",
      refresh_token: "ref",
      expires_in: 1800,
      email: "user@example.com",
    });
  });

  it("returns expired when backend reports the ticket is gone", async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ status: "expired" }), { status: 200 }),
    );

    const result = await exchangeTicket("missing");
    expect(result.status).toBe("expired");
    expect(result.access_token).toBeUndefined();
  });

  it("throws when the backend returns a non-200 status", async () => {
    mockFetch.mockResolvedValue(new Response("boom", { status: 502 }));

    await expect(exchangeTicket("any")).rejects.toThrow(/ticket exchange failed/);
  });

  it("normalizes nulls in the response payload to undefined", async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "authenticated",
          access_token: "tok",
          refresh_token: null,
          expires_in: null,
          email: null,
        }),
        { status: 200 },
      ),
    );

    const result = await exchangeTicket("partial");
    expect(result.refresh_token).toBeUndefined();
    expect(result.expires_in).toBeUndefined();
    expect(result.email).toBeUndefined();
  });
});
