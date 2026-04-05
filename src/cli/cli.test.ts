import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProgram } from "./cli";

describe("CLI", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("creates a program with correct name", () => {
    const program = createProgram();
    expect(program.name()).toBe("dosu");
  });

  it("has version flag", () => {
    const program = createProgram();
    expect(program.version()).toMatch(/^v\d+/);
  });

  it("has login command", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "login");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Authenticate");
  });

  it("has logout command", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "logout");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Clear saved credentials");
  });

  it("has status command", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "status");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("status");
  });

  it("has mcp command with add and list subcommands", () => {
    const program = createProgram();
    const mcpCmd = program.commands.find((c) => c.name() === "mcp");
    expect(mcpCmd).toBeDefined();
    expect(mcpCmd?.commands.find((c) => c.name() === "add")).toBeDefined();
    expect(mcpCmd?.commands.find((c) => c.name() === "list")).toBeDefined();
  });

  it("has setup command with --deployment option", () => {
    const program = createProgram();
    const cmd = program.commands.find((c) => c.name() === "setup");
    expect(cmd).toBeDefined();
    const opts = cmd?.options.find((o) => o.long === "--deployment");
    expect(opts).toBeDefined();
  });

  it("mcp add has --global flag", () => {
    const program = createProgram();
    const mcpCmd = program.commands.find((c) => c.name() === "mcp");
    const addCmd = mcpCmd?.commands.find((c) => c.name() === "add");
    const globalOpt = addCmd?.options.find((o) => o.long === "--global");
    expect(globalOpt).toBeDefined();
  });
});
