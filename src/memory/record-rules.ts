/** Ports of the frozen memwriter's record rules (coding-memory-bench 0951e6a: `_clip` in
 * memwriter/system.py; `_prepare_recorded_command` and `_parse_command_observation` in
 * procmem/system.py). The server renders records from what these produce, so the output must
 * match the Python byte for byte: lengths count code points and lines split like `splitlines()`. */

const MAX_ERROR_LINE_LENGTH = 160;

/** Python's `str.splitlines()` boundaries. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the boundaries being ported
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

function splitlines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(LINE_BREAK);
  // A trailing break ends the last line rather than starting an empty one.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** `_clip`: strip, then keep the first and last half of `limit` code points around a marker. */
export function clip(text: string, limit: number): string {
  const points = Array.from(text.trim());
  if (points.length <= limit) return points.join("");
  const half = Math.floor(limit / 2);
  return (
    `${points.slice(0, half).join("")}\n[... ${points.length - limit} characters cut ...]\n` +
    points.slice(points.length - half).join("")
  );
}

const HEREDOC_RE =
  /<<(?<strip>-?)(?!<)\s*(?:'(?<single>[^'\n]+)'|"(?<double>[^"\n]+)"|(?<bare>[A-Za-z_][A-Za-z0-9_]*))/y;

/** The heredoc delimiters a shell line opens, in order, skipping `<<` inside quotes. */
function heredocDelimiters(line: string): Array<[string, boolean]> {
  const delimiters: Array<[string, boolean]> = [];
  let quote: string | null = null;
  let escaped = false;
  let index = 0;
  while (index < line.length) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      index += 1;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      index += 1;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      index += 1;
      continue;
    }
    if (line.startsWith("<<", index) && !line.startsWith("<<<", index)) {
      HEREDOC_RE.lastIndex = index;
      const match = HEREDOC_RE.exec(line);
      if (match?.groups) {
        const { strip, single, double, bare } = match.groups;
        delimiters.push([(single ?? double ?? bare) as string, strip === "-"]);
        index = HEREDOC_RE.lastIndex;
        continue;
      }
    }
    index += 1;
  }
  return delimiters;
}

function stripHeredocBodies(command: string): string {
  const kept: string[] = [];
  const pending: Array<[string, boolean]> = [];
  for (const line of splitlines(command)) {
    if (pending.length > 0) {
      const [delimiter, stripTabs] = pending[0];
      const comparable = stripTabs ? line.replace(/^\t+/, "") : line;
      if (comparable === delimiter) pending.shift();
      continue;
    }
    kept.push(line);
    pending.push(...heredocDelimiters(line));
  }
  return kept.join("\n");
}

const CD_PREFIX_RE = /^\s*cd\s+[\s\S]+?\s*&&\s*/;

/** `_prepare_recorded_command`: drop heredoc bodies and blank lines, collapse whitespace per
 * line, and remove one leading `cd <dir> &&`. */
export function prepareRecordedCommand(command: string): string {
  const prepared = splitlines(stripHeredocBodies(command))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
  return prepared.replace(CD_PREFIX_RE, "");
}

const RETURNCODE_RE = /<returncode>\s*(-?\d+)\s*<\/returncode>/;
const OUTPUT_RE = /<(output|output_head|output_tail)>\s*([\s\S]*?)\s*<\/\1>/g;
const ERROR_MARKER_RE = /(?:\bERROR\b|error:|not found|Could not|\bFAILED\b)/i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI escapes, as the Python does
const ANSI_ESCAPE_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** `_parse_command_observation`: the return code and, for a failure, the LAST output line that
 * looks like an error (ANSI stripped, whitespace collapsed, cut to 160 code points). */
export function parseCommandObservation(content: string): [number, string | null] | null {
  const match = RETURNCODE_RE.exec(content);
  if (match === null) return null;
  const returncode = Number.parseInt(match[1], 10);
  if (returncode === 0) return [returncode, null];

  const output = Array.from(content.matchAll(OUTPUT_RE), (m) => m[2]).join("\n");
  let errorLine: string | null = null;
  for (const line of splitlines(output)) {
    let clean = line.replace(ANSI_ESCAPE_RE, "").replace(/\s+/g, " ").trim();
    if (
      clean === "" ||
      clean.startsWith(":") ||
      clean.startsWith("'") ||
      clean.startsWith('"') ||
      !ERROR_MARKER_RE.test(clean)
    ) {
      continue;
    }
    const points = Array.from(clean);
    if (points.length > MAX_ERROR_LINE_LENGTH) {
      clean = `${points
        .slice(0, MAX_ERROR_LINE_LENGTH - 3)
        .join("")
        .trimEnd()}...`;
    }
    errorLine = clean;
  }
  return [returncode, errorLine];
}
