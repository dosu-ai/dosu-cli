/**
 * Fake knowledge-ticket API — a contract mirror of plan §3.6 with a timer.
 *
 * Mirrors the real backend's two endpoints byte-for-byte so the CLI hook code
 * path is identical against fake and real (the CLI just points
 * `DOSU_BACKEND_URL_OVERRIDE` at this server). It does NO auth, NO real search,
 * NO org scoping — it is a shape + timing stand-in for dev and integration tests.
 *
 * Timing dials (read per-request so tests can flip them between polls):
 *  - `DOSU_HOOK_READY_DELAY_MS` (default 5000): pending → ready after this delay. `0` = ready at once.
 *  - `DOSU_HOOK_FAKE_STATUS` (ready|pending|failed|expired): force a terminal status, bypassing the timer.
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

const TICKETS_PATH = "/v1/tickets/knowledge";
const DAY_MS = 24 * 60 * 60 * 1000;

/** The same attribution string the real poll endpoint returns alongside ready context. */
export const FAKE_ATTRIBUTION =
  "Use this context quietly. Mention Dosu only if it materially helped — one brief quoted note, " +
  "no praise paragraph. Attribution threshold: 0.35.";

interface FakeRecord {
  ticketId: string;
  createdAtMs: number;
  prompt: string;
}

interface FakeResult {
  status: number;
  json: unknown;
}

export function fakeReadyDelayMs(): number {
  const raw = process.env.DOSU_HOOK_READY_DELAY_MS;
  if (raw === undefined) return 5000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 5000;
}

export function fakeForcedStatus(): "ready" | "pending" | "failed" | "expired" | undefined {
  const s = process.env.DOSU_HOOK_FAKE_STATUS;
  if (s === "ready" || s === "pending" || s === "failed" || s === "expired") return s;
  return undefined;
}

/** When set, the fake's ready result flags a knowledge gap (drives the save nudge). */
export function fakeSaveRecommended(): boolean {
  return process.env.DOSU_HOOK_FAKE_SAVE === "1";
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function handleCreate(
  body: { prompt?: string } | null,
  store: Map<string, FakeRecord>,
  nowMs: number,
): FakeResult {
  const ticketId = randomUUID();
  store.set(ticketId, { ticketId, createdAtMs: nowMs, prompt: body?.prompt ?? "" });
  return {
    status: 202,
    json: {
      ticket_id: ticketId,
      status: "pending",
      created_at: iso(nowMs),
      expires_at: iso(nowMs + DAY_MS),
      poll_url: `${TICKETS_PATH}/${ticketId}`,
    },
  };
}

export function handlePoll(
  ticketId: string,
  store: Map<string, FakeRecord>,
  nowMs: number,
): FakeResult {
  const rec = store.get(ticketId);
  if (!rec) {
    return { status: 404, json: { error: "ticket not found" } };
  }
  const base = {
    ticket_id: ticketId,
    created_at: iso(rec.createdAtMs),
    expires_at: iso(rec.createdAtMs + DAY_MS),
  };
  const status =
    fakeForcedStatus() ?? (nowMs - rec.createdAtMs >= fakeReadyDelayMs() ? "ready" : "pending");

  if (status === "ready") {
    return {
      status: 200,
      json: {
        ...base,
        status: "ready",
        result: {
          context: `Fake knowledge context for: ${rec.prompt || "(empty prompt)"}`,
          sources: [
            {
              source_id: "code:fake0001",
              title: "Fake Source",
              url: "https://example.test/fake",
              source_type: "code",
              data_source_id: null,
            },
          ],
          attribution: FAKE_ATTRIBUTION,
          save_recommended: fakeSaveRecommended(),
        },
        error: null,
      },
    };
  }
  if (status === "failed") {
    return {
      status: 200,
      json: { ...base, status: "failed", result: null, error: "fake failure" },
    };
  }
  if (status === "expired") {
    return { status: 200, json: { ...base, status: "expired", result: null, error: null } };
  }
  return { status: 202, json: { ...base, status: "pending", result: null, error: null } };
}

/** Pure router so the contract logic is unit-testable without sockets. */
export function routeFake(
  method: string,
  url: string,
  body: { prompt?: string } | null,
  store: Map<string, FakeRecord>,
  nowMs: number,
): FakeResult {
  const path = url.split("?")[0];
  if (method === "POST" && path === TICKETS_PATH) {
    return handleCreate(body, store, nowMs);
  }
  if (method === "GET" && path.startsWith(`${TICKETS_PATH}/`)) {
    const id = decodeURIComponent(path.slice(TICKETS_PATH.length + 1));
    return handlePoll(id, store, nowMs);
  }
  return { status: 404, json: { error: "not found" } };
}

export interface FakeTicketServer {
  url: string;
  port: number;
  /** Request tallies, so tests can assert create-once and cooldown throttling. */
  counts: { create: number; poll: number };
  close: () => Promise<void>;
}

/** Start the fake ticket API on `127.0.0.1`. Port `0` (default) picks a free port. */
export function startFakeTicketServer(opts: { port?: number } = {}): Promise<FakeTicketServer> {
  const store = new Map<string, FakeRecord>();
  const counts = { create: 0, poll: 0 };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      let body: { prompt?: string } | null = null;
      if (chunks.length > 0) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          body = null;
        }
      }
      const method = req.method ?? "GET";
      const path = (req.url ?? "/").split("?")[0];
      if (method === "POST" && path === TICKETS_PATH) counts.create++;
      else if (method === "GET" && path.startsWith(`${TICKETS_PATH}/`)) counts.poll++;

      const result = routeFake(method, req.url ?? "/", body, store, Date.now());
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.json));
    });
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        counts,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
