import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockOpen = vi.hoisted(() => vi.fn());
vi.mock("open", () => ({ default: (...args: unknown[]) => mockOpen(...args) }));

import { defaultReportPath, writeAndOpenReport } from "./write";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dosu-report-write-"));
  mockOpen.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeAndOpenReport", () => {
  it("writes the HTML and opens the file URL by default", async () => {
    const openUrl = vi.fn().mockResolvedValue(undefined);
    const out = join(dir, "report.html");
    const path = await writeAndOpenReport({ html: "<html>hi</html>", out, openUrl });
    expect(path).toBe(out);
    expect(readFileSync(out, "utf8")).toBe("<html>hi</html>");
    expect(openUrl).toHaveBeenCalledWith(expect.stringMatching(/^file:\/\//));
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it("skips opening when open is false", async () => {
    const openUrl = vi.fn();
    await writeAndOpenReport({
      html: "<html/>",
      out: join(dir, "quiet.html"),
      open: false,
      openUrl,
    });
    expect(openUrl).not.toHaveBeenCalled();
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it("uses the default tmp path and the open package when no injector is given", async () => {
    expect(defaultReportPath()).toContain("dosu-knowledge-report.html");
    const out = join(dir, "opened.html");
    await writeAndOpenReport({ html: "<html>open</html>", out });
    expect(mockOpen).toHaveBeenCalledWith(expect.stringMatching(/^file:\/\//));
  });

  it("writes to the default tmp file when out is omitted", async () => {
    const path = await writeAndOpenReport({ html: "<html>tmp</html>", open: false });
    expect(path).toBe(defaultReportPath());
    expect(readFileSync(path, "utf8")).toBe("<html>tmp</html>");
  });
});
