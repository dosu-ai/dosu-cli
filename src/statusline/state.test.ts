import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countKnowledge,
  knowledgeStateDir,
  knowledgeStatePath,
  loadToolResponseText,
  recordKnowledgeCounts,
} from "./state";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dosu-statusline-state-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const UUID = "123e4567-e89b-12d3-a456-426614174000";

/** A read_knowledge result: branch notes first, then org knowledge (real payload order). */
function knowledgeText(opts: { pages: string[]; notes: number; duplicatePage?: boolean }): string {
  const noteBlocks = Array.from(
    { length: opts.notes },
    (_, i) => `### Note ${i + 1}\nauthor_id: ${UUID}\ncontent: something learned`,
  );
  const notesSection = opts.notes > 0 ? `## Branch notes\n\n${noteBlocks.join("\n\n")}\n\n` : "";
  const pages = opts.duplicatePage ? [...opts.pages, ...opts.pages] : opts.pages;
  const sources = pages
    .map((url) => `<source url="${url}" title="Doc" lines="1-17" has_more="False">body</source>`)
    .join("\n");
  return `${notesSection}## Org knowledge\n\n${sources}\n`;
}

describe("countKnowledge", () => {
  it("counts distinct pages and branch notes", () => {
    const text = knowledgeText({
      pages: ["https://app.dosu.dev/doc/1", "https://app.dosu.dev/doc/2"],
      notes: 77,
    });
    expect(countKnowledge(text)).toEqual({ pages: 2, notes: 77 });
  });

  it("dedupes a document matching at several line ranges", () => {
    const text = knowledgeText({
      pages: ["https://app.dosu.dev/doc/1"],
      notes: 0,
      duplicatePage: true,
    });
    expect(countKnowledge(text)).toEqual({ pages: 1, notes: 0 });
  });

  it("counts zero notes when there is no branch-notes section", () => {
    const text = knowledgeText({ pages: ["https://app.dosu.dev/doc/1"], notes: 0 });
    expect(countKnowledge(text)).toEqual({ pages: 1, notes: 0 });
  });

  it("does not count author_id-like prose outside the notes section", () => {
    const text = `## Org knowledge\n\nauthor_id: ${UUID}\n<source url="https://app.dosu.dev/doc/1" title="Doc">x</source>`;
    expect(countKnowledge(text)).toEqual({ pages: 1, notes: 0 });
  });

  it("returns zeros for text with no knowledge", () => {
    expect(countKnowledge("No knowledge found.")).toEqual({ pages: 0, notes: 0 });
  });
});

describe("loadToolResponseText", () => {
  it("unwraps string, result, content, and text shapes", () => {
    expect(loadToolResponseText("plain")).toBe("plain");
    expect(loadToolResponseText({ result: "r" })).toBe("r");
    expect(loadToolResponseText({ content: "c" })).toBe("c");
    expect(loadToolResponseText({ text: "t" })).toBe("t");
    expect(loadToolResponseText({ other: 1 })).toBe('{"other":1}');
  });

  it("follows an offload pointer to a raw-JSON file (the common case)", () => {
    const text = knowledgeText({ pages: ["https://app.dosu.dev/doc/1"], notes: 3 });
    const offload = join(home, "offload-read_knowledge-1.txt");
    writeFileSync(offload, JSON.stringify({ result: text }));
    const loaded = loadToolResponseText(`Tool result was too large, saved to ${offload}`);
    expect(countKnowledge(loaded)).toEqual({ pages: 1, notes: 3 });
  });

  it("falls back to unescaping when the offload file is truncated JSON", () => {
    const text = knowledgeText({ pages: ["https://app.dosu.dev/doc/1"], notes: 2 });
    const offload = join(home, "offload-truncated.txt");
    writeFileSync(offload, JSON.stringify({ result: text }).slice(0, -10));
    const loaded = loadToolResponseText(`saved to ${offload}`);
    expect(countKnowledge(loaded)).toEqual({ pages: 1, notes: 2 });
  });

  it("normalizes inline escaped-JSON text when the pointer file is missing", () => {
    const text = knowledgeText({ pages: ["https://app.dosu.dev/doc/1"], notes: 1 });
    const escaped = JSON.stringify(text).slice(1, -1); // escaped, no surrounding quotes
    expect(countKnowledge(loadToolResponseText(`saved to /nonexistent/x.txt ${escaped}`))).toEqual({
      pages: 1,
      notes: 1,
    });
  });
});

describe("recordKnowledgeCounts", () => {
  it("writes the state file for the session", () => {
    recordKnowledgeCounts("sess-1", { pages: 3, notes: 77 }, home);
    expect(JSON.parse(readFileSync(knowledgeStatePath("sess-1", home), "utf-8"))).toEqual({
      pages: 3,
      notes: 77,
    });
  });

  it("overwrites with the latest delivery", () => {
    recordKnowledgeCounts("sess-1", { pages: 3, notes: 77 }, home);
    recordKnowledgeCounts("sess-1", { pages: 1, notes: 0 }, home);
    expect(JSON.parse(readFileSync(knowledgeStatePath("sess-1", home), "utf-8"))).toEqual({
      pages: 1,
      notes: 0,
    });
  });

  it("writes nothing for all-zero counts or a missing session id", () => {
    recordKnowledgeCounts("sess-1", { pages: 0, notes: 0 }, home);
    recordKnowledgeCounts("", { pages: 1, notes: 0 }, home);
    expect(existsSync(knowledgeStateDir(home))).toBe(false);
  });

  it("prunes state files older than the TTL on write", () => {
    mkdirSync(knowledgeStateDir(home), { recursive: true });
    const stale = knowledgeStatePath("old-session", home);
    const fresh = knowledgeStatePath("fresh-session", home);
    writeFileSync(stale, "{}");
    writeFileSync(fresh, "{}");
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, eightDaysAgo, eightDaysAgo);
    recordKnowledgeCounts("sess-1", { pages: 1, notes: 0 }, home);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("never throws when the state dir is unwritable", () => {
    writeFileSync(join(home, ".dosu"), "a file where the dir should be");
    expect(() => recordKnowledgeCounts("sess-1", { pages: 1, notes: 0 }, home)).not.toThrow();
  });
});
