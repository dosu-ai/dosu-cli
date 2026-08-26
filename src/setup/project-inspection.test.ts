import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SetupProvider } from "../mcp/providers";
import { CodexProvider } from "../mcp/providers/codex";
import { CursorProvider } from "../mcp/providers/cursor";
import { OpenCodeProvider } from "../mcp/providers/opencode";
import {
  inspectProjectProvider,
  inspectRepositoryBindings,
  repositoryNeedsTargetReplacement,
} from "./project-inspection";

describe("project MCP inspection", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "dosu-project-inspect-")));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeJSON(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2));
  }

  it("extracts a secretless deployment binding and reports an absent config", () => {
    const cursor = CursorProvider();
    expect(inspectProjectProvider(cursor, tempDir)).toMatchObject({ status: "absent" });

    const path = cursor.projectConfigPath(tempDir) ?? "";
    writeJSON(path, {
      mcpServers: {
        dosu: { command: "dosu", args: ["mcp", "proxy", "--deployment", "dep-a"] },
      },
    });

    expect(inspectProjectProvider(cursor, tempDir)).toMatchObject({
      status: "owned",
      target: { kind: "deployment", deploymentID: "dep-a" },
      path,
    });
  });

  it("blocks foreign, malformed, and symlinked project config", () => {
    const cursor = CursorProvider();
    const path = cursor.projectConfigPath(tempDir) ?? "";
    writeJSON(path, { mcpServers: { dosu: { command: "foreign", args: [] } } });
    const foreignBytes = readFileSync(path, "utf-8");
    expect(inspectProjectProvider(cursor, tempDir)).toMatchObject({ status: "foreign" });
    expect(readFileSync(path, "utf-8")).toBe(foreignBytes);

    writeFileSync(path, '{"mcpServers":');
    expect(inspectProjectProvider(cursor, tempDir)).toMatchObject({ status: "malformed" });

    rmSync(dirname(path), { recursive: true, force: true });
    const outside = join(tempDir, "outside");
    mkdirSync(outside);
    symlinkSync(outside, dirname(path));
    expect(inspectProjectProvider(cursor, tempDir)).toMatchObject({ status: "malformed" });
  });

  it("reads multiline Codex TOML without changing its comments", () => {
    const codex = CodexProvider();
    const path = codex.projectConfigPath(tempDir) ?? "";
    mkdirSync(dirname(path), { recursive: true });
    const content = [
      "# keep",
      "[mcp_servers.dosu]",
      'command = "dosu"',
      'args = ["mcp", "proxy", "--deployment", "dep-codex"]',
      "",
      "[features]",
      "apps = true",
      "",
    ].join("\n");
    writeFileSync(path, content);

    expect(inspectProjectProvider(codex, tempDir)).toMatchObject({
      status: "owned",
      target: { kind: "deployment", deploymentID: "dep-codex" },
    });
    expect(readFileSync(path, "utf-8")).toBe(content);
  });

  it("aggregates conflicting bindings and requires explicit replacement", () => {
    const cursor = CursorProvider();
    const opencode = OpenCodeProvider();
    writeJSON(cursor.projectConfigPath(tempDir) ?? "", {
      mcpServers: {
        dosu: { command: "dosu", args: ["mcp", "proxy", "--deployment", "dep-a"] },
      },
    });
    writeJSON(opencode.projectConfigPath(tempDir) ?? "", {
      mcp: {
        dosu: { command: "dosu", args: ["mcp", "proxy", "--deployment", "dep-b"] },
      },
    });

    const state = inspectRepositoryBindings(tempDir, [cursor, opencode]);
    expect(state.blockers).toEqual([]);
    expect(state.targets).toEqual([
      { kind: "deployment", deploymentID: "dep-a" },
      { kind: "deployment", deploymentID: "dep-b" },
    ]);
    expect(repositoryNeedsTargetReplacement(state, "dep-a")).toBe(true);
    expect(repositoryNeedsTargetReplacement(state, "dep-c")).toBe(true);
  });

  it("treats missing paths and missing Dosu entries as absent", () => {
    const noPath: SetupProvider = {
      ...CursorProvider(),
      id: () => "no-path",
      projectConfigPath: () => null,
    };
    expect(inspectProjectProvider(noPath, tempDir)).toEqual({
      providerID: "no-path",
      path: null,
      status: "absent",
    });

    const cursor = CursorProvider();
    writeJSON(cursor.projectConfigPath(tempDir) ?? "", {
      mcpServers: { other: { command: "other", args: [] } },
    });
    expect(inspectProjectProvider(cursor, tempDir)).toMatchObject({ status: "absent" });
  });

  it("blocks unsupported formats and normalizes non-Error inspection failures", () => {
    const unsupportedPath = join(tempDir, ".unknown", "mcp.json");
    const unsupported: SetupProvider = {
      ...CursorProvider(),
      id: () => "unknown-agent",
      projectConfigPath: () => unsupportedPath,
    };
    writeJSON(unsupportedPath, { mcpServers: { dosu: {} } });

    const throwing: SetupProvider = {
      ...CursorProvider(),
      id: () => "throwing-agent",
      projectConfigPath: () => {
        throw "path inspection failed";
      },
    };

    const inspected = inspectRepositoryBindings(tempDir, [unsupported, throwing]);

    expect(inspected.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerID: "unknown-agent",
          status: "malformed",
          error: "unsupported project config format",
        }),
        expect.objectContaining({
          providerID: "throwing-agent",
          path: null,
          status: "malformed",
          error: "path inspection failed",
        }),
      ]),
    );
  });

  it("recognizes an OSS project binding as requiring replacement for a cloud Library", () => {
    const cursor = CursorProvider();
    writeJSON(cursor.projectConfigPath(tempDir) ?? "", {
      mcpServers: {
        dosu: { command: "dosu", args: ["mcp", "proxy", "--oss"] },
      },
    });

    const inspected = inspectRepositoryBindings(tempDir, [cursor]);

    expect(inspected.targets).toEqual([{ kind: "oss" }]);
    expect(repositoryNeedsTargetReplacement(inspected, "dep-cloud")).toBe(true);
  });
});
