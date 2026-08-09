import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertProjectSkillInstallSafe,
  projectSkillEvidenceUnchanged,
  verifyProjectSkillInstallation,
} from "./project-skill-ownership";

let root: string;
const extraRoots: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dosu-project-skill-ownership-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const extraRoot of extraRoots.splice(0)) {
    rmSync(extraRoot, { recursive: true, force: true });
  }
});

function writeOwnedSkill(target: string): void {
  const content = "---\nname: dosu\ndescription: Dosu knowledge\n---\nUse Dosu.\n";
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "SKILL.md"), content);
  const computedHash = createHash("sha256").update("SKILL.md").update(content).digest("hex");
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

function writeLock(computedHash: string, skills: Record<string, unknown> = {}): void {
  writeFileSync(
    join(root, "skills-lock.json"),
    JSON.stringify({
      version: 1,
      skills: {
        ...skills,
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

describe("project skill ownership", () => {
  it("verifies the actual Claude-only direct layout from skills@1.5.22", () => {
    const claude = join(root, ".claude", "skills", "dosu");
    writeOwnedSkill(claude);

    expect(
      verifyProjectSkillInstallation({
        projectRoot: root,
        targets: [{ path: claude, symlink: false }],
      }),
    ).toMatchObject({ ok: true });
  });

  it("verifies the actual mixed canonical plus Claude symlink layout", () => {
    const canonical = join(root, ".agents", "skills", "dosu");
    const claude = join(root, ".claude", "skills", "dosu");
    writeOwnedSkill(canonical);
    mkdirSync(join(root, ".claude", "skills"), { recursive: true });
    symlinkSync("../../.agents/skills/dosu", claude, "dir");

    expect(
      verifyProjectSkillInstallation({
        projectRoot: root,
        targets: [
          { path: canonical, symlink: false },
          { path: claude, symlink: true },
        ],
      }),
    ).toMatchObject({ ok: true });
  });

  it("verifies the actual Factory-only direct layout from skills@1.5.22", () => {
    const factory = join(root, ".factory", "skills", "dosu");
    writeOwnedSkill(factory);

    expect(
      verifyProjectSkillInstallation({
        projectRoot: root,
        targets: [{ path: factory, symlink: false }],
      }),
    ).toMatchObject({ ok: true });
  });

  it("verifies the mixed Factory symlink and accepts a later Factory-only rerun", () => {
    const canonical = join(root, ".agents", "skills", "dosu");
    const factory = join(root, ".factory", "skills", "dosu");
    writeOwnedSkill(canonical);
    mkdirSync(join(root, ".factory", "skills"), { recursive: true });
    symlinkSync("../../.agents/skills/dosu", factory, "dir");
    const mixedTargets = [
      { path: canonical, symlink: false },
      { path: factory, symlink: true },
    ];

    expect(
      verifyProjectSkillInstallation({ projectRoot: root, targets: mixedTargets }),
    ).toMatchObject({ ok: true });
    expect(() =>
      assertProjectSkillInstallSafe({
        projectRoot: root,
        targets: [{ path: factory, symlink: false }],
      }),
    ).not.toThrow();
    expect(
      verifyProjectSkillInstallation({
        projectRoot: root,
        targets: [{ path: factory, symlink: false }],
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects a foreign Factory skill symlink before install", () => {
    const canonical = join(root, ".agents", "skills", "dosu");
    const factory = join(root, ".factory", "skills", "dosu");
    const external = mkdtempSync(join(tmpdir(), "dosu-foreign-factory-skill-"));
    extraRoots.push(external);
    writeOwnedSkill(canonical);
    mkdirSync(join(root, ".factory", "skills"), { recursive: true });
    symlinkSync(external, factory, "dir");

    expect(() =>
      assertProjectSkillInstallSafe({
        projectRoot: root,
        targets: [{ path: factory, symlink: false }],
      }),
    ).toThrow(/ownership/i);
  });

  it("accepts a Claude-only rerun of the previously owned mixed layout", () => {
    const canonical = join(root, ".agents", "skills", "dosu");
    const claude = join(root, ".claude", "skills", "dosu");
    writeOwnedSkill(canonical);
    mkdirSync(join(root, ".claude", "skills"), { recursive: true });
    symlinkSync("../../.agents/skills/dosu", claude, "dir");
    const claudeOnlyTargets = [{ path: claude, symlink: false }];

    expect(() =>
      assertProjectSkillInstallSafe({ projectRoot: root, targets: claudeOnlyTargets }),
    ).not.toThrow();
    expect(
      verifyProjectSkillInstallation({ projectRoot: root, targets: claudeOnlyTargets }),
    ).toMatchObject({
      ok: true,
      evidence: expect.arrayContaining([
        expect.objectContaining({ kind: "directory", path: canonical }),
        expect.objectContaining({ kind: "symlink", path: claude }),
      ]),
    });
  });

  it("rejects foreign and edited shared layouts during a Claude-only rerun", () => {
    const canonical = join(root, ".agents", "skills", "dosu");
    const claude = join(root, ".claude", "skills", "dosu");
    writeOwnedSkill(canonical);
    mkdirSync(join(root, ".claude", "skills"), { recursive: true });

    const external = mkdtempSync(join(tmpdir(), "dosu-foreign-shared-skill-"));
    extraRoots.push(external);
    const externalSkill = join(external, "dosu");
    mkdirSync(externalSkill, { recursive: true });
    writeFileSync(
      join(externalSkill, "SKILL.md"),
      "---\nname: dosu\ndescription: Dosu knowledge\n---\nUse Dosu.\n",
    );
    symlinkSync(externalSkill, claude, "dir");
    expect(() =>
      assertProjectSkillInstallSafe({
        projectRoot: root,
        targets: [{ path: claude, symlink: false }],
      }),
    ).toThrow(/ownership/i);

    rmSync(claude);
    symlinkSync("../../.agents/skills/dosu", claude, "dir");
    writeFileSync(join(canonical, "SKILL.md"), "---\nname: dosu\n---\nuser edited\n");
    expect(() =>
      assertProjectSkillInstallSafe({
        projectRoot: root,
        targets: [{ path: claude, symlink: false }],
      }),
    ).toThrow(/ownership/i);
  });

  it("rejects a duplicate-key lock and a foreign mixed-layout symlink", () => {
    const canonical = join(root, ".agents", "skills", "dosu");
    const claude = join(root, ".claude", "skills", "dosu");
    writeOwnedSkill(canonical);
    const validLock = `{"version":1,"skills":{"dosu":${JSON.stringify({
      source: "dosu-ai/dosu-skill",
      sourceType: "github",
      skillPath: "skills/dosu/SKILL.md",
      computedHash: "a".repeat(64),
    })},"dosu":{}}}`;
    writeFileSync(join(root, "skills-lock.json"), validLock);
    expect(
      verifyProjectSkillInstallation({
        projectRoot: root,
        targets: [{ path: canonical, symlink: false }],
      }),
    ).toMatchObject({ ok: false, reason: "project_skill_lock_mismatch" });

    writeOwnedSkill(canonical);
    mkdirSync(join(root, ".claude", "skills"), { recursive: true });
    symlinkSync("../../../foreign", claude, "dir");
    expect(
      verifyProjectSkillInstallation({
        projectRoot: root,
        targets: [
          { path: canonical, symlink: false },
          { path: claude, symlink: true },
        ],
      }),
    ).toMatchObject({ ok: false, reason: "project_skill_foreign_symlink" });
  });

  it("allows a clean install but rejects pre-existing skill content without an ownership lock", () => {
    const target = join(root, ".agents", "skills", "dosu");
    expect(() =>
      assertProjectSkillInstallSafe({
        projectRoot: root,
        targets: [{ path: target, symlink: false }],
      }),
    ).not.toThrow();

    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), "user-authored");
    expect(() =>
      assertProjectSkillInstallSafe({
        projectRoot: root,
        targets: [{ path: target, symlink: false }],
      }),
    ).toThrow(/cannot prove ownership/i);
    expect(
      verifyProjectSkillInstallation({
        projectRoot: root,
        targets: [{ path: target, symlink: false }],
      }),
    ).toMatchObject({ ok: false, reason: "project_skill_lock_mismatch" });
  });

  it("treats an unclaimed lock as safe only while no Dosu target exists", () => {
    const target = join(root, ".agents", "skills", "dosu");
    writeFileSync(
      join(root, "skills-lock.json"),
      JSON.stringify({ version: 1, skills: { other: { source: "example" } } }),
    );
    expect(() =>
      assertProjectSkillInstallSafe({
        projectRoot: root,
        targets: [{ path: target, symlink: false }],
      }),
    ).not.toThrow();

    mkdirSync(target, { recursive: true });
    expect(() =>
      assertProjectSkillInstallSafe({
        projectRoot: root,
        targets: [{ path: target, symlink: false }],
      }),
    ).toThrow(/cannot prove ownership/i);
  });

  it("rejects malformed, symlinked, and semantically foreign ownership locks", () => {
    const target = join(root, ".agents", "skills", "dosu");
    const lockPath = join(root, "skills-lock.json");
    writeFileSync(lockPath, "not-json");
    expect(() => assertProjectSkillInstallSafe({ projectRoot: root, targets: [] })).toThrow(
      /cannot prove ownership/i,
    );

    rmSync(lockPath);
    writeFileSync(join(root, "foreign-lock.json"), '{"version":1,"skills":{}}');
    symlinkSync(join(root, "foreign-lock.json"), lockPath);
    expect(verifyProjectSkillInstallation({ projectRoot: root, targets: [] })).toMatchObject({
      ok: false,
      reason: "project_skill_lock_mismatch",
    });

    rmSync(lockPath);
    writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        skills: {
          dosu: {
            source: "someone/else",
            sourceType: "github",
            skillPath: "skills/dosu/SKILL.md",
            computedHash: "a".repeat(64),
          },
        },
      }),
    );
    expect(() =>
      assertProjectSkillInstallSafe({
        projectRoot: root,
        targets: [{ path: target, symlink: false }],
      }),
    ).toThrow(/cannot prove ownership/i);
  });

  it("hashes nested regular files deterministically while ignoring package and VCS metadata", () => {
    const target = join(root, ".agents", "skills", "dosu");
    const skill = "---\nname: dosu\ndescription: Dosu knowledge\n---\nUse Dosu.\n";
    mkdirSync(join(target, "references"), { recursive: true });
    mkdirSync(join(target, ".git"), { recursive: true });
    mkdirSync(join(target, "node_modules"), { recursive: true });
    writeFileSync(join(target, "SKILL.md"), skill);
    writeFileSync(join(target, "references", "guide.md"), "guide");
    writeFileSync(join(target, ".git", "ignored"), "changes freely");
    writeFileSync(join(target, "node_modules", "ignored"), "changes freely");
    const computedHash = createHash("sha256")
      .update("references/guide.md")
      .update("guide")
      .update("SKILL.md")
      .update(skill)
      .digest("hex");
    writeLock(computedHash);

    const verification = verifyProjectSkillInstallation({
      projectRoot: root,
      targets: [{ path: target, symlink: false }],
    });
    expect(verification).toMatchObject({ ok: true });
    if (!verification.ok) throw new Error(verification.reason);
    expect(verification.evidence.some((item) => item.kind === "directory")).toBe(true);

    writeFileSync(join(target, ".git", "ignored"), "still ignored");
    for (const evidence of verification.evidence) {
      expect(projectSkillEvidenceUnchanged(evidence, root)).toBe(true);
    }
    writeFileSync(join(target, "references", "guide.md"), "user edit");
    expect(verification.evidence.some((item) => !projectSkillEvidenceUnchanged(item, root))).toBe(
      true,
    );
  });

  it("rejects missing targets, ordinary files, bad frontmatter, and nested symlinks", () => {
    const target = join(root, ".agents", "skills", "dosu");
    writeLock("a".repeat(64));
    expect(
      verifyProjectSkillInstallation({
        projectRoot: root,
        targets: [{ path: target, symlink: false }],
      }),
    ).toMatchObject({ ok: false, reason: "project_skill_missing", path: target });

    mkdirSync(join(root, ".agents", "skills"), { recursive: true });
    writeFileSync(target, "ordinary file", { flag: "w" });
    expect(
      verifyProjectSkillInstallation({
        projectRoot: root,
        targets: [{ path: target, symlink: false }],
      }),
    ).toMatchObject({ ok: false, reason: "project_skill_modified" });

    rmSync(target);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), "---\nname: other\n---\n");
    const other = readFileSync(join(target, "SKILL.md"));
    writeLock(createHash("sha256").update("SKILL.md").update(other).digest("hex"));
    expect(
      verifyProjectSkillInstallation({
        projectRoot: root,
        targets: [{ path: target, symlink: false }],
      }),
    ).toMatchObject({ ok: false, reason: "project_skill_modified" });

    writeFileSync(join(target, "SKILL.md"), "---\nname: dosu\n---\n");
    symlinkSync(join(root, "foreign-lock.json"), join(target, "nested-link"));
    expect(
      verifyProjectSkillInstallation({
        projectRoot: root,
        targets: [{ path: target, symlink: false }],
      }),
    ).toMatchObject({ ok: false, reason: "project_skill_modified" });
  });

  it("revalidates mixed-layout symlink and lock evidence after verification", () => {
    const canonical = join(root, ".agents", "skills", "dosu");
    const claude = join(root, ".claude", "skills", "dosu");
    writeOwnedSkill(canonical);
    mkdirSync(join(root, ".claude", "skills"), { recursive: true });
    symlinkSync("../../.agents/skills/dosu", claude, "dir");
    const verification = verifyProjectSkillInstallation({
      projectRoot: root,
      targets: [
        { path: canonical, symlink: false },
        { path: claude, symlink: true },
      ],
    });
    if (!verification.ok) throw new Error(verification.reason);

    const lockEvidence = verification.evidence.find((item) => item.kind === "file");
    const symlinkEvidence = verification.evidence.find((item) => item.kind === "symlink");
    expect(lockEvidence && projectSkillEvidenceUnchanged(lockEvidence, root)).toBe(true);
    expect(symlinkEvidence && projectSkillEvidenceUnchanged(symlinkEvidence, root)).toBe(true);

    writeFileSync(join(root, "skills-lock.json"), '{"version":1,"skills":{}}');
    expect(lockEvidence && projectSkillEvidenceUnchanged(lockEvidence, root)).toBe(false);
    rmSync(claude);
    symlinkSync("../../.agents/skills", claude, "dir");
    expect(symlinkEvidence && projectSkillEvidenceUnchanged(symlinkEvidence, root)).toBe(false);
  });

  it("allows an owned reinstall when present targets are intact and missing adapters are optional", () => {
    const canonical = join(root, ".agents", "skills", "dosu");
    const optionalClaude = join(root, ".claude", "skills", "dosu");
    writeOwnedSkill(canonical);
    expect(() =>
      assertProjectSkillInstallSafe({
        projectRoot: root,
        targets: [
          { path: canonical, symlink: false },
          { path: optionalClaude, symlink: true },
        ],
      }),
    ).not.toThrow();

    writeFileSync(join(canonical, "SKILL.md"), "user changed");
    expect(() =>
      assertProjectSkillInstallSafe({
        projectRoot: root,
        targets: [{ path: canonical, symlink: false }],
      }),
    ).toThrow(/cannot prove ownership/i);
  });

  it("rejects an ordinary target that resolves outside the verified project root", () => {
    const external = mkdtempSync(join(tmpdir(), "dosu-external-skill-"));
    extraRoots.push(external);
    const externalSkill = join(external, "skills", "dosu");
    const content = "---\nname: dosu\n---\n";
    mkdirSync(externalSkill, { recursive: true });
    writeFileSync(join(externalSkill, "SKILL.md"), content);
    const computedHash = createHash("sha256").update("SKILL.md").update(content).digest("hex");
    writeLock(computedHash);
    symlinkSync(external, join(root, ".agents"), "dir");

    expect(
      verifyProjectSkillInstallation({
        projectRoot: root,
        targets: [{ path: join(root, ".agents", "skills", "dosu"), symlink: false }],
      }),
    ).toMatchObject({ ok: false, reason: "project_skill_modified" });
  });

  it("rejects an empty directory even when its digest matches because SKILL.md is required", () => {
    const target = join(root, ".agents", "skills", "dosu");
    mkdirSync(target, { recursive: true });
    writeLock(createHash("sha256").digest("hex"));
    expect(
      verifyProjectSkillInstallation({
        projectRoot: root,
        targets: [{ path: target, symlink: false }],
      }),
    ).toMatchObject({ ok: false, reason: "project_skill_modified" });
  });

  it("treats replaced and removed evidence as changed", () => {
    const target = join(root, ".agents", "skills", "dosu");
    writeOwnedSkill(target);
    const verification = verifyProjectSkillInstallation({
      projectRoot: root,
      targets: [{ path: target, symlink: false }],
    });
    if (!verification.ok) throw new Error(verification.reason);
    const lockEvidence = verification.evidence.find((item) => item.kind === "file");
    const directoryEvidence = verification.evidence.find((item) => item.kind === "directory");
    if (!lockEvidence || !directoryEvidence)
      throw new Error("expected lock and directory evidence");

    const lockPath = join(root, "skills-lock.json");
    const foreignLock = join(root, "foreign-lock.json");
    writeFileSync(foreignLock, readFileSync(lockPath));
    rmSync(lockPath);
    symlinkSync(foreignLock, lockPath);
    expect(projectSkillEvidenceUnchanged(lockEvidence, root)).toBe(false);

    rmSync(target, { recursive: true });
    expect(projectSkillEvidenceUnchanged(directoryEvidence, root)).toBe(false);
  });
});
