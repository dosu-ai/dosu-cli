/** A sessiondb server, as the ship step sees it: it takes the raw transcript of a session with
 * the owner's bearer token, normalizes and redacts it, decides whether it is worth keeping and
 * how much of it is new, and writes the owner's bucket. Its answer becomes the session's outcome
 * in the sync ledger. */

import { gzipSync } from "node:zlib";
import { VERSION } from "../version/version";

/** What a client stores of a session it shipped, from the server's answer: how many normalized
 * records the session had and the sha256 of their canonical JSON. Sent back on the next upload
 * so only the session's tail is written. */
export interface ShippedPrefix {
  records: number;
  prefix_sha256: string;
}

/** What one session's upload came to. `shipped` and `trivial` are settled; `rejected` is
 * settled too (the same bytes can never succeed); `failed` stops the batch, backs off, and is
 * retried later. */
type TargetResult =
  | { status: "shipped"; taskId: string; shipped: ShippedPrefix }
  | { status: "trivial"; shipped: ShippedPrefix }
  | { status: "rejected"; httpStatus?: number; message: string }
  | { status: "failed"; message: string };

interface TargetSend {
  /** The trajectory source (`claude-code`, `codex`, …). */
  agent: string;
  session_id: string;
  transcript: string;
  format: "jsonl" | "json";
  project?: string;
  /** The client's best guess; the transcript's own record wins on the server. */
  branch?: string;
  parent_session_id?: string;
  /** A fork: the session whose history this log begins with. */
  fork_of?: string;
  /** What the last answer said, when this session shipped before. */
  shipped?: ShippedPrefix;
}

export interface Target {
  /** The configured name (`--target team`). */
  name: string;
  /** For messages. */
  url: string;
  send(input: TargetSend): Promise<TargetResult>;
}

/** Statuses where re-sending the same bytes cannot succeed: the session is settled as rejected
 * instead of failing every run behind a poison pill. Everything else — auth, rate limit, 5xx,
 * the owner's bucket down (502) — is a failure that backs off and retries. */
const REJECTED_STATUSES = new Set([400, 413, 422]);

/** Per-request cap; ship runs are already detached from the hook, so patience is cheap. */
const REQUEST_TIMEOUT_MS = 60_000;

interface ServerAnswer {
  status: "stored" | "duplicate" | "trivial";
  content_hash?: string;
  records_total: number;
  prefix_sha256: string;
}

interface ServerError {
  error?: { code?: string; message?: string };
}

export interface ServerTargetOptions {
  name: string;
  url: string;
  token: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export function createServerTarget(options: ServerTargetOptions): Target {
  const url = options.url.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    name: options.name,
    url,
    async send(input) {
      const body = gzipSync(Buffer.from(JSON.stringify(input)));
      try {
        const response = await fetchImpl(`${url}/v1/sessions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
            Authorization: `Bearer ${options.token}`,
            "User-Agent": `dosu-cli/${VERSION}`,
          },
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status === 200 || response.status === 201) {
          const answer = (await response.json()) as ServerAnswer;
          const shipped = { records: answer.records_total, prefix_sha256: answer.prefix_sha256 };
          if (answer.status === "trivial") return { status: "trivial", shipped };
          return { status: "shipped", taskId: `${answer.status}:${answer.content_hash}`, shipped };
        }
        const detail = (await response.json().catch(() => ({}))) as ServerError;
        const message = detail.error?.message
          ? `${detail.error.code ?? response.status}: ${detail.error.message}`
          : `HTTP ${response.status}`;
        if (REJECTED_STATUSES.has(response.status)) {
          return { status: "rejected", httpStatus: response.status, message };
        }
        return { status: "failed", message: `server ${url}: ${message}` };
      } catch (err) {
        return { status: "failed", message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
