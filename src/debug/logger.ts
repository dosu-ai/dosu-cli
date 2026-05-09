/**
 * Debug logger — persistent file logging with optional stderr output.
 *
 * Always writes to ~/.config/dosu-cli/debug.log (or XDG equivalent).
 * When --debug is passed, also prints to stderr.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { getConfigDir } from "../config/config";
import { VERSION } from "../version/version";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const MAX_LOG_SIZE = 1_048_576; // 1 MB
const TRUNCATE_KEEP = 524_288; // 512 KB
const LOG_FILENAME = "debug.log";
const REDACTED = "[REDACTED]";
const SECRET_QUERY_KEYS = [
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "token",
  "id_token",
  "code",
];

let initialized = false;
let debugToConsole = false;
let logFilePath: string | null = null;

export function redactSecrets(message: string): string {
  let redacted = message;
  for (const key of SECRET_QUERY_KEYS) {
    const queryPattern = new RegExp(`([?&]${key}=)[^\\s&#]+`, "gi");
    redacted = redacted.replace(queryPattern, `$1${REDACTED}`);
  }
  redacted = redacted.replace(
    /(\b(?:access_token|refresh_token|api_key|id_token|token)\b\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,]+)/gi,
    `$1${REDACTED}`,
  );
  redacted = redacted.replace(/(X-Dosu-API-Key:\s*)[^\s,]+/gi, `$1${REDACTED}`);
  redacted = redacted.replace(/(Authorization:\s*Bearer\s+)[^\s,]+/gi, `$1${REDACTED}`);
  return redacted;
}

function ensureInit(): void {
  if (!initialized) {
    initLogger({});
  }
}

function resolveLogPath(): string {
  if (!logFilePath) {
    const dir = getConfigDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    logFilePath = join(dir, LOG_FILENAME);
  }
  return logFilePath;
}

function truncateIfNeeded(): void {
  try {
    const path = resolveLogPath();
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.size <= MAX_LOG_SIZE) return;

    const content = readFileSync(path);
    const start = content.length - TRUNCATE_KEEP;
    // Find the first newline after the cut point to avoid splitting a line
    let lineStart = start;
    while (lineStart < content.length && content[lineStart] !== 0x0a) {
      lineStart++;
    }
    lineStart = Math.min(lineStart + 1, content.length);

    writeFileSync(path, content.subarray(lineStart), { mode: 0o600 });
  } catch {
    // Graceful degradation — truncation failure is non-fatal
  }
}

function writeSessionHeader(): void {
  try {
    const now = new Date().toISOString();
    const header =
      "\n════════════════════════════════════════\n" +
      `Session: ${now} | v${VERSION} | ${process.platform} ${process.arch} | node ${process.version}\n` +
      "════════════════════════════════════════\n";
    appendFileSync(resolveLogPath(), header, { mode: 0o600 });
  } catch {
    // Graceful degradation
  }
}

function initLogger(opts: { debug?: boolean }): void {
  debugToConsole = opts.debug ?? false;
  try {
    resolveLogPath();
    truncateIfNeeded();
    writeSessionHeader();
  } catch {
    // Graceful degradation — if we can't set up the log file, continue without it
  }
  initialized = true;
}

function writeEntry(level: LogLevel, mod: string, message: string): void {
  ensureInit();
  const timestamp = new Date().toISOString();
  const safeMessage = redactSecrets(message);
  const line = `[${timestamp}] [${level}] [${mod}] ${safeMessage}\n`;

  try {
    appendFileSync(resolveLogPath(), line, { mode: 0o600 });
  } catch {
    // Graceful degradation — file write failure is non-fatal
  }

  if (debugToConsole) {
    const colorize = {
      DEBUG: pc.dim,
      INFO: pc.cyan,
      WARN: pc.yellow,
      ERROR: pc.red,
    }[level];
    console.error(colorize(line.trimEnd()));
  }
}

export const logger = {
  init: initLogger,
  getLogPath(): string {
    return resolveLogPath();
  },
  debug(mod: string, message: string): void {
    writeEntry("DEBUG", mod, message);
  },
  info(mod: string, message: string): void {
    writeEntry("INFO", mod, message);
  },
  warn(mod: string, message: string): void {
    writeEntry("WARN", mod, message);
  },
  error(mod: string, message: string): void {
    writeEntry("ERROR", mod, message);
  },
  /** Reset singleton state — test use only. */
  _resetForTesting(): void {
    initialized = false;
    debugToConsole = false;
    logFilePath = null;
  },
};
