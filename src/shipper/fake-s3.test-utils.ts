/** An in-memory S3 bucket behind a fetch, for the SDK's signed-fetch S3 client: path-style
 * `GET`/`PUT`/`HEAD`/`DELETE` of objects and `ListObjectsV2`, with an MD5 ETag as S3 reports
 * for a single-part PUT. `deny` answers 403 AccessDenied to every request. */

import { createHash } from "node:crypto";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface FakeS3 {
  fetch: Fetch;
  /** Keys inside the bucket, prefix included. */
  objects: Map<string, Uint8Array>;
  requests: { method: string; url: string; authorization: string | null }[];
  deny: boolean;
}

export function fakeS3(endpoint: string, bucket: string): FakeS3 {
  const objects = new Map<string, Uint8Array>();
  const requests: FakeS3["requests"] = [];
  const s3: FakeS3 = {
    objects,
    requests,
    deny: false,
    fetch: async (input, init) => {
      const method = init?.method ?? "GET";
      const authorization = new Headers(init?.headers).get("authorization");
      requests.push({ method, url: input, authorization });
      if (s3.deny || !authorization?.startsWith("AWS4-HMAC-SHA256 ")) {
        return new Response("<Error><Code>AccessDenied</Code><Message>denied</Message></Error>", {
          status: 403,
        });
      }
      const url = new URL(input);
      const base = `/${bucket}`;
      if (!input.startsWith(endpoint) || !url.pathname.startsWith(base)) {
        return new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 });
      }
      const key = decodeURIComponent(url.pathname.slice(base.length + 1));
      if (method === "GET" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const after = url.searchParams.get("start-after") ?? "";
        const max = Number(url.searchParams.get("max-keys") ?? 1000);
        const all = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
        const page = all.slice(0, max);
        const contents = page.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("");
        return new Response(
          `<ListBucketResult><IsTruncated>${all.length > max}</IsTruncated>${contents}</ListBucketResult>`,
        );
      }
      const body = objects.get(key);
      switch (method) {
        case "PUT": {
          const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
          objects.set(key, bytes);
          return new Response(null, {
            status: 200,
            headers: { etag: `"${createHash("md5").update(bytes).digest("hex")}"` },
          });
        }
        case "GET":
          return body ? new Response(new Uint8Array(body)) : new Response(null, { status: 404 });
        case "HEAD":
          return body
            ? new Response(null, {
                headers: {
                  etag: `"${createHash("md5").update(body).digest("hex")}"`,
                  "content-length": String(body.length),
                },
              })
            : new Response(null, { status: 404 });
        case "DELETE":
          objects.delete(key);
          return new Response(null, { status: 204 });
        default:
          return new Response(null, { status: 405 });
      }
    },
  };
  return s3;
}
