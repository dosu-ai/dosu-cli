/** A sessiondb, as the ship step sees it: it takes the raw transcript of a session, normalizes
 * and redacts it, decides whether it is worth keeping and how much of it is new, and writes the
 * owner's bucket. Its answer becomes the session's outcome in the sync ledger.
 *
 * The work is `@dosu-ai/sessiondb`'s: `createServerTarget` is its HTTP backend (the server runs
 * the pipeline against its bucket; this machine holds a token), and `createTarget` wraps any of
 * its clients, so a target over a bucket this machine writes directly is the same code. */

import {
  connect,
  type Fetch,
  isSource,
  OffsetMismatch,
  ServerError,
  type SessionDB,
  SessionRejected,
  type ShippedPrefix,
} from "@dosu-ai/sessiondb";
import { describeServerError } from "../sources/server-client";
import { VERSION } from "../version/version";

export type { ShippedPrefix };

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

/** Server statuses where re-sending the same bytes cannot succeed: the session is settled as
 * rejected instead of failing every run behind a poison pill. (A 422 arrives as the SDK's
 * `SessionRejected` already.) Everything else — auth, rate limit, 5xx, the owner's bucket down
 * (502) — is a failure that backs off and retries. */
const REJECTED_STATUSES = new Set([400, 413]);

/** Per-request cap; ship runs are already detached from the hook, so patience is cheap. */
const REQUEST_TIMEOUT_MS = 60_000;

/** `<code>: <message>`, or the message alone when the server gave no code. */
function detail(err: ServerError | OffsetMismatch): string {
  return err.code === "unknown" ? err.message : `${err.code}: ${err.message}`;
}

/** A target over any sessiondb client: a server, or a bucket this machine writes. */
function createTarget(db: SessionDB, options: { name: string; url: string }): Target {
  const url = options.url.replace(/\/$/, "");
  return {
    name: options.name,
    url,
    async send(input) {
      if (!isSource(input.agent)) {
        return { status: "rejected", message: `unsupported_source: ${input.agent}` };
      }
      try {
        const answer = await db.ingest({ ...input, agent: input.agent });
        const shipped = { records: answer.records_total, prefix_sha256: answer.prefix_sha256 };
        if (answer.status === "trivial") return { status: "trivial", shipped };
        return { status: "shipped", taskId: `${answer.status}:${answer.content_hash}`, shipped };
      } catch (err) {
        if (err instanceof SessionRejected) {
          return { status: "rejected", httpStatus: 422, message: `${err.code}: ${err.message}` };
        }
        if (err instanceof ServerError && REJECTED_STATUSES.has(err.status)) {
          return { status: "rejected", httpStatus: err.status, message: detail(err) };
        }
        if (err instanceof ServerError || err instanceof OffsetMismatch) {
          return { status: "failed", message: `server ${url}: ${detail(err)}` };
        }
        // A StoreError's message already names the server when it was never reached.
        const message = describeServerError(err);
        return {
          status: "failed",
          message: message.includes(url) ? message : `server ${url}: ${message}`,
        };
      }
    },
  };
}

export interface ServerTargetOptions {
  name: string;
  url: string;
  token: string;
  fetchImpl?: Fetch;
}

/** A sessiondb server as a target: the raw transcript goes to it with the owner's bearer token,
 * gzipped whatever its size. */
export function createServerTarget(options: ServerTargetOptions): Target {
  const db = connect({
    server: options.url,
    token: options.token,
    fetch: options.fetchImpl,
    gzipFrom: 0,
    timeoutMs: REQUEST_TIMEOUT_MS,
    userAgent: `dosu-cli/${VERSION}`,
  });
  return createTarget(db, { name: options.name, url: options.url });
}
