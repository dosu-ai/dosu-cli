import { existsSync } from "node:fs";
import { getJSONServer } from "../mcp/config-helpers";
import { type ProjectMcpTarget, projectMcpTarget } from "../mcp/project-proxy";
import type { SetupProvider } from "../mcp/providers";
import { readCodexProjectMcpEntry } from "../mcp/providers/codex";
import { assertSafeProjectPath } from "./project-root";

export type ProjectProviderInspection =
  | { providerID: string; path: string | null; status: "absent" }
  | {
      providerID: string;
      path: string;
      status: "owned";
      target: ProjectMcpTarget;
    }
  | { providerID: string; path: string; status: "foreign" }
  | { providerID: string; path: string | null; status: "malformed"; error?: string };

type ProjectBindingBlocker = Extract<
  ProjectProviderInspection,
  { status: "foreign" | "malformed" }
>;

export interface RepositoryBindingState {
  projectRoot: string;
  inspections: ProjectProviderInspection[];
  blockers: ProjectBindingBlocker[];
  targets: ProjectMcpTarget[];
  ownedProviderIDs: string[];
}

const JSON_TOP_KEY: Readonly<Record<string, string>> = {
  claude: "mcpServers",
  cursor: "mcpServers",
  vscode: "servers",
  gemini: "mcpServers",
  zed: "context_servers",
  copilot: "mcpServers",
  opencode: "mcp",
  mcporter: "mcpServers",
  factory: "mcpServers",
};

export function inspectProjectProvider(
  provider: SetupProvider,
  projectRoot: string,
): ProjectProviderInspection {
  const providerID = provider.id();
  let path: string | null = null;

  try {
    path = provider.projectConfigPath(projectRoot);
    if (!path) return { providerID, path, status: "absent" };
    assertSafeProjectPath(projectRoot, path);
    if (!existsSync(path)) return { providerID, path, status: "absent" };
    let entry: unknown;
    if (providerID === "codex") {
      entry = readCodexProjectMcpEntry(projectRoot);
    } else {
      const topKey = JSON_TOP_KEY[providerID];
      if (!topKey) {
        return {
          providerID,
          path,
          status: "malformed",
          error: "unsupported project config format",
        };
      }
      entry = getJSONServer(path, topKey);
    }
    if (entry === undefined) return { providerID, path, status: "absent" };
    const target = projectMcpTarget(entry);
    if (!target) return { providerID, path, status: "foreign" };
    return { providerID, path, status: "owned", target };
  } catch (error: unknown) {
    return {
      providerID,
      path,
      status: "malformed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function targetKey(target: ProjectMcpTarget): string {
  return target.kind === "oss" ? "oss" : `deployment:${target.deploymentID}`;
}

export function inspectRepositoryBindings(
  projectRoot: string,
  providers: readonly SetupProvider[],
): RepositoryBindingState {
  const inspections = providers
    .filter((provider) => provider.configurationKind() === "project")
    .map((provider) => inspectProjectProvider(provider, projectRoot));
  const blockerByPath = new Map<string, ProjectBindingBlocker>();
  const targetByKey = new Map<string, ProjectMcpTarget>();
  const ownedProviderIDs = new Set<string>();

  for (const inspection of inspections) {
    if (inspection.status === "foreign" || inspection.status === "malformed") {
      blockerByPath.set(inspection.path ?? `${inspection.providerID}:unknown`, inspection);
    }
    if (inspection.status === "owned") {
      targetByKey.set(targetKey(inspection.target), inspection.target);
      ownedProviderIDs.add(inspection.providerID);
    }
  }

  return {
    projectRoot,
    inspections,
    blockers: [...blockerByPath.values()],
    targets: [...targetByKey.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, target]) => target),
    ownedProviderIDs: [...ownedProviderIDs].sort(),
  };
}

export function repositoryNeedsTargetReplacement(
  state: RepositoryBindingState,
  deploymentID: string,
): boolean {
  return state.targets.some(
    (target) => target.kind === "oss" || target.deploymentID !== deploymentID,
  );
}
