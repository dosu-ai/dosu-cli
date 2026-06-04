import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FAKE_ATTRIBUTION,
  fakeForcedStatus,
  fakeReadyDelayMs,
  fakeSaveRecommended,
  handleCreate,
  handlePoll,
  routeFake,
  startFakeTicketServer,
} from "./fake-server";

interface Rec {
  ticketId: string;
  createdAtMs: number;
  prompt: string;
}

describe("fake-server timing knobs", () => {
  let origDelay: string | undefined;
  let origStatus: string | undefined;

  beforeEach(() => {
    origDelay = process.env.DOSU_HOOK_READY_DELAY_MS;
    origStatus = process.env.DOSU_HOOK_FAKE_STATUS;
    delete process.env.DOSU_HOOK_READY_DELAY_MS;
    delete process.env.DOSU_HOOK_FAKE_STATUS;
  });
  afterEach(() => {
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore("DOSU_HOOK_READY_DELAY_MS", origDelay);
    restore("DOSU_HOOK_FAKE_STATUS", origStatus);
  });

  it("defaults the ready delay to 5000 and ignores garbage", () => {
    expect(fakeReadyDelayMs()).toBe(5000);
    process.env.DOSU_HOOK_READY_DELAY_MS = "nope";
    expect(fakeReadyDelayMs()).toBe(5000);
    process.env.DOSU_HOOK_READY_DELAY_MS = "0";
    expect(fakeReadyDelayMs()).toBe(0);
  });

  it("only recognizes known forced statuses", () => {
    expect(fakeForcedStatus()).toBeUndefined();
    process.env.DOSU_HOOK_FAKE_STATUS = "ready";
    expect(fakeForcedStatus()).toBe("ready");
    process.env.DOSU_HOOK_FAKE_STATUS = "bogus";
    expect(fakeForcedStatus()).toBeUndefined();
  });
});

describe("fake-server handlers", () => {
  let store: Map<string, Rec>;
  beforeEach(() => {
    store = new Map();
    delete process.env.DOSU_HOOK_READY_DELAY_MS;
    delete process.env.DOSU_HOOK_FAKE_STATUS;
  });

  it("handleCreate returns 202 pending and stores the record", () => {
    const res = handleCreate({ prompt: "hi" }, store, 1000);
    expect(res.status).toBe(202);
    const body = res.json as Record<string, unknown>;
    expect(body.status).toBe("pending");
    expect(typeof body.ticket_id).toBe("string");
    expect(store.size).toBe(1);
  });

  it("handlePoll 404s for an unknown ticket", () => {
    expect(handlePoll("missing", store, 1000).status).toBe(404);
  });

  it("handlePoll is pending before the delay and ready after", () => {
    process.env.DOSU_HOOK_READY_DELAY_MS = "5000";
    const created = handleCreate({ prompt: "x" }, store, 1000).json as { ticket_id: string };
    expect(handlePoll(created.ticket_id, store, 2000).status).toBe(202); // pending
    const ready = handlePoll(created.ticket_id, store, 7000); // 6000ms later
    expect(ready.status).toBe(200);
    const body = ready.json as { status: string; result: { attribution: string } };
    expect(body.status).toBe("ready");
    expect(body.result.attribution).toBe(FAKE_ATTRIBUTION);
  });

  it("handlePoll honors forced failed / expired statuses", () => {
    const created = handleCreate({ prompt: "x" }, store, 1000).json as { ticket_id: string };
    process.env.DOSU_HOOK_FAKE_STATUS = "failed";
    expect((handlePoll(created.ticket_id, store, 1000).json as { status: string }).status).toBe(
      "failed",
    );
    process.env.DOSU_HOOK_FAKE_STATUS = "expired";
    expect((handlePoll(created.ticket_id, store, 1000).json as { status: string }).status).toBe(
      "expired",
    );
  });

  it("routeFake dispatches create/poll and 404s unknown routes", () => {
    expect(routeFake("POST", "/v1/tickets/knowledge", { prompt: "p" }, store, 1).status).toBe(202);
    const id = [...store.keys()][0];
    expect(routeFake("GET", `/v1/tickets/knowledge/${id}`, null, store, 1).status).toBeLessThan(
      300,
    );
    expect(routeFake("GET", "/nope", null, store, 1).status).toBe(404);
  });

  it("flags save_recommended in the ready result when DOSU_HOOK_FAKE_SAVE=1", () => {
    expect(fakeSaveRecommended()).toBe(false);
    const created = handleCreate({ prompt: "x" }, store, 1000).json as { ticket_id: string };
    process.env.DOSU_HOOK_FAKE_STATUS = "ready";
    process.env.DOSU_HOOK_FAKE_SAVE = "1";
    expect(fakeSaveRecommended()).toBe(true);
    const body = handlePoll(created.ticket_id, store, 1000).json as {
      result: { save_recommended: boolean };
    };
    expect(body.result.save_recommended).toBe(true);
    delete process.env.DOSU_HOOK_FAKE_SAVE;
  });
});

describe("startFakeTicketServer (http)", () => {
  it("serves create + poll over HTTP", async () => {
    process.env.DOSU_HOOK_READY_DELAY_MS = "0";
    const srv = await startFakeTicketServer();
    try {
      const create = await fetch(`${srv.url}/v1/tickets/knowledge`, {
        method: "POST",
        body: JSON.stringify({ prompt: "hello" }),
      });
      expect(create.status).toBe(202);
      const { ticket_id } = (await create.json()) as { ticket_id: string };

      const poll = await fetch(`${srv.url}/v1/tickets/knowledge/${ticket_id}`);
      expect(poll.status).toBe(200);
      expect(((await poll.json()) as { status: string }).status).toBe("ready");

      const missing = await fetch(`${srv.url}/v1/tickets/knowledge/does-not-exist`);
      expect(missing.status).toBe(404);
    } finally {
      await srv.close();
      delete process.env.DOSU_HOOK_READY_DELAY_MS;
    }
  });
});
