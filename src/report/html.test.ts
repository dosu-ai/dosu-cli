import { describe, expect, it } from "vitest";
import { buildReportHtml, parseLineSpec, renderTraceHtml } from "./html";
import type { ReportCandidate, ReportInventory } from "./types";

const inventory: ReportInventory = {
  transcripts: [
    {
      source: "claude",
      transcript_id: "sess-1",
      title: "why does auth retry?",
      learning_tokens: 20_000,
      rediscovery_tool_calls: 4,
      user_queries: ["why does auth retry?"],
    },
  ],
  totals: { learning_tokens: 20_000 },
};

const written: ReportCandidate = {
  title: "OAuth refresh token expiry",
  content: "Retry after 401; do not reuse the expired access token.",
  transcript_id: "sess-1",
  status: "written",
  approx_rediscovery_tokens: 12_000,
  investigation_lines: "1-2",
  user_query: "why does auth retry?",
};

describe("buildReportHtml", () => {
  it("renders the skill report sections for written notes", () => {
    const html = buildReportHtml({
      inventory,
      candidates: [written],
      orgName: "Acme",
      projects: ["dosu", "dosu-cli"],
      generatedAt: new Date("2026-09-09T19:00:00Z"),
    });
    expect(html).toContain("Dosu knowledge report — Acme");
    expect(html).toContain("Dosu · Knowledge report");
    expect(html).toContain("Iowan Old Style");
    expect(html).toContain("Tokens scanned");
    expect(html).toContain("Notes written to Dosu");
    expect(html).toContain("OAuth refresh token expiry");
    expect(html).toContain("Heaviest sessions");
    expect(html).toContain("Print / Save as PDF");
    expect(html).toContain("Projects <code>dosu</code>, <code>dosu-cli</code>");
    expect(html).toContain("why does auth retry?");
    expect(html).toContain("window.print()");
    expect(html).not.toContain("<code>sess-1</code>");
  });

  it("escapes HTML in titles", () => {
    const html = buildReportHtml({
      inventory,
      candidates: [{ ...written, title: "<script>alert(1)</script>" }],
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("labels dry-run candidates as proposed", () => {
    const html = buildReportHtml({
      inventory,
      candidates: [{ title: "A", content: "B" }],
      dryRun: true,
    });
    expect(html).toContain("Proposed write_knowledge calls");
    expect(html).toContain("status-proposed");
  });

  it("includes a Work to learn this expander from a digest", () => {
    const html = buildReportHtml({
      inventory,
      candidates: [written],
      digests: {
        "sess-1": {
          turns: [
            { role: "user", line: 1, est_tokens: 12, text: ["why does auth retry?"], tools: [] },
            {
              role: "assistant",
              line: 2,
              est_tokens: 40,
              text: [],
              tools: [{ name: "Read", path: "src/auth.py" }],
            },
          ],
        },
      },
    });
    expect(html).toContain("Work to learn this");
    expect(html).toContain("auth.py");
  });
});

describe("renderTraceHtml", () => {
  it("returns empty without a matching digest", () => {
    expect(renderTraceHtml({ transcript_id: "missing" }, {})).toBe("");
  });
});

describe("parseLineSpec", () => {
  it("parses ranges and singles", () => {
    expect([...parseLineSpec("1-3,5")].sort((a, b) => a - b)).toEqual([1, 2, 3, 5]);
  });

  it("accepts arrays, reversed ranges, and empty values", () => {
    expect([...parseLineSpec(["4-2", "9"])].sort((a, b) => a - b)).toEqual([2, 3, 4, 9]);
    expect(parseLineSpec(null).size).toBe(0);
    expect(parseLineSpec("").size).toBe(0);
  });
});

describe("buildReportHtml empty and mixed", () => {
  it("renders the empty-notes copy", () => {
    const html = buildReportHtml({ inventory, candidates: [] });
    expect(html).toContain("write_knowledge notes");
    expect(html).toContain("No write_knowledge payloads yet");
    expect(html).toContain("Tokens scanned");
  });

  it("falls back to transcript learning_tokens when inventory totals are missing", () => {
    const html = buildReportHtml({
      inventory: { transcripts: inventory.transcripts },
      candidates: [written],
    });
    expect(html).toContain("20,000");
  });

  it("labels mixed statuses in the notes heading", () => {
    const html = buildReportHtml({
      inventory,
      candidates: [
        { ...written, status: "written" },
        { title: "Draft", content: "soon", status: "pending" },
        { title: "Idea", content: "maybe", status: "proposed" },
        { title: "Known", content: "already", status: "already_in_library" },
      ],
    });
    expect(html).toContain("1 written");
    expect(html).toContain("1 pending");
    expect(html).toContain("1 proposed");
    expect(html).toContain("1 already in library");
  });

  it("renders with no candidates argument at all", () => {
    const html = buildReportHtml({ inventory });
    expect(html).toContain("write_knowledge notes");
  });
});

describe("renderTraceHtml tools", () => {
  it("classifies SQL, planning, and code tools in the expander", () => {
    const html = renderTraceHtml(
      { transcript_id: "sess-1", investigation_lines: "1-4", approx_rediscovery_tokens: 100 },
      {
        "sess-1": {
          turns: [
            { role: "user", line: 1, est_tokens: 10, text: ["why?"], tools: [] },
            {
              role: "assistant",
              line: 2,
              est_tokens: 30,
              text: [],
              tools: [{ name: "execute_sql", query: "select 1 from orders" }],
            },
            {
              role: "assistant",
              line: 3,
              est_tokens: 20,
              text: [],
              tools: [{ name: "TodoWrite" }],
            },
            {
              role: "assistant",
              line: 4,
              est_tokens: 8,
              text: [],
              tools: [{ name: "Edit", path: "src/auth.py" }],
            },
          ],
        },
      },
    );
    expect(html).toContain("Work to learn this");
    expect(html).toContain("SQL");
    expect(html).toContain("implementation (not counted)");
    expect(html).toContain("auth.py");
  });
});

describe("trace preview fallback ladder", () => {
  const digestFor = (tools: object[], text: string[] = []) => ({
    "sess-1": {
      turns: [
        { role: "user", line: 1, est_tokens: 5, text: ["q"], tools: [] },
        { role: "assistant", line: 2, est_tokens: 40, text, tools },
      ],
    },
  });
  const cand = { transcript_id: "sess-1", investigation_lines: "1-2" };

  it("walks pattern, command, query, file_path, and prompt previews", () => {
    const html = renderTraceHtml(
      cand,
      digestFor([
        { name: "Grep", pattern: "retry after 401" },
        { name: "Shell", command_preview: "rg refresh" },
        { name: "Search", query: "token rotation" },
        { name: "Read", file_path: "src/deep/leaf-file.ts" },
        { name: "Read", file_path: "noslash.ts" },
        { name: "Task", prompt: "trace the retry loop" },
        { name: "Read", path: "bare-path.ts" },
      ]),
    );
    for (const s of [
      "retry after 401",
      "rg refresh",
      "token rotation",
      "leaf-file.ts",
      "noslash.ts",
      "trace the retry loop",
      "bare-path.ts",
    ]) {
      expect(html).toContain(s);
    }
  });

  it("falls back to MCP knowledge args, arguments, tool_name/server, and canned labels", () => {
    const html = renderTraceHtml(
      cand,
      digestFor([
        { name: "CallMcpTool", knowledge: { tool: "query_logs", arguments: { sql: "select 2" } } },
        { name: "mcp__srv__deep_tool", arguments: { description: "described call" } },
        { name: "CallMcpTool", tool_name: "snake_tool", server: "dosu" },
        { name: "GetMcpTools" },
        { name: "CallMcpTool" },
        { name: "CallMcpTool", knowledge: { tool: "some_tool" } },
        { name: "mcp:inner_tool" },
        {},
      ]),
    );
    expect(html).toContain("select 2");
    expect(html).toContain("described call");
    expect(html).toContain("snake_tool · dosu");
    expect(html).toContain("Look up available MCP tools");
    expect(html).toContain("MCP call");
    expect(html).toContain("MCP call · some_tool");
    expect(html).toContain("inner_tool");
    expect(html).toContain("No input recorded");
    expect(html).toContain("Logs");
    expect(html).toContain("MCP schema");
  });

  it("caps long traces with an omitted-steps row and counts reasoning turns", () => {
    const turns = [
      { role: "user", line: 1, est_tokens: 5, text: ["q"], tools: [] },
      { role: "assistant", line: 2, est_tokens: 3, text: ["thinking it through"], tools: [] },
      { role: "user", line: 3, est_tokens: 0, text: [""], tools: [] },
      ...Array.from({ length: 60 }, (_, i) => ({
        role: "assistant",
        line: i + 4,
        est_tokens: 0,
        text: [],
        tools: [{ name: "Read", path: `f${i}.ts` }],
      })),
    ];
    const html = renderTraceHtml(
      { transcript_id: "sess-1", investigation_lines: "1-70" },
      { "sess-1": { turns } },
    );
    expect(html).toContain("earlier steps omitted");
    expect(html).toContain("1 reasoning");
  });

  it("buckets write_knowledge as other and keeps two-status headings partial", () => {
    const html = renderTraceHtml(
      cand,
      digestFor([{ name: "write_knowledge" }, { name: "finalize_session_knowledge" }]),
    );
    expect(html).toContain("Work to learn this");
    const heading = buildReportHtml({
      inventory,
      candidates: [
        { ...written, status: "written" },
        { title: "Draft", content: "soon", status: "pending" },
      ],
    });
    expect(heading).toContain("1 written, 1 pending —");
  });
});

describe("presentation and inventory edges", () => {
  it("uses how_found and plain_english when present", () => {
    const html = buildReportHtml({
      inventory: {
        cwd: "git@fallback/repo.git",
        transcripts: [
          { source: "claude", transcript_id: "a", learning_tokens: 9 },
          { source: "cursor", transcript_id: "b", learning_tokens: 40 },
        ],
      },
      candidates: [
        {
          title: "Idea",
          content: "Idea",
          plain_english: "Say it simply.",
          how_found: "Read tokens.py then retried.",
          status: "already_in_library",
        },
      ],
    });
    expect(html).toContain("Notes already in the Library");
    expect(html).toContain("Say it simply.");
    expect(html).toContain("To find this");
    expect(html).toContain("Read tokens.py then retried.");
    expect(html).toContain("cursor");
  });

  it("shows an em dash when rediscovery tokens are missing", () => {
    const html = buildReportHtml({
      inventory,
      candidates: [{ title: "X", content: "Y", status: "written" }],
    });
    expect(html).toContain("rediscovery ~— tok");
    expect(html).toContain("Investigation stretch was not measured.");
  });
});

describe("renderTraceHtml coverage", () => {
  it("renders no trace when investigation_lines is absent — never a session-sized one", () => {
    const html = renderTraceHtml(
      { transcript_id: "sess-1" },
      {
        "sess-1": {
          turns: [
            { role: "user", line: 2, est_tokens: 4, text: "plain string question" },
            { role: "assistant", line: 3, est_tokens: 6, text: ["because 401"] },
          ],
        },
      },
    );
    expect(html).toBe("");
  });

  it("renders a trace from an attributed line range (string text turns included)", () => {
    const html = renderTraceHtml(
      { transcript_id: "sess-1", investigation_lines: "2-3" },
      {
        "sess-1": {
          turns: [
            { role: "user", line: 2, est_tokens: 4, text: "plain string question" },
            { role: "assistant", line: 3, est_tokens: 6, text: ["because 401"] },
          ],
        },
      },
    );
    expect(html).toContain("Question");
    expect(html).toContain("Reasoning");
  });

  it("skips empty user turns, tool_result, and caps long traces", () => {
    const turns = [
      { role: "user", line: 1, est_tokens: 1, text: [] },
      ...Array.from({ length: 55 }, (_, i) => ({
        role: "assistant" as const,
        line: i + 2,
        est_tokens: 2,
        text: [`step ${i}`],
      })),
    ];
    const html = renderTraceHtml(
      { transcript_id: "sess-1", investigation_lines: `1-${turns.length}` },
      { "sess-1": { turns } },
    );
    expect(html).toContain("earlier steps omitted");
  });

  it("previews MCP wrappers, arguments, and knowledge payloads", () => {
    const html = renderTraceHtml(
      { transcript_id: "sess-1", investigation_lines: "1-8" },
      {
        "sess-1": {
          turns: [
            { role: "user", line: 1, est_tokens: 3, text: ["go"] },
            {
              role: "assistant",
              line: 2,
              est_tokens: 4,
              text: [],
              tools: [{ name: "Grep", pattern: "OAuthRefresh" }],
            },
            {
              role: "assistant",
              line: 3,
              est_tokens: 4,
              text: [],
              tools: [{ name: "Bash", command_preview: "git status" }],
            },
            {
              role: "assistant",
              line: 4,
              est_tokens: 4,
              text: [],
              tools: [{ name: "Read", file_path: "pkg/tokens.py" }],
            },
            {
              role: "assistant",
              line: 5,
              est_tokens: 4,
              text: [],
              tools: [{ name: "Agent", prompt: "summarize the retry path" }],
            },
            {
              role: "assistant",
              line: 6,
              est_tokens: 4,
              text: [],
              tools: [
                {
                  name: "CallMcpTool",
                  knowledge: { tool: "execute_sql", arguments: { sql: "select 1" } },
                },
              ],
            },
            {
              role: "assistant",
              line: 7,
              est_tokens: 4,
              text: [],
              tools: [{ name: "GetMcpTools" }],
            },
            {
              role: "assistant",
              line: 8,
              est_tokens: 4,
              text: [],
              tools: [
                { name: "tool_result" },
                {
                  name: "mcp__dosu__write_knowledge",
                  arguments: { query: "oauth refresh" },
                },
                { name: "mcp:query_logs" },
                { name: "CallMcpTool", toolName: "ask", server: "dosu" },
              ],
            },
          ],
        },
      },
    );
    expect(html).toContain("OAuthRefresh");
    expect(html).toContain("git status");
    expect(html).toContain("tokens.py");
    expect(html).toContain("summarize the retry path");
    expect(html).toContain("SQL");
    expect(html).toContain("MCP schema");
    expect(html).toContain("Logs");
    expect(html).toContain("select 1");
  });
});

describe("remaining html branches", () => {
  it("parses invalid fragments without throwing", () => {
    expect([...parseLineSpec(" , ,1-x, foo, 8")]).toEqual([8]);
  });

  it("renders untitled notes, mixed statuses, and missing inventory rows", () => {
    const html = buildReportHtml({
      inventory: { transcripts: undefined as unknown as [] },
      candidates: [
        { status: "proposed" },
        { title: "P", content: "pending", status: "pending" },
        { title: "A", content: "already", status: "already_in_library" },
        { title: "W", content: "written", status: "written" },
      ],
    });
    expect(html).toContain("Untitled");
    expect(html).toContain("1 written");
    expect(html).toContain("1 proposed");
    expect(html).toContain("1 pending");
    expect(html).toContain("1 already in library");
    expect(html).toContain("No sessions");
    expect(html).toContain("Extract a lean note");
  });

  it("returns empty traces for empty or unmatched digests", () => {
    expect(renderTraceHtml({ transcript_id: "sess-1" }, { "sess-1": { turns: [] } })).toBe("");
    expect(
      renderTraceHtml(
        { transcript_id: "sess-1", investigation_lines: "90-91" },
        {
          "sess-1": {
            turns: [{ role: "assistant", line: 1, est_tokens: 0, text: [] }],
          },
        },
      ),
    ).toBe("");
    expect(
      renderTraceHtml(
        { transcript_id: "sess-1" },
        { "sess-1": { turns: [{ role: "assistant", line: 0, est_tokens: 2, text: ["x"] }] } },
      ),
    ).toBe("");
  });

  it("covers leftover tool preview branches", () => {
    const long = "x".repeat(90);
    const html = renderTraceHtml(
      { transcript_id: "sess-1", investigation_lines: "1-6" },
      {
        "sess-1": {
          turns: [
            { role: "user", line: 1, est_tokens: 0, text: ["   "] },
            {
              role: "assistant",
              line: 2,
              est_tokens: 0,
              text: [],
              tools: [{ name: "Read", path: "auth.py" }, { name: "" }],
            },
            {
              role: "assistant",
              line: 3,
              est_tokens: 3,
              text: [],
              tools: [{ name: "CallMcpTool" }],
            },
            {
              role: "assistant",
              line: 4,
              est_tokens: 3,
              text: [],
              tools: [{ name: "Grep", arguments: { query: "" } }],
            },
            {
              role: "assistant",
              line: 5,
              est_tokens: 3,
              text: [],
              tools: [{ name: "Write", path: long }],
            },
            { role: "assistant", line: 6, est_tokens: 0, text: [] },
          ],
        },
      },
    );
    expect(html).toContain("MCP call");
    expect(html).toContain("auth.py");
    expect(html).toContain("No input recorded");
    expect(html).toContain("implementation (not counted)");
  });
});

it("uses turn text as the tool preview and empty-step traces", () => {
  expect(
    renderTraceHtml(
      { transcript_id: "sess-1", investigation_lines: "1" },
      { "sess-1": { turns: [{ role: "assistant", line: 1, est_tokens: 0, text: [] }] } },
    ),
  ).toBe("");
  const html = renderTraceHtml(
    { transcript_id: "sess-1", investigation_lines: "1-3" },
    {
      "sess-1": {
        turns: [
          { role: "user", line: 1, est_tokens: 1, text: ["ask"] },
          {
            role: "assistant",
            line: 2,
            est_tokens: 4,
            text: ["looked at the retry loop"],
            tools: [{ name: "UnknownTool" }],
          },
          {
            role: "assistant",
            line: 3,
            est_tokens: 2,
            text: [],
            tools: [{ name: "CallMcpTool", tool_name: "  " }],
          },
        ],
      },
    },
  );
  expect(html).toContain("looked at the retry loop");
  expect(html).toContain("MCP call");
});

describe("optional-field fallbacks", () => {
  type Transcript = ReportInventory["transcripts"][number];

  it("flags a capped fetch, treats zero rediscovery tokens as unmeasured, and tolerates bare rows", () => {
    const html = buildReportHtml({
      inventory: {
        transcripts: [
          { transcript_id: "a", learning_tokens: 0 } as unknown as Transcript,
          { source: "cursor", transcript_id: "b" } as unknown as Transcript,
        ],
      },
      candidates: [{ title: "Zero", content: "Zero", approx_rediscovery_tokens: 0 }],
      truncated: true,
    });
    expect(html).toContain("newest notes only (server capped the fetch)");
    expect(html).toContain("Investigation stretch was not measured.");
    expect(html).toContain("rediscovery ~0 tok");
    expect(html).toContain('<div class="label">Tokens scanned</div><div class="value">0</div>');
    // A transcript without a source renders an empty host cell rather than "undefined".
    expect(html).toContain("<td></td>");
    expect(html).not.toContain("undefined");
    expect(html).toContain("2 sessions with notes");
  });

  it("omits the truncation notice and pluralizes a single session", () => {
    const html = buildReportHtml({ inventory, candidates: [] });
    expect(html).not.toContain("newest notes only");
    expect(html).toContain("1 session with notes");
  });

  it("leaves out zero-count status bits in the mixed heading", () => {
    const noWritten = buildReportHtml({
      inventory,
      candidates: [
        { title: "P", content: "p", status: "pending" },
        { title: "Q", content: "q", status: "proposed" },
      ],
    });
    expect(noWritten).toContain("1 proposed, 1 pending —");
    expect(noWritten).not.toContain("written,");

    const noPending = buildReportHtml({
      inventory,
      candidates: [
        { title: "W", content: "w", status: "written" },
        { title: "Q", content: "q", status: "proposed" },
      ],
    });
    expect(noPending).toContain("1 written, 1 proposed —");
    expect(noPending).not.toContain("1 pending");
  });
});

describe("trace edge shapes", () => {
  it("renders no trace when the digest has no turns even with a line spec", () => {
    expect(
      renderTraceHtml(
        { transcript_id: "sess-1", investigation_lines: "1-2" },
        { "sess-1": { turns: [] } },
      ),
    ).toBe("");
  });

  it("handles turns missing line, role, text, and est_tokens with a zero-width bar", () => {
    const html = renderTraceHtml(
      { transcript_id: "sess-1", investigation_lines: "1-2" },
      {
        "sess-1": {
          turns: [
            { role: "user", text: ["q"] },
            { tools: [{ name: "Read", path: "a.ts" }] },
            { text: ["thought it over"] },
          ],
        },
      },
    );
    expect(html).toContain("Question");
    expect(html).toContain("a.ts");
    expect(html).toContain("thought it over");
    expect(html).toContain("1 reasoning");
    expect(html).toContain("~0 tok");
    // No learning tokens at all: every bar segment collapses to zero width and
    // the legend stays empty rather than dividing by zero.
    expect(html).toContain('class="tb context" style="width:0.0%"');
    expect(html).toContain('<p class="trace-legend"></p>');
    expect(html).toContain('<span class="tok"></span></li>');
  });

  it("falls through whitespace-only and trailing-slash preview fields", () => {
    const html = renderTraceHtml(
      { transcript_id: "sess-1", investigation_lines: "1-2" },
      {
        "sess-1": {
          turns: [
            { role: "user", line: 1, est_tokens: 1, text: ["q"] },
            {
              role: "assistant",
              line: 2,
              est_tokens: 7,
              text: [],
              tools: [
                { name: "Read", path: "dir/" },
                { name: "Grep", pattern: "   " },
                { name: "Shell", command_preview: "  " },
                { name: "Search", query: " " },
                { name: "Read", file_path: "nested/" },
                { name: "Task", prompt: "\t" },
                { name: "Tool", arguments: { query: "   ", sql: "select 9" } },
              ],
            },
          ],
        },
      },
    );
    expect(html.match(/No input recorded/g)).toHaveLength(6);
    expect(html).toContain("select 9");
    expect(html).not.toContain("dir/");
    expect(html).not.toContain("nested/");
  });
});

describe("buildReportHtml shipped sessions", () => {
  const shipped = [
    {
      at: "2026-09-01T00:00:00.000Z",
      session: "claude/abc",
      task_id: "task-1",
      session_url: "https://app/memories/sessions/abc?x=1&y=2",
      project: "dosu-cli",
    },
    { at: "2026-09-02T00:00:00.000Z", session: "codex/def", task_id: "task-2" },
  ];

  it("renders shipped rows newest first with escaped memory links", () => {
    const html = buildReportHtml({ inventory, shipped });

    expect(html).toContain("Shipped to Dosu memory");
    expect(html).toContain("claude/abc");
    expect(html).toContain("dosu-cli");
    // The URL is escaped into the anchor.
    expect(html).toContain('href="https://app/memories/sessions/abc?x=1&amp;y=2"');
    // A record the backend has not linked yet still shows, marked as processing.
    expect(html).toContain("codex/def");
    expect(html).toContain("processing");
    // Newest first: codex/def (Sep 2) renders before claude/abc (Sep 1).
    expect(html.indexOf("codex/def")).toBeLessThan(html.indexOf("claude/abc"));
    // The privacy footer reflects that transcripts were shipped, by choice.
    expect(html).toContain("Shipped transcripts are redacted locally before upload");
    expect(html).not.toContain("Session logs stay between you and your agent");
  });

  it("omits the section — and keeps the local-only privacy copy — when nothing shipped", () => {
    const html = buildReportHtml({ inventory });

    expect(html).not.toContain("Shipped to Dosu memory");
    expect(html).toContain("Session logs stay between you and your agent");
  });
});
