import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const mockRender = vi.hoisted(() => vi.fn());
vi.mock("./render", () => ({
  renderStatusline: (...args: unknown[]) => mockRender(...args),
}));

import { readStdin, runStatuslineRender, runStatuslineRenderFromArgv } from "./run";

type FakeStdin = NodeJS.ReadStream & { isTTY?: boolean };

function piped(content: string): FakeStdin {
  const stream = new PassThrough();
  stream.end(content);
  return stream as unknown as FakeStdin;
}

describe("readStdin", () => {
  it("drains a piped payload", async () => {
    await expect(readStdin(piped('{"cwd":"/w"}'))).resolves.toBe('{"cwd":"/w"}');
  });

  it("reads a TTY as empty without touching it", async () => {
    const tty = { isTTY: true } as unknown as FakeStdin;
    await expect(readStdin(tty)).resolves.toBe("");
  });

  it("reads a failing stream as empty", async () => {
    const stream = new PassThrough();
    const promise = readStdin(stream as unknown as FakeStdin);
    stream.destroy(new Error("boom"));
    await expect(promise).resolves.toBe("");
  });
});

describe("runStatuslineRender", () => {
  it("feeds stdin and the agent id to the renderer and writes one line", async () => {
    const lines: string[] = [];
    await runStatuslineRender("claude", {
      readStdin: async () => '{"cwd":"/w"}',
      render: (raw, agent) => `rendered ${agent} ${raw}`,
      write: (line) => lines.push(line),
    });
    expect(lines).toEqual(['rendered claude {"cwd":"/w"}']);
  });

  it("defaults to the real renderer and stdout", async () => {
    mockRender.mockReturnValue("📚 Dosu studying");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runStatuslineRender("cursor", { readStdin: async () => "{}" });
      expect(mockRender).toHaveBeenCalledWith("{}", "cursor");
      expect(write).toHaveBeenCalledWith("📚 Dosu studying\n");
    } finally {
      write.mockRestore();
    }
  });
});

describe("runStatuslineRenderFromArgv", () => {
  it("takes the agent from the argv tail", async () => {
    const agents: string[] = [];
    await runStatuslineRenderFromArgv(
      ["bun", "index.ts", "knowledge", "statusline", "render", "--agent", "cursor"],
      {
        readStdin: async () => "",
        render: (_raw, agent) => {
          agents.push(agent);
          return "";
        },
        write: () => {},
      },
    );
    expect(agents).toEqual(["cursor"]);
  });
});
