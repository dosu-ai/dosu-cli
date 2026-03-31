#!/usr/bin/env bun
/**
 * Mock backend for local testing of `dosu add`, `dosu sync`, and related commands.
 *
 * Stubs POST /v1/public-libraries. All other requests proxy to production.
 *
 * Usage:
 *   bun run scripts/mock-backend.ts
 *
 * Then in another terminal:
 *   DOSU_BACKEND_URL=http://localhost:7099 bun run dev add facebook/react
 *   DOSU_BACKEND_URL=http://localhost:7099 bun run dev sync facebook/react
 */

const PORT = Number(process.env.MOCK_PORT ?? 7099);
const UPSTREAM = "https://api.dosu.dev";

// In-memory store of added libraries
const libraries = new Map<string, { repo_slug: string; data_source_id: string }>();
let counter = 0;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;

    // POST /v1/public-libraries
    if (method === "POST" && url.pathname === "/v1/public-libraries") {
      const apiKey = req.headers.get("X-Dosu-API-Key");
      if (!apiKey) {
        return Response.json({ detail: "Missing API key" }, { status: 401 });
      }

      const body = (await req.json()) as { repo_slug: string };
      const existing = libraries.get(body.repo_slug);

      if (existing) {
        console.log(`[mock] ${body.repo_slug} already exists — sync re-triggered`);
        return Response.json({
          status: "already_exists",
          repo_slug: body.repo_slug,
          data_source_id: existing.data_source_id,
          deployment_id: "mock-dep",
          sync_triggered: true,
        });
      }

      counter++;
      const dsId = `mock-ds-${counter}`;
      libraries.set(body.repo_slug, { repo_slug: body.repo_slug, data_source_id: dsId });
      console.log(`[mock] created ${body.repo_slug} (${dsId})`);
      return Response.json(
        {
          status: "created",
          repo_slug: body.repo_slug,
          data_source_id: dsId,
          deployment_id: "mock-dep",
          sync_triggered: true,
        },
        { status: 201 },
      );
    }

    // Proxy everything else to production
    const upstream = `${UPSTREAM}${url.pathname}${url.search}`;
    const headers = new Headers(req.headers);
    headers.set("host", new URL(UPSTREAM).host);

    try {
      const proxyBody = method !== "GET" && method !== "HEAD" ? await req.blob() : undefined;
      const resp = await fetch(upstream, { method, headers, body: proxyBody });
      console.log(`[proxy] ${method} ${url.pathname} → ${resp.status}`);
      return new Response(resp.body, {
        status: resp.status,
        headers: resp.headers,
      });
    } catch (err) {
      console.error(`[proxy] error: ${err}`);
      return Response.json({ error: "proxy error" }, { status: 502 });
    }
  },
});

console.log(`Mock backend running on http://localhost:${server.port}`);
console.log(`Proxying non-stubbed routes to ${UPSTREAM}`);
console.log(`\nStubbed endpoints:`);
console.log(`  POST /v1/public-libraries → create/re-add library`);
console.log(`\nTest with:`);
console.log(`  DOSU_BACKEND_URL=http://localhost:${server.port} bun run dev add facebook/react`);
