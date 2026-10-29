/** A sessiondb server for tests, behind a `fetch`: it answers `POST /v1/sessions` the way the
 * real one does, with a toy normalizer (one record per non-empty transcript line) so the
 * continuation and worthiness answers are consistent across uploads. */

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { vi } from "vitest";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Upload {
  agent: string;
  session_id: string;
  transcript: string;
  format: "jsonl" | "json";
  project?: string;
  branch?: string;
  parent_session_id?: string;
  fork_of?: string;
  shipped?: { records: number; prefix_sha256: string };
}

/** The server's worthiness floor: fewer characters than this is a greeting. */
const MIN_CHARS = 2000;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function prefixHash(lines: string[], n: number): string {
  return sha256(lines.slice(0, n).join("\n"));
}

/** The upload a request to the server target carries (its body is gzipped JSON). */
export function uploadOf(init: RequestInit | undefined): Upload {
  const body = init?.body;
  if (body instanceof Uint8Array) return JSON.parse(gunzipSync(Buffer.from(body)).toString());
  return JSON.parse(body as string);
}

export function fakeSessiondb() {
  const uploads: Upload[] = [];
  /** The server's answer to one request; tests that fail some uploads call it for the rest. */
  const handle: Fetch = async (input, init) => {
    if (!input.endsWith("/v1/sessions") || init?.method !== "POST") {
      return new Response(JSON.stringify({ error: { code: "not_found", message: input } }), {
        status: 404,
      });
    }
    const upload = uploadOf(init);
    uploads.push(upload);
    const lines = upload.transcript.split("\n").filter((line) => line.trim() !== "");
    const whole = { records_total: lines.length, prefix_sha256: prefixHash(lines, lines.length) };
    const shipped = upload.shipped;
    const resumed =
      shipped !== undefined &&
      shipped.records <= lines.length &&
      prefixHash(lines, shipped.records) === shipped.prefix_sha256;
    const fresh = resumed ? lines.slice(shipped.records) : lines;
    if (fresh.join("").length < MIN_CHARS) {
      return new Response(JSON.stringify({ status: "trivial", ...whole }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        status: "stored",
        content_hash: sha256(fresh.join("\n")),
        session_id: upload.session_id,
        records: fresh.length,
        events: fresh.length,
        ...whole,
        raw: { status: "stored", part: 0 },
      }),
      { status: 201 },
    );
  };
  const fetchImpl = vi.fn<Fetch>(handle);
  return { fetchImpl, uploads, handle };
}
