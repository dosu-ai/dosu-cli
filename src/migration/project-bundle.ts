import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  projectSkillEvidenceUnchanged,
  verifyProjectSkillInstallation,
} from "../commands/project-skill-ownership";
import { projectSkillInstallTargetsForProviders } from "../commands/skill";
import { providerUsesProjectInstructions } from "../setup/project-instructions";
import {
  isExactProjectCodexProxy,
  isExactProjectJsonProxy,
  type ProjectProxyExpectation,
} from "./planners";
import { assertProjectProof, type ProjectProof } from "./project-proof";
import type { ProviderId } from "./targets";

const projectBundleBrand: unique symbol = Symbol("DosuProjectBundleProof");
const projectBundleEvidence: unique symbol = Symbol("DosuProjectBundleEvidence");

const AGENTS_START = "<!-- dosu:mcp:start v2 -->";
const AGENTS_END = "<!-- dosu:mcp:end -->";
const ADAPTER_START = "<!-- dosu:project-instructions:start v1 -->";
const ADAPTER_END = "<!-- dosu:project-instructions:end -->";

type SupportedProjectProvider =
  | "claude"
  | "cursor"
  | "vscode"
  | "gemini"
  | "codex"
  | "zed"
  | "copilot"
  | "opencode"
  | "antigravity"
  | "mcporter"
  | "factory";

interface ProviderBundleSpec {
  mcpPath(root: string): string;
  topKey?: string;
  adapter?: "claude" | "gemini" | "antigravity";
}

const PROJECT_BUNDLE_SPECS: Readonly<Record<SupportedProjectProvider, ProviderBundleSpec>> = {
  claude: {
    mcpPath: (root) => join(root, ".mcp.json"),
    topKey: "mcpServers",
    adapter: "claude",
  },
  cursor: {
    mcpPath: (root) => join(root, ".cursor", "mcp.json"),
    topKey: "mcpServers",
  },
  vscode: {
    mcpPath: (root) => join(root, ".vscode", "mcp.json"),
    topKey: "servers",
  },
  gemini: {
    mcpPath: (root) => join(root, ".gemini", "settings.json"),
    topKey: "mcpServers",
    adapter: "gemini",
  },
  codex: {
    mcpPath: (root) => join(root, ".codex", "config.toml"),
  },
  zed: {
    mcpPath: (root) => join(root, ".zed", "settings.json"),
    topKey: "context_servers",
  },
  copilot: {
    mcpPath: (root) => join(root, ".mcp.json"),
    topKey: "mcpServers",
  },
  opencode: {
    mcpPath: (root) => join(root, "opencode.json"),
    topKey: "mcp",
  },
  antigravity: {
    mcpPath: (root) => join(root, ".agents", "mcp_config.json"),
    topKey: "mcpServers",
    adapter: "antigravity",
  },
  mcporter: {
    mcpPath: (root) => join(root, "config", "mcporter.json"),
    topKey: "mcpServers",
  },
  factory: {
    mcpPath: (root) => join(root, ".factory", "mcp.json"),
    topKey: "mcpServers",
  },
};

type BundleEvidence =
  | { kind: "file"; path: string; realPath: string; hash: string }
  | { kind: "directory"; path: string; realPath: string; hash: string }
  | { kind: "symlink"; path: string; realPath: string };

export interface ProjectBundleProof {
  readonly root: string;
  readonly providers: readonly SupportedProjectProvider[];
  readonly [projectBundleBrand]: true;
  readonly [projectBundleEvidence]: readonly BundleEvidence[];
}

export type ProjectBundleFailureReason =
  | "no_selected_provider"
  | "unsupported_provider"
  | "invalid_proxy_expectation"
  | "project_mcp_mismatch"
  | "project_instructions_mismatch"
  | "project_skill_mismatch";

export type ProjectBundleVerification =
  | { ok: true; proof: ProjectBundleProof }
  | { ok: false; reason: ProjectBundleFailureReason; provider?: ProviderId; path?: string };

export type ProjectBundleStatus = "valid" | "unauthorized_provider" | "changed";

function isSupportedProvider(provider: ProviderId): provider is SupportedProjectProvider {
  return Object.hasOwn(PROJECT_BUNDLE_SPECS, provider);
}

function containsPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." &&
      !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(path))
  );
}

function contentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function readRegularFile(
  path: string,
  realRoot: string,
): { content: string; evidence: BundleEvidence } | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const realPath = realpathSync(path);
    if (!containsPath(realRoot, realPath)) return null;
    const content = readFileSync(path, "utf8");
    return { content, evidence: { kind: "file", path, realPath, hash: contentHash(content) } };
  } catch {
    return null;
  }
}

function exactOwnedBlock(content: string, start: string, body: string, end: string): boolean {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex < 0 || endIndex < startIndex) return false;
  if (content.indexOf(start, startIndex + start.length) !== -1) return false;
  if (content.indexOf(end, endIndex + end.length) !== -1) return false;
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const expected = `${start}${eol}${body.trim().replace(/\r?\n/g, eol)}${eol}${end}`;
  return content.slice(startIndex, endIndex + end.length) === expected;
}

function adapterPath(root: string, adapter: NonNullable<ProviderBundleSpec["adapter"]>): string {
  switch (adapter) {
    case "claude":
      return join(root, "CLAUDE.md");
    case "gemini":
      return join(root, "GEMINI.md");
    case "antigravity":
      return join(root, ".agents", "rules", "dosu.md");
  }
}

function verifyAdapter(
  root: string,
  realRoot: string,
  adapter: NonNullable<ProviderBundleSpec["adapter"]>,
  instructionContent: string,
): BundleEvidence | null {
  const path = adapterPath(root, adapter);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      if (adapter === "antigravity") return null;
      const realPath = realpathSync(path);
      if (realPath !== realpathSync(join(root, "AGENTS.md"))) return null;
      return { kind: "symlink", path, realPath };
    }
  } catch {
    return null;
  }

  const file = readRegularFile(path, realRoot);
  if (!file) return null;
  const body = adapter === "antigravity" ? instructionContent : "@AGENTS.md";
  return exactOwnedBlock(file.content, ADAPTER_START, body, ADAPTER_END) ? file.evidence : null;
}

function verifyProjectSkill(
  root: string,
  providers: readonly SupportedProjectProvider[],
): BundleEvidence[] | null {
  const targets = projectSkillInstallTargetsForProviders(providers, root);
  const verification = verifyProjectSkillInstallation({ projectRoot: root, targets });
  return verification.ok ? verification.evidence : null;
}

function deduplicateEvidence(evidence: readonly BundleEvidence[]): BundleEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.kind}\0${item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validProxyExpectation(expectation: ProjectProxyExpectation): boolean {
  const value = expectation as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proxy = value as Record<string, unknown>;
  if (
    typeof proxy.packageVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(proxy.packageVersion)
  ) {
    return false;
  }
  const keys = Object.keys(proxy).sort();
  if (proxy.oss === true) {
    return keys.length === 2 && keys[0] === "oss" && keys[1] === "packageVersion";
  }
  const expectedKeys =
    proxy.oss === false
      ? ["deploymentID", "oss", "packageVersion"]
      : ["deploymentID", "packageVersion"];
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]) &&
    typeof proxy.deploymentID === "string" &&
    proxy.deploymentID.length > 0
  );
}

export function verifyProjectBundle(input: {
  project: ProjectProof;
  providerIDs: readonly ProviderId[];
  proxy: ProjectProxyExpectation;
  instructionContent: string;
}): ProjectBundleVerification {
  assertProjectProof(input.project);
  const providers = [...new Set(input.providerIDs)];
  if (providers.length === 0) return { ok: false, reason: "no_selected_provider" };
  const unsupported = providers.find((provider) => !isSupportedProvider(provider));
  if (unsupported) return { ok: false, reason: "unsupported_provider", provider: unsupported };
  if (!validProxyExpectation(input.proxy)) {
    return { ok: false, reason: "invalid_proxy_expectation" };
  }

  const supported = providers as SupportedProjectProvider[];
  let realRoot: string;
  try {
    realRoot = realpathSync(input.project.root);
  } catch {
    return { ok: false, reason: "project_mcp_mismatch" };
  }
  const evidence: BundleEvidence[] = [];

  for (const provider of supported) {
    const spec = PROJECT_BUNDLE_SPECS[provider];
    const path = spec.mcpPath(input.project.root);
    const file = readRegularFile(path, realRoot);
    if (!file) return { ok: false, reason: "project_mcp_mismatch", provider, path };
    const valid =
      provider === "codex"
        ? isExactProjectCodexProxy(file.content, input.proxy)
        : isExactProjectJsonProxy({
            content: file.content,
            provider,
            topKey: spec.topKey ?? "",
            expectation: input.proxy,
          });
    if (!valid) return { ok: false, reason: "project_mcp_mismatch", provider, path };
    evidence.push(file.evidence);
  }

  if (supported.some(providerUsesProjectInstructions)) {
    const path = join(input.project.root, "AGENTS.md");
    const agents = readRegularFile(path, realRoot);
    if (
      !agents ||
      !exactOwnedBlock(agents.content, AGENTS_START, input.instructionContent, AGENTS_END)
    ) {
      return { ok: false, reason: "project_instructions_mismatch", path };
    }
    evidence.push(agents.evidence);

    for (const provider of supported) {
      const adapter = PROJECT_BUNDLE_SPECS[provider].adapter;
      if (!adapter) continue;
      const adapterEvidence = verifyAdapter(
        input.project.root,
        realRoot,
        adapter,
        input.instructionContent,
      );
      if (!adapterEvidence) {
        return {
          ok: false,
          reason: "project_instructions_mismatch",
          provider,
          path: adapterPath(input.project.root, adapter),
        };
      }
      evidence.push(adapterEvidence);
    }
  }

  const skillProviders = supported.filter(
    (provider) => projectSkillInstallTargetsForProviders([provider], input.project.root).length > 0,
  );
  if (skillProviders.length > 0) {
    const skillEvidence = verifyProjectSkill(input.project.root, skillProviders);
    if (!skillEvidence) return { ok: false, reason: "project_skill_mismatch" };
    evidence.push(...skillEvidence);
  }

  const frozenProviders = Object.freeze([...supported]);
  const frozenEvidence = Object.freeze(deduplicateEvidence(evidence));
  const proof: ProjectBundleProof = {
    root: resolve(input.project.root),
    providers: frozenProviders,
    [projectBundleBrand]: true,
    [projectBundleEvidence]: frozenEvidence,
  };
  return {
    ok: true,
    proof: Object.freeze(proof),
  };
}

function evidenceUnchanged(evidence: BundleEvidence, realRoot: string): boolean {
  try {
    const stat = lstatSync(evidence.path);
    if (evidence.kind === "symlink") {
      return stat.isSymbolicLink() && realpathSync(evidence.path) === evidence.realPath;
    }
    if (stat.isSymbolicLink() || realpathSync(evidence.path) !== evidence.realPath) return false;
    if (evidence.kind === "file") {
      return stat.isFile() && contentHash(readFileSync(evidence.path)) === evidence.hash;
    }
    return stat.isDirectory() && projectSkillEvidenceUnchanged(evidence, realRoot);
  } catch {
    return false;
  }
}

export function projectBundleStatus(
  proof: ProjectBundleProof,
  provider: ProviderId,
): ProjectBundleStatus {
  if (proof?.[projectBundleBrand] !== true) return "changed";
  if (!proof.providers.includes(provider as SupportedProjectProvider))
    return "unauthorized_provider";
  let realRoot: string;
  try {
    realRoot = realpathSync(proof.root);
  } catch {
    return "changed";
  }
  return proof[projectBundleEvidence].every((evidence) => evidenceUnchanged(evidence, realRoot))
    ? "valid"
    : "changed";
}

export function assertProjectBundleProof(proof: ProjectBundleProof): void {
  if (proof?.[projectBundleBrand] !== true) {
    throw new Error("A verified project bundle proof is required for legacy migration");
  }
}
