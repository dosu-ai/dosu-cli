import { spawn as nodeSpawn } from "node:child_process";

export interface KillableProcess {
  pid?: number;
  kill(signal: NodeJS.Signals): boolean;
}

interface TreeKillerProcess {
  once(event: "error", listener: () => void): TreeKillerProcess;
  once(event: "close", listener: (code: number | null) => void): TreeKillerProcess;
  kill(signal: NodeJS.Signals): boolean;
}

export type SpawnTreeKiller = (
  command: string,
  args: string[],
  options: {
    shell: false;
    stdio: "ignore";
    windowsHide: true;
  },
) => TreeKillerProcess;

export interface WindowsTreeShutdownDependencies {
  spawnTreeKiller?: SpawnTreeKiller;
  shutdownDeadlineMs?: number;
}

export type ProcessTreeShutdownResult = "terminated" | "unconfirmed";

export type KillProcessGroup = (pid: number, signal: NodeJS.Signals | 0) => void;

export interface PosixTreeShutdownDependencies {
  killProcessGroup?: KillProcessGroup;
  killGraceMs?: number;
  shutdownDeadlineMs?: number;
}

function isPositivePID(pid: number | undefined): pid is number {
  return Number.isSafeInteger(pid) && (pid ?? 0) > 0;
}

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}

/**
 * Terminate a Windows shell and every descendant without putting runtime
 * secrets on a second command line. The promise always resolves by its hard
 * deadline, even if taskkill and the original child never emit `close`.
 */
export async function terminateWindowsProcessTree(
  child: KillableProcess,
  deps: WindowsTreeShutdownDependencies = {},
): Promise<ProcessTreeShutdownResult> {
  return await new Promise<ProcessTreeShutdownResult>((resolve) => {
    let settled = false;
    let treeKiller: TreeKillerProcess | undefined;

    const settle = (result: ProcessTreeShutdownResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const killShellFallback = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The shell may already have exited while taskkill was running.
      }
      settle("unconfirmed");
    };
    const deadline = setTimeout(
      () => {
        try {
          treeKiller?.kill("SIGKILL");
        } catch {
          // A concurrently closed taskkill process needs no cleanup.
        }
        killShellFallback();
      },
      Math.max(1, deps.shutdownDeadlineMs ?? 1_000),
    );

    if (!isPositivePID(child.pid)) {
      killShellFallback();
      return;
    }

    try {
      treeKiller = (deps.spawnTreeKiller ?? (nodeSpawn as unknown as SpawnTreeKiller))(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        { shell: false, stdio: "ignore", windowsHide: true },
      );
      treeKiller.once("error", killShellFallback);
      treeKiller.once("close", (code) => {
        if (code === 0) settle("terminated");
        else killShellFallback();
      });
    } catch {
      killShellFallback();
    }
  });
}

type GroupStatus = "present" | "absent" | "unknown";

function processGroupStatus(groupID: number, killProcessGroup: KillProcessGroup): GroupStatus {
  try {
    killProcessGroup(groupID, 0);
    return "present";
  } catch (error: unknown) {
    return codeOf(error) === "ESRCH" ? "absent" : "unknown";
  }
}

function signalProcessGroup(
  groupID: number,
  signal: NodeJS.Signals,
  killProcessGroup: KillProcessGroup,
): GroupStatus {
  try {
    killProcessGroup(groupID, signal);
    return "present";
  } catch (error: unknown) {
    return codeOf(error) === "ESRCH" ? "absent" : "unknown";
  }
}

async function waitForGroupExit(
  groupID: number,
  timeoutMs: number,
  killProcessGroup: KillProcessGroup,
): Promise<GroupStatus> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (true) {
    const status = processGroupStatus(groupID, killProcessGroup);
    // EPERM can be transient while a killed descendant is being reparented or
    // reaped (notably under Darwin sandbox/load). It is not proof of cleanup,
    // but neither should it bypass the remaining TERM/KILL deadline. Only
    // ESRCH confirms that the group is gone.
    if (status === "absent") return status;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return status;
    await delay(Math.min(10, remaining));
  }
}

/**
 * Terminate the dedicated process group created for npx and all descendants.
 * A missing PID cannot prove tree cleanup, so it deliberately returns
 * `unconfirmed` after best-effort direct-child TERM/KILL signals.
 */
export async function terminatePosixProcessTree(
  child: KillableProcess,
  deps: PosixTreeShutdownDependencies = {},
): Promise<ProcessTreeShutdownResult> {
  const graceMs = Math.max(1, deps.killGraceMs ?? 250);
  const deadlineMs = Math.max(1, deps.shutdownDeadlineMs ?? 1_000);
  if (!isPositivePID(child.pid)) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Continue to the forced best-effort signal.
    }
    await delay(graceMs);
    try {
      child.kill("SIGKILL");
    } catch {
      // Cleanup cannot be confirmed without a process-group ID.
    }
    return "unconfirmed";
  }

  const groupID = -child.pid;
  const killProcessGroup = deps.killProcessGroup ?? process.kill.bind(process);
  const termStatus = signalProcessGroup(groupID, "SIGTERM", killProcessGroup);
  if (termStatus === "absent") return "terminated";
  if (termStatus === "unknown") return "unconfirmed";

  const afterTerm = await waitForGroupExit(groupID, graceMs, killProcessGroup);
  if (afterTerm === "absent") return "terminated";

  const killStatus = signalProcessGroup(groupID, "SIGKILL", killProcessGroup);
  if (killStatus === "absent") return "terminated";

  const afterKill = await waitForGroupExit(groupID, deadlineMs, killProcessGroup);
  return afterKill === "absent" ? "terminated" : "unconfirmed";
}
