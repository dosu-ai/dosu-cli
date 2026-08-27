import { homedir } from "node:os";
import type { DejaSession, DriveStatus, RepositoryIdentity } from "./types";

const SPINNER_COLUMNS = 4;
const SUMMARY_LABEL_WIDTH = 15;

export function scanStatus(
  path: string,
  columns = process.stdout.columns || 80,
  homeDirectory = homedir(),
): string {
  const display =
    path === homeDirectory || path.startsWith(`${homeDirectory}/`)
      ? `~${path.slice(homeDirectory.length)}`
      : path;
  return truncateMiddle(`Scanning… ${display}`, Math.max(24, columns - SPINNER_COLUMNS));
}

export function renderHostStatus(
  status: Pick<DriveStatus, "contributors" | "packages" | "sessions" | "ready">,
): string {
  if (status.contributors === 0 && status.packages === 0) return "Waiting for contributors…";
  const contributors = countLabel(status.contributors, "contributor");
  if (status.packages === 0) return `${contributors} joined · Waiting for sessions…`;
  return `${contributors} · ${countLabel(status.packages, "repository", "repositories")} · ${countLabel(status.sessions, "session")} · ${status.ready ? "Ready" : "Indexing…"}`;
}

export function renderSessionSummary(
  repositories: readonly RepositoryIdentity[],
  sessionsByRepository: ReadonlyMap<string, readonly DejaSession[]>,
): string {
  const lines: string[] = [];
  let total = 0;
  for (const repository of repositories) {
    const sessions = sessionsByRepository.get(repository.root) ?? [];
    total += sessions.length;
    lines.push(`├─ ${repository.root}`);
    const counts = new Map<string, number>();
    for (const session of sessions) {
      counts.set(session.harness, (counts.get(session.harness) ?? 0) + 1);
    }
    const harnesses = [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
    if (harnesses.length === 0) {
      lines.push("│  └─ No sessions");
      continue;
    }
    for (const [index, [harness, count]] of harnesses.entries()) {
      const branch = index === harnesses.length - 1 ? "└─" : "├─";
      lines.push(
        `│  ${branch} ${displayHarness(harness).padEnd(SUMMARY_LABEL_WIDTH)}${countLabel(count, "session")}`,
      );
    }
  }
  lines.push(`└─ ${"Total".padEnd(SUMMARY_LABEL_WIDTH + 3)}${countLabel(total, "session")}`);
  return lines.join("\n");
}

export function displayHarness(harness: string): string {
  return harness
    .split(/[-_]/)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function truncateMiddle(value: string, maximum: number): string {
  const characters = [...value];
  if (characters.length <= maximum) return value;
  const available = maximum - 1;
  const beginning = Math.floor(available * 0.4);
  const ending = available - beginning;
  return `${characters.slice(0, beginning).join("")}…${characters.slice(-ending).join("")}`;
}
