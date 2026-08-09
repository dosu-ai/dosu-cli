import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { getWebAppURL } from "../config/constants";
import { INSTALL_CHANNEL, VERSION } from "../version/version";

const REQUEST_TIMEOUT_MS = 500;
const MAX_STACK_FRAMES = 20;
const UNKNOWN_COMMAND = "unknown";
const FALLBACK_INSTALL_ID = "00000000-0000-4000-8000-000000000000";
const CLI_PACKAGE_ROOT = detectCliPackageRoot();
const SAFE_ERROR_TYPES = new Set([
  "AbortError",
  "AggregateError",
  "CommanderError",
  "CliUsageError",
  "CommandExitError",
  "Error",
  "OAuthCallbackError",
  "RangeError",
  "ReferenceError",
  "SessionExpiredError",
  "SyntaxError",
  "TicketHttpError",
  "TRPCClientError",
  "TypeError",
]);
const SAFE_ERROR_CODES = new Set([
  "ABORT_ERR",
  "BAD_GATEWAY",
  "BAD_REQUEST",
  "CLIENT_CLOSED_REQUEST",
  "CONFLICT",
  "EACCES",
  "EAI_AGAIN",
  "EBUSY",
  "ECONNREFUSED",
  "ECONNRESET",
  "EEXIST",
  "EHOSTUNREACH",
  "EINVAL",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "ENAMETOOLONG",
  "ENETUNREACH",
  "ENFILE",
  "ENOENT",
  "ENOMEM",
  "ENOSPC",
  "ENOTFOUND",
  "ENOTDIR",
  "EPIPE",
  "EPERM",
  "EROFS",
  "ETIMEDOUT",
  "FORBIDDEN",
  "GATEWAY_TIMEOUT",
  "IMPORT_ALREADY_IN_PROGRESS",
  "INTERNAL_SERVER_ERROR",
  "INVALID_ARGUMENT",
  "METHOD_NOT_SUPPORTED",
  "NOT_FOUND",
  "NOT_IMPLEMENTED",
  "PARSE_ERROR",
  "PAYLOAD_TOO_LARGE",
  "PAYMENT_REQUIRED",
  "PRECONDITION_FAILED",
  "SERVICE_UNAVAILABLE",
  "TIMEOUT",
  "TOO_MANY_REQUESTS",
  "UNAUTHORIZED",
  "UNPROCESSABLE_CONTENT",
  "UNSUPPORTED_MEDIA_TYPE",
  "VALIDATION_ERROR",
  "commander.conflictingOption",
  "commander.error",
  "commander.excessArguments",
  "commander.invalidArgument",
  "commander.missingArgument",
  "commander.missingMandatoryOptionValue",
  "commander.optionMissingArgument",
  "commander.unknownCommand",
  "commander.unknownOption",
]);

export type CommandResult = "success" | "validation_error" | "failure";

/** Compatible with the persisted settings shape without coupling to its I/O. */
export interface TelemetrySettings {
  schema_version?: number;
  analytics?: boolean;
  errors?: boolean;
  install_id?: string;
}

export interface CommandTelemetryContext {
  mode?: "cloud" | "oss";
  isAuthenticated?: boolean;
}

interface NormalizedContext {
  mode: "cloud" | "oss";
  isAuthenticated: boolean;
}

export interface RuntimeMetadata {
  version: string;
  installChannel: string;
  platform: string;
  arch: string;
  runtime: string;
  runtimeMajor: number;
  isCi: boolean;
  isTty: boolean;
}

export interface SafeStackFrame {
  filename: string;
  lineno: number;
  colno: number;
  in_app: true;
}

export interface SafeError {
  type: string;
  code?: string;
  status?: number;
  frames: SafeStackFrame[];
  exitCode?: number;
}

export interface PostHogProperties {
  $geoip_disable: true;
  $process_person_profile: false;
  schema_version: 1;
  command: string;
  result: CommandResult;
  duration_bucket: string;
  cli_version: string;
  install_channel: string;
  platform: string;
  arch: string;
  runtime: string;
  runtime_major: number;
  is_ci: boolean;
  is_tty: boolean;
  mode: "cloud" | "oss";
  is_authenticated: boolean;
  exit_code: number;
  error_code?: string;
}

export interface PostHogPayload {
  api_key: string;
  distinct_id: string;
  event: "cli_command_completed";
  properties: PostHogProperties;
}

export interface PostHogPayloadInput {
  apiKey: string;
  installId: string;
  command: string;
  result: CommandResult;
  durationMs: number;
  exitCode: number;
  errorCode?: string;
  context: CommandTelemetryContext;
  runtime: RuntimeMetadata;
}

export interface ParsedSentryDsn {
  dsn: string;
  endpoint: string;
  projectId: string;
  publicKey: string;
}

export interface SentryEnvelope {
  endpoint: string;
  body: string;
}

export interface SentryEnvelopeInput {
  dsn: string;
  command: string;
  context: CommandTelemetryContext;
  runtime: RuntimeMetadata;
  error: SafeError;
  eventId: string;
  timestampMs: number;
}

export type TelemetryFetch = (input: string, init: RequestInit) => Promise<{ ok: boolean }>;

export interface TelemetryDependencies {
  fetch?: TelemetryFetch;
  now?: () => number;
  randomUUID?: () => string;
  env?: Readonly<Record<string, string | undefined>>;
  stderr?: (payload: string) => void;
  webAppURL?: () => string;
  version?: string;
  installChannel?: string;
  platform?: string;
  arch?: string;
  runtime?: string;
  runtimeMajor?: number;
  isCi?: boolean;
  isTty?: boolean;
}

export interface CommandTelemetry {
  start(command: string, context?: CommandTelemetryContext): void;
  complete(exitCode?: number): Promise<void>;
  fail(error: unknown): Promise<void>;
}

function safeString(value: unknown, pattern: RegExp, fallback: string): string {
  if (typeof value !== "string" || !pattern.test(value)) return fallback;
  return value;
}

function canonicalCommand(value: unknown): string {
  if (typeof value !== "string") return UNKNOWN_COMMAND;
  const command = value.trim();
  if (command.length > 80) return UNKNOWN_COMMAND;
  if (!/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*){0,3}$/.test(command)) {
    return UNKNOWN_COMMAND;
  }
  return command;
}

function normalizeContext(context: CommandTelemetryContext | undefined): NormalizedContext {
  return {
    mode: context?.mode === "oss" ? "oss" : "cloud",
    isAuthenticated: context?.isAuthenticated === true,
  };
}

function normalizeExitCode(value: unknown, fallback = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(255, Math.max(0, Math.trunc(value)));
}

function normalizeRuntime(runtime: RuntimeMetadata): RuntimeMetadata {
  return {
    version: safeString(runtime.version, /^[A-Za-z0-9.+_-]{1,32}$/, "unknown"),
    installChannel: safeString(runtime.installChannel, /^[A-Za-z][A-Za-z0-9_-]{0,31}$/, "unknown"),
    platform: safeString(runtime.platform, /^[A-Za-z0-9_-]{1,24}$/, "unknown"),
    arch: safeString(runtime.arch, /^[A-Za-z0-9_-]{1,24}$/, "unknown"),
    runtime: safeString(runtime.runtime, /^[A-Za-z][A-Za-z0-9_-]{0,23}$/, "unknown"),
    runtimeMajor: Math.min(9_999, Math.max(0, Math.trunc(runtime.runtimeMajor) || 0)),
    isCi: runtime.isCi === true,
    isTty: runtime.isTty === true,
  };
}

function validInstallId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function validEventId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/i.test(value);
}

function validErrorType(value: unknown): value is string {
  return typeof value === "string" && SAFE_ERROR_TYPES.has(value);
}

function validErrorCode(value: unknown): value is string {
  return typeof value === "string" && SAFE_ERROR_CODES.has(value);
}

function validStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

function objectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function safeRead(value: unknown, key: string): unknown {
  if (!objectLike(value)) return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function parseStack(stack: unknown): SafeStackFrame[] {
  if (typeof stack !== "string" || !CLI_PACKAGE_ROOT) return [];
  const frames: SafeStackFrame[] = [];
  const lines = stack.slice(0, 100_000).split("\n", 200);

  for (const originalLine of lines) {
    if (frames.length >= MAX_STACK_FRAMES) break;
    const parsed = parseOwnedStackLine(originalLine, CLI_PACKAGE_ROOT);
    if (!parsed) continue;
    const { filename, lineno, colno } = parsed;
    if (
      !Number.isSafeInteger(lineno) ||
      !Number.isSafeInteger(colno) ||
      lineno < 1 ||
      colno < 1 ||
      lineno > 10_000_000 ||
      colno > 10_000_000
    ) {
      continue;
    }
    frames.push({ filename, lineno, colno, in_app: true });
  }

  return frames;
}

function detectCliPackageRoot(): string | undefined {
  try {
    const modulePath = fileURLToPath(import.meta.url).replaceAll("\\", "/");
    for (const suffix of ["/src/telemetry/telemetry.ts", "/bin/dosu.js"]) {
      if (modulePath.endsWith(suffix)) return modulePath.slice(0, -suffix.length);
    }
  } catch {
    // Unknown bundle layouts omit frames rather than guessing ownership.
  }
  return undefined;
}

function parseOwnedStackLine(
  originalLine: string,
  packageRoot: string,
): Omit<SafeStackFrame, "in_app"> | undefined {
  const line = originalLine.replaceAll("\\", "/");
  const match =
    line.match(/^\s*at\s+.*\s+\((.+):(\d+):(\d+)\)\s*$/) ??
    line.match(/^\s*at\s+(.+):(\d+):(\d+)\s*$/);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;

  let absolutePath = match[1];
  try {
    if (absolutePath.startsWith("file://")) absolutePath = fileURLToPath(absolutePath);
  } catch {
    return undefined;
  }
  if (!isAbsolute(absolutePath)) return undefined;

  const resolvedPath = resolve(absolutePath);
  const relativePath = relative(packageRoot, resolvedPath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }

  const filename = relativePath.replaceAll("\\", "/");
  if (
    !/^(?:src\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?)|bin\/dosu\.js)$/.test(
      filename,
    )
  ) {
    return undefined;
  }
  try {
    if (!existsSync(resolvedPath)) return undefined;
  } catch {
    return undefined;
  }

  return { filename, lineno: Number(match[2]), colno: Number(match[3]) };
}

/** Extracts only allowlisted, bounded diagnostics. Raw Error values are never retained. */
export function sanitizeError(error: unknown): SafeError {
  const data = safeRead(error, "data");
  const typeCandidate = safeRead(error, "name");
  const codeCandidates = [safeRead(data, "code"), safeRead(error, "code")];
  const statusCandidates = [
    safeRead(data, "httpStatus"),
    safeRead(error, "status"),
    safeRead(error, "statusCode"),
  ];
  const exitCodeCandidate = safeRead(error, "exitCode");
  const code = codeCandidates.find(validErrorCode);
  const status = statusCandidates.find(validStatus);
  const exitCode =
    typeof exitCodeCandidate === "number" && Number.isFinite(exitCodeCandidate)
      ? normalizeExitCode(exitCodeCandidate)
      : undefined;

  return {
    type: validErrorType(typeCandidate) ? typeCandidate : "Error",
    ...(code ? { code } : {}),
    ...(status ? { status } : {}),
    frames: parseStack(safeRead(error, "stack")),
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

export function durationBucket(durationMs: number): string {
  const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  if (duration < 100) return "<100ms";
  if (duration < 500) return "100-499ms";
  if (duration < 2_000) return "500ms-1.9s";
  if (duration < 10_000) return "2-9.9s";
  if (duration < 60_000) return "10-59s";
  return "60s+";
}

export function buildPostHogPayload(input: PostHogPayloadInput): PostHogPayload {
  const context = normalizeContext(input.context);
  const runtime = normalizeRuntime(input.runtime);
  const errorCode = validErrorCode(input.errorCode) ? input.errorCode : undefined;
  const result: CommandResult =
    input.result === "success" || input.result === "validation_error" ? input.result : "failure";

  return {
    api_key: input.apiKey,
    distinct_id: validInstallId(input.installId) ? input.installId : FALLBACK_INSTALL_ID,
    event: "cli_command_completed",
    properties: {
      $geoip_disable: true,
      $process_person_profile: false,
      schema_version: 1,
      command: canonicalCommand(input.command),
      result,
      duration_bucket: durationBucket(input.durationMs),
      cli_version: runtime.version,
      install_channel: runtime.installChannel,
      platform: runtime.platform,
      arch: runtime.arch,
      runtime: runtime.runtime,
      runtime_major: runtime.runtimeMajor,
      is_ci: runtime.isCi,
      is_tty: runtime.isTty,
      mode: context.mode,
      is_authenticated: context.isAuthenticated,
      exit_code: normalizeExitCode(input.exitCode),
      ...(errorCode ? { error_code: errorCode } : {}),
    },
  };
}

/** Accept only PostHog's public project-token format, never management credentials. */
export function parsePostHogProjectToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  return /^phc_[A-Za-z0-9_-]{3,252}$/.test(token) ? token : null;
}

/** HTTPS in production; explicit development mode may use only a loopback HTTP origin. */
export function parseTelemetryWebAppURL(
  value: unknown,
  allowInsecureLoopback = false,
): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return null;
  try {
    const url = new URL(value.trim());
    if (!url.hostname || url.username || url.password || url.search || url.hash) return null;
    const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    const secure = url.protocol === "https:";
    const allowedDevelopmentOrigin =
      allowInsecureLoopback && url.protocol === "http:" && loopbackHosts.has(url.hostname);
    if (!secure && !allowedDevelopmentOrigin) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function parseSentryDsn(value: unknown): ParsedSentryDsn | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return null;
  const dsn = value.trim();
  try {
    const url = new URL(dsn);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      !url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(url.username) ||
      url.username.toLowerCase().startsWith("sntry")
    ) {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    const projectId = segments.pop();
    if (!projectId || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) return null;
    if (segments.some((segment) => !/^[A-Za-z0-9._~-]{1,128}$/.test(segment))) return null;
    const prefix = segments.length > 0 ? `/${segments.join("/")}` : "";

    return {
      dsn,
      endpoint: `${url.protocol}//${url.host}${prefix}/api/${projectId}/envelope/`,
      projectId,
      publicKey: url.username,
    };
  } catch {
    return null;
  }
}

function sentryTags(
  command: string,
  context: NormalizedContext,
  runtime: RuntimeMetadata,
  error: SafeError,
): Record<string, string> {
  return {
    schema_version: "1",
    command,
    cli_version: runtime.version,
    install_channel: runtime.installChannel,
    os: runtime.platform,
    arch: runtime.arch,
    runtime: runtime.runtime,
    runtime_major: String(runtime.runtimeMajor),
    is_ci: String(runtime.isCi),
    is_tty: String(runtime.isTty),
    mode: context.mode,
    is_authenticated: String(context.isAuthenticated),
    ...(error.code ? { error_code: error.code } : {}),
    ...(error.status ? { http_status: String(error.status) } : {}),
    ...(error.exitCode === undefined ? {} : { exit_code: String(error.exitCode) }),
  };
}

export function buildSentryEnvelope(input: SentryEnvelopeInput): SentryEnvelope | null {
  const parsedDsn = parseSentryDsn(input.dsn);
  if (!parsedDsn || !validEventId(input.eventId)) return null;
  const context = normalizeContext(input.context);
  const runtime = normalizeRuntime(input.runtime);
  const command = canonicalCommand(input.command);
  const error: SafeError = {
    type: validErrorType(input.error.type) ? input.error.type : "Error",
    ...(validErrorCode(input.error.code) ? { code: input.error.code } : {}),
    ...(validStatus(input.error.status) ? { status: input.error.status } : {}),
    ...(typeof input.error.exitCode === "number" && Number.isFinite(input.error.exitCode)
      ? { exitCode: normalizeExitCode(input.error.exitCode) }
      : {}),
    // V8 stacks are newest-first; Sentry expects oldest-first.
    frames: input.error.frames
      .slice(0, MAX_STACK_FRAMES)
      .map((frame) => ({
        filename:
          /^(?:src\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:[cm]?[jt]sx?)|bin\/dosu\.js)$/.test(
            frame.filename,
          )
            ? frame.filename
            : "src/unknown.ts",
        lineno: Math.min(10_000_000, Math.max(1, Math.trunc(frame.lineno) || 1)),
        colno: Math.min(10_000_000, Math.max(1, Math.trunc(frame.colno) || 1)),
        in_app: true as const,
      }))
      .reverse(),
  };
  const exceptionValue = {
    type: error.type,
    value: error.code ?? error.type,
    ...(error.frames.length > 0 ? { stacktrace: { frames: error.frames } } : {}),
  };
  const newestFrame = error.frames.at(-1);
  const safeCallsite = newestFrame ? `${newestFrame.filename}:${newestFrame.lineno}` : "unknown";
  const timestampMs = Number.isFinite(input.timestampMs) ? Math.max(0, input.timestampMs) : 0;
  const event = {
    event_id: input.eventId.toLowerCase(),
    timestamp: timestampMs / 1_000,
    platform: "node",
    level: "error",
    release: `dosu-cli@${runtime.version}`,
    tags: sentryTags(command, context, runtime, error),
    fingerprint: ["dosu-cli", command, error.type, error.code ?? "unknown", safeCallsite],
    exception: { values: [exceptionValue] },
  };
  const envelopeHeader = {
    event_id: input.eventId.toLowerCase(),
    dsn: parsedDsn.dsn,
    sent_at: new Date(timestampMs).toISOString(),
  };

  return {
    endpoint: parsedDsn.endpoint,
    body: `${JSON.stringify(envelopeHeader)}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}`,
  };
}

const defaultFetch: TelemetryFetch = async (input, init) => fetch(input, init);

/** One attempt, HTTPS only, hard 500ms deadline, and every failure is swallowed. */
export async function sendHttpsRequest(
  url: string,
  init: RequestInit,
  fetcher: TelemetryFetch = defaultFetch,
): Promise<boolean> {
  try {
    if (new URL(url).protocol !== "https:") return false;
  } catch {
    return false;
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("telemetry request timed out"));
    }, REQUEST_TIMEOUT_MS);
  });

  try {
    const request = fetcher(url, { ...init, redirect: "error", signal: controller.signal });
    const result = await Promise.race([request, timeout]);
    return result.ok;
  } catch {
    return false;
  } finally {
    // We never consume a response body. Abort after headers to release sockets
    // whose body would otherwise keep the Node CLI alive past the deadline.
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
  }
}

function environmentFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && !["0", "false", "no", "off"].includes(normalized);
}

function runtimeNameAndMajor(): { runtime: string; runtimeMajor: number } {
  const versions = process.versions as NodeJS.ProcessVersions & { bun?: string };
  const runtime = versions.bun ? "bun" : "node";
  const version = versions.bun ?? versions.node;
  return { runtime, runtimeMajor: Number.parseInt(version.split(".")[0] ?? "0", 10) || 0 };
}

function resolveRuntime(
  dependencies: TelemetryDependencies,
  env: Readonly<Record<string, string | undefined>>,
): RuntimeMetadata {
  const detected = runtimeNameAndMajor();
  return normalizeRuntime({
    version: dependencies.version ?? VERSION,
    installChannel: dependencies.installChannel ?? INSTALL_CHANNEL,
    platform: dependencies.platform ?? process.platform,
    arch: dependencies.arch ?? process.arch,
    runtime: dependencies.runtime ?? detected.runtime,
    runtimeMajor: dependencies.runtimeMajor ?? detected.runtimeMajor,
    isCi: dependencies.isCi ?? environmentFlag(env.CI),
    isTty: dependencies.isTty ?? process.stdout.isTTY === true,
  });
}

function validationFailure(exitCode: number, error: SafeError | undefined): boolean {
  if (exitCode === 2) return true;
  if (error?.type === "CliUsageError") return true;
  if (!error?.code) return false;
  return (
    error.code.startsWith("commander.") ||
    ["BAD_REQUEST", "INVALID_ARGUMENT", "UNPROCESSABLE_CONTENT", "VALIDATION_ERROR"].includes(
      error.code,
    )
  );
}

function safeNow(now: () => number): number {
  try {
    const value = now();
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  } catch {
    return 0;
  }
}

function safeUuid(generate: () => string): string | undefined {
  try {
    const value = generate();
    return validInstallId(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function eventId(generate: () => string): string | undefined {
  const uuid = safeUuid(generate);
  return uuid?.replaceAll("-", "");
}

/**
 * Command-scoped telemetry. The caller supplies only a canonical command name and coarse context.
 * Consent is checked independently for analytics and error diagnostics.
 */
export function createCommandTelemetry(
  settings: TelemetrySettings,
  dependencies: TelemetryDependencies = {},
): CommandTelemetry {
  const env = dependencies.env ?? process.env;
  const fetcher = dependencies.fetch ?? defaultFetch;
  const now = dependencies.now ?? Date.now;
  const generateUuid = dependencies.randomUUID ?? randomUUID;
  const writeStderr =
    dependencies.stderr ?? ((payload: string) => process.stderr.write(`${payload}\n`));
  const webAppURL = dependencies.webAppURL ?? getWebAppURL;
  const runtime = resolveRuntime(dependencies, env);
  const debug = env.DOSU_TELEMETRY_DEBUG === "1";
  const disabled =
    environmentFlag(env.DO_NOT_TRACK) || environmentFlag(env.DOSU_TELEMETRY_DISABLED);
  const rawAnalyticsToken = dependencies.env
    ? (env.DOSU_POSTHOG_PROJECT_TOKEN_OVERRIDE ?? env.DOSU_POSTHOG_PROJECT_TOKEN)
    : (process.env.DOSU_POSTHOG_PROJECT_TOKEN_OVERRIDE ?? process.env.DOSU_POSTHOG_PROJECT_TOKEN);
  const rawSentryDsn = dependencies.env
    ? (env.DOSU_SENTRY_DSN_OVERRIDE ?? env.DOSU_SENTRY_DSN)
    : (process.env.DOSU_SENTRY_DSN_OVERRIDE ?? process.env.DOSU_SENTRY_DSN);
  const analyticsToken = parsePostHogProjectToken(rawAnalyticsToken) ?? undefined;
  const sentryDsn = parseSentryDsn(rawSentryDsn)?.dsn;

  let started = false;
  let terminal = false;
  let startedAt = 0;
  let command = UNKNOWN_COMMAND;
  let context: NormalizedContext = normalizeContext(undefined);
  let generatedInstallId: string | undefined;

  function installId(): string | undefined {
    if (validInstallId(settings.install_id)) return settings.install_id;
    generatedInstallId ??= safeUuid(generateUuid);
    return generatedInstallId;
  }

  function debugPayload(payload: string): void {
    try {
      writeStderr(payload);
    } catch {
      // Debug output must never change command behavior.
    }
  }

  async function dispatch(
    result: CommandResult,
    exitCode: number,
    error: SafeError | undefined,
  ): Promise<void> {
    try {
      const tasks: Promise<unknown>[] = [];
      if (!disabled && settings.analytics === true && analyticsToken) {
        const id = installId();
        if (id) {
          const payload = buildPostHogPayload({
            apiKey: analyticsToken,
            installId: id,
            command,
            result,
            durationMs: safeNow(now) - startedAt,
            exitCode,
            errorCode: error?.code,
            context,
            runtime,
          });
          const body = JSON.stringify(payload);
          if (debug) {
            debugPayload(body);
          } else {
            const base = parseTelemetryWebAppURL(webAppURL());
            if (base) {
              tasks.push(
                sendHttpsRequest(
                  `${base}/ph-api/i/v0/e/`,
                  {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body,
                  },
                  fetcher,
                ),
              );
            }
          }
        }
      }

      if (!disabled && settings.errors === true && result === "failure" && error && sentryDsn) {
        const id = eventId(generateUuid);
        const envelope = id
          ? buildSentryEnvelope({
              dsn: sentryDsn,
              command,
              context,
              runtime,
              error,
              eventId: id,
              timestampMs: safeNow(now),
            })
          : null;
        if (envelope) {
          if (debug) {
            debugPayload(envelope.body);
          } else {
            tasks.push(
              sendHttpsRequest(
                envelope.endpoint,
                {
                  method: "POST",
                  headers: { "content-type": "application/x-sentry-envelope" },
                  body: envelope.body,
                },
                fetcher,
              ),
            );
          }
        }
      }

      await Promise.all(tasks);
    } catch {
      // Telemetry is intentionally fail-open and must never affect CLI behavior.
    }
  }

  return {
    start(commandName, commandContext) {
      if (started || terminal) return;
      started = true;
      command = canonicalCommand(commandName);
      context = normalizeContext(commandContext);
      startedAt = safeNow(now);
    },

    async complete(exitCode = 0) {
      if (!started || terminal) return;
      terminal = true;
      const normalizedExitCode = normalizeExitCode(exitCode, 0);
      const result: CommandResult =
        normalizedExitCode === 0
          ? "success"
          : validationFailure(normalizedExitCode, undefined)
            ? "validation_error"
            : "failure";
      const error: SafeError | undefined =
        result === "failure"
          ? { type: "CommandExitError", frames: [], exitCode: normalizedExitCode }
          : undefined;
      await dispatch(result, normalizedExitCode, error);
    },

    async fail(rawError) {
      if (!started || terminal) return;
      terminal = true;
      const error = sanitizeError(rawError);
      const exitCode = error.exitCode ?? 1;
      const result: CommandResult = validationFailure(exitCode, error)
        ? "validation_error"
        : "failure";
      await dispatch(result, exitCode, error);
    },
  };
}
