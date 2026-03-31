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

  it("passes email through when provided", async () => {
    const result = await startCallbackServer();
    server = result.server;

    const resp = await fetch(
      `http://localhost:${server.port}/callback?access_token=tok123&refresh_token=ref456&expires_in=7200&email=user%40example.com`,
    );
    const html = await resp.text();
    expect(html).toContain("user@example.com");
    expect(html).toContain("Signed in as");

    const token = await result.tokenPromise;
    expect(token.email).toBe("user@example.com");
  });

  it("omits email line when email is not provided", async () => {
    const result = await startCallbackServer();
    server = result.server;

    const resp = await fetch(`http://localhost:${server.port}/callback?access_token=tok123`);
    const html = await resp.text();
    expect(html).not.toContain("Signed in as");
    expect(html).toContain("Authentication Successful");

    const token = await result.tokenPromise;
    expect(token.email).toBeUndefined();
  });

  it("escapes HTML in email to prevent XSS", async () => {
    const result = await startCallbackServer();
    server = result.server;

    const resp = await fetch(
      `http://localhost:${server.port}/callback?access_token=tok123&email=${encodeURIComponent("<script>alert(1)</script>")}`,
    );
    const html = await resp.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("extract page forwards email parameter", async () => {
    const result = await startCallbackServer();
    server = result.server;

    const resp = await fetch(`http://localhost:${server.port}/callback`);
    const html = await resp.text();
    expect(html).toContain("params.get('email')");
    expect(html).toContain("encodeURIComponent(email)");
  });

  it("success page includes Dosu logo SVG", async () => {
    const result = await startCallbackServer();
    server = result.server;

    const resp = await fetch(`http://localhost:${server.port}/callback?access_token=tok`);
    const html = await resp.text();
    expect(html).toContain('<svg width="52" height="54"');
    expect(html).toContain("viewBox");
  });

  it("success page includes 10s auto-close countdown", async () => {
    const result = await startCallbackServer();
    server = result.server;

    const resp = await fetch(`http://localhost:${server.port}/callback?access_token=tok`);
    const html = await resp.text();
    expect(html).toContain('id="countdown">10</span>');
    expect(html).toContain("window.close()");
  });

  it("success page card is clickable to close", async () => {
    const result = await startCallbackServer();
    server = result.server;

    const resp = await fetch(`http://localhost:${server.port}/callback?access_token=tok`);
    const html = await resp.text();
    expect(html).toContain('class="card" onclick="window.close()"');
    expect(html).toContain("cursor: pointer");
  });

  it("email is rendered bold in success page", async () => {
    const result = await startCallbackServer();
    server = result.server;

    const resp = await fetch(
      `http://localhost:${server.port}/callback?access_token=tok&email=test%40dosu.dev`,
    );
    const html = await resp.text();
    expect(html).toContain("<strong>test@dosu.dev</strong>");
  });

  it("treats literal string 'null' in refresh_token as empty", async () => {
    const result = await startCallbackServer();
    server = result.server;

    // Simulates what happens when browser JS does encodeURIComponent(null)
    // which produces the literal string "null" in the URL
    await fetch(`http://localhost:${server.port}/callback?access_token=tok&refresh_token=null`);
    const token = await result.tokenPromise;

    // Should normalize "null" to empty string, not store literal "null"
    expect(token.refresh_token).toBe("");
  });
});
