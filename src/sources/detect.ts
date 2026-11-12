/** Before an org admin makes a bucket the org's store, ask Dosu what is in it (`POST /detect`),
 * say so in plain words, and let them confirm or name the format of its raw files. Dosu reads
 * whatever lands under the prefix with its read-only key: the sessiondb layout members' machines
 * ship into, and raw logs other tools drop beside it (Datadog, CI, scripts), whose format the
 * server tells apart per file. */

import {
  type Detection,
  type DetectRequest,
  SOURCE_AGENTS,
  type SourceAgent,
  type SourcesApi,
} from "./api";
import { type Asker, WizardCancelled } from "./prompts";

/** `s3://bucket/prefix` of a detect body. */
function urlOfBody(body: Pick<DetectRequest, "kind" | "bucket" | "prefix">): string {
  return `${body.kind}://${body.bucket}${body.prefix ? `/${body.prefix}` : ""}`;
}

export function plural(n: number, what: string): string {
  return `${n} ${what}${n === 1 ? "" : "s"}`;
}

/** At most `max` names, and how many more. */
function someOf(names: string[], max = 3): string {
  const shown = names.slice(0, max).join(", ");
  return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

/** `codex ×2, datadog-trajectory ×1`, most first. */
export function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([agent, n]) => `${agent} ×${n}`)
    .join(", ");
}

/** What detection found, in one sentence: "s3://acme/team: a sessiondb store, plus 12 raw files
 * (codex ×2, datadog-trajectory ×1 sampled; 1 file I can't tell: odd.jsonl)", or "s3://acme/team:
 * empty; Dosu will check it every 5 minutes". `agent`: the format named for all raw files. */
function describeDetection(url: string, d: Detection, agent?: string): string {
  if (!d.sessiondb && d.raw_files === 0) {
    return `${url}: empty; Dosu will check it every 5 minutes${
      agent ? ` and read what lands there as ${agent}` : ""
    }`;
  }
  const parts: string[] = [];
  if (d.sessiondb) {
    parts.push(
      `a sessiondb store${d.layout_created_by ? ` (written by ${d.layout_created_by})` : ""}`,
    );
  }
  if (d.raw_files > 0) {
    const files = plural(d.raw_files, "raw file");
    const notes: string[] = [];
    if (agent) notes.push(`all read as ${agent}`);
    else {
      const sampled = formatCounts(d.agents);
      if (sampled) notes.push(`${sampled} sampled`);
      if (d.undetected.length > 0) {
        const n = d.undetected.length;
        notes.push(`${n === 1 ? "1 file" : `${n} files`} I can't tell: ${someOf(d.undetected)}`);
      }
    }
    if (d.dated_prefix) notes.push(`laid out by day under ${d.dated_prefix}`);
    parts.push(notes.length > 0 ? `${files} (${notes.join("; ")})` : files);
  }
  let sentence = `${url}: ${parts.join(", plus ")}`;
  if (d.raw_files > 0 && !d.scan_raw) {
    if (d.raw_scanned_by) sentence += ". Another connection of the org already reads its raw files";
    else if (d.raw_unavailable)
      sentence += `. Dosu can't import its raw files: ${d.raw_unavailable}`;
  }
  return sentence;
}

export interface SettleOptions {
  /** Named up front (`--agent`): every raw file is read as it, and nothing is asked. */
  agent?: SourceAgent;
  /** A person can be asked; false takes what detection found. */
  interactive: boolean;
  ask: Asker;
  /** Where the findings are told. */
  say: (line: string) => void;
  /** The org's store's own raw scan, when the store is being set again: the raw files it reads
   * are the ones this store would read, not another connection's. */
  rawSourceId?: string | null;
}

export interface Settled {
  detection: Detection;
  /** The raw files' format for the store, when the admin named or picked one. */
  agent?: SourceAgent;
}

/** Detect, say what is there, and settle the raw files' format: detected per file unless the
 * person names one. Interactively the person confirms, picks a format, or declines (thrown as
 * `WizardCancelled`). Errors from Dosu are the caller's: a bucket it cannot read with the key. */
export async function settleDetection(
  api: Pick<SourcesApi, "detect">,
  body: DetectRequest,
  options: SettleOptions,
): Promise<Settled> {
  const { interactive, ask, say } = options;
  const url = urlOfBody(body);
  const agent = options.agent;
  let detection = await api.detect(agent ? { ...body, agent } : body);
  if (options.rawSourceId && detection.raw_scanned_by === options.rawSourceId) {
    detection = { ...detection, scan_raw: true, raw_scanned_by: null };
  }
  say(describeDetection(url, detection, agent));
  if (agent || !interactive) return { detection, ...(agent ? { agent } : {}) };
  const choice = await ask.select<"yes" | "agent" | "no">(
    {
      message: "Make it the org's session store?",
      options: [
        {
          value: "yes",
          label: "Yes",
          ...(detection.scan_raw ? { hint: "Dosu tells each raw file's format apart" } : {}),
        },
        ...(detection.scan_raw
          ? [{ value: "agent" as const, label: "Yes, and every raw file is one format…" }]
          : []),
        { value: "no", label: "No" },
      ],
    },
    undefined,
  );
  if (choice === "no") throw new WizardCancelled();
  if (choice === "yes") return { detection };
  const sampled = Object.keys(detection.agents);
  const picked = await ask.select<SourceAgent>(
    {
      message: "Which format are the raw files?",
      options: SOURCE_AGENTS.map((a) => ({
        value: a,
        label: a,
        ...(sampled.includes(a) ? { hint: "sampled" } : {}),
      })),
    },
    undefined,
  );
  return { detection, agent: picked };
}
