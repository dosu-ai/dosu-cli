import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertProjectBundleProof,
  projectBundleStatus,
  verifyProjectBundle,
} from "./project-bundle";
import { proveProjectScope } from "./project-proof";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dosu-project-bundle-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function gitProof() {
  const result = proveProjectScope({
    cwd: root,
    gitTopLevel: root,
    insideWorkTree: true,
    bareRepository: false,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.proof;
}

function writeClaudeBundle(deploymentID = "dep-project"): void {
  // skills@1.5.22 writes a direct Claude copy for a one-agent install.
  const skillDir = join(root, ".claude", "skills", "dosu");
  mkdirSync(skillDir, { recursive: true });
  const skill = "---\nname: dosu\ndescription: Dosu knowledge\n---\nUse Dosu.\n";
  writeFileSync(join(skillDir, "SKILL.md"), skill);
  const computedHash = createHash("sha256").update("SKILL.md").update(skill).digest("hex");
  writeFileSync(
    join(root, "skills-lock.json"),
    JSON.stringify({
      version: 1,
      skills: {
        dosu: {
          source: "dosu-ai/dosu-skill",
          sourceType: "github",
          skillPath: "skills/dosu/SKILL.md",
          computedHash,
        },
      },
    }),
  );
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        dosu: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@dosu/cli@0.43.0", "mcp", "proxy", "--deployment", deploymentID],
        },
      },
    }),
  );
  writeFileSync(
    join(root, "AGENTS.md"),
    "<!-- dosu:mcp:start v2 -->\nUse Dosu.\n<!-- dosu:mcp:end -->\n",
  );
  writeFileSync(
    join(root, "CLAUDE.md"),
    "<!-- dosu:project-instructions:start v1 -->\n@AGENTS.md\n<!-- dosu:project-instructions:end -->\n",
  );
}

function writeCanonicalSkill(): void {
  const skillDir = join(root, ".agents", "skills", "dosu");
  mkdirSync(skillDir, { recursive: true });
  const skill = "---\nname: dosu\ndescription: Dosu knowledge\n---\nUse Dosu.\n";
  writeFileSync(join(skillDir, "SKILL.md"), skill);
  const computedHash = createHash("sha256").update("SKILL.md").update(skill).digest("hex");
  writeFileSync(
    join(root, "skills-lock.json"),
    JSON.stringify({
      version: 1,
      skills: {
        dosu: {
          source: "dosu-ai/dosu-skill",
          sourceType: "github",
          skillPath: "skills/dosu/SKILL.md",
          computedHash,
        },
      },
    }),
  );
}

function writeFactoryBundle(includeSkill = true): void {
  mkdirSync(join(root, ".factory"), { recursive: true });
  writeFileSync(
    join(root, ".factory", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        dosu: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@dosu/cli@0.43.0", "mcp", "proxy", "--deployment", "dep-project"],
        },
      },
    }),
  );
  writeFileSync(
    join(root, "AGENTS.md"),
    "<!-- dosu:mcp:start v2 -->\nUse Dosu.\n<!-- dosu:mcp:end -->\n",
  );
  if (!includeSkill) return;
  const skillDir = join(root, ".factory", "skills", "dosu");
  mkdirSync(skillDir, { recursive: true });
  const skill = "---\nname: dosu\ndescription: Dosu knowledge\n---\nUse Dosu.\n";
  writeFileSync(join(skillDir, "SKILL.md"), skill);
  const computedHash = createHash("sha256").update("SKILL.md").update(skill).digest("hex");
  writeFileSync(
    join(root, "skills-lock.json"),
    JSON.stringify({
      version: 1,
      skills: {
        dosu: {
          source: "dosu-ai/dosu-skill",
          sourceType: "github",
          skillPath: "skills/dosu/SKILL.md",
          computedHash,
        },
      },
    }),
  );
}

function verifyClaude() {
  return verifyProjectBundle({
    project: gitProof(),
    providerIDs: ["claude"],
    proxy: { packageVersion: "0.43.0", deploymentID: "dep-project" },
    instructionContent: "Use Dosu.",
  });
}

function writeMcporterBundle(target: "dep-project" | "oss" = "dep-project"): void {
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "mcporter.json"),
    JSON.stringify({
      mcpServers: {
        dosu: {
          command: "npx",
          args:
            target === "oss"
              ? ["-y", "@dosu/cli@0.43.0", "mcp", "proxy", "--oss"]
              : ["-y", "@dosu/cli@0.43.0", "mcp", "proxy", "--deployment", target],
        },
      },
    }),
  );
}

describe("file-backed project bundle proof", () => {
  it("rejects a relative Git root instead of resolving it against process cwd", () => {
    expect(
      proveProjectScope({
        cwd: root,
        gitTopLevel: "relative-project",
        insideWorkTree: true,
        bareRepository: false,
      }),
    ).toEqual({ ok: false, reason: "invalid_git_root" });
  });

  it("authorizes only after exact MCP, instructions, adapter, skill, and lock are re-read", () => {
    writeClaudeBundle();
    expect(verifyClaude()).toMatchObject({ ok: true });
  });

  it("rejects unsupported providers and wrong deployment or credential-bearing proxies", () => {
    writeClaudeBundle("wrong-deployment");
    expect(verifyClaude()).toMatchObject({ ok: false, reason: "project_mcp_mismatch" });

    const unsupported = verifyProjectBundle({
      project: gitProof(),
      providerIDs: ["cline"],
      proxy: { packageVersion: "0.43.0", deploymentID: "dep-project" },
      instructionContent: "Use Dosu.",
    });
    expect(unsupported).toMatchObject({ ok: false, reason: "unsupported_provider" });

    expect(
      verifyProjectBundle({
        project: gitProof(),
        providerIDs: ["claude"],
        proxy: {} as never,
        instructionContent: "Use Dosu.",
      }),
    ).toEqual({ ok: false, reason: "invalid_proxy_expectation" });

    writeClaudeBundle();
    const path = join(root, ".mcp.json");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    parsed.mcpServers.dosu.headers = { "X-Dosu-API-Key": "secret" };
    writeFileSync(path, JSON.stringify(parsed));
    expect(verifyClaude()).toMatchObject({ ok: false, reason: "project_mcp_mismatch" });
  });

  it("rejects missing exact adapter, skill provenance, or skill content hash", () => {
    writeClaudeBundle();
    writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md\n");
    expect(verifyClaude()).toMatchObject({ ok: false, reason: "project_instructions_mismatch" });

    writeClaudeBundle();
    writeFileSync(join(root, "skills-lock.json"), '{"version":1,"skills":{}}');
    expect(verifyClaude()).toMatchObject({ ok: false, reason: "project_skill_mismatch" });

    writeClaudeBundle();
    writeFileSync(join(root, ".claude", "skills", "dosu", "SKILL.md"), "user replacement");
    expect(verifyClaude()).toMatchObject({ ok: false, reason: "project_skill_mismatch" });
  });

  it("requires at least one selected project-capable provider", () => {
    expect(
      verifyProjectBundle({
        project: gitProof(),
        providerIDs: [],
        proxy: { packageVersion: "0.43.0", deploymentID: "dep-project" },
        instructionContent: "Use Dosu.",
      }),
    ).toEqual({ ok: false, reason: "no_selected_provider" });
  });

  it.each([
    ["non-object", null],
    ["array", []],
    ["bad version", { packageVersion: "latest", deploymentID: "dep-project" }],
    ["empty deployment", { packageVersion: "0.43.0", deploymentID: "" }],
    ["extra field", { packageVersion: "0.43.0", deploymentID: "dep-project", extra: true }],
    ["invalid OSS keys", { packageVersion: "0.43.0", oss: true, deploymentID: "dep" }],
    ["non-string deployment", { packageVersion: "0.43.0", deploymentID: 7 }],
  ])("rejects an invalid proxy expectation: %s", (_name, proxy) => {
    expect(
      verifyProjectBundle({
        project: gitProof(),
        providerIDs: ["mcporter"],
        proxy: proxy as never,
        instructionContent: "Use Dosu.",
      }),
    ).toEqual({ ok: false, reason: "invalid_proxy_expectation" });
  });

  it("verifies the MCP-only MCPorter bundle and rechecks its file evidence", () => {
    writeMcporterBundle();
    const verification = verifyProjectBundle({
      project: gitProof(),
      providerIDs: ["mcporter", "mcporter"],
      proxy: { packageVersion: "0.43.0", deploymentID: "dep-project" },
      instructionContent: "Use Dosu.",
    });
    expect(verification).toMatchObject({ ok: true });
    if (!verification.ok) throw new Error(verification.reason);
    expect(projectBundleStatus(verification.proof, "mcporter")).toBe("valid");
    expect(projectBundleStatus(verification.proof, "cursor")).toBe("unauthorized_provider");

    writeFileSync(join(root, "config", "mcporter.json"), '{"mcpServers":{}}');
    expect(projectBundleStatus(verification.proof, "mcporter")).toBe("changed");
  });

  it("revalidates every kind of evidence in a complete Claude bundle", () => {
    writeClaudeBundle();
    const verification = verifyClaude();
    if (!verification.ok) throw new Error(verification.reason);
    expect(projectBundleStatus(verification.proof, "claude")).toBe("valid");

    rmSync(join(root, ".claude", "skills", "dosu", "SKILL.md"));
    expect(projectBundleStatus(verification.proof, "claude")).toBe("changed");
  });

  it("verifies an OSS MCP-only bundle", () => {
    writeMcporterBundle("oss");
    expect(
      verifyProjectBundle({
        project: gitProof(),
        providerIDs: ["mcporter"],
        proxy: { packageVersion: "0.43.0", oss: true },
        instructionContent: "Use Dosu.",
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects project config symlinks even when their content is exact", () => {
    writeMcporterBundle();
    const path = join(root, "config", "mcporter.json");
    const foreign = join(root, "foreign.json");
    writeFileSync(foreign, readFileSync(path));
    rmSync(path);
    symlinkSync(foreign, path);
    expect(
      verifyProjectBundle({
        project: gitProof(),
        providerIDs: ["mcporter"],
        proxy: { packageVersion: "0.43.0", deploymentID: "dep-project" },
        instructionContent: "Use Dosu.",
      }),
    ).toMatchObject({ ok: false, reason: "project_mcp_mismatch", provider: "mcporter" });
  });

  it.each([
    ["cursor", ".cursor/mcp.json"],
    ["vscode", ".vscode/mcp.json"],
    ["gemini", ".gemini/settings.json"],
    ["codex", ".codex/config.toml"],
    ["zed", ".zed/settings.json"],
    ["copilot", ".mcp.json"],
    ["opencode", "opencode.json"],
    ["antigravity", ".agents/mcp_config.json"],
    ["factory", ".factory/mcp.json"],
  ] as const)("reports the documented missing project path for %s", (provider, relativePath) => {
    expect(
      verifyProjectBundle({
        project: gitProof(),
        providerIDs: [provider],
        proxy: { packageVersion: "0.43.0", deploymentID: "dep-project" },
        instructionContent: "Use Dosu.",
      }),
    ).toMatchObject({
      ok: false,
      reason: "project_mcp_mismatch",
      provider,
      path: join(root, ...relativePath.split("/")),
    });
  });

  it("verifies an exact Codex TOML bundle and notices when the project disappears", () => {
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(
      join(root, ".codex", "config.toml"),
      '[mcp_servers.dosu]\ncommand = "npx"\nargs = ["-y", "@dosu/cli@0.43.0", "mcp", "proxy", "--deployment", "dep-project"]\n',
    );
    writeFileSync(
      join(root, "AGENTS.md"),
      "<!-- dosu:mcp:start v2 -->\nUse Dosu.\n<!-- dosu:mcp:end -->\n",
    );
    writeCanonicalSkill();
    const verification = verifyProjectBundle({
      project: gitProof(),
      providerIDs: ["codex"],
      proxy: { packageVersion: "0.43.0", deploymentID: "dep-project" },
      instructionContent: "Use Dosu.",
    });
    expect(verification).toMatchObject({ ok: true });
    if (!verification.ok) throw new Error(verification.reason);

    rmSync(root, { recursive: true });
    expect(projectBundleStatus(verification.proof, "codex")).toBe("changed");
  });

  it("requires and revalidates the complete Factory MCP, instructions, and Droid skill bundle", () => {
    writeFactoryBundle(false);
    const input = {
      project: gitProof(),
      providerIDs: ["factory"],
      proxy: { packageVersion: "0.43.0", deploymentID: "dep-project" },
      instructionContent: "Use Dosu.",
    } as const;

    expect(verifyProjectBundle(input)).toMatchObject({
      ok: false,
      reason: "project_skill_mismatch",
    });

    writeFactoryBundle();
    const verification = verifyProjectBundle(input);
    expect(verification).toMatchObject({ ok: true });
    if (!verification.ok) throw new Error(verification.reason);
    expect(projectBundleStatus(verification.proof, "factory")).toBe("valid");

    writeFileSync(join(root, ".factory", "skills", "dosu", "SKILL.md"), "user edit");
    expect(projectBundleStatus(verification.proof, "factory")).toBe("changed");
  });

  it("accepts a Claude adapter symlink only when it resolves to canonical AGENTS.md", () => {
    writeClaudeBundle();
    rmSync(join(root, "CLAUDE.md"));
    symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
    const verification = verifyClaude();
    expect(verification).toMatchObject({ ok: true });
    if (!verification.ok) throw new Error(verification.reason);

    rmSync(join(root, "CLAUDE.md"));
    writeFileSync(join(root, "other.md"), "@AGENTS.md");
    symlinkSync("other.md", join(root, "CLAUDE.md"));
    expect(projectBundleStatus(verification.proof, "claude")).toBe("changed");
    expect(verifyClaude()).toMatchObject({
      ok: false,
      reason: "project_instructions_mismatch",
      provider: "claude",
    });
  });

  it.each([
    "gemini",
    "antigravity",
  ] as const)("verifies the exact %s instruction adapter and rejects adapter symlinks", (provider) => {
    const configPath =
      provider === "gemini"
        ? join(root, ".gemini", "settings.json")
        : join(root, ".agents", "mcp_config.json");
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          dosu: {
            command: "npx",
            args: ["-y", "@dosu/cli@0.43.0", "mcp", "proxy", "--deployment", "dep-project"],
          },
        },
      }),
    );
    writeFileSync(
      join(root, "AGENTS.md"),
      "<!-- dosu:mcp:start v2 -->\nUse Dosu.\n<!-- dosu:mcp:end -->\n",
    );
    const adapterPath =
      provider === "gemini" ? join(root, "GEMINI.md") : join(root, ".agents", "rules", "dosu.md");
    mkdirSync(join(adapterPath, ".."), { recursive: true });
    writeFileSync(
      adapterPath,
      `<!-- dosu:project-instructions:start v1 -->\n${provider === "gemini" ? "@AGENTS.md" : "Use Dosu."}\n<!-- dosu:project-instructions:end -->\n`,
    );
    writeCanonicalSkill();

    const input = {
      project: gitProof(),
      providerIDs: [provider],
      proxy: { packageVersion: "0.43.0", deploymentID: "dep-project" },
      instructionContent: "Use Dosu.",
    } as const;
    expect(verifyProjectBundle(input)).toMatchObject({ ok: true });

    rmSync(adapterPath);
    symlinkSync(join(root, "AGENTS.md"), adapterPath);
    expect(verifyProjectBundle(input)).toMatchObject({
      ok: provider === "gemini",
      ...(provider === "antigravity"
        ? { reason: "project_instructions_mismatch", provider: "antigravity" }
        : {}),
    });
  });

  it("rejects duplicate or edited instruction marker blocks", () => {
    writeClaudeBundle();
    writeFileSync(
      join(root, "AGENTS.md"),
      "<!-- dosu:mcp:start v2 -->\nEdited\n<!-- dosu:mcp:end -->\n<!-- dosu:mcp:start v2 -->\nUse Dosu.\n<!-- dosu:mcp:end -->\n",
    );
    expect(verifyClaude()).toMatchObject({
      ok: false,
      reason: "project_instructions_mismatch",
    });

    writeClaudeBundle();
    writeFileSync(
      join(root, "AGENTS.md"),
      "<!-- dosu:mcp:start v2 -->\nUse Dosu.\n<!-- dosu:mcp:end -->\n<!-- dosu:mcp:end -->\n",
    );
    expect(verifyClaude()).toMatchObject({
      ok: false,
      reason: "project_instructions_mismatch",
    });
  });

  it("does not accept a structurally forged bundle proof", () => {
    const forged = { root, providers: ["claude"] };
    expect(() => {
      // @ts-expect-error The runtime guard must reject an input TypeScript correctly leaves unbranded.
      assertProjectBundleProof(forged);
    }).toThrow(/verified project bundle proof/i);
    // @ts-expect-error Status must also fail closed for an unbranded runtime value.
    expect(projectBundleStatus(forged, "claude")).toBe("changed");
  });
});
