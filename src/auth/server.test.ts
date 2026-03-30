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

  it("returns 404 for non-callback paths", async () => {
    const result = await startCallbackServer();
    server = result.server;
    const resp = await fetch(`http://localhost:${server.port}/other`);
    expect(resp.status).toBe(404);
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
});
