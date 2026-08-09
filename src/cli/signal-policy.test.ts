import { describe, expect, it, vi } from "vitest";
import {
  dispatchCliSignal,
  installsImmediateSigintHandler,
  registerCliSignalCleanup,
} from "./signal-policy";

describe("SIGINT policy", () => {
  it("lets the project MCP proxy forward shutdown to its child", () => {
    expect(installsImmediateSigintHandler(["node", "dosu", "mcp", "proxy", "--oss"])).toBe(false);
  });

  it("keeps immediate Ctrl+C handling for interactive commands", () => {
    expect(installsImmediateSigintHandler(["dosu", "setup"])).toBe(true);
  });

  it("keeps ordinary Ctrl+C immediate when no guarded operation is active", async () => {
    const exit = vi.fn();

    await dispatchCliSignal("SIGINT", exit);

    expect(exit).toHaveBeenCalledWith(0);
  });

  it.each([
    ["SIGINT", 0],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)("waits for guarded cleanup before exiting on %s", async (signal, exitCode) => {
    let finishCleanup: (() => void) | undefined;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    const unregister = registerCliSignalCleanup(cleanup);
    const exit = vi.fn();

    const dispatched = dispatchCliSignal(signal, exit);
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledWith(signal);
    expect(exit).not.toHaveBeenCalled();

    finishCleanup?.();
    await dispatched;
    expect(exit).toHaveBeenCalledWith(exitCode);
    unregister();
  });

  it("coalesces repeated signals while cleanup is in progress", async () => {
    let finishCleanup: (() => void) | undefined;
    const unregister = registerCliSignalCleanup(
      () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
    );
    const exit = vi.fn();

    const first = dispatchCliSignal("SIGTERM", exit);
    const second = dispatchCliSignal("SIGINT", exit);
    await Promise.resolve();
    finishCleanup?.();
    await Promise.all([first, second]);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(143);
    unregister();
  });

  it("exits with failure when guarded cleanup cannot be confirmed", async () => {
    const unregister = registerCliSignalCleanup(async () => {
      throw new Error("shutdown unconfirmed");
    });
    const exit = vi.fn();

    await dispatchCliSignal("SIGINT", exit);

    expect(exit).toHaveBeenCalledWith(1);
    unregister();
  });
});
