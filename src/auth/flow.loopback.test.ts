import { request } from "node:http";
import { describe, expect, it, vi } from "vitest";

const { mockOpenDefault } = vi.hoisted(() => ({ mockOpenDefault: vi.fn() }));

// The browser is the process boundary: stand in for one whose resolver maps `localhost` to IPv4
// only (seen with Windows browsers, proxies, and IPv6-disabled hosts). It follows the callback
// URL the CLI handed out, as the web app does after a successful sign-in.
vi.mock("open", () => ({ default: mockOpenDefault }));

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

import { startOAuthFlow } from "./flow";

function ipv4OnlyBrowserGet(url: URL): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { family: 4 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("startOAuthFlow loopback callback", () => {
  it("completes when the browser resolves the callback host to IPv4 only", async () => {
    const browserResult = new Promise<number | Error>((resolve) => {
      mockOpenDefault.mockImplementationOnce(async (authURL: string) => {
        const callback = new URL(
          new URL(authURL, "https://app.dosu.dev").searchParams.get("callback") ?? "",
        );
        callback.searchParams.set("access_token", "tok");
        callback.searchParams.set("refresh_token", "ref");
        ipv4OnlyBrowserGet(callback).then(resolve, resolve);
      });
    });

    const flow = startOAuthFlow(undefined, "/cli/auth", {}, undefined, { timeoutMs: 3_000 });

    expect(await browserResult).toBe(200);
    await expect(flow).resolves.toMatchObject({
      browserOpened: true,
      token: { access_token: "tok", refresh_token: "ref" },
    });
  });
});
