import { spawn as nodeSpawn } from "node:child_process";
import { type CliSignalCleanup, registerCliSignalCleanup } from "../cli/signal-policy";
import type { Config } from "../config/config";
import { VERSION } from "../version/version";
import {
  type KillProcessGroup,
  type SpawnTreeKiller,
  terminatePosixProcessTree,
  terminateWindowsProcessTree,
} from "./process-tree";
import { buildProjectProxyCommand } from "./project-proxy";

export type ProjectProxyPreflightReason =
  | "initialize_ok"
  | "spawn_failed"
  | "initialize_rejected"
  | "invalid_response"
  | "interrupted"
  | "process_exited"
  | "shutdown_unconfirmed"
  | "timeout";

export type ProjectProxyPreflightResult =
  | { ok: true; reason: "initialize_ok" }
  | { ok: false; reason: Exclude<ProjectProxyPreflightReason, "initialize_ok"> };

interface PreflightInput {
  write(value: string): boolean;
}

interface PreflightOutput {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): PreflightOutput;
}

interface PreflightChild {
  pid?: number;
  stdin: PreflightInput;
  stdout: PreflightOutput;
  stderr: PreflightOutput;
  once(event: "error", listener: () => void): PreflightChild;
  once(event: "close", listener: () => void): PreflightChild;
  kill(signal: NodeJS.Signals): boolean;
}

type SpawnPreflight = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
    shell: boolean;
    detached: boolean;
  },
) => PreflightChild;

export interface ProjectProxyPreflightDependencies {
  spawn?: SpawnPreflight;
  timeoutMs?: number;
  killGraceMs?: number;
  shutdownDeadlineMs?: number;
  platform?: NodeJS.Platform;
  spawnTreeKiller?: SpawnTreeKiller;
  killProcessGroup?: KillProcessGroup;
  registerSignalCleanup?: (cleanup: CliSignalCleanup) => () => void;
}

const INITIALIZE_ID = 1;
const MAX_PROTOCOL_OUTPUT = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Start the exact checked-in stdio command and complete an MCP initialize round-trip.
 * Legacy globals are preserved unless this succeeds.
 */
export async function preflightProjectProxy(
  cfg: Config,
  projectRoot: string,
  deps: ProjectProxyPreflightDependencies = {},
): Promise<ProjectProxyPreflightResult> {
  const command = buildProjectProxyCommand(cfg);
  const platform = deps.platform ?? process.platform;
  let child: PreflightChild;
  try {
    child = (deps.spawn ?? (nodeSpawn as unknown as SpawnPreflight))(
      command.command,
      command.args,
      {
        cwd: projectRoot,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        // The exact project command is `npx`; on Windows it resolves to
        // npx.cmd, which Node can execute only through a shell.
        shell: platform === "win32",
        // npm exec launches the requested binary through a child shell even
        // on POSIX. A dedicated group lets shutdown reach every descendant.
        detached: platform !== "win32",
      },
    );
  } catch {
    return { ok: false, reason: "spawn_failed" };
  }

  return await new Promise<ProjectProxyPreflightResult>((resolve) => {
    let finalResult: ProjectProxyPreflightResult | undefined;
    let shutdownStarted = false;
    let shutdownMustBeConfirmed = false;
    let interrupted = false;
    let shutdownComplete: Promise<void> | undefined;
    let shutdownStatus: "terminated" | "unconfirmed" | undefined;
    let unregisterSignalCleanup = () => {};
    let stdout = "";
    // Codex currently allows roughly ten seconds for stdio startup. Passing a
    // slower check would authorize cleanup for a project entry Codex still times out on.
    const timeout = setTimeout(
      () => finish({ ok: false, reason: "timeout" }),
      deps.timeoutMs ?? 8_000,
    );

    function resolveClosed(result: ProjectProxyPreflightResult): void {
      clearTimeout(timeout);
      unregisterSignalCleanup();
      resolve(result);
    }

    function resolveAfterShutdown(
      result: ProjectProxyPreflightResult,
      status: "terminated" | "unconfirmed",
    ): void {
      const effectiveResult: ProjectProxyPreflightResult = interrupted
        ? { ok: false, reason: "interrupted" }
        : result;
      resolveClosed(
        status !== "terminated" &&
          (shutdownMustBeConfirmed ||
            effectiveResult.ok ||
            effectiveResult.reason === "interrupted")
          ? { ok: false, reason: "shutdown_unconfirmed" }
          : effectiveResult,
      );
    }

    function finish(result: ProjectProxyPreflightResult, requireConfirmedShutdown = false): void {
      if (requireConfirmedShutdown) shutdownMustBeConfirmed = true;
      if (finalResult) return;
      finalResult = result;
      clearTimeout(timeout);
      shutdownStarted = true;
      if (platform === "win32") {
        shutdownComplete = terminateWindowsProcessTree(child, {
          spawnTreeKiller: deps.spawnTreeKiller,
          shutdownDeadlineMs: deps.shutdownDeadlineMs,
        }).then((status) => {
          shutdownStatus = status;
          resolveAfterShutdown(result, status);
        });
        return;
      }
      shutdownComplete = terminatePosixProcessTree(child, {
        killProcessGroup: deps.killProcessGroup,
        killGraceMs: deps.killGraceMs,
        shutdownDeadlineMs: deps.shutdownDeadlineMs,
      }).then((status) => {
        shutdownStatus = status;
        resolveAfterShutdown(result, status);
      });
    }

    unregisterSignalCleanup = (deps.registerSignalCleanup ?? registerCliSignalCleanup)(async () => {
      interrupted = true;
      finish({ ok: false, reason: "interrupted" }, true);
      await shutdownComplete;
      if (shutdownStatus !== "terminated") {
        throw new Error("Project MCP preflight shutdown could not be confirmed");
      }
    });

    child.once("error", () => {
      if (shutdownStarted) return;
      finish({ ok: false, reason: "spawn_failed" }, true);
    });
    child.once("close", () => {
      if (shutdownStarted) return;
      finish({ ok: false, reason: "process_exited" }, true);
    });
    child.stderr.on("data", () => {
      // Drain diagnostics so a noisy package runner cannot block. Never echo it:
      // nested process errors can contain private paths or endpoint details.
    });
    child.stdout.on("data", (chunk) => {
      stdout += Buffer.from(chunk).toString("utf8");
      if (stdout.length > MAX_PROTOCOL_OUTPUT) {
        finish({ ok: false, reason: "invalid_response" });
        return;
      }
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          finish({ ok: false, reason: "invalid_response" });
          return;
        }
        if (!isRecord(message) || message.id !== INITIALIZE_ID) continue;
        if (isRecord(message.error)) {
          finish({ ok: false, reason: "initialize_rejected" });
          return;
        }
        const result = isRecord(message.result) ? message.result : undefined;
        if (!result || typeof result.protocolVersion !== "string" || !isRecord(result.serverInfo)) {
          finish({ ok: false, reason: "invalid_response" });
          return;
        }
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
        );
        finish({ ok: true, reason: "initialize_ok" });
        return;
      }
    });

    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: INITIALIZE_ID,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "dosu-cli-project-preflight", version: VERSION },
          },
        })}\n`,
      );
    } catch {
      finish({ ok: false, reason: "spawn_failed" });
    }
  });
}
