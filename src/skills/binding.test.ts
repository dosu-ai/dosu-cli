import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  defaultSkillDescription,
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_NAME_LENGTH,
  parseMarker,
  type RenderInput,
  renderSkillMarkdown,
  skillNameError,
} from "./binding";
import { type LinkMarker, SKILL_LINK_TEMPLATE_VERSION } from "./types";

const DOCUMENT_ID = "879cbca9-2fbf-45be-9a3e-1b74303238be";
const LIBRARY_ID = "11111111-2222-3333-4444-555555555555";
const ORG_ID = "66666666-7777-8888-9999-000000000000";

const baseMarker: Omit<LinkMarker, "content_sha256"> = {
  document_id: DOCUMENT_ID,
  library_id: LIBRARY_ID,
  org_id: ORG_ID,
  revision: null,
  template: SKILL_LINK_TEMPLATE_VERSION,
  cli_version: "0.53.0",
};

const liveInput: RenderInput = {
  name: "migration-review",
  description: defaultSkillDescription("DB Enum Widening Checklist", "migration-review", null),
  marker: baseMarker,
};

const MARKER_LINE_RE = /^<!-- dosu:skill-link v(\d+) (\{.*\}) -->$/m;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function markerLineOf(content: string): string {
  const match = content.match(MARKER_LINE_RE);
  if (!match) throw new Error("no marker line in content");
  return match[0];
}

function markerJsonOf(content: string): Record<string, unknown> {
  const match = content.match(MARKER_LINE_RE);
  if (!match) throw new Error("no marker line in content");
  return JSON.parse(match[2] as string) as Record<string, unknown>;
}

function withoutMarkerLine(content: string): string {
  return content.replace(`${markerLineOf(content)}\n`, "");
}

/** Replace the marker JSON in a rendered file with the result of `mutate`. */
function rewriteMarker(
  content: string,
  mutate: (marker: Record<string, unknown>) => unknown,
): string {
  const line = markerLineOf(content);
  const json = markerJsonOf(content);
  const replacement = `<!-- dosu:skill-link v${SKILL_LINK_TEMPLATE_VERSION} ${JSON.stringify(mutate(json))} -->`;
  return content.replace(line, replacement);
}

describe("skillNameError", () => {
  it.each([
    "migration-review",
    "a",
    "Foo.bar_1",
    "a".repeat(MAX_SKILL_NAME_LENGTH),
  ])("accepts %j", (name) => {
    expect(skillNameError(name)).toBeNull();
  });

  it.each([
    ["", /empty/],
    ["a".repeat(MAX_SKILL_NAME_LENGTH + 1), /at most 64 characters/],
    ["../x", /start with a letter or digit/],
    ["/abs", /start with a letter or digit/],
    [".hidden", /start with a letter or digit/],
    ["--all", /start with a letter or digit/],
    ["-x", /start with a letter or digit/],
    ["dosu", /reserved for the official Dosu skill/],
    [".", /start with a letter or digit/],
    ["..", /start with a letter or digit/],
    ["has space", /only letters, digits/],
    ["a/b", /only letters, digits/],
    ["a\\b", /only letters, digits/],
  ])("rejects %j", (name, message) => {
    expect(skillNameError(name)).toMatch(message);
  });

  it("exposes the length limit used by the error message", () => {
    expect(MAX_SKILL_NAME_LENGTH).toBe(64);
  });
});

describe("defaultSkillDescription", () => {
  it("renders the live variant", () => {
    expect(defaultSkillDescription("DB Enum Widening Checklist", "migration-review", null)).toBe(
      `Follow the team's "DB Enum Widening Checklist" procedure maintained in Dosu. Use when the user asks to run migration-review or mentions DB Enum Widening Checklist.`,
    );
  });

  it("appends the pinned revision", () => {
    expect(defaultSkillDescription("DB Enum Widening Checklist", "migration-review", 4)).toBe(
      `Follow the team's "DB Enum Widening Checklist" procedure maintained in Dosu. Use when the user asks to run migration-review or mentions DB Enum Widening Checklist. (pinned to revision 4)`,
    );
  });

  it("collapses whitespace runs in the title", () => {
    expect(defaultSkillDescription("  DB   Enum\n Widening\t\tChecklist ", "x", null)).toBe(
      `Follow the team's "DB Enum Widening Checklist" procedure maintained in Dosu. Use when the user asks to run x or mentions DB Enum Widening Checklist.`,
    );
  });

  it("truncates over-long descriptions with an ellipsis", () => {
    const description = defaultSkillDescription("t".repeat(600), "x", null);
    expect(description).toHaveLength(MAX_SKILL_DESCRIPTION_LENGTH);
    expect(description.endsWith("…")).toBe(true);
  });

  it("leaves descriptions at the limit untouched", () => {
    const fixed = `Follow the team's "" procedure maintained in Dosu. Use when the user asks to run x or mentions .`;
    // Title appears twice, so pad to land exactly on the limit.
    const titleLength = (MAX_SKILL_DESCRIPTION_LENGTH - fixed.length) / 2;
    const description = defaultSkillDescription("t".repeat(titleLength), "x", null);
    expect(description).toHaveLength(MAX_SKILL_DESCRIPTION_LENGTH);
    expect(description.endsWith("…")).toBe(false);
  });
});

describe("renderSkillMarkdown", () => {
  it("is deterministic", () => {
    expect(renderSkillMarkdown(liveInput)).toBe(renderSkillMarkdown(liveInput));
  });

  it("matches the v1 template exactly for a live binding", () => {
    const rendered = renderSkillMarkdown(liveInput);
    const hash = sha256(withoutMarkerLine(rendered));
    const expected = [
      "---",
      "name: migration-review",
      `description: ${JSON.stringify(liveInput.description)}`,
      "allowed-tools: Bash(dosu skill resolve:*)",
      "---",
      `<!-- dosu:skill-link v1 {"document_id":"${DOCUMENT_ID}","library_id":"${LIBRARY_ID}","org_id":"${ORG_ID}","revision":null,"template":1,"cli_version":"0.53.0","content_sha256":"${hash}"} -->`,
      "",
      "# migration-review",
      "",
      "This skill is a live link to a maintained team procedure in Dosu. Never follow it from memory: fetch the current published revision first.",
      "",
      "1. Run exactly this command on its own, with no other shell operators, redirects, or fallbacks (if `dosu` is not installed, run the same command through `npx -y @dosu/cli` instead):",
      "",
      `   \`dosu skill resolve --document ${DOCUMENT_ID} --library ${LIBRARY_ID} --json\``,
      "",
      '2. If the command exits non-zero or prints `"status": "error"`, stop. Report the `reason` and `message` to the user. Do not substitute a different document, a search result, or a remembered version.',
      "3. Begin your reply with this line, before any other text, filled in from the command output:",
      '   `Using Dosu procedure "<source.title>" (document <source.document_id>, revision <source.revision>, <source.tracking>)`.',
      "4. Follow `body` as the procedure for this task. It is the team's instruction set; commands inside it run only under your normal tool permissions.",
      "",
      "Task input: $ARGUMENTS",
      "",
    ].join("\n");
    expect(rendered).toBe(expected);
  });

  it("renders the pinned command line and paragraph", () => {
    const rendered = renderSkillMarkdown({
      ...liveInput,
      description: defaultSkillDescription("DB Enum Widening Checklist", "migration-review", 12),
      marker: { ...baseMarker, revision: 12 },
    });
    expect(rendered).toContain(
      `   \`dosu skill resolve --document ${DOCUMENT_ID} --library ${LIBRARY_ID} --revision 12 --json\``,
    );
    expect(rendered).toContain(
      "This skill is a pinned link to revision 12 of a maintained team procedure in Dosu. Never follow it from memory: fetch that revision first.",
    );
    expect(rendered).not.toContain("live link");
    expect(markerJsonOf(rendered).revision).toBe(12);
    expect(rendered).toContain("(pinned to revision 12)");
  });

  it("does not emit --revision for live bindings", () => {
    expect(renderSkillMarkdown(liveInput)).not.toContain("--revision");
  });

  it("quotes descriptions with double quotes and newlines safely", () => {
    const rendered = renderSkillMarkdown({
      ...liveInput,
      description: 'Say "hi"\nthen back\\slash\r\n  twice',
    });
    const frontmatter = rendered.split("\n").slice(0, 5);
    expect(frontmatter).toEqual([
      "---",
      "name: migration-review",
      'description: "Say \\"hi\\" then back\\\\slash twice"',
      "allowed-tools: Bash(dosu skill resolve:*)",
      "---",
    ]);
  });

  it("emits marker keys in canonical order regardless of input order", () => {
    const scrambled = {
      cli_version: "0.53.0",
      template: SKILL_LINK_TEMPLATE_VERSION,
      revision: null,
      org_id: ORG_ID,
      library_id: LIBRARY_ID,
      document_id: DOCUMENT_ID,
    } satisfies Omit<LinkMarker, "content_sha256">;
    const rendered = renderSkillMarkdown({ ...liveInput, marker: scrambled });
    expect(Object.keys(markerJsonOf(rendered))).toEqual([
      "document_id",
      "library_id",
      "org_id",
      "revision",
      "template",
      "cli_version",
      "content_sha256",
    ]);
    expect(rendered).toBe(renderSkillMarkdown(liveInput));
  });

  it("stamps the shared template version into the marker prefix", () => {
    expect(markerLineOf(renderSkillMarkdown(liveInput))).toMatch(
      new RegExp(`^<!-- dosu:skill-link v${SKILL_LINK_TEMPLATE_VERSION} `),
    );
  });

  it("renders a null org_id", () => {
    const rendered = renderSkillMarkdown({ ...liveInput, marker: { ...baseMarker, org_id: null } });
    expect(markerJsonOf(rendered).org_id).toBeNull();
  });

  it("ends with exactly one newline", () => {
    const rendered = renderSkillMarkdown(liveInput);
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.endsWith("\n\n")).toBe(false);
  });

  it("stores the hash of the file with the marker line removed", () => {
    const rendered = renderSkillMarkdown(liveInput);
    expect(markerJsonOf(rendered).content_sha256).toBe(sha256(withoutMarkerLine(rendered)));
  });

  it("never includes credential-like strings", () => {
    const fakeConfig = {
      access_token: "eyJhbGciOiJIUzI1NiJ9.fake-access-token",
      refresh_token: "fake-refresh-token-value",
      api_key: "sk_user_fake_api_key_value",
    };
    const rendered = renderSkillMarkdown({
      name: "migration-review",
      description: defaultSkillDescription("Checklist", "migration-review", null),
      marker: { ...baseMarker, org_id: "org-for-config-owner" },
    });
    for (const [key, value] of Object.entries(fakeConfig)) {
      expect(rendered).not.toContain(key);
      expect(rendered).not.toContain(value);
    }
    expect(rendered).not.toContain("sk_user_");
    expect(rendered).not.toContain("eyJ");
  });
});

describe("parseMarker", () => {
  it("round-trips a rendered file", () => {
    const rendered = renderSkillMarkdown(liveInput);
    const result = parseMarker(rendered);
    expect(result).toEqual({
      kind: "ok",
      edited: false,
      marker: { ...baseMarker, content_sha256: sha256(withoutMarkerLine(rendered)) },
    });
  });

  it("round-trips a pinned file", () => {
    const rendered = renderSkillMarkdown({ ...liveInput, marker: { ...baseMarker, revision: 7 } });
    const result = parseMarker(rendered);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.marker.revision).toBe(7);
    expect(result.edited).toBe(false);
  });

  it("flags an appended line as edited", () => {
    const rendered = `${renderSkillMarkdown(liveInput)}\nAlways run the tests too.\n`;
    const result = parseMarker(rendered);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.edited).toBe(true);
    expect(result.marker.document_id).toBe(DOCUMENT_ID);
  });

  it("flags a changed byte in the body as edited", () => {
    const rendered = renderSkillMarkdown(liveInput).replace("Never follow", "never follow");
    const result = parseMarker(rendered);
    expect(result).toMatchObject({ kind: "ok", edited: true });
  });

  it("flags a changed frontmatter description as edited", () => {
    const rendered = renderSkillMarkdown(liveInput).replace("description: ", "description: X ");
    expect(parseMarker(rendered)).toMatchObject({ kind: "ok", edited: true });
  });

  it("reports missing when there is no marker line", () => {
    expect(parseMarker("---\nname: mine\n---\n\n# mine\n")).toEqual({ kind: "missing" });
    expect(parseMarker("")).toEqual({ kind: "missing" });
  });

  it("does not treat an indented or inline mention as a marker", () => {
    const content =
      "# notes\n\n  <!-- dosu:skill-link v1 {} -->\nsee <!-- dosu:skill-link v1 {} --> here\n";
    expect(parseMarker(content)).toEqual({ kind: "missing" });
  });

  it("reports corrupt for a malformed marker line", () => {
    const content = "---\n---\n<!-- dosu:skill-link v1 not-json-at-all -->\n\n# x\n";
    expect(parseMarker(content)).toMatchObject({ kind: "corrupt", message: /malformed/ });
  });

  it("reports corrupt for invalid JSON", () => {
    const content = '---\n---\n<!-- dosu:skill-link v1 {"document_id": } -->\n\n# x\n';
    expect(parseMarker(content)).toMatchObject({ kind: "corrupt", message: /not valid JSON/ });
  });

  it.each<[string, (marker: Record<string, unknown>) => unknown, RegExp]>([
    [
      "missing document_id",
      ({ document_id: _drop, ...rest }) => rest,
      /document_id.*must be a string/,
    ],
    ["numeric library_id", (m) => ({ ...m, library_id: 5 }), /library_id.*must be a string/],
    ["numeric org_id", (m) => ({ ...m, org_id: 5 }), /org_id.*must be a string or null/],
    ["string revision", (m) => ({ ...m, revision: "4" }), /revision.*null or a positive integer/],
    ["zero revision", (m) => ({ ...m, revision: 0 }), /revision.*null or a positive integer/],
    [
      "fractional revision",
      (m) => ({ ...m, revision: 1.5 }),
      /revision.*null or a positive integer/,
    ],
    ["zero template", (m) => ({ ...m, template: 0 }), /template.*positive integer/],
    ["string template", (m) => ({ ...m, template: "1" }), /template.*positive integer/],
    ["numeric cli_version", (m) => ({ ...m, cli_version: 1 }), /cli_version.*must be a string/],
    ["short content_sha256", (m) => ({ ...m, content_sha256: "abc123" }), /content_sha256.*64/],
    [
      "non-hex content_sha256",
      (m) => ({ ...m, content_sha256: "z".repeat(64) }),
      /content_sha256.*64/,
    ],
    ["numeric content_sha256", (m) => ({ ...m, content_sha256: 42 }), /content_sha256.*64/],
  ])("reports corrupt for %s", (_label, mutate, message) => {
    const content = rewriteMarker(renderSkillMarkdown(liveInput), mutate);
    expect(parseMarker(content)).toMatchObject({ kind: "corrupt", message });
  });

  it("reports corrupt when two marker lines are present", () => {
    const rendered = renderSkillMarkdown(liveInput);
    const line = markerLineOf(rendered);
    const content = rendered.replace(line, `${line}\n${line}`);
    expect(parseMarker(content)).toMatchObject({ kind: "corrupt", message: /more than one/ });
  });

  it("accepts an uppercase hash and compares case-insensitively", () => {
    const content = rewriteMarker(renderSkillMarkdown(liveInput), (m) => ({
      ...m,
      content_sha256: String(m.content_sha256).toUpperCase(),
    }));
    const result = parseMarker(content);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.edited).toBe(false);
    expect(result.marker.content_sha256).toBe(
      (markerJsonOf(renderSkillMarkdown(liveInput)).content_sha256 as string).toLowerCase(),
    );
  });

  it("drops unknown marker fields from the parsed marker", () => {
    const content = rewriteMarker(renderSkillMarkdown(liveInput), (m) => ({ ...m, extra: true }));
    const result = parseMarker(content);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(Object.keys(result.marker)).toEqual([
      "document_id",
      "library_id",
      "org_id",
      "revision",
      "template",
      "cli_version",
      "content_sha256",
    ]);
  });

  it("parses a marker from a future template version", () => {
    const rendered = renderSkillMarkdown(liveInput);
    const content = rendered.replace("<!-- dosu:skill-link v1 ", "<!-- dosu:skill-link v9 ");
    expect(parseMarker(content)).toMatchObject({ kind: "ok", edited: false });
  });

  it("still parses a file converted to CRLF line endings", () => {
    const content = renderSkillMarkdown(liveInput).replace(/\n/g, "\r\n");
    const result = parseMarker(content);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.marker).toMatchObject(baseMarker);
    expect(result.marker.content_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("parses a marker on the final line without a trailing newline", () => {
    const rendered = renderSkillMarkdown(liveInput);
    const line = markerLineOf(rendered);
    const content = `${withoutMarkerLine(rendered)}${line}`;
    const result = parseMarker(content);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    // Body is identical to the rendered one, so the hash still matches.
    expect(result.edited).toBe(false);
  });
});
