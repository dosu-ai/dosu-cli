/** An in-memory S3 bucket behind a fetch, for the SDK's signed-fetch S3 client: path-style
 * `GET`/`PUT`/`HEAD`/`DELETE` of objects under `endpoint/bucket`, with an MD5 ETag as S3
 * reports for a single-part PUT. `deny` answers 403 AccessDenied to every request. */

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
      const method = init?.method as string;
      const authorization = new Headers(init?.headers).get("authorization");
      requests.push({ method, url: input, authorization });
      if (s3.deny) {
        return new Response("<Error><Code>AccessDenied</Code><Message>denied</Message></Error>", {
          status: 403,
        });
      }
      const key = decodeURIComponent(input.slice(`${endpoint}/${bucket}/`.length));
      const body = objects.get(key);
      const etag = (bytes: Uint8Array) => `"${createHash("md5").update(bytes).digest("hex")}"`;
      if (method === "PUT") {
        const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
        objects.set(key, bytes);
        return new Response(null, { headers: { etag: etag(bytes) } });
      }
      if (method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      if (!body) return new Response(null, { status: 404 });
      return method === "HEAD"
        ? new Response(null, {
            headers: { etag: etag(body), "content-length": String(body.length) },
          })
        : new Response(new Uint8Array(body));
    },
  };
  return s3;
}
