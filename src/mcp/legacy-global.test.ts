import { describe, expect, it } from "vitest";
import { isReleasedLegacyGlobalMcpServer } from "./legacy-global";

const headers = { "X-Dosu-API-Key": "old-key" };
const deploymentURL = "https://api.dosu.dev/v1/mcp/deployments/dep-123";

describe("isReleasedLegacyGlobalMcpServer", () => {
  it.each([
    ["claude", { type: "http", url: deploymentURL, headers }],
    ["cursor", { url: deploymentURL, headers }],
    ["zed", { source: "custom", type: "http", url: deploymentURL, headers }],
    ["opencode", { type: "remote", url: deploymentURL, enabled: true, headers }],
    ["copilot", { type: "http", url: deploymentURL, tools: ["*"], headers }],
    ["mcporter", { type: "http", url: deploymentURL, headers }],
    ["cline", { type: "streamableHttp", url: deploymentURL, disabled: false, headers }],
    ["antigravity", { serverUrl: deploymentURL, headers }],
  ])("accepts the released %s cloud shape", (providerID, entry) => {
    expect(isReleasedLegacyGlobalMcpServer(providerID, entry)).toBe(true);
  });

  it("accepts the released OSS default shape", () => {
    expect(
      isReleasedLegacyGlobalMcpServer("cursor", {
        type: "http",
        url: "https://api.dosu.dev/v1/mcp",
        headers,
      }),
    ).toBe(true);
  });

  it.each([
    ["foreign origin", { type: "http", url: "https://foreign.example/v1/mcp", headers }],
    [
      "runtime override origin",
      { type: "http", url: "https://api-staging.dosu.dev/v1/mcp", headers },
    ],
    ["file URL", { type: "http", url: "file:///v1/mcp", headers }],
    [
      "wrong command",
      { type: "http", url: deploymentURL, headers, command: "other-server", args: ["serve"] },
    ],
    ["unknown field", { type: "http", url: deploymentURL, headers, extra: true }],
    [
      "extra header",
      {
        type: "http",
        url: deploymentURL,
        headers: { ...headers, Authorization: "Bearer foreign" },
      },
    ],
  ])("rejects %s", (_name, entry) => {
    expect(isReleasedLegacyGlobalMcpServer("claude", entry)).toBe(false);
  });
});
