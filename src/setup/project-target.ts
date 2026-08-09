import { lstatSync, readFileSync } from "node:fs";
import {
  getNodeValue,
  type Node as JsonNode,
  type ParseError,
  parseTree,
} from "jsonc-parser/lib/esm/main.js";
import { parse as parseToml } from "smol-toml";
import {
  ownedProjectProxyOptionsForProvider,
  type ProjectProxyOptions,
  sameProjectProxyTarget,
} from "../mcp/project-proxy";
import type { SetupProvider } from "../mcp/providers";

export type ProviderProjectTargetInspection =
  | { disposition: "owned"; providerID: string; path: string; target: ProjectProxyOptions }
  | { disposition: "not_found"; providerID: string; path?: string }
  | { disposition: "ambiguous"; providerID: string; path: string };

export type ProjectPinnedTargetResolution =
  | { ok: true; target?: ProjectProxyOptions; providers: string[] }
  | {
      ok: false;
      reason:
        | "ambiguous_project_config"
        | "conflicting_project_targets"
        | "requested_project_target_conflict";
      providers: string[];
      paths: string[];
    };

export type RequestedProjectTarget = { mode: "oss" } | { mode: "cloud"; deploymentID?: string };

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function duplicateJsonKey(node: JsonNode): boolean {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0] ? getNodeValue(property.children[0]) : undefined;
      if (typeof key !== "string") continue;
      if (seen.has(key)) return true;
      seen.add(key);
    }
  }
  return (node.children ?? []).some(duplicateJsonKey);
}

function jsonTopKey(providerID: string): string {
  switch (providerID) {
    case "vscode":
      return "servers";
    case "zed":
      return "context_servers";
    case "opencode":
      return "mcp";
    default:
      return "mcpServers";
  }
}

function projectEntryFromJson(content: string, providerID: string): unknown {
  const errors: ParseError[] = [];
  const root = parseTree(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (!root || errors.length > 0 || root.type !== "object" || duplicateJsonKey(root)) {
    throw new Error("invalid project JSON");
  }
  const parsed: unknown = getNodeValue(root);
  if (!isRecord(parsed)) throw new Error("invalid project JSON");
  const section = parsed[jsonTopKey(providerID)];
  if (section === undefined) return undefined;
  if (!isRecord(section)) throw new Error("invalid project MCP section");
  return section.dosu;
}

function projectEntryFromToml(content: string): unknown {
  const parsed: unknown = parseToml(content);
  if (!isRecord(parsed) || !isRecord(parsed.mcp_servers)) return undefined;
  return parsed.mcp_servers.dosu;
}

/** Read a project pin only from an exact, secretless Dosu proxy emitted by a released CLI. */
export function inspectProviderProjectTarget(
  provider: SetupProvider,
  projectRoot: string,
): ProviderProjectTargetInspection {
  const providerID = provider.id();
  const path = provider.projectConfigPath(projectRoot);
  if (!path) return { disposition: "not_found", providerID };
  try {
    if (!entryExists(path)) return { disposition: "not_found", providerID, path };
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { disposition: "ambiguous", providerID, path };
    }
    const content = readFileSync(path, "utf8");
    const entry =
      providerID === "codex"
        ? projectEntryFromToml(content)
        : projectEntryFromJson(content, providerID);
    if (entry === undefined) return { disposition: "not_found", providerID, path };
    const target = ownedProjectProxyOptionsForProvider(providerID, entry);
    return target
      ? { disposition: "owned", providerID, path, target }
      : { disposition: "ambiguous", providerID, path };
  } catch {
    return { disposition: "ambiguous", providerID, path };
  }
}

export function resolveProjectPinnedTarget(
  providers: readonly SetupProvider[],
  projectRoot: string,
  requested?: RequestedProjectTarget,
  retargetProviderIDs: readonly string[] = [],
): ProjectPinnedTargetResolution {
  const inspections = providers.map((provider) =>
    inspectProviderProjectTarget(provider, projectRoot),
  );
  const ambiguous = inspections.filter(
    (
      inspection,
    ): inspection is Extract<ProviderProjectTargetInspection, { disposition: "ambiguous" }> =>
      inspection.disposition === "ambiguous",
  );
  if (ambiguous.length > 0) {
    return {
      ok: false,
      reason: "ambiguous_project_config",
      providers: ambiguous.map((inspection) => inspection.providerID),
      paths: uniqueStrings(ambiguous.map((inspection) => inspection.path)),
    };
  }
  const owned = inspections.filter(
    (
      inspection,
    ): inspection is Extract<ProviderProjectTargetInspection, { disposition: "owned" }> =>
      inspection.disposition === "owned",
  );
  if (owned.length === 0) return { ok: true, providers: [] };
  const mutableProviders = new Set(retargetProviderIDs);
  const mutablePaths = new Set(
    owned
      .filter((inspection) => mutableProviders.has(inspection.providerID))
      .map((inspection) => inspection.path),
  );
  const fixed = requested
    ? owned.filter(
        (inspection) =>
          !mutableProviders.has(inspection.providerID) && !mutablePaths.has(inspection.path),
      )
    : owned;
  const firstFixed = fixed[0]?.target;
  if (
    firstFixed &&
    fixed.some((inspection) => !sameProjectProxyTarget(firstFixed, inspection.target))
  ) {
    return {
      ok: false,
      reason: "conflicting_project_targets",
      providers: fixed.map((inspection) => inspection.providerID),
      paths: uniqueStrings(fixed.map((inspection) => inspection.path)),
    };
  }
  const requestedConflicts =
    requested?.mode === "oss"
      ? fixed.some((inspection) => inspection.target.oss !== true)
      : requested?.mode === "cloud"
        ? fixed.some(
            (inspection) =>
              inspection.target.oss === true ||
              (requested.deploymentID !== undefined &&
                inspection.target.deploymentID !== requested.deploymentID),
          )
        : false;
  if (requestedConflicts) {
    return {
      ok: false,
      reason: "requested_project_target_conflict",
      providers: fixed.map((inspection) => inspection.providerID),
      paths: uniqueStrings(fixed.map((inspection) => inspection.path)),
    };
  }
  let resolvedTarget: ProjectProxyOptions | undefined;
  if (requested?.mode === "oss") {
    resolvedTarget = { oss: true };
  } else if (requested?.mode === "cloud" && requested.deploymentID) {
    resolvedTarget = { deploymentID: requested.deploymentID };
  } else if (firstFixed) {
    resolvedTarget = firstFixed;
  } else if (requested?.mode === "cloud") {
    const firstOwned = owned[0].target;
    const allOwnedShareOneCloudTarget =
      firstOwned.oss !== true &&
      owned.every(
        (inspection) =>
          inspection.target.oss !== true && sameProjectProxyTarget(firstOwned, inspection.target),
      );
    resolvedTarget = allOwnedShareOneCloudTarget ? firstOwned : undefined;
  } else {
    const firstOwned = owned[0].target;
    if (owned.some((inspection) => !sameProjectProxyTarget(firstOwned, inspection.target))) {
      return {
        ok: false,
        reason: "conflicting_project_targets",
        providers: owned.map((inspection) => inspection.providerID),
        paths: uniqueStrings(owned.map((inspection) => inspection.path)),
      };
    }
    resolvedTarget = firstOwned;
  }
  const result: ProjectPinnedTargetResolution = {
    ok: true,
    providers: owned.map((inspection) => inspection.providerID),
  };
  if (resolvedTarget) result.target = resolvedTarget;
  return result;
}
