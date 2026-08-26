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
});
