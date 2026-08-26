import * as p from "@clack/prompts";
import { skillInstallTargetForProvider } from "../commands/skill";
import type { AccountTarget, Config } from "../config/config";
import { saveConfig } from "../config/config";
import { allSetupProviders, type SetupProvider } from "../mcp/providers";
import {
  fetchDosuRule,
  isRuleAgent,
  rulePathForAgent,
  validateRuleForAgentMutation,
} from "../rules/installer";
import { stepUpdateAgentsMd, validateAgentsMdMutation } from "./agents-md-step";
import { logLegacyGlobalReconciliation, runInstallSkill, stepConfigureTools } from "./flow";
import {
  type LegacyGlobalReconciliation,
  reconcileLegacyGlobalSetup,
} from "./legacy-global-cleanup";
import {
  inspectRepositoryBindings,
  type RepositoryBindingState,
  repositoryNeedsTargetReplacement,
} from "./project-inspection";
import {
  type ScannedRepository,
  scanGitRepositories,
  validateScanDirectories,
} from "./repository-scan";
import { stepConfigureAgentRules } from "./rules-step";

export interface BulkRepositoryResult {
  projectRoot: string;
  success: boolean;
  error?: string;
}

export interface BulkProjectSetupResult {
  status: "cancelled" | "blocked" | "failed" | "completed";
  repositories: BulkRepositoryResult[];
}

export interface BulkConfigureRepositoryRequest {
  config: Config;
  repository: ScannedRepository;
  selectedProviders: SetupProvider[];
  knownProviders: SetupProvider[];
  initialState: RepositoryBindingState;
  replaceExisting: boolean;
  instruction: string;
}

type ConfigureRepository = (
  request: BulkConfigureRepositoryRequest,
) => Promise<BulkRepositoryResult>;

export interface BulkProjectSetupDependencies {
  providers?: () => SetupProvider[];
  validateDirectories?: (inputs: readonly string[]) => string[];
  scanRepositories?: (directories: readonly string[]) => ScannedRepository[];
  inspectRepository?: (
    projectRoot: string,
    providers: readonly SetupProvider[],
  ) => RepositoryBindingState;
  installSkills?: (providers: SetupProvider[]) => Promise<boolean>;
  fetchInstruction?: () => Promise<string>;
  configureRepository?: ConfigureRepository;
  reconcileGlobal?: (
    selectedProviders: readonly SetupProvider[],
    projectRoot: string,
    knownProviders: readonly SetupProvider[],
  ) => LegacyGlobalReconciliation;
  saveConfig?: (config: Config) => void;
}

function targetKey(target: AccountTarget): string | null {
  return target.deployment_id && target.api_key ? target.deployment_id : null;
}

function availableTargets(config: Config): AccountTarget[] {
  const byID = new Map<string, AccountTarget>();
  for (const target of Object.values(config.active_account?.targets ?? {})) {
    const key = targetKey(target);
    if (key) byID.set(key, target);
  }
  const active = config.active_account?.target;
  const activeKey = active ? targetKey(active) : null;
  if (active && activeKey) byID.set(activeKey, active);
  return [...byID.values()].sort((left, right) =>
    (left.deployment_name ?? left.deployment_id ?? "").localeCompare(
      right.deployment_name ?? right.deployment_id ?? "",
    ),
  );
}

function configForTarget(config: Config, target: AccountTarget): Config {
  const copy = structuredClone(config);
  if (!copy.active_account) throw new Error("Authenticate before configuring projects in bulk.");
  copy.mode = undefined;
  copy.active_account.target = structuredClone(target);
  return copy;
}

function parseDirectoryInput(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function selectedTargetMatches(state: RepositoryBindingState, deploymentID: string): boolean {
  return (
    state.targets.length === 1 &&
    state.targets[0]?.kind === "deployment" &&
    state.targets[0].deploymentID === deploymentID
  );
}

export async function configureBulkRepository(
  request: BulkConfigureRepositoryRequest,
): Promise<BulkRepositoryResult> {
  const {
    config,
    repository,
    selectedProviders,
    knownProviders,
    initialState,
    replaceExisting,
    instruction,
  } = request;
  const currentState = inspectRepositoryBindings(repository.path, knownProviders);
  const deploymentID = config.active_account?.target?.deployment_id;
  if (
    initialState.blockers.length > 0 ||
    currentState.blockers.length > 0 ||
    !deploymentID ||
    (repositoryNeedsTargetReplacement(currentState, deploymentID) && !replaceExisting)
  ) {
    return {
      projectRoot: repository.path,
      success: false,
      error: "project configuration changed or cannot be safely replaced",
    };
  }

  try {
    validateAgentsMdMutation(repository.path);
    for (const provider of selectedProviders) {
      validateRuleForAgentMutation(provider.id(), repository.path);
    }
    const providerIDs = new Set(selectedProviders.map((provider) => provider.id()));
    if (replaceExisting) {
      for (const providerID of currentState.ownedProviderIDs) providerIDs.add(providerID);
    }
    const providersToInstall = knownProviders.filter((provider) => providerIDs.has(provider.id()));
    const mcpResults = stepConfigureTools(
      config,
      { toInstall: providersToInstall, toRemove: [], skipped: [] },
      repository.path,
    );
    const mcpFailure = mcpResults.find((result) => result.error);
    if (mcpFailure) throw mcpFailure.error;

    const ruleResults = await stepConfigureAgentRules(
      { toInstall: selectedProviders, toRemove: [] },
      mcpResults,
      repository.path,
      instruction,
    );
    const requiredRuleIDs = new Set(
      selectedProviders
        .filter(
          (provider) =>
            isRuleAgent(provider.id()) && rulePathForAgent(provider.id(), repository.path) !== null,
        )
        .map((provider) => provider.id()),
    );
    const successfulRuleIDs = new Set(
      ruleResults
        .filter((result) => !result.error && result.action !== "not_found")
        .map((result) => result.provider.id()),
    );
    if ([...requiredRuleIDs].some((providerID) => !successfulRuleIDs.has(providerID))) {
      throw new Error("a required project rule could not be verified");
    }
    if (!(await stepUpdateAgentsMd(repository.path, instruction))) {
      throw new Error("AGENTS.md could not be verified");
    }

    const after = inspectRepositoryBindings(repository.path, knownProviders);
    if (
      after.blockers.length > 0 ||
      !selectedTargetMatches(after, deploymentID) ||
      selectedProviders.some((provider) => !provider.isProjectConfigured(repository.path))
    ) {
      throw new Error("project MCP binding could not be verified");
    }
    return { projectRoot: repository.path, success: true };
  } catch (error: unknown) {
    return {
      projectRoot: repository.path,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function defaultDependencies(
  overrides: BulkProjectSetupDependencies,
): Required<BulkProjectSetupDependencies> {
  return {
    providers: allSetupProviders,
    validateDirectories: validateScanDirectories,
    scanRepositories: scanGitRepositories,
    inspectRepository: inspectRepositoryBindings,
    installSkills: async (providers) => {
      const supported = bulkSkillProviders(providers);
      return supported.length === 0 || runInstallSkill(supported);
    },
    fetchInstruction: fetchDosuRule,
    configureRepository: configureBulkRepository,
    reconcileGlobal: reconcileLegacyGlobalSetup,
    saveConfig,
    ...overrides,
  };
}

export function bulkSkillProviders(providers: readonly SetupProvider[]): SetupProvider[] {
  return providers.filter((provider) => skillInstallTargetForProvider(provider.id()) !== null);
}

function reloadableProjectProviders(providers: readonly SetupProvider[]): SetupProvider[] {
  return providers.filter(
    (provider) => provider.configurationKind() === "project" && provider.isInstalled(),
  );
}

function preview(
  target: AccountTarget,
  repositories: readonly { repository: ScannedRepository; replaceExisting: boolean }[],
  providers: readonly SetupProvider[],
): string {
  const replacementCount = repositories.filter((item) => item.replaceExisting).length;
  return [
    `Library: ${target.deployment_name ?? target.deployment_id}`,
    `Projects: ${repositories.length}`,
    `Agents: ${providers.map((provider) => provider.name()).join(", ")}`,
    `Library replacements: ${replacementCount}`,
    ...repositories.map(
      (item) => `  ${item.replaceExisting ? "replace" : "configure"} ${item.repository.path}`,
    ),
  ].join("\n");
}

export async function runBulkProjectSetup(
  config: Config,
  overrides: BulkProjectSetupDependencies = {},
): Promise<BulkProjectSetupResult> {
  const dependencies = defaultDependencies(overrides);
  const targets = availableTargets(config);
  if (targets.length === 0) {
    p.log.warn("No Library credential is available. Configure the current project first.");
    return { status: "blocked", repositories: [] };
  }

  const targetID = await p.select({
    message: "Select Library",
    options: targets.map((target) => ({
      label: target.deployment_name ?? target.deployment_id ?? "Unnamed Library",
      value: target.deployment_id ?? "",
    })),
  });
  if (p.isCancel(targetID)) return { status: "cancelled", repositories: [] };
  const target = targets.find((candidate) => candidate.deployment_id === targetID);
  if (!target?.deployment_id) return { status: "blocked", repositories: [] };

  const directoryInput = await p.text({
    message: "Directories to scan (comma or newline separated)",
    initialValue: config.scan_directories?.join(", ") ?? "",
    placeholder: "~/code, ~/work",
  });
  if (p.isCancel(directoryInput)) return { status: "cancelled", repositories: [] };
  let scanDirectories: string[];
  try {
    scanDirectories = dependencies.validateDirectories(parseDirectoryInput(String(directoryInput)));
  } catch (error: unknown) {
    p.log.error(error instanceof Error ? error.message : String(error));
    return { status: "blocked", repositories: [] };
  }

  const knownProviders = dependencies.providers();
  const repositories = dependencies.scanRepositories(scanDirectories);
  if (repositories.length === 0) {
    p.log.warn("No Git repositories or worktrees were found in those directories.");
    return { status: "blocked", repositories: [] };
  }
  const states = new Map(
    repositories.map((repository) => [
      repository.path,
      dependencies.inspectRepository(repository.path, knownProviders),
    ]),
  );
  const repositoryIDs = await p.multiselect({
    message: "Select projects",
    options: repositories.map((repository) => {
      const state = states.get(repository.path);
      const blocked = Boolean(state?.blockers.length);
      return {
        label: repository.path,
        value: repository.path,
        hint: blocked
          ? "blocked: foreign or malformed config"
          : state?.targets.length
            ? "already bound to a Library"
            : repository.kind,
        ...(blocked ? { disabled: true } : {}),
      };
    }),
    initialValues: repositories
      .filter((repository) => !states.get(repository.path)?.blockers.length)
      .map((repository) => repository.path),
    required: true,
  });
  if (p.isCancel(repositoryIDs)) return { status: "cancelled", repositories: [] };
  const requestedIDs = new Set(repositoryIDs as string[]);
  const selectedRepositories: Array<{
    repository: ScannedRepository;
    state: RepositoryBindingState;
    replaceExisting: boolean;
  }> = [];
  for (const repository of repositories) {
    if (!requestedIDs.has(repository.path)) continue;
    const state = states.get(repository.path);
    if (!state || state.blockers.length > 0) {
      p.log.warn(`Skipped blocked project: ${repository.path}`);
      continue;
    }
    const replaceExisting = repositoryNeedsTargetReplacement(state, target.deployment_id);
    if (replaceExisting) {
      const replace = await p.confirm({
        message: `${repository.path} is bound to another Library. Replace its Dosu binding?`,
      });
      if (p.isCancel(replace)) return { status: "cancelled", repositories: [] };
      if (!replace) continue;
    }
    selectedRepositories.push({ repository, state, replaceExisting });
  }
  if (selectedRepositories.length === 0) {
    p.log.warn("No projects remain selected.");
    return { status: "cancelled", repositories: [] };
  }

  const availableProviders = reloadableProjectProviders(knownProviders);
  if (availableProviders.length === 0) {
    p.log.warn("No supported project-scoped agents are installed.");
    return { status: "blocked", repositories: [] };
  }
  const providerIDs = await p.multiselect({
    message: "Select agents",
    options: availableProviders.map((provider) => ({
      label: provider.name(),
      value: provider.id(),
    })),
    required: true,
  });
  if (p.isCancel(providerIDs)) return { status: "cancelled", repositories: [] };
  const selectedProviderIDs = new Set(providerIDs as string[]);
  const selectedProviders = availableProviders.filter((provider) =>
    selectedProviderIDs.has(provider.id()),
  );
  if (selectedProviders.length === 0) return { status: "cancelled", repositories: [] };

  p.log.info(preview(target, selectedRepositories, selectedProviders));
  const confirmed = await p.confirm({ message: "Apply this plan?" });
  if (p.isCancel(confirmed) || !confirmed) return { status: "cancelled", repositories: [] };

  if (!(await dependencies.installSkills(selectedProviders))) {
    p.log.error("Official Dosu skills could not be installed; no project was changed.");
    return { status: "failed", repositories: [] };
  }
  let instruction: string;
  try {
    instruction = await dependencies.fetchInstruction();
    config.scan_directories = scanDirectories;
    dependencies.saveConfig(config);
  } catch (error: unknown) {
    p.log.error(
      `Could not prepare bulk project setup: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { status: "failed", repositories: [] };
  }
  const projectConfig = configForTarget(config, target);
  const results: BulkRepositoryResult[] = [];
  for (const selected of selectedRepositories) {
    try {
      const result = await dependencies.configureRepository({
        config: projectConfig,
        repository: selected.repository,
        selectedProviders,
        knownProviders,
        initialState: selected.state,
        replaceExisting: selected.replaceExisting,
        instruction,
      });
      results.push(result);
      if (!result.success) {
        p.log.error(`${result.projectRoot}: ${result.error ?? "project setup failed"}`);
      }
    } catch (error: unknown) {
      const result = {
        projectRoot: selected.repository.path,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      results.push(result);
      p.log.error(`${result.projectRoot}: ${result.error}`);
    }
  }

  if (results.length > 0 && results.every((result) => result.success)) {
    try {
      logLegacyGlobalReconciliation(
        dependencies.reconcileGlobal(selectedProviders, results[0].projectRoot, knownProviders),
      );
    } catch {
      p.log.warn("Project setup succeeded, but old global configuration was left unchanged.");
    }
  }
  const succeeded = results.filter((result) => result.success).length;
  const failed = results.length - succeeded;
  if (failed > 0) p.log.warn(`Configured ${succeeded} project(s); ${failed} failed.`);
  else p.log.success(`Configured ${succeeded} project(s).`);
  return { status: "completed", repositories: results };
}
