/** Shared `[agents...]` resolution for the per-agent switch commands (hooks, incognito,
 * statusline): named ids are looked up and validated; no ids means every detected agent. */

import pc from "picocolors";

export interface SelectableAgent {
  id(): string;
  isInstalled(): boolean;
}

export function resolveAgents<T extends SelectableAgent>(
  ids: string[],
  all: () => T[],
  get: (id: string) => T | undefined,
): T[] {
  if (ids.length === 0) {
    const installed = all().filter((agent) => agent.isInstalled());
    if (installed.length === 0) {
      console.log(pc.dim("No supported agents detected on this machine."));
    }
    return installed;
  }
  const agents: T[] = [];
  for (const id of ids) {
    const agent = get(id.toLowerCase());
    if (!agent) {
      console.error(
        pc.red(
          `unknown agent '${id}'. Supported: ${all()
            .map((a) => a.id())
            .join(", ")}`,
        ),
      );
      process.exitCode = 1;
      return [];
    }
    agents.push(agent);
  }
  return agents;
}
