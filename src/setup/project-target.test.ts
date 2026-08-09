import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestConfig } from "../config/config.test-utils";
import { allSetupProviders } from "../mcp/providers";
import { ClaudeProvider } from "../mcp/providers/claude";
import { ClaudeDesktopProvider } from "../mcp/providers/claude-desktop";
import { CodexProvider } from "../mcp/providers/codex";
import { CopilotProvider } from "../mcp/providers/copilot";
import { CursorProvider } from "../mcp/providers/cursor";
import { inspectProviderProjectTarget, resolveProjectPinnedTarget } from "./project-target";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dosu-project-target-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function args(target: string): string[] {
  return ["-y", "@dosu/cli@0.42.0", "mcp", "proxy", "--deployment", target];
}

function writeCursor(target: string): void {
  const path = join(root, ".cursor", "mcp.json");
  mkdirSync(join(root, ".cursor"), { recursive: true });
  writeFileSync(
    path,
    `{// preserved\n  "mcpServers": {"dosu": ${JSON.stringify({
      type: "stdio",
      command: "npx",
      args: args(target),
    })}}\n}`,
  );
}

function writeCodex(target: string): void {
  mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(
    join(root, ".codex", "config.toml"),
    `[mcp_servers.dosu]\ncommand = "npx"\nargs = ${JSON.stringify(args(target))}\n`,
  );
}

describe("project MCP target recovery", () => {
  it("resolves pins from every provider with an official project config", () => {
    const providers = allSetupProviders().filter(
      (provider) => provider.projectConfigPath(root) !== null,
    );
    const expectedProviderIDs = [
      "claude",
      "cursor",
      "vscode",
      "gemini",
      "codex",
      "zed",
      "copilot",
      "opencode",
      "antigravity",
      "mcporter",
      "factory",
    ];
    expect(providers.map((provider) => provider.id())).toEqual(expectedProviderIDs);

    const cfg = makeTestConfig({
      access_token: "access",
      refresh_token: "refresh",
      expires_at: Date.now() + 60_000,
      deployment_id: "dep-all-providers",
      deployment_name: "Project",
      api_key: "private-key",
    });
    for (const provider of providers) provider.install(cfg, false, { projectRoot: root });

    expect(resolveProjectPinnedTarget(providers, root)).toEqual({
      ok: true,
      target: { deploymentID: "dep-all-providers" },
      providers: expectedProviderIDs,
    });
  });

  it("recovers an exact historical-version JSON or Codex project pin", () => {
    writeCursor("dep-a");
    writeCodex("dep-a");

    expect(inspectProviderProjectTarget(CursorProvider(), root)).toMatchObject({
      disposition: "owned",
      target: { deploymentID: "dep-a" },
    });
    expect(inspectProviderProjectTarget(CodexProvider(), root)).toMatchObject({
      disposition: "owned",
      target: { deploymentID: "dep-a" },
    });
    expect(resolveProjectPinnedTarget([CursorProvider(), CodexProvider()], root)).toMatchObject({
      ok: true,
      target: { deploymentID: "dep-a" },
    });
  });

  it("fails closed when exact project configs pin different deployments", () => {
    writeCursor("dep-a");
    writeCodex("dep-b");

    expect(resolveProjectPinnedTarget([CursorProvider(), CodexProvider()], root)).toEqual({
      ok: false,
      reason: "conflicting_project_targets",
      providers: ["cursor", "codex"],
      paths: [join(root, ".cursor", "mcp.json"), join(root, ".codex", "config.toml")],
    });
  });

  it("fails closed with the provider and path for a foreign server named dosu", () => {
    mkdirSync(join(root, ".cursor"), { recursive: true });
    const path = join(root, ".cursor", "mcp.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { dosu: { command: "foreign", args: [] } } }));

    expect(inspectProviderProjectTarget(CursorProvider(), root)).toMatchObject({
      disposition: "ambiguous",
    });
    expect(resolveProjectPinnedTarget([CursorProvider()], root)).toEqual({
      ok: false,
      reason: "ambiguous_project_config",
      providers: ["cursor"],
      paths: [path],
    });
  });

  it("fails closed with the provider and path for ambiguous Codex TOML", () => {
    const path = join(root, ".codex", "config.toml");
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(path, "[[unterminated");

    expect(resolveProjectPinnedTarget([CursorProvider(), CodexProvider()], root)).toEqual({
      ok: false,
      reason: "ambiguous_project_config",
      providers: ["codex"],
      paths: [path],
    });
  });

  it("rejects an explicit deployment that would split an undetected client's exact pin", () => {
    writeCursor("dep-a");

    expect(
      resolveProjectPinnedTarget([CursorProvider()], root, {
        mode: "cloud",
        deploymentID: "dep-b",
      }),
    ).toEqual({
      ok: false,
      reason: "requested_project_target_conflict",
      providers: ["cursor"],
      paths: [join(root, ".cursor", "mcp.json")],
    });
  });

  it("allows an explicit rerun when every exact project pin already has that target", () => {
    writeCursor("dep-a");
    writeCodex("dep-a");

    expect(
      resolveProjectPinnedTarget([CursorProvider(), CodexProvider()], root, {
        mode: "cloud",
        deploymentID: "dep-a",
      }),
    ).toMatchObject({
      ok: true,
      target: { deploymentID: "dep-a" },
      providers: ["cursor", "codex"],
    });
  });

  it("allows an explicitly selected client to retarget its own exact pin", () => {
    writeCursor("dep-a");

    expect(
      resolveProjectPinnedTarget(
        [CursorProvider()],
        root,
        { mode: "cloud", deploymentID: "dep-b" },
        ["cursor"],
      ),
    ).toEqual({
      ok: true,
      target: { deploymentID: "dep-b" },
      providers: ["cursor"],
    });
  });

  it("does not recover an OSS pin as the target of an explicit Cloud request", () => {
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(
      join(root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          dosu: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@dosu/cli@0.42.0", "mcp", "proxy", "--oss"],
          },
        },
      }),
    );

    expect(
      resolveProjectPinnedTarget([CursorProvider()], root, { mode: "cloud" }, ["cursor"]),
    ).toEqual({ ok: true, providers: ["cursor"] });
  });

  it("still rejects an unselected client's pin when the selected client can retarget", () => {
    writeCursor("dep-a");
    writeCodex("dep-a");

    expect(
      resolveProjectPinnedTarget(
        [CursorProvider(), CodexProvider()],
        root,
        { mode: "cloud", deploymentID: "dep-b" },
        ["cursor"],
      ),
    ).toEqual({
      ok: false,
      reason: "requested_project_target_conflict",
      providers: ["codex"],
      paths: [join(root, ".codex", "config.toml")],
    });
  });

  it("treats every client sharing a selected project file as mutable", () => {
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          dosu: {
            type: "stdio",
            command: "npx",
            args: args("dep-a"),
          },
        },
      }),
    );

    expect(
      resolveProjectPinnedTarget(
        [ClaudeProvider(), CopilotProvider()],
        root,
        { mode: "cloud", deploymentID: "dep-b" },
        ["claude"],
      ),
    ).toEqual({
      ok: true,
      target: { deploymentID: "dep-b" },
      providers: ["claude", "copilot"],
    });
  });

  it.each([
    ["OSS over Cloud", { mode: "oss" } as const, "dep-a"],
    ["Cloud over OSS", { mode: "cloud" } as const, null],
  ])("rejects an explicit %s mode that conflicts with the repository", (_name, request, cloud) => {
    if (cloud) {
      writeCursor(cloud);
    } else {
      mkdirSync(join(root, ".cursor"), { recursive: true });
      writeFileSync(
        join(root, ".cursor", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            dosu: {
              type: "stdio",
              command: "npx",
              args: ["-y", "@dosu/cli@0.42.0", "mcp", "proxy", "--oss"],
            },
          },
        }),
      );
    }

    expect(resolveProjectPinnedTarget([CursorProvider()], root, request)).toMatchObject({
      ok: false,
      reason: "requested_project_target_conflict",
      providers: ["cursor"],
      paths: [join(root, ".cursor", "mcp.json")],
    });
  });

  it("treats unsupported, missing, and Dosu-free project files as unpinned", () => {
    expect(inspectProviderProjectTarget(ClaudeDesktopProvider(), root)).toEqual({
      disposition: "not_found",
      providerID: "claude-desktop",
    });
    expect(inspectProviderProjectTarget(CursorProvider(), root)).toMatchObject({
      disposition: "not_found",
      providerID: "cursor",
    });

    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(join(root, ".cursor", "mcp.json"), '{"mcpServers":{"other":{}}}');
    expect(inspectProviderProjectTarget(CursorProvider(), root)).toMatchObject({
      disposition: "not_found",
      providerID: "cursor",
    });

    writeFileSync(join(root, ".cursor", "mcp.json"), "{}");
    expect(inspectProviderProjectTarget(CursorProvider(), root)).toMatchObject({
      disposition: "not_found",
      providerID: "cursor",
    });
  });

  it.each([
    ["invalid JSON", "{"],
    ["duplicate top-level key", '{"mcpServers":{},"mcpServers":{}}'],
    ["duplicate Dosu key", '{"mcpServers":{"dosu":{},"dosu":{}}}'],
    ["array root", "[]"],
    ["non-object MCP section", '{"mcpServers":[]}'],
  ])("fails closed for %s", (_name, content) => {
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(join(root, ".cursor", "mcp.json"), content);
    expect(inspectProviderProjectTarget(CursorProvider(), root)).toMatchObject({
      disposition: "ambiguous",
      providerID: "cursor",
    });
  });

  it("fails closed for a symlink or directory at the project config path", () => {
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(join(root, "foreign.json"), '{"mcpServers":{}}');
    symlinkSync(join(root, "foreign.json"), join(root, ".cursor", "mcp.json"));
    expect(inspectProviderProjectTarget(CursorProvider(), root)).toMatchObject({
      disposition: "ambiguous",
    });

    rmSync(join(root, ".cursor", "mcp.json"));
    mkdirSync(join(root, ".cursor", "mcp.json"));
    expect(inspectProviderProjectTarget(CursorProvider(), root)).toMatchObject({
      disposition: "ambiguous",
    });
  });

  it("recognizes an exact OSS pin and rejects malformed Codex TOML", () => {
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(
      join(root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          dosu: {
            type: "stdio",
            command: "npx",
            args: ["-y", "@dosu/cli@0.42.0", "mcp", "proxy", "--oss"],
          },
        },
      }),
    );
    expect(inspectProviderProjectTarget(CursorProvider(), root)).toMatchObject({
      disposition: "owned",
      target: { oss: true },
    });

    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(join(root, ".codex", "config.toml"), "[[unterminated");
    expect(inspectProviderProjectTarget(CodexProvider(), root)).toMatchObject({
      disposition: "ambiguous",
      providerID: "codex",
    });
  });

  it("treats valid Codex TOML without a Dosu table as unpinned", () => {
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(join(root, ".codex", "config.toml"), '[model]\nname = "gpt"\n');
    expect(inspectProviderProjectTarget(CodexProvider(), root)).toMatchObject({
      disposition: "not_found",
      providerID: "codex",
    });
  });

  it("returns no pin when no selected provider has an owned entry", () => {
    expect(resolveProjectPinnedTarget([ClaudeDesktopProvider(), CursorProvider()], root)).toEqual({
      ok: true,
      providers: [],
    });
  });
});
