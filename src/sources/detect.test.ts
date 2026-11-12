import { describe, expect, it, vi } from "vitest";
import type { Detection, DetectRequest } from "./api";
import { formatCounts, plural, settleDetection } from "./detect";
import { type Asker, WizardCancelled } from "./prompts";

const BODY: DetectRequest = {
  kind: "s3",
  bucket: "acme",
  prefix: "team",
  access_key_id: "AKIDREAD",
  secret_access_key: "readsecret",
};

const EMPTY: Detection = {
  sessiondb: false,
  layout_created_by: null,
  raw_files: 0,
  agents: {},
  undetected: [],
  dated_prefix: null,
  scan_raw: false,
  raw_scanned_by: null,
  raw_unavailable: null,
};

/** Dosu answering `found`, and the person answering `picks` in order. */
function setup(found: Partial<Detection>, picks: unknown[] = []) {
  const detect = vi.fn(async (_body: DetectRequest) => ({ ...EMPTY, ...found }));
  const select = vi.fn(async () => picks.shift());
  const ask = { text: vi.fn(), select, confirm: vi.fn() } as unknown as Asker;
  const said: string[] = [];
  return { api: { detect }, ask, select, said, say: (line: string) => said.push(line) };
}

describe("settleDetection: what it says", () => {
  it("an empty prefix is checked again later, read as the named format", async () => {
    const t = setup({});
    await settleDetection(t.api, BODY, { interactive: false, ask: t.ask, say: t.say });
    await settleDetection(
      t.api,
      { ...BODY, prefix: "" },
      {
        agent: "codex",
        interactive: false,
        ask: t.ask,
        say: t.say,
      },
    );
    expect(t.said).toEqual([
      "s3://acme/team: empty; Dosu will check it every 5 minutes",
      "s3://acme: empty; Dosu will check it every 5 minutes and read what lands there as codex",
    ]);
    expect(t.api.detect).toHaveBeenLastCalledWith({ ...BODY, prefix: "", agent: "codex" });
  });

  it("a sessiondb store beside raw files: sampled formats, undetected files, the dated layout", async () => {
    const t = setup({
      sessiondb: true,
      layout_created_by: "jane",
      raw_files: 12,
      agents: { "datadog-trajectory": 1, codex: 2 },
      undetected: ["a.jsonl", "b.jsonl", "c.jsonl", "d.jsonl", "e.jsonl"],
      dated_prefix: "logs/YYYY/MM/DD",
      scan_raw: true,
    });
    await settleDetection(t.api, BODY, { interactive: false, ask: t.ask, say: t.say });
    expect(t.said[0]).toBe(
      "s3://acme/team: a sessiondb store (written by jane), plus 12 raw files (codex ×2, datadog-trajectory ×1 sampled; 5 files I can't tell: a.jsonl, b.jsonl, c.jsonl and 2 more; laid out by day under logs/YYYY/MM/DD)",
    );
  });

  it("one undetected file, and a sessiondb store with no marker author", async () => {
    const t = setup({ sessiondb: true, raw_files: 1, undetected: ["odd.jsonl"] });
    await settleDetection(t.api, BODY, { interactive: false, ask: t.ask, say: t.say });
    expect(t.said[0]).toBe(
      "s3://acme/team: a sessiondb store, plus 1 raw file (1 file I can't tell: odd.jsonl)",
    );
  });

  it("raw files it won't read: another connection has them, or Dosu cannot import them", async () => {
    const taken = setup({ raw_files: 3, raw_scanned_by: "src-other" });
    await settleDetection(taken.api, BODY, { interactive: false, ask: taken.ask, say: taken.say });
    expect(taken.said[0]).toBe(
      "s3://acme/team: 3 raw files. Another connection of the org already reads its raw files",
    );

    const off = setup({ raw_files: 3, raw_unavailable: "no imports store" });
    await settleDetection(off.api, BODY, { interactive: false, ask: off.ask, say: off.say });
    expect(off.said[0]).toBe(
      "s3://acme/team: 3 raw files. Dosu can't import its raw files: no imports store",
    );
  });

  it("the store's own raw scan is not another connection's when the store is set again", async () => {
    const t = setup({ raw_files: 3, raw_scanned_by: "src-raw" });
    const { detection } = await settleDetection(t.api, BODY, {
      interactive: false,
      ask: t.ask,
      say: t.say,
      rawSourceId: "src-raw",
    });
    expect(detection).toMatchObject({ scan_raw: true, raw_scanned_by: null });
    expect(t.said[0]).toBe("s3://acme/team: 3 raw files");
  });
});

describe("settleDetection: what the admin answers", () => {
  it("takes what was found without asking when nobody can answer, or the format was named", async () => {
    const t = setup({ raw_files: 2, scan_raw: true });
    expect(
      await settleDetection(t.api, BODY, { interactive: false, ask: t.ask, say: t.say }),
    ).toEqual({ detection: { ...EMPTY, raw_files: 2, scan_raw: true } });
    expect(
      await settleDetection(t.api, BODY, {
        agent: "cursor",
        interactive: true,
        ask: t.ask,
        say: t.say,
      }),
    ).toMatchObject({ agent: "cursor" });
    expect(t.select).not.toHaveBeenCalled();
  });

  it("yes keeps per-file detection; declining cancels", async () => {
    const yes = setup({ raw_files: 2, scan_raw: true }, ["yes"]);
    expect(
      await settleDetection(yes.api, BODY, { interactive: true, ask: yes.ask, say: yes.say }),
    ).not.toHaveProperty("agent");

    const no = setup({}, ["no"]);
    await expect(
      settleDetection(no.api, BODY, { interactive: true, ask: no.ask, say: no.say }),
    ).rejects.toBeInstanceOf(WizardCancelled);
    // Nothing to convert: no format to pick.
    const options = (no.select.mock.calls[0] as unknown as [{ options: { value: string }[] }])[0]
      .options;
    expect(options.map((o) => o.value)).toEqual(["yes", "no"]);
  });

  it("picks one format for every raw file, the sampled ones marked", async () => {
    const t = setup({ raw_files: 2, scan_raw: true, agents: { codex: 2 } }, ["agent", "codex"]);
    expect(
      await settleDetection(t.api, BODY, { interactive: true, ask: t.ask, say: t.say }),
    ).toMatchObject({ agent: "codex" });
    const formats = (
      t.select.mock.calls[1] as unknown as [{ options: { value: string; hint?: string }[] }]
    )[0].options;
    expect(formats.find((o) => o.value === "codex")?.hint).toBe("sampled");
    expect(formats.find((o) => o.value === "cursor")?.hint).toBeUndefined();
  });
});

describe("plural and formatCounts", () => {
  it("counts in words, most first then by name", () => {
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(2, "file")).toBe("2 files");
    expect(formatCounts({ b: 1, a: 1, c: 3 })).toBe("c ×3, a ×1, b ×1");
  });
});
