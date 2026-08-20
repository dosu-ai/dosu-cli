import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { driveCommand } from "../commands/drive";
import { loadDriveState, rememberRepositories, setActiveDrive } from "./state";

const cleanup: string[] = [];

afterEach(async () => {
  delete process.env.DOSU_DRIVE_HOME;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Dosu Drive acceptance gates", () => {
  it("gate 1: exposes the complete Drive command surface", () => {
    const command = driveCommand();
    expect(command.commands.map((item) => item.name())).toEqual([
      "host",
      "join",
      "setup",
      "search",
      "status",
      "stop",
      "destroy",
      "mcp",
    ]);
    expect(
      command.commands.find((item) => item.name() === "mcp")?.commands.map((item) => item.name()),
    ).toEqual(["add", "status", "remove", "serve"]);
  });

  it("gate 2: persists Drive state without modifying repository or session files", async () => {
    const root = await mkdtemp(join(tmpdir(), "dosu-drive-acceptance-"));
    cleanup.push(root);
    const driveHome = join(root, "state");
    const source = join(root, "source-session.jsonl");
    mkdirSync(driveHome, { recursive: true });
    writeFileSync(source, '{"message":"untouched"}\n');
    process.env.DOSU_DRIVE_HOME = driveHome;

    setActiveDrive({
      id: "drive-1",
      name: "Demo Drive",
      url: "http://127.0.0.1:47821/",
      protocolVersion: 1,
      local: true,
    });
    rememberRepositories(["/tmp/repo-a", "/tmp/repo-b", "/tmp/repo-a"]);

    expect(loadDriveState()).toMatchObject({
      active: { id: "drive-1", url: "http://127.0.0.1:47821" },
      recentRepositories: ["/tmp/repo-a", "/tmp/repo-b"],
    });
    expect(readFileSync(source, "utf8")).toBe('{"message":"untouched"}\n');
    expect(existsSync(source)).toBe(true);
  });
});
