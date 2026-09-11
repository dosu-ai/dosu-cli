import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function defaultReportPath(): string {
  return join(tmpdir(), "dosu-knowledge-report.html");
}

export interface WriteReportOptions {
  html: string;
  out?: string;
  open?: boolean;
  openUrl?: (url: string) => Promise<unknown>;
}

export async function writeAndOpenReport(options: WriteReportOptions): Promise<string> {
  const out = resolve(options.out ?? defaultReportPath());
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, options.html, "utf8");
  if (options.open !== false) {
    const url = pathToFileURL(out).href;
    if (options.openUrl) {
      await options.openUrl(url);
    } else {
      const open = await import("open");
      await open.default(url);
    }
  }
  return out;
}
