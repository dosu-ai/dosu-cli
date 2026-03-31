import { afterEach, describe, expect, it } from "vitest";
import { type CallbackServer, startCallbackServer } from "./server";

describe("auth callback server", () => {
  let server: CallbackServer | null = null;

  afterEach(() => {
    if (server) {
      server.close();
      server = null;
    }
  });

  it("starts on a random port", async () => {
    const result = await startCallbackServer();
    server = result.server;
    expect(server.port).toBeGreaterThan(0);
    expect(server.port).toBeLessThan(65536);
  });

  it("returns friendly HTML for non-callback paths", async () => {
    const result = await startCallbackServer();
    server = result.server;
    const resp = await fetch(`http://localhost:${server.port}/other`);
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(resp.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("close this window");
  });

  it("serves extract HTML when no access_token in query", async () => {
    const result = await startCallbackServer();
    server = result.server;
    const resp = await fetch(`http://localhost:${server.port}/callback`);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("Completing authentication");
    expect(html).toContain("window.location.href");
  });

  it("returns token and serves success HTML when access_token is present", async () => {
    const result = await startCallbackServer();
    server = result.server;

    const resp = await fetch(
      `http://localhost:${server.port}/callback?access_token=tok123&refresh_token=ref456&expires_in=7200`,
    );
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("Authentication Successful");

    const token = await result.tokenPromise;
    expect(token.access_token).toBe("tok123");
    expect(token.refresh_token).toBe("ref456");
    expect(token.expires_in).toBe(7200);
  });

  it("defaults expires_in to 3600 when not provided", async () => {
    const result = await startCallbackServer();
    server = result.server;

    await fetch(`http://localhost:${server.port}/callback?access_token=tok`);
    const token = await result.tokenPromise;
    expect(token.expires_in).toBe(3600);
  });

  it("handles missing refresh_token", async () => {
    const result = await startCallbackServer();
    server = result.server;

    await fetch(`http://localhost:${server.port}/callback?access_token=tok`);
    const token = await result.tokenPromise;
    expect(token.refresh_token).toBe("");
  });

  it("returns a friendly HTML page for non-callback paths instead of plain text 404", async () => {
    const result = await startCallbackServer();
    server = result.server;

    // Browsers may hit /, /favicon.ico, or other paths.
    // These should show a friendly page, not a raw "Not Found" string.
    const resp = await fetch(`http://localhost:${server.port}/`);
    const body = await resp.text();

    expect(resp.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("close this window");
    expect(body).toContain("terminal");
  });

  it("browser receives complete success HTML when server closes immediately after token resolves", async () => {
    // This simulates exactly what flow.ts does:
    //   const token = await tokenPromise;  <-- token resolves
    //   } finally { server.close(); }      <-- server killed immediately
    //
    // The browser's HTTP response might be cut short if server.close()
    // terminates the connection before res.end() finishes flushing.

    const result = await startCallbackServer();
    server = result.server;
    const port = server.port;

    // Use raw TCP via http module to have full control over response reading.
    // fetch() may buffer internally, masking the issue.
    const http = require("node:http") as typeof import("node:http");

    const body = await new Promise<string>((resolve, reject) => {
      const req = http.get(
        `http://localhost:${port}/callback?access_token=tok&refresh_token=ref&expires_in=3600`,
        async (res) => {
          // As soon as tokenPromise resolves, kill the server (like flow.ts finally block)
          await result.tokenPromise;
          server!.close();
          server = null;

          // Now try to read the full response body — the connection may already be dead
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
          res.on("error", (err) => reject(err));
        },
      );
      req.on("error", reject);
    });

    expect(body).toContain("Authentication Successful");
    expect(body).toContain("You can safely close this window");
  });

  it("rejects new connections after server.close() is called", async () => {
    // After flow.ts calls server.close(), the browser might still request
    // /favicon.ico or the user might refresh. These new connections should fail.
    // This confirms server.close() does stop new requests.
    const result = await startCallbackServer();
    server = result.server;
    const port = server.port;

    // Complete the auth flow
    await fetch(`http://localhost:${port}/callback?access_token=tok&refresh_token=ref&expires_in=3600`);
    await result.tokenPromise;

    // Close the server (like flow.ts finally block)
    server.close();
    server = null;

    // Wait a tick for the server to fully stop accepting connections
    await new Promise((r) => setTimeout(r, 50));

    // A new request after close should fail (connection refused)
    try {
      await fetch(`http://localhost:${port}/favicon.ico`);
      // If we get here, the server is still accepting — that's unexpected
      expect.unreachable("Expected connection to be refused after server.close()");
    } catch (err: any) {
      // Connection refused is expected
      expect(err.message).toMatch(/ECONNREFUSED|fetch failed|ConnectionRefused/i);
    }
  });
});
