import { describe, expect, it, vi } from "vitest";
import { type SpawnDetached, selfInvocation, spawnDetachedSelf } from "./detach";

describe("selfInvocation", () => {
  it("uses execPath plus the entry script for script runtimes", () => {
    const invocation = selfInvocation("/usr/bin/node", "/opt/dosu/bin/dosu.js");
    expect(invocation).toEqual({ command: "/usr/bin/node", baseArgs: ["/opt/dosu/bin/dosu.js"] });
  });

  it("uses execPath alone for bun-compiled binaries", () => {
    const invocation = selfInvocation("/usr/local/bin/dosu", "/$bunfs/root/dosu");
    expect(invocation).toEqual({ command: "/usr/local/bin/dosu", baseArgs: [] });
  });

  it("uses execPath alone when argv[1] is empty", () => {
    const invocation = selfInvocation("/usr/local/bin/dosu", "");
    expect(invocation).toEqual({ command: "/usr/local/bin/dosu", baseArgs: [] });
  });
});

describe("spawnDetachedSelf", () => {
  it("spawns detached with stdio ignored and unrefs the child", () => {
    const unref = vi.fn();
    const spawnImpl: SpawnDetached = vi.fn().mockReturnValue({ unref });

    const ok = spawnDetachedSelf(["knowledge", "sync", "--quiet"], spawnImpl, {
      command: "/usr/bin/node",
      baseArgs: ["/opt/dosu.js"],
    });

    expect(ok).toBe(true);
    expect(spawnImpl).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/opt/dosu.js", "knowledge", "sync", "--quiet"],
      { detached: true, stdio: "ignore" },
    );
    expect(unref).toHaveBeenCalled();
  });

  it("returns false instead of throwing when spawn fails", () => {
    const spawnImpl: SpawnDetached = vi.fn().mockImplementation(() => {
      throw new Error("EPERM");
    });

    expect(spawnDetachedSelf(["knowledge", "sync"], spawnImpl)).toBe(false);
  });
});
