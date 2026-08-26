import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODE_OSS, updateTarget } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import { mcpBaseURL, mcpRemoteServer, mcpURL } from "./config-helpers";
import { npxPathEnv } from "./detect";
import {
  buildProjectProxyCommand,
  isDosuOwnedMcpServer,
  type ProjectProxyDependencies,
  resolveProjectProxyRuntime,
  runProjectProxy,
} from "./project-proxy";

const originalBackendOverride = process.env.DOSU_BACKEND_URL_OVERRIDE;

beforeEach(() => {
  process.env.DOSU_BACKEND_URL_OVERRIDE = "https://api.example.test";
});

afterEach(() => {
  if (originalBackendOverride === undefined) {
    delete process.env.DOSU_BACKEND_URL_OVERRIDE;
  } else {
    process.env.DOSU_BACKEND_URL_OVERRIDE = originalBackendOverride;
  }
});

function cloudConfig(deploymentID = "dep_123", apiKey = "key_secret") {
  return makeTestConfig({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_at: 4_102_444_800,
    deployment_id: deploymentID,
    api_key: apiKey,
  });
}

function ossConfig(apiKey = "key_secret") {
  return makeTestConfig({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_at: 4_102_444_800,
    api_key: apiKey,
    mode: MODE_OSS,
  });
}

interface MockChild {
  once: {
    (event: "error", listener: (error: Error) => void): unknown;
    (event: "close", listener: (code: number | null) => void): unknown;
  };
  emit(event: "error", error: Error): void;
  emit(event: "close", code: number | null): void;
}

function mockChild(): MockChild {
  const listeners = new Map<string, (value: unknown) => void>();
  const once = ((event: string, listener: (value: unknown) => void) => {
    listeners.set(event, listener);
  }) as MockChild["once"];
  return {
    once,
    emit(event: string, value: unknown) {
      listeners.get(event)?.(value);
    },
  } as MockChild;
}

type SpawnProxy = NonNullable<ProjectProxyDependencies["spawn"]>;

describe("project MCP proxy", () => {
  describe("Dosu entry ownership", () => {
    it.each([
      { command: "dosu", args: ["mcp", "proxy", "--oss"] },
      {
        type: "local",
        command: ["dosu", "mcp", "proxy", "--deployment", "dep_123"],
      },
      { command: "npx", args: ["-y", "@dosu/cli@0.43.0", "mcp", "proxy", "--oss"] },
      {
        type: "local",
        command: ["npx", "-y", "@dosu/cli@0.43.0", "mcp", "proxy", "--deployment", "dep_123"],
      },
    ])("recognizes a released Dosu shape", (server) => {
      expect(isDosuOwnedMcpServer(server)).toBe(true);
    });

    it.each([
      { command: "npx", args: ["-y", "other-cli", "mcp", "proxy", "--oss"] },
      { command: "npx", args: ["-y", "@dosu/cli@latest", "mcp", "proxy", "--oss"] },
      { command: "npx", args: ["-y", "@dosu/cli@file:../cli", "mcp", "proxy", "--oss"] },
      { command: "dosu", args: ["mcp", "proxy", "--oss", "--foreign"] },
      {
        command: "dosu",
        args: ["mcp", "proxy", "--deployment", "dep_123", "--foreign"],
      },
      {
        command: "npx",
        args: ["-y", "@dosu/cli@0.43.0", "mcp", "proxy", "--oss", "--foreign"],
      },
      {
        command: "npx",
        args: ["-y", "@dosu/cli@0.43.0", "mcp", "proxy", "--deployment", "dep_123", "--foreign"],
      },
      {
        url: "https://foreign.example/v1/mcp/deployments/dep_123",
        headers: { "X-Dosu-API-Key": "secret" },
      },
      {
        command: "other",
        args: [
          "mcp-remote@9.9.9",
          "https://foreign.example/v1/mcp",
          "--header",
          `X-Dosu-API-Key:\${X_DOSU_API_KEY}`,
        ],
        env: { X_DOSU_API_KEY: "secret" },
      },
      { url: "https://other.example/v1/mcp", headers: { Authorization: "secret" } },
      { command: "npx", args: ["-y", "mcp-remote@0.1.38", "https://other.example"] },
      null,
    ])("rejects a foreign or ambiguous shape", (server) => {
      expect(isDosuOwnedMcpServer(server)).toBe(false);
    });
  });

  describe("project command", () => {
    it("uses the globally installed CLI and contains no Cloud secret or endpoint", () => {
      const command = buildProjectProxyCommand(cloudConfig());

      expect(command).toEqual({
        command: "dosu",
        args: ["mcp", "proxy", "--deployment", "dep_123"],
      });
      const serialized = JSON.stringify(command);
      expect(serialized).not.toContain("key_secret");
      expect(serialized).not.toContain("/v1/mcp");
    });

    it("builds the OSS command", () => {
      expect(buildProjectProxyCommand(ossConfig())).toEqual({
        command: "dosu",
        args: ["mcp", "proxy", "--oss"],
      });
    });

    it.each([
      undefined,
      "",
      "../other",
      "dep id",
      "dep&whoami",
      "dep%PATH%",
    ])("rejects an unsafe deployment id: %s", (deploymentID) => {
      const cfg = cloudConfig();
      if (cfg.active_account?.target) cfg.active_account.target.deployment_id = deploymentID;
      expect(() => buildProjectProxyCommand(cfg)).toThrow("Invalid project deployment ID");
    });
  });

  describe("active config resolution", () => {
    it("uses the matching active Cloud target", () => {
      expect(resolveProjectProxyRuntime(cloudConfig(), { deploymentID: "dep_123" })).toEqual({
        endpoint: mcpURL("dep_123"),
        apiKey: "key_secret",
      });
    });

    it("uses OSS only while the active config is OSS", () => {
      expect(resolveProjectProxyRuntime(ossConfig(), { oss: true })).toEqual({
        endpoint: mcpBaseURL(),
        apiKey: "key_secret",
      });
    });

    it("resolves an earlier project after another deployment becomes active", () => {
      const cfg = cloudConfig("dep_123", "key_first");
      updateTarget(cfg, { deployment_id: "dep_other", api_key: "key_other" });

      expect(resolveProjectProxyRuntime(cfg, { deploymentID: "dep_123" })).toEqual({
        endpoint: mcpURL("dep_123"),
        apiKey: "key_first",
      });
    });

    it("fails closed when the project deployment has no stored credential", () => {
      expect(() =>
        resolveProjectProxyRuntime(cloudConfig("dep_other"), { deploymentID: "dep_123" }),
      ).toThrow("No credential is stored for this project's Dosu MCP");
    });

    it("fails closed when Cloud and OSS modes disagree", () => {
      expect(() => resolveProjectProxyRuntime(cloudConfig(), { oss: true })).toThrow(
        "is not configured for OSS mode",
      );
      expect(() => resolveProjectProxyRuntime(ossConfig(), { deploymentID: "dep_123" })).toThrow(
        "No credential is stored",
      );
    });

    it("requires exactly one target", () => {
      expect(() => resolveProjectProxyRuntime(cloudConfig(), {})).toThrow("Exactly one");
      expect(() =>
        resolveProjectProxyRuntime(cloudConfig(), { deploymentID: "dep_123", oss: true }),
      ).toThrow("Exactly one");
    });

    it("rejects unsafe runtime deployment ids", () => {
      expect(() =>
        resolveProjectProxyRuntime(cloudConfig("dep&whoami"), {
          deploymentID: "dep&whoami",
        }),
      ).toThrow("Invalid project deployment ID");
    });

    it("fails before launch when the active API key is missing", () => {
      expect(() =>
        resolveProjectProxyRuntime(cloudConfig("dep_123", ""), { deploymentID: "dep_123" }),
      ).toThrow("API key is missing");
    });

    it.each([
      "https://api.example.test&echo%X_DOSU_API_KEY%",
      "https://user:password@api.example.test",
      "file:///tmp/mcp",
    ])("rejects an unsafe runtime endpoint before the key reaches a shell: %s", (endpoint) => {
      process.env.DOSU_BACKEND_URL_OVERRIDE = endpoint;
      expect(() => resolveProjectProxyRuntime(cloudConfig(), { deploymentID: "dep_123" })).toThrow(
        "Invalid Dosu MCP endpoint",
      );
    });
  });

  describe("bridge process", () => {
    it("passes the key only through the child environment", async () => {
      const child = mockChild();
      const spawn = vi.fn<SpawnProxy>(() => child);
      const result = runProjectProxy(
        { deploymentID: "dep_123" },
        {
          loadConfig: () => cloudConfig(),
          findNpx: () => "/opt/node/bin/npx",
          platform: "linux",
          spawn,
        },
      );

      child.emit("close", 0);
      await expect(result).resolves.toBe(0);

      const remote = mcpRemoteServer(mcpURL("dep_123"), "key_secret");
      expect(spawn).toHaveBeenCalledWith("/opt/node/bin/npx", remote.args, {
        stdio: "inherit",
        shell: false,
        env: expect.objectContaining({
          PATH: npxPathEnv("/opt/node/bin/npx"),
          X_DOSU_API_KEY: "key_secret",
        }),
      });
      expect(JSON.stringify(spawn.mock.calls[0]?.[1])).not.toContain("key_secret");
    });

    it("uses the cmd launcher through a shell on Windows", async () => {
      const child = mockChild();
      const spawn = vi.fn<SpawnProxy>(() => child);
      const result = runProjectProxy(
        { deploymentID: "dep_123" },
        {
          loadConfig: () => cloudConfig(),
          findNpx: () => "C:\\Program Files\\nodejs\\npx.cmd",
          platform: "win32",
          spawn,
        },
      );

      child.emit("close", 7);
      await expect(result).resolves.toBe(7);
      expect(spawn).toHaveBeenCalledWith(
        "npx.cmd",
        expect.any(Array),
        expect.objectContaining({
          shell: true,
          stdio: "inherit",
          env: expect.objectContaining({
            NoDefaultCurrentDirectoryInExePath: "1",
            X_DOSU_API_KEY: "key_secret",
          }),
        }),
      );
    });

    it("returns one for a signal-style close without an exit code", async () => {
      const child = mockChild();
      const result = runProjectProxy(
        { deploymentID: "dep_123" },
        {
          loadConfig: () => cloudConfig(),
          findNpx: () => "/opt/node/bin/npx",
          platform: "linux",
          spawn: () => child,
        },
      );

      child.emit("close", null);
      await expect(result).resolves.toBe(1);
    });

    it("surfaces a child launch error", async () => {
      const child = mockChild();
      const result = runProjectProxy(
        { deploymentID: "dep_123" },
        {
          loadConfig: () => cloudConfig(),
          findNpx: () => "/opt/node/bin/npx",
          platform: "linux",
          spawn: () => child,
        },
      );

      child.emit("error", new Error("spawn failed"));
      await expect(result).rejects.toThrow("spawn failed");
    });

    it("does not spawn when active config validation fails", async () => {
      const spawn = vi.fn();
      await expect(
        runProjectProxy(
          { deploymentID: "dep_123" },
          {
            loadConfig: () => cloudConfig("dep_other"),
            findNpx: () => "/opt/node/bin/npx",
            platform: "linux",
            spawn,
          },
        ),
      ).rejects.toThrow("No credential is stored");
      expect(spawn).not.toHaveBeenCalled();
    });
  });
});
