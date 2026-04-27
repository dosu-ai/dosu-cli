import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type InstallationCallbackServer,
  startInstallationCallbackServer,
} from "./installation-server";

vi.mock("../debug/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    init: vi.fn(),
    getLogPath: vi.fn(() => "/tmp/test-debug.log"),
  },
}));

describe("installation callback server", () => {
  let server: InstallationCallbackServer | null = null;

  afterEach(() => {
    if (server) {
      server.close();
      server = null;
    }
  });

  it("starts on a random port", async () => {
    const result = await startInstallationCallbackServer();
    server = result.server;
    expect(server.port).toBeGreaterThan(0);
    expect(server.port).toBeLessThan(65536);
  });

  it("returns 404 for non-callback paths", async () => {
    const result = await startInstallationCallbackServer();
    server = result.server;
    const resp = await fetch(`http://localhost:${server.port}/other`);
    expect(resp.status).toBe(404);
    expect(await resp.text()).toBe("Not Found");
  });

  it("resolves the installation promise with the parsed installation_id", async () => {
    const result = await startInstallationCallbackServer();
    server = result.server;

    const resp = await fetch(`http://localhost:${server.port}/callback?installation_id=12345`);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("GitHub App connected");

    const installation = await result.installationPromise;
    expect(installation.installation_id).toBe(12345);
  });

  it("returns 400 when installation_id is missing", async () => {
    const result = await startInstallationCallbackServer();
    server = result.server;

    const resp = await fetch(`http://localhost:${server.port}/callback`);
    expect(resp.status).toBe(400);
    expect(await resp.text()).toBe("Missing installation_id");
    // installationPromise must still be pending
    void result.installationPromise;
  });

  it("returns 400 when installation_id is not a number", async () => {
    const result = await startInstallationCallbackServer();
    server = result.server;

    const resp = await fetch(`http://localhost:${server.port}/callback?installation_id=abc`);
    expect(resp.status).toBe(400);
    expect(await resp.text()).toBe("Missing installation_id");
    void result.installationPromise;
  });

  it("handles a request with no URL path (defaults to /)", async () => {
    const result = await startInstallationCallbackServer();
    server = result.server;

    const resp = await fetch(`http://localhost:${server.port}/`);
    expect(resp.status).toBe(404);
  });
});
