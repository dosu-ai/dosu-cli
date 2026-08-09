import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ParseError, parse as parseJsonc, parseTree } from "jsonc-parser/lib/esm/main.js";
import { describe, expect, it } from "vitest";
import {
  isExactProjectCodexProxy,
  isExactProjectJsonProxy,
  planCodexDosuMcp,
  planLegacyCodexMcp,
  planLegacyJsonMcp,
  planLegacyRuleSection,
  planLegacyStandaloneRule,
  planProjectCodexMcp,
  removeJsonObjectPropertyRaw,
} from "./planners";

const API_KEY = "dosu_test_key";
const DEPLOYMENT_URL = "https://api.dosu.dev/v1/mcp/deployments/dep-123";
const BASE_URL = "https://api.dosu.dev/v1/mcp";
const RELEASED_RULE = readFileSync(join(process.cwd(), "rules", "dosu.md"), "utf8");

describe("legacy JSON/JSONC MCP planner", () => {
  const cases: Array<{
    name: string;
    provider: Parameters<typeof planLegacyJsonMcp>[0]["provider"];
    topKey: string;
    entry: Record<string, unknown>;
  }> = [
    {
      name: "standard HTTP",
      provider: "claude",
      topKey: "mcpServers",
      entry: {
        type: "http",
        url: DEPLOYMENT_URL,
        headers: { "X-Dosu-API-Key": API_KEY },
      },
    },
    {
      name: "Cursor cloud",
      provider: "cursor",
      topKey: "mcpServers",
      entry: { url: DEPLOYMENT_URL, headers: { "X-Dosu-API-Key": API_KEY } },
    },
    {
      name: "Cline cloud",
      provider: "cline",
      topKey: "mcpServers",
      entry: {
        type: "streamableHttp",
        disabled: false,
        url: DEPLOYMENT_URL,
        headers: { "X-Dosu-API-Key": API_KEY },
      },
    },
    {
      name: "OpenCode cloud",
      provider: "opencode",
      topKey: "mcp",
      entry: {
        type: "remote",
        enabled: true,
        url: DEPLOYMENT_URL,
        headers: { "X-Dosu-API-Key": API_KEY },
      },
    },
    {
      name: "Zed cloud",
      provider: "zed",
      topKey: "context_servers",
      entry: {
        source: "custom",
        type: "http",
        url: DEPLOYMENT_URL,
        headers: { "X-Dosu-API-Key": API_KEY },
      },
    },
    {
      name: "Antigravity cloud",
      provider: "antigravity",
      topKey: "mcpServers",
      entry: {
        serverUrl: DEPLOYMENT_URL,
        headers: { "X-Dosu-API-Key": API_KEY },
      },
    },
    {
      name: "Copilot cloud",
      provider: "copilot",
      topKey: "mcpServers",
      entry: {
        type: "http",
        url: DEPLOYMENT_URL,
        tools: ["*"],
        headers: { "X-Dosu-API-Key": API_KEY },
      },
    },
    {
      // Custom-shape providers used the common standard builder in OSS mode.
      name: "custom provider OSS fallback",
      provider: "opencode",
      topKey: "mcp",
      entry: {
        type: "http",
        url: BASE_URL,
        headers: { "X-Dosu-API-Key": API_KEY },
      },
    },
    {
      name: "Claude Desktop mcp-remote",
      provider: "claude-desktop",
      topKey: "mcpServers",
      entry: {
        command: "/opt/homebrew/bin/npx",
        args: [
          "-y",
          "mcp-remote@0.1.38",
          DEPLOYMENT_URL,
          "--header",
          "X-Dosu-API-Key:$" + "{X_DOSU_API_KEY}",
          "--transport",
          "http-only",
        ],
        env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin", X_DOSU_API_KEY: API_KEY },
      },
    },
  ];

  for (const fixture of cases) {
    it(`removes the released ${fixture.name} shape and preserves JSONC siblings`, () => {
      const content = `{
  // keep this user comment
  "${fixture.topKey}": {
    "other": { "url": "https://example.com" },
    "dosu": ${JSON.stringify(fixture.entry)}
  },
  "userSetting": true
}\n`;

      const plan = planLegacyJsonMcp({
        content,
        provider: fixture.provider,
        topKey: fixture.topKey,
      });

      expect(plan.disposition).toBe("remove");
      expect(plan.mutation).toBe("write");
      expect(plan.nextContent).toContain("keep this user comment");
      expect(plan.nextContent).toContain('"other"');
      expect(plan.nextContent).toContain('"userSetting"');
      expect(plan.nextContent).not.toContain('"dosu"');
      expect(plan.nextContent).not.toContain(API_KEY);
    });
  }

  it("refuses duplicate keys instead of trusting JSON.parse last-write-wins", () => {
    const content = `{
      "mcpServers": {
        "dosu": {"type":"http","url":"${DEPLOYMENT_URL}","headers":{"X-Dosu-API-Key":"a"}},
        "dosu": {"type":"http","url":"${DEPLOYMENT_URL}","headers":{"X-Dosu-API-Key":"b"}}
      }
    }`;
    const plan = planLegacyJsonMcp({ content, provider: "claude", topKey: "mcpServers" });
    expect(plan).toMatchObject({ disposition: "preserved_ambiguous", reason: "duplicate_key" });
  });

  it("refuses malformed JSONC", () => {
    const plan = planLegacyJsonMcp({
      content: '{"mcpServers":{"dosu":',
      provider: "claude",
      topKey: "mcpServers",
    });
    expect(plan).toMatchObject({ disposition: "preserved_ambiguous", reason: "parse_error" });
  });

  it("refuses a foreign server that happens to be named dosu", () => {
    const content = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer user-owned" },
        },
      },
    });
    const plan = planLegacyJsonMcp({ content, provider: "claude", topKey: "mcpServers" });
    expect(plan).toMatchObject({
      disposition: "preserved_ambiguous",
      reason: "foreign_dosu_entry",
    });
  });

  it("does not treat a Dosu-shaped entry on a foreign origin as released", () => {
    const content = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://example.invalid/v1/mcp/deployments/dep-123",
          headers: { "X-Dosu-API-Key": API_KEY },
        },
      },
    });

    expect(planLegacyJsonMcp({ content, provider: "claude", topKey: "mcpServers" })).toMatchObject({
      disposition: "preserved_ambiguous",
      reason: "foreign_dosu_entry",
    });
  });

  it("preserves a Dosu-shaped URL containing userinfo", () => {
    const content = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: "https://user:pass@api.dosu.dev/v1/mcp/deployments/dep-123",
          headers: { "X-Dosu-API-Key": API_KEY },
        },
      },
    });

    expect(planLegacyJsonMcp({ content, provider: "claude", topKey: "mcpServers" })).toMatchObject({
      disposition: "preserved_ambiguous",
      reason: "foreign_dosu_entry",
    });
  });

  it("refuses unknown fields even on an otherwise matching Dosu entry", () => {
    const content = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "http",
          url: DEPLOYMENT_URL,
          headers: { "X-Dosu-API-Key": API_KEY },
          userAdded: true,
        },
      },
    });
    const plan = planLegacyJsonMcp({ content, provider: "claude", topKey: "mcpServers" });
    expect(plan).toMatchObject({
      disposition: "preserved_ambiguous",
      reason: "unknown_dosu_shape",
    });
  });

  it("accepts the standard fallback for custom providers only at the OSS base URL", () => {
    const standard = (url: string) =>
      JSON.stringify({
        mcp: {
          dosu: { type: "http", url, headers: { "X-Dosu-API-Key": API_KEY } },
        },
      });
    expect(
      planLegacyJsonMcp({ content: standard(BASE_URL), provider: "opencode", topKey: "mcp" }),
    ).toMatchObject({ disposition: "remove" });
    expect(
      planLegacyJsonMcp({
        content: standard(DEPLOYMENT_URL),
        provider: "opencode",
        topKey: "mcp",
      }),
    ).toMatchObject({ disposition: "preserved_ambiguous", reason: "unknown_dosu_shape" });
  });

  it("never accepts a common standard fallback for Copilot", () => {
    const content = JSON.stringify({
      mcpServers: {
        dosu: { type: "http", url: BASE_URL, headers: { "X-Dosu-API-Key": API_KEY } },
      },
    });
    expect(planLegacyJsonMcp({ content, provider: "copilot", topKey: "mcpServers" })).toMatchObject(
      { disposition: "preserved_ambiguous", reason: "unknown_dosu_shape" },
    );
  });

  it("preserves every unrelated JSONC byte while deleting only Dosu and its separator", () => {
    const entry = JSON.stringify({
      type: "http",
      url: DEPLOYMENT_URL,
      headers: { "X-Dosu-API-Key": API_KEY },
    });
    const content = `{
  "mcpServers": {
    "first" : { "url": "https://one.example" }, /* keep comma, spacing */
    "dosu": ${entry}, // keep this user comment byte-for-byte
    "last": {"url":"https://last.example"}
  }
}\n`;
    const expected = `{
  "mcpServers": {
    "first" : { "url": "https://one.example" }, /* keep comma, spacing */
     // keep this user comment byte-for-byte
    "last": {"url":"https://last.example"}
  }
}\n`;
    const plan = planLegacyJsonMcp({ content, provider: "claude", topKey: "mcpServers" });
    expect(plan).toMatchObject({ disposition: "remove", nextContent: expected });
  });

  it("keeps a one-child JSONC object valid when Dosu has a trailing comma", () => {
    const content = `{
  "mcpServers": {
    "dosu": {"type":"http","url":"${DEPLOYMENT_URL}","headers":{"X-Dosu-API-Key":"${API_KEY}"}},
  },
}
`;
    const plan = planLegacyJsonMcp({ content, provider: "claude", topKey: "mcpServers" });
    expect(plan).toMatchObject({ disposition: "remove" });
    const errors: ParseError[] = [];
    expect(parseJsonc(plan.nextContent ?? "", errors, { allowTrailingComma: true })).toEqual({
      mcpServers: {},
    });
    expect(errors).toEqual([]);
  });

  it("rejects relative PATH entries in the released Claude Desktop shape", () => {
    const content = JSON.stringify({
      mcpServers: {
        dosu: {
          type: "stdio",
          command: "/usr/local/bin/npx",
          args: [
            "-y",
            "mcp-remote@0.1.38",
            DEPLOYMENT_URL,
            "--header",
            "X-Dosu-API-Key:$" + "{X_DOSU_API_KEY}",
            "--transport",
            "http-only",
          ],
          env: { PATH: "relative/bin:/usr/bin", X_DOSU_API_KEY: API_KEY },
        },
      },
    });
    expect(
      planLegacyJsonMcp({ content, provider: "claude-desktop", topKey: "mcpServers" }),
    ).toMatchObject({ disposition: "preserved_ambiguous", reason: "unknown_dosu_shape" });
  });

  it("does not silently own endpoint paths with a trailing slash", () => {
    for (const url of [
      "https://api.dosu.dev/v1/mcp/",
      "https://api.dosu.dev/v1/mcp/deployments/dep-123/",
    ]) {
      const content = JSON.stringify({
        mcpServers: {
          dosu: { type: "http", url, headers: { "X-Dosu-API-Key": API_KEY } },
        },
      });
      expect(
        planLegacyJsonMcp({ content, provider: "claude", topKey: "mcpServers" }),
      ).toMatchObject({ disposition: "preserved_ambiguous", reason: "foreign_dosu_entry" });
    }
  });

  it("is idempotent when no Dosu child exists", () => {
    const content = '{"mcpServers":{"other":{"url":"https://example.com"}}}';
    const plan = planLegacyJsonMcp({ content, provider: "claude", topKey: "mcpServers" });
    expect(plan).toMatchObject({ disposition: "not_found", reason: "dosu_entry_absent" });
    expect(plan.nextContent).toBeUndefined();
  });

  it.each([
    ["[]", "root_not_object"],
    ['{"mcpServers":true}', "top_key_not_object"],
    ['{"mcpServers":{"dosu":"user-owned"}}', "foreign_dosu_entry"],
    ['{"other":{}}', "dosu_entry_absent"],
  ])("fails closed for structural JSON edge case %#", (content, reason) => {
    expect(planLegacyJsonMcp({ content, provider: "claude", topKey: "mcpServers" })).toMatchObject({
      reason,
    });
  });

  it.each([
    42,
    "not a URL",
    "ftp://api.dosu.dev/v1/mcp",
    "https://api.dosu.dev/v1/mcp?mine=true",
    "https://api.dosu.dev/v1/mcp#mine",
  ])("preserves a same-named entry with an unowned endpoint %#", (url) => {
    const content = JSON.stringify({
      mcpServers: {
        dosu: { type: "http", url, headers: { "X-Dosu-API-Key": API_KEY } },
      },
    });
    expect(planLegacyJsonMcp({ content, provider: "claude", topKey: "mcpServers" })).toMatchObject({
      disposition: "preserved_ambiguous",
      reason: "foreign_dosu_entry",
    });
  });

  it.each([
    null,
    {},
    { "X-Dosu-API-Key": "" },
    { "X-Dosu-API-Key": API_KEY, Authorization: "mine" },
  ])("preserves standard entries whose header proof is not exact %#", (headers) => {
    const content = JSON.stringify({
      mcpServers: { dosu: { type: "http", url: DEPLOYMENT_URL, headers } },
    });
    expect(planLegacyJsonMcp({ content, provider: "claude", topKey: "mcpServers" })).toMatchObject({
      disposition: "preserved_ambiguous",
      reason: "unknown_dosu_shape",
    });
  });

  it("accepts the released Windows Claude Desktop command and PATH shape", () => {
    const content = JSON.stringify({
      mcpServers: {
        dosu: {
          command: "C:\\Program Files\\nodejs\\npx.cmd",
          args: [
            "-y",
            "mcp-remote@0.1.38",
            DEPLOYMENT_URL,
            "--header",
            "X-Dosu-API-Key:$" + "{X_DOSU_API_KEY}",
            "--transport",
            "http-only",
          ],
          env: {
            PATH: "C:\\Program Files\\nodejs;C:\\Windows\\System32",
            X_DOSU_API_KEY: API_KEY,
          },
        },
      },
    });
    expect(
      planLegacyJsonMcp({ content, provider: "claude-desktop", topKey: "mcpServers" }),
    ).toMatchObject({ disposition: "remove" });
  });

  it.each([
    { command: 1 },
    { command: "npx" },
    { command: "/usr/bin/node" },
    { args: "not-an-array" },
    { args: ["-y"] },
    { env: null },
    { env: { PATH: "/usr/bin", X_DOSU_API_KEY: API_KEY, USER_VALUE: "mine" } },
  ])("preserves mutated Claude Desktop ownership evidence %#", (replacement) => {
    const entry = {
      command: "/usr/bin/npx",
      args: [
        "-y",
        "mcp-remote@0.1.38",
        DEPLOYMENT_URL,
        "--header",
        "X-Dosu-API-Key:$" + "{X_DOSU_API_KEY}",
        "--transport",
        "http-only",
      ],
      env: { PATH: "/usr/bin:/bin", X_DOSU_API_KEY: API_KEY },
      ...replacement,
    };
    const content = JSON.stringify({ mcpServers: { dosu: entry } });
    expect(
      planLegacyJsonMcp({ content, provider: "claude-desktop", topKey: "mcpServers" }),
    ).toMatchObject({ disposition: "preserved_ambiguous" });
  });

  it("validates every provider-specific project proxy envelope", () => {
    const expectation = { packageVersion: "0.43.0", deploymentID: "dep-project" } as const;
    const args = ["-y", "@dosu/cli@0.43.0", "mcp", "proxy", "--deployment", "dep-project"];
    const cases = [
      ["claude", "mcpServers", { type: "stdio", command: "npx", args }],
      ["gemini", "mcpServers", { command: "npx", args }],
      ["zed", "context_servers", { command: "npx", args, env: {} }],
      ["opencode", "mcp", { type: "local", command: ["npx", ...args], enabled: true }],
    ] as const;
    for (const [provider, topKey, entry] of cases) {
      expect(
        isExactProjectJsonProxy({
          content: JSON.stringify({ [topKey]: { dosu: entry } }),
          provider,
          topKey,
          expectation,
        }),
      ).toBe(true);
    }
  });

  it("rejects malformed project proxy documents and envelopes", () => {
    const expectation = { packageVersion: "0.43.0", oss: true } as const;
    for (const content of ["{", "[]", '{"mcpServers":{"dosu":{},"dosu":{}}}']) {
      expect(
        isExactProjectJsonProxy({ content, provider: "claude", topKey: "mcpServers", expectation }),
      ).toBe(false);
    }
    expect(
      isExactProjectJsonProxy({
        content: JSON.stringify({
          context_servers: { dosu: { command: "npx", args: [], env: { MINE: "1" } } },
        }),
        provider: "zed",
        topKey: "context_servers",
        expectation,
      }),
    ).toBe(false);
  });

  it("raw JSONC removal refuses non-objects, absent keys, and inconsistent separators", () => {
    const content = '{"dosu":1,"other":2}';
    const root = parseTree(content);
    const valueNode = root?.children?.[0]?.children?.[1];
    if (!root || !valueNode) throw new Error("expected parsed object fixture");
    expect(removeJsonObjectPropertyRaw(content, valueNode, "dosu")).toBe(null);
    expect(removeJsonObjectPropertyRaw(content, root, "missing")).toBe(null);
    expect(removeJsonObjectPropertyRaw(content.replace(",", ":"), root, "dosu")).toBe(null);
  });
});

describe("legacy Codex TOML planner", () => {
  it("removes the pre-v0.42 HTTP form and keeps unrelated TOML byte content", () => {
    const content = `model = "gpt-5"

[mcp_servers.other]
url = "https://example.com"

[mcp_servers.dosu]
type = "http"
url = "${DEPLOYMENT_URL}"

[mcp_servers.dosu.http_headers]
X-Dosu-API-Key = "${API_KEY}"

[projects."/tmp/example"]
trust_level = "trusted"
`;
    const plan = planLegacyCodexMcp(content);
    expect(plan.disposition).toBe("remove");
    expect(plan.nextContent).toContain('model = "gpt-5"');
    expect(plan.nextContent).toContain("[mcp_servers.other]");
    expect(plan.nextContent).toContain('[projects."/tmp/example"]');
    expect(plan.nextContent).not.toContain("mcp_servers.dosu");
    expect(plan.nextContent).not.toContain(API_KEY);
  });

  it("removes the current stdio mcp-remote form", () => {
    const content = `[mcp_servers.dosu]
command = "/opt/homebrew/bin/npx"
args = ["-y", "mcp-remote@0.1.38", "${DEPLOYMENT_URL}", "--header", "X-Dosu-API-Key:\${X_DOSU_API_KEY}", "--transport", "http-only"]

[mcp_servers.dosu.env]
PATH = "/opt/homebrew/bin:/usr/bin:/bin"
X_DOSU_API_KEY = "${API_KEY}"
`;
    const plan = planLegacyCodexMcp(content);
    expect(plan.disposition).toBe("remove");
    expect(plan.nextContent).not.toContain("mcp_servers.dosu");
    expect(plan.nextContent).not.toContain(API_KEY);
  });

  it("preserves trailing user comments byte-for-byte after the last legacy assignment", () => {
    const kept = `# KEEP USER COMMENT

[mcp_servers.other]
url = "https://example.com"
`;
    const content = `[mcp_servers.dosu]
type = "http"
url = "${DEPLOYMENT_URL}"

[mcp_servers.dosu.http_headers]
X-Dosu-API-Key = "${API_KEY}"
${kept}`;
    const plan = planLegacyCodexMcp(content);
    expect(plan).toMatchObject({ disposition: "remove", nextContent: `\n${kept}` });
  });

  it("refuses duplicate Dosu sections", () => {
    const content = `[mcp_servers.dosu]
type = "http"
url = "${DEPLOYMENT_URL}"
[mcp_servers.dosu]
type = "http"
url = "${DEPLOYMENT_URL}"
`;
    expect(planLegacyCodexMcp(content)).toMatchObject({
      disposition: "preserved_ambiguous",
      reason: "parse_error",
    });
  });

  it("refuses foreign and unknown shapes", () => {
    const foreign = `[mcp_servers.dosu]\ntype = "http"\nurl = "https://example.com/mcp"\n`;
    expect(planLegacyCodexMcp(foreign)).toMatchObject({
      disposition: "preserved_ambiguous",
      reason: "foreign_dosu_entry",
    });

    const unknown = `[mcp_servers.dosu]\ntype = "http"\nurl = "${DEPLOYMENT_URL}"\nuser_key = true\n`;
    expect(planLegacyCodexMcp(unknown)).toMatchObject({
      disposition: "preserved_ambiguous",
      reason: "unknown_dosu_shape",
    });
  });

  it("preserves a complete Codex-shaped entry on a foreign origin", () => {
    const content = `[mcp_servers.dosu]
type = "http"
url = "https://example.invalid/v1/mcp/deployments/dep-123"

[mcp_servers.dosu.http_headers]
X-Dosu-API-Key = "${API_KEY}"
`;

    expect(planLegacyCodexMcp(content)).toMatchObject({
      disposition: "preserved_ambiguous",
      reason: "foreign_dosu_entry",
    });
  });

  it("preserves a complete Codex-shaped URL containing userinfo", () => {
    const content = `[mcp_servers.dosu]
type = "http"
url = "https://user:pass@api.dosu.dev/v1/mcp/deployments/dep-123"

[mcp_servers.dosu.http_headers]
X-Dosu-API-Key = "${API_KEY}"
`;

    expect(planLegacyCodexMcp(content)).toMatchObject({
      disposition: "preserved_ambiguous",
      reason: "foreign_dosu_entry",
    });
  });

  it("refuses an orphan nested Dosu section", () => {
    const content = `[mcp_servers.dosu.http_headers]\nX-Dosu-API-Key = "${API_KEY}"\n`;
    expect(planLegacyCodexMcp(content)).toMatchObject({
      disposition: "preserved_ambiguous",
      reason: "incomplete_dosu_shape",
    });
  });

  it("never treats table-like text inside TOML multiline strings as a section", () => {
    const content = `message = """
[mcp_servers.dosu]
type = "http"
url = "${DEPLOYMENT_URL}"
[mcp_servers.dosu.http_headers]
X-Dosu-API-Key = "${API_KEY}"
"""

[mcp_servers.other]
url = "https://example.com"
`;
    expect(planLegacyCodexMcp(content)).toMatchObject({
      disposition: "not_found",
      reason: "dosu_entry_absent",
    });
  });

  it("preserves malformed TOML with an unterminated multiline string", () => {
    const content = `message = """
[mcp_servers.dosu]
type = "http"
url = "${DEPLOYMENT_URL}"
`;
    expect(planLegacyCodexMcp(content)).toMatchObject({
      disposition: "preserved_ambiguous",
      reason: "parse_error",
    });
  });

  it("also ignores table-like text inside multiline literal strings", () => {
    const content = `message = '''
[mcp_servers.dosu]
type = "http"
url = "${DEPLOYMENT_URL}"
'''
`;
    expect(planLegacyCodexMcp(content)).toMatchObject({
      disposition: "not_found",
      reason: "dosu_entry_absent",
    });
  });

  it("requires the entire document to be valid TOML before removing a legacy table", () => {
    const content = `invalid = = =

[mcp_servers.dosu]
type = "http"
url = "${DEPLOYMENT_URL}"

[mcp_servers.dosu.http_headers]
X-Dosu-API-Key = "${API_KEY}"
`;
    expect(planLegacyCodexMcp(content)).toMatchObject({
      disposition: "preserved_ambiguous",
      reason: "parse_error",
    });
  });

  it("rejects a relative PATH in the released stdio form", () => {
    const content = `[mcp_servers.dosu]
command = "/usr/local/bin/npx"
args = ["-y", "mcp-remote@0.1.38", "${DEPLOYMENT_URL}", "--header", "X-Dosu-API-Key:\${X_DOSU_API_KEY}", "--transport", "http-only"]

[mcp_servers.dosu.env]
PATH = "relative/bin:/usr/bin"
X_DOSU_API_KEY = "${API_KEY}"
`;
    expect(planLegacyCodexMcp(content)).toMatchObject({
      disposition: "preserved_ambiguous",
      reason: "unknown_dosu_shape",
    });
  });

  it.each([
    [`[mcp_servers.dosu]\n\ntype = "http"\nurl = "${DEPLOYMENT_URL}"\n`, "unknown_dosu_shape"],
    [
      `[mcp_servers.dosu]\ntype = "http" # comment\nurl = "${DEPLOYMENT_URL}"\n`,
      "unknown_dosu_shape",
    ],
    [`[mcp_servers.dosu]\ntype = 1\nurl = "${DEPLOYMENT_URL}"\n`, "unknown_dosu_shape"],
    [
      `[mcp_servers.dosu]\ntype = "http"\ntype = "http"\nurl = "${DEPLOYMENT_URL}"\n`,
      "parse_error",
    ],
    [
      `[mcp_servers.dosu]\ntype = "http"\nurl = "${DEPLOYMENT_URL}"\n\n[mcp_servers.other]\nurl = "https://example.com"\n\n[mcp_servers.dosu.http_headers]\nX-Dosu-API-Key = "${API_KEY}"\n`,
      "noncontiguous_dosu_sections",
    ],
  ])("preserves strict TOML ownership edge case %#", (content, reason) => {
    expect(planLegacyCodexMcp(content)).toMatchObject({
      disposition: "preserved_ambiguous",
      reason,
    });
  });

  it("recognizes the released Codex shape with CRLF and a Windows absolute PATH", () => {
    const content = [
      "[mcp_servers.dosu]",
      'command = "C:\\\\Program Files\\\\nodejs\\\\npx.cmd"',
      `args = ["-y", "mcp-remote@0.1.38", "${DEPLOYMENT_URL}", "--header", "X-Dosu-API-Key:\${X_DOSU_API_KEY}", "--transport", "http-only"]`,
      "[mcp_servers.dosu.env]",
      'PATH = "C:\\\\Program Files\\\\nodejs;C:\\\\Windows\\\\System32"',
      `X_DOSU_API_KEY = "${API_KEY}"`,
      "",
    ].join("\r\n");
    expect(planLegacyCodexMcp(content)).toMatchObject({ disposition: "remove" });
  });
});

describe("project Codex TOML planner", () => {
  const expected = { packageVersion: "0.43.0", deploymentID: "dep-project" } as const;
  const projectSection = `[mcp_servers.dosu]\ncommand = "npx"\nargs = ["-y", "@dosu/cli@0.43.0", "mcp", "proxy", "--deployment", "dep-project"]\n`;

  it("recognizes and range-removes only the exact current secretless proxy", () => {
    const content = `model = "gpt-5"\n\n${projectSection}\n[projects."/repo"]\ntrust_level = "trusted"\n`;
    expect(isExactProjectCodexProxy(content, expected)).toBe(true);
    const plan = planProjectCodexMcp(content, expected);
    expect(plan).toMatchObject({ disposition: "remove", mutation: "write" });
    expect(plan.nextContent).toContain('model = "gpt-5"');
    expect(plan.nextContent).toContain('[projects."/repo"]');
    expect(plan.nextContent).not.toContain("mcp_servers.dosu");
  });

  it("preserves trailing user comments byte-for-byte after the project proxy assignment", () => {
    const kept = `# KEEP USER COMMENT

[projects."/repo"]
trust_level = "trusted"
`;
    const plan = planProjectCodexMcp(`${projectSection}${kept}`, expected);
    expect(plan).toMatchObject({ disposition: "remove", nextContent: kept });
  });

  it("rejects a wrong deployment, raw-key field, duplicate section, and unknown field", () => {
    expect(
      isExactProjectCodexProxy(projectSection.replace("dep-project", "other-deployment"), expected),
    ).toBe(false);
    expect(
      planProjectCodexMcp(`${projectSection}X_DOSU_API_KEY = "secret"\n`, expected),
    ).toMatchObject({ disposition: "preserved_ambiguous", reason: "unknown_dosu_shape" });
    expect(planProjectCodexMcp(`${projectSection}${projectSection}`, expected)).toMatchObject({
      disposition: "preserved_ambiguous",
      reason: "parse_error",
    });
    expect(
      planProjectCodexMcp(projectSection.replace("\n", '\nuser_key = "mine"\n'), expected),
    ).toMatchObject({ disposition: "preserved_ambiguous", reason: "unknown_dosu_shape" });
  });

  it("recognizes the exact OSS proxy independently from global paths", () => {
    const content = `[mcp_servers.dosu]\ncommand = "npx"\nargs = ["-y", "@dosu/cli@0.43.0", "mcp", "proxy", "--oss"]\n`;
    expect(isExactProjectCodexProxy(content, { packageVersion: "0.43.0", oss: true })).toBe(true);
  });

  it("accepts any exact pinned project proxy for safe provider upgrades", () => {
    const old = projectSection.replace("@dosu/cli@0.43.0", "@dosu/cli@0.42.1");
    expect(isExactProjectCodexProxy(old)).toBe(true);
    expect(planProjectCodexMcp(old)).toMatchObject({ disposition: "remove" });
  });

  it("requires the entire document to be valid TOML before proving a project proxy", () => {
    const content = `invalid = = =\n\n${projectSection}`;
    expect(isExactProjectCodexProxy(content, expected)).toBe(false);
    expect(planProjectCodexMcp(content, expected)).toMatchObject({
      disposition: "preserved_ambiguous",
      reason: "parse_error",
    });
  });

  it.each([
    `[mcp_servers.dosu]\ncommand = "other"\nargs = ["-y", "@dosu/cli@0.43.0", "mcp", "proxy", "--oss"]\n`,
    `[mcp_servers.dosu]\ncommand = "npx"\nargs = ["-y", "@dosu/cli@latest", "mcp", "proxy", "--oss"]\n`,
    `[mcp_servers.dosu]\ncommand = "npx"\nargs = ["-y", "@dosu/cli@0.43.0", "mcp", "proxy", "--deployment", ""]\n`,
    `[mcp_servers.dosu]\ncommand = "npx"\nargs = [1]\n`,
  ])("does not own a mutated historical project pin %#", (content) => {
    expect(planProjectCodexMcp(content)).toMatchObject({ disposition: "preserved_ambiguous" });
  });

  it("covers explicit shared planner policy switches", () => {
    expect(planCodexDosuMcp('model = "gpt-5"\n', { allowLegacyGlobal: false })).toMatchObject({
      disposition: "not_found",
    });
    expect(planCodexDosuMcp(projectSection, { projectProxy: undefined })).toMatchObject({
      disposition: "preserved_ambiguous",
    });
  });
});

describe("shared Codex semantic ownership guard", () => {
  it("refuses quoted or dotted semantic Dosu tables that raw range removal cannot own", () => {
    for (const header of ['[mcp_servers."dosu"]', '["mcp_servers".dosu]']) {
      const content = `${header}\ncommand = "npx"\nargs = ["-y", "@dosu/cli@0.43.0", "mcp", "proxy", "--oss"]\n`;
      expect(planCodexDosuMcp(content)).toMatchObject({
        disposition: "preserved_ambiguous",
        reason: "semantic_dosu_table_unowned",
      });
    }
  });

  it("does not mistake quoted table text inside a multiline string for semantic config", () => {
    const content = `message = """
[mcp_servers."dosu"]
command = "npx"
"""
`;
    expect(planCodexDosuMcp(content)).toMatchObject({
      disposition: "not_found",
      reason: "dosu_entry_absent",
    });
  });
});

describe("legacy rules planners", () => {
  it("removes one complete marker block and preserves user instructions", () => {
    const content = `# User instructions

<!-- dosu:rules:start v1 -->
${RELEASED_RULE.trimEnd()}
<!-- dosu:rules:end -->

Keep this.
`;
    const plan = planLegacyRuleSection(content);
    expect(plan).toMatchObject({ disposition: "remove", mutation: "write" });
    expect(plan.nextContent).toContain("# User instructions");
    expect(plan.nextContent).toContain("Keep this.");
    expect(plan.nextContent).not.toContain("dosu:rules:start");
  });

  it("does not normalize blank lines outside the owned marker block", () => {
    const content = `First line



Second line

<!-- dosu:rules:start v1 -->
${RELEASED_RULE.trimEnd()}
<!-- dosu:rules:end -->

Last line
`;
    const plan = planLegacyRuleSection(content);
    expect(plan).toMatchObject({ disposition: "remove", mutation: "write" });
    expect(plan.nextContent).toBe(`First line



Second line


Last line
`);
  });

  it("plans file deletion when the marker block is the whole file", () => {
    const content = `<!-- dosu:rules:start v1 -->\n${RELEASED_RULE.trimEnd()}\n<!-- dosu:rules:end -->\n`;
    expect(planLegacyRuleSection(content)).toMatchObject({
      disposition: "remove",
      mutation: "delete",
    });
  });

  it("handles CRLF marker blocks and the completely absent case", () => {
    expect(planLegacyRuleSection("user text\r\n")).toMatchObject({
      disposition: "not_found",
      reason: "dosu_rule_absent",
    });
    expect(
      planLegacyRuleSection(
        `before\r\n<!-- dosu:rules:start v1 -->\r\n${RELEASED_RULE.trimEnd().replace(/\n/g, "\r\n")}\r\n<!-- dosu:rules:end -->\r\nafter\r\n`,
      ),
    ).toMatchObject({ disposition: "remove", mutation: "write" });
  });

  it("preserves a marker block whose body was edited by the user", () => {
    const content =
      "<!-- dosu:rules:start v1 -->\nUSER CUSTOM: never delete\n<!-- dosu:rules:end -->\n";
    expect(planLegacyRuleSection(content)).toMatchObject({
      disposition: "preserved_ambiguous",
      reason: "modified_rule_section",
    });
  });

  it("refuses duplicate or incomplete markers", () => {
    expect(
      planLegacyRuleSection(
        "<!-- dosu:rules:start v1 -->a<!-- dosu:rules:end -->\n<!-- dosu:rules:start v1 -->b<!-- dosu:rules:end -->",
      ),
    ).toMatchObject({ disposition: "preserved_ambiguous", reason: "duplicate_marker" });
    expect(planLegacyRuleSection("<!-- dosu:rules:start v1 -->\nmissing end")).toMatchObject({
      disposition: "preserved_ambiguous",
      reason: "incomplete_marker",
    });
  });

  it("deletes only exact released standalone Claude/Cursor rules", () => {
    expect(planLegacyStandaloneRule(RELEASED_RULE, "claude")).toMatchObject({
      disposition: "remove",
      mutation: "delete",
    });
    const cursorRule = `---\nalwaysApply: true\n---\n\n${RELEASED_RULE}`;
    expect(planLegacyStandaloneRule(cursorRule, "cursor")).toMatchObject({
      disposition: "remove",
      mutation: "delete",
    });
    expect(planLegacyStandaloneRule(`${RELEASED_RULE}\n# user edit\n`, "claude")).toMatchObject({
      disposition: "preserved_ambiguous",
      reason: "modified_standalone_rule",
    });
  });
});
