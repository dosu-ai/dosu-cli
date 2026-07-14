import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";

const postWithApiKey = vi.fn();
const getWithApiKey = vi.fn();

vi.mock("../client/client", () => ({
  Client: vi.fn(function () {
    return { postWithApiKey, getWithApiKey };
  }),
}));

import {
  isDefinitiveError,
  requestCreateTicket,
  requestGetTicket,
  TicketHttpError,
} from "./ticket-client";

const cfg: Config = makeTestConfig({ access_token: "at", refresh_token: "rt", expires_at: 0 });

function jsonResponse(status: number, body: unknown) {
  return { status, json: async () => body };
}

describe("hooks/ticket-client", () => {
  beforeEach(() => {
    postWithApiKey.mockReset();
    getWithApiKey.mockReset();
  });

  it("requestCreateTicket returns the parsed 202 body", async () => {
    postWithApiKey.mockResolvedValue(
      jsonResponse(202, { ticket_id: "t1", status: "pending", created_at: "x", expires_at: "y" }),
    );
    const res = await requestCreateTicket(cfg, {
      deployment_id: "d",
      agent: "claude-code",
      session_id: "s",
      prompt: "p",
    });
    expect(res.ticket_id).toBe("t1");
    expect(postWithApiKey).toHaveBeenCalledWith(
      "/v1/tickets/knowledge",
      expect.objectContaining({ prompt: "p" }),
    );
  });

  it("requestCreateTicket throws TicketHttpError on a non-2xx status", async () => {
    postWithApiKey.mockResolvedValue(jsonResponse(400, {}));
    await expect(
      requestCreateTicket(cfg, { deployment_id: "d", agent: "a", session_id: "s", prompt: "p" }),
    ).rejects.toBeInstanceOf(TicketHttpError);
  });

  it("requestGetTicket parses ready and pending", async () => {
    getWithApiKey.mockResolvedValueOnce(
      jsonResponse(200, {
        ticket_id: "t",
        status: "ready",
        created_at: "x",
        expires_at: "y",
        result: { context: "c", sources: [], attribution: "a" },
        error: null,
      }),
    );
    const ready = await requestGetTicket(cfg, "t");
    expect(ready.status).toBe("ready");
    expect(ready.result?.context).toBe("c");

    getWithApiKey.mockResolvedValueOnce(
      jsonResponse(202, { ticket_id: "t", status: "pending", result: null, error: null }),
    );
    expect((await requestGetTicket(cfg, "t")).status).toBe("pending");
  });

  it("requestGetTicket coerces an unknown status to failed", async () => {
    getWithApiKey.mockResolvedValue(
      jsonResponse(200, { ticket_id: "t", status: "weird", result: { context: "c" }, error: null }),
    );
    const res = await requestGetTicket(cfg, "t");
    expect(res.status).toBe("failed");
    expect(res.result).toBeNull();
  });

  it("requestGetTicket throws TicketHttpError for 404/5xx", async () => {
    getWithApiKey.mockResolvedValueOnce(jsonResponse(404, {}));
    await expect(requestGetTicket(cfg, "t")).rejects.toBeInstanceOf(TicketHttpError);
    getWithApiKey.mockResolvedValueOnce(jsonResponse(503, {}));
    await expect(requestGetTicket(cfg, "t")).rejects.toBeInstanceOf(TicketHttpError);
  });

  it("classifies transient vs definitive errors", () => {
    expect(isDefinitiveError(new TicketHttpError(404))).toBe(true);
    expect(isDefinitiveError(new TicketHttpError(400))).toBe(true);
    expect(isDefinitiveError(new TicketHttpError(500))).toBe(false);
    expect(isDefinitiveError(new TicketHttpError(429))).toBe(false);
    expect(isDefinitiveError(new Error("network"))).toBe(false);
  });
});
