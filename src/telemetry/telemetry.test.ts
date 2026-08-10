import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  buildPostHogPayload,
  buildSentryEnvelope,
  createCommandTelemetry,
  durationBucket,
  fetchWithoutRedirect,
  parsePostHogProjectToken,
  parseSentryDsn,
  parseTelemetryWebAppURL,
  sanitizeError,
  sendHttpsRequest,
} from "./telemetry";

const SAFE_RUNTIME = {
  version: "1.2.3",
  installChannel: "npm",
  platform: "darwin",
  arch: "arm64",
  runtime: "bun",
  runtimeMajor: 1,
  isCi: false,
  isTty: true,
} as const;

const SAFE_CONTEXT = {
  mode: "cloud",
  isAuthenticated: true,
} as const;

const AUTHENTICATED_CONTEXT = {
  mode: "cloud",
  isAuthenticated: true,
  user: {
    id: "22222222-2222-4222-8222-222222222222",
    email: "user@example.com",
  },
} as const;

const DOSU_SOURCE_FILE = fileURLToPath(new URL("../commands/ask.ts", import.meta.url));

function response(ok: boolean): Response {
  return { ok } as Response;
}

function testDependencies(overrides: Record<string, unknown> = {}) {
  return {
    fetch: vi.fn(async (_input: string, _init: RequestInit) => response(true)),
    now: vi.fn(() => 1_000),
    randomUUID: vi.fn(() => "11111111-1111-4111-8111-111111111111"),
    env: {
      DOSU_POSTHOG_PROJECT_TOKEN_OVERRIDE: "phc_public_project_token",
      DOSU_CLI_SENTRY_DSN_OVERRIDE: "https://public@sentry.example.test/42",
    },
    stderr: vi.fn(),
    webAppURL: vi.fn(() => "https://dosu.dev"),
    ...SAFE_RUNTIME,
    ...overrides,
  };
}

describe("safe payload builders", () => {
  it("builds an allowlisted PostHog completion event", () => {
    const payload = buildPostHogPayload({
      apiKey: "phc_public_project_token",
      installId: "11111111-1111-4111-8111-111111111111",
      command: "knowledge search",
      result: "success",
      durationMs: 812,
      exitCode: 0,
      context: SAFE_CONTEXT,
      runtime: SAFE_RUNTIME,
    });

    expect(Object.keys(payload).sort()).toEqual(["api_key", "distinct_id", "event", "properties"]);
    expect(payload.distinct_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(payload.event).toBe("cli_command_completed");
    expect(Object.keys(payload.properties).sort()).toEqual(
      [
        "$geoip_disable",
        "$process_person_profile",
        "arch",
        "cli_version",
        "command",
        "duration_bucket",
        "exit_code",
        "install_channel",
        "is_authenticated",
        "is_ci",
        "is_tty",
        "mode",
        "platform",
        "result",
        "runtime",
        "runtime_major",
        "schema_version",
      ].sort(),
    );
    expect(payload.properties).toEqual({
      $geoip_disable: true,
      $process_person_profile: false,
      schema_version: 1,
      command: "knowledge search",
      result: "success",
      duration_bucket: "500ms-1.9s",
      cli_version: "1.2.3",
      install_channel: "npm",
      platform: "darwin",
      arch: "arm64",
      runtime: "bun",
      runtime_major: 1,
      is_ci: false,
      is_tty: true,
      mode: "cloud",
      is_authenticated: true,
      exit_code: 0,
    });
  });

  it("associates authenticated command events with the existing user person", () => {
    const payload = buildPostHogPayload({
      apiKey: "phc_public_project_token",
      installId: "11111111-1111-4111-8111-111111111111",
      command: "knowledge search",
      result: "success",
      durationMs: 812,
      exitCode: 0,
      context: AUTHENTICATED_CONTEXT,
      runtime: SAFE_RUNTIME,
    });

    expect(payload.distinct_id).toBe("22222222-2222-4222-8222-222222222222");
    expect(payload.properties).not.toHaveProperty("$process_person_profile");
    expect(JSON.stringify(payload)).not.toContain("user@example.com");
  });

  it("keeps command events personless when authenticated identity is invalid", () => {
    const payload = buildPostHogPayload({
      apiKey: "phc_public_project_token",
      installId: "11111111-1111-4111-8111-111111111111",
      command: "status",
      result: "success",
      durationMs: 1,
      exitCode: 0,
      context: {
        mode: "cloud",
        isAuthenticated: true,
        user: { id: "not-a-user-id", email: "user@example.com" },
      },
      runtime: SAFE_RUNTIME,
    });

    expect(payload.distinct_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(payload.properties.$process_person_profile).toBe(false);
  });

  it("adds only a validated stable error code", () => {
    const payload = buildPostHogPayload({
      apiKey: "public",
      installId: "11111111-1111-4111-8111-111111111111",
      command: "ask",
      result: "validation_error",
      durationMs: 2,
      exitCode: 999,
      errorCode: "BAD_REQUEST",
      context: { mode: "oss", isAuthenticated: false },
      runtime: SAFE_RUNTIME,
    });

    expect(payload.properties.error_code).toBe("BAD_REQUEST");
    expect(payload.properties.exit_code).toBe(255);
    expect(Object.keys(payload.properties)).toHaveLength(18);
  });

  it.each([
    [0, "<100ms"],
    [99, "<100ms"],
    [100, "100-499ms"],
    [499, "100-499ms"],
    [500, "500ms-1.9s"],
    [1_999, "500ms-1.9s"],
    [2_000, "2-9.9s"],
    [10_000, "10-59s"],
    [60_000, "60s+"],
  ])("buckets duration %i without exposing exact timings", (duration, bucket) => {
    expect(durationBucket(duration)).toBe(bucket);
  });

  it("constructs a minimal Sentry envelope with normalized Dosu-owned frames", () => {
    const stack = Array.from(
      { length: 25 },
      (_, index) => `    at privateFunction (${DOSU_SOURCE_FILE}:${index + 1}:7)`,
    ).join("\n");
    const error = Object.assign(new Error("raw secret message"), {
      name: "TRPCClientError",
      code: "BAD_REQUEST",
      status: 400,
      data: { path: "knowledge.search" },
      stack,
    });

    const built = buildSentryEnvelope({
      dsn: "https://public@sentry.example.test/base/42",
      command: "knowledge search",
      context: SAFE_CONTEXT,
      runtime: SAFE_RUNTIME,
      error: sanitizeError(error),
      eventId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      timestampMs: 2_000,
    });

    expect(built).not.toBeNull();
    const lines = built?.body.split("\n") ?? [];
    expect(lines).toHaveLength(3);
    const envelopeHeader = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    const itemHeader = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;
    const event = JSON.parse(lines[2] ?? "{}") as Record<string, unknown>;
    expect(Object.keys(envelopeHeader).sort()).toEqual(["dsn", "event_id", "sent_at"]);
    expect(itemHeader).toEqual({ type: "event" });
    expect(Object.keys(event).sort()).toEqual([
      "event_id",
      "exception",
      "fingerprint",
      "level",
      "platform",
      "release",
      "tags",
      "timestamp",
    ]);
    expect(event).not.toHaveProperty("message");
    expect(event).not.toHaveProperty("user");
    expect(event).not.toHaveProperty("request");
    expect(event).not.toHaveProperty("breadcrumbs");
    expect(event).not.toHaveProperty("contexts");
    expect(event).not.toHaveProperty("extra");

    const exception = event.exception as {
      values: Array<{
        type: string;
        value: string;
        stacktrace: { frames: Array<Record<string, unknown>> };
      }>;
    };
    expect(Object.keys(exception)).toEqual(["values"]);
    expect(Object.keys(exception.values[0] ?? {}).sort()).toEqual(
      ["stacktrace", "type", "value"].sort(),
    );
    expect(exception.values[0]?.type).toBe("TRPCClientError");
    expect(exception.values[0]?.value).toBe("BAD_REQUEST");
    expect(exception.values[0]?.stacktrace.frames).toHaveLength(20);
    expect(exception.values[0]?.stacktrace.frames[0]).toEqual({
      filename: "src/commands/ask.ts",
      lineno: 20,
      colno: 7,
      in_app: true,
    });
    expect(exception.values[0]?.stacktrace.frames.at(-1)).toEqual({
      filename: "src/commands/ask.ts",
      lineno: 1,
      colno: 7,
      in_app: true,
    });
    expect(event.fingerprint).toEqual([
      "dosu-cli",
      "knowledge search",
      "TRPCClientError",
      "BAD_REQUEST",
      "src/commands/ask.ts:1",
    ]);
    expect(built?.endpoint).toBe("https://sentry.example.test/base/api/42/envelope/");
    expect(built?.body).not.toContain("raw secret message");
    expect(built?.body).not.toContain("/Users/alice/private");
    expect(built?.body).not.toContain("privateFunction");
  });

  it("adds only validated user id and email to authenticated Sentry errors", () => {
    const built = buildSentryEnvelope({
      dsn: "https://public@sentry.example.test/42",
      command: "status",
      context: {
        ...AUTHENTICATED_CONTEXT,
        user: {
          ...AUTHENTICATED_CONTEXT.user,
          token: "must-not-leak",
          metadata: { name: "must-not-leak" },
        },
      } as typeof AUTHENTICATED_CONTEXT,
      runtime: SAFE_RUNTIME,
      error: { type: "Error", frames: [] },
      eventId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      timestampMs: 2_000,
    });

    const event = JSON.parse(built?.body.split("\n")[2] ?? "{}") as Record<string, unknown>;
    expect(event.user).toEqual({
      id: "22222222-2222-4222-8222-222222222222",
      email: "user@example.com",
    });
    expect(JSON.stringify(event)).not.toContain("must-not-leak");
  });

  it("links npm bundle frames to the exact uploaded source map debug id", () => {
    const debugId = "99ff1efe-b52e-6f8f-6475-6e2164756e21";
    const built = buildSentryEnvelope({
      dsn: "https://public@sentry.example.test/42",
      command: "status",
      context: SAFE_CONTEXT,
      runtime: SAFE_RUNTIME,
      error: {
        type: "Error",
        frames: [{ filename: "bin/dosu.js", lineno: 120, colno: 9, in_app: true }],
      },
      eventId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      timestampMs: 2_000,
      debugId,
    });

    const event = JSON.parse(built?.body.split("\n")[2] ?? "{}") as {
      debug_meta?: { images?: Array<Record<string, unknown>> };
      exception?: { values?: Array<{ stacktrace?: { frames?: Array<Record<string, unknown>> } }> };
    };
    expect(event.debug_meta).toEqual({
      images: [{ type: "sourcemap", code_file: "app:///bin/dosu.js", debug_id: debugId }],
    });
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({
      filename: "bin/dosu.js",
      abs_path: "app:///bin/dosu.js",
      lineno: 120,
      colno: 9,
      in_app: true,
    });
  });

  it("omits Sentry user data unless authentication and identity are both valid", () => {
    const contexts = [
      {
        mode: "cloud" as const,
        isAuthenticated: false,
        user: AUTHENTICATED_CONTEXT.user,
      },
      {
        mode: "cloud" as const,
        isAuthenticated: true,
        user: { id: "invalid", email: "user@example.com" },
      },
    ];

    for (const context of contexts) {
      const built = buildSentryEnvelope({
        dsn: "https://public@sentry.example.test/42",
        command: "status",
        context,
        runtime: SAFE_RUNTIME,
        error: { type: "Error", frames: [] },
        eventId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        timestampMs: 2_000,
      });
      const event = JSON.parse(built?.body.split("\n")[2] ?? "{}") as Record<string, unknown>;
      expect(event).not.toHaveProperty("user");
    }
  });

  it("never serializes malicious messages, paths, emails, credentials, or raw arguments", () => {
    const sentinels = [
      "RAW_TOKEN_XYZ",
      "alice@private.example",
      "/Users/alice/secret/repo",
      "--api-key=RAW_KEY_XYZ",
      "sk-live-PRIVATE",
    ];
    const error = Object.assign(new Error(sentinels.join(" ")), {
      name: "alice@private.example",
      code: "sk-live-PRIVATE",
      status: "alice@private.example",
      path: "/Users/alice/secret/repo",
      stack:
        "Error: RAW_TOKEN_XYZ\n" +
        "    at leak (/Users/alice/secret/repo/src/commands/ask.ts:3:9)\n" +
        "    at dependency (/Users/alice/secret/repo/node_modules/pkg/index.js:4:2)",
    });
    const safeError = sanitizeError(error);
    const analytics = buildPostHogPayload({
      apiKey: "public",
      installId: "11111111-1111-4111-8111-111111111111",
      command: `ask ${sentinels[3]}`,
      result: "failure",
      durationMs: 1,
      exitCode: 1,
      errorCode: safeError.code,
      context: SAFE_CONTEXT,
      runtime: SAFE_RUNTIME,
    });
    const sentry = buildSentryEnvelope({
      dsn: "https://public@sentry.example.test/42",
      command: `ask ${sentinels[3]}`,
      context: SAFE_CONTEXT,
      runtime: SAFE_RUNTIME,
      error: safeError,
      eventId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      timestampMs: 2_000,
    });
    const serialized = `${JSON.stringify(analytics)}\n${sentry?.body ?? ""}`;

    for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("node_modules");
    expect(serialized).not.toContain("src/commands/ask.ts");
    expect(analytics.properties.command).toBe("unknown");
    expect(safeError).toMatchObject({ type: "Error" });
    expect(safeError.code).toBeUndefined();
    expect(safeError.status).toBeUndefined();
  });

  it("accepts only known error types and codes, not merely safe-looking user strings", () => {
    const safeError = sanitizeError({
      name: "PrivateCustomerWorkflowError",
      code: "PRIVATE_INTERNAL_STATE",
      stack: "PrivateCustomerWorkflowError at /Users/alice/project/index.ts:1:1",
    });

    expect(safeError).toEqual({ type: "Error", frames: [] });
  });

  it.each([
    "EISDIR",
    "ELOOP",
    "EMFILE",
    "ENAMETOOLONG",
    "ENFILE",
    "ENOMEM",
    "ENOTDIR",
  ])("keeps stable local filesystem code %s without its message or path", (code) => {
    const safeError = sanitizeError({
      name: "Error",
      code,
      message: "private customer path",
      path: "customer-secrets.repo",
    });

    expect(safeError).toEqual({ type: "Error", code, frames: [] });
    expect(JSON.stringify(safeError)).not.toContain("customer");
  });

  it("rejects user-controlled values that resemble Commander codes", () => {
    const safeError = sanitizeError({
      name: "CommanderError",
      code: "commander.alicePrivateToken42",
    });

    expect(safeError).toEqual({ type: "CommanderError", frames: [] });
  });

  it("never treats a Node filesystem error path as an RPC identifier", () => {
    const privateFilename = `customer-secrets-${process.pid}.repo`;
    let fsError: unknown;
    try {
      readFileSync(privateFilename);
    } catch (error) {
      fsError = error;
    }

    const safeError = sanitizeError(fsError);
    expect(safeError).toMatchObject({ type: "Error", code: "ENOENT" });
    expect(JSON.stringify(safeError)).not.toContain(privateFilename);
  });

  it("does not mistake user text or a user-project src path for a Dosu-owned frame", () => {
    const nonexistentOwnedPath = resolve(dirname(DOSU_SOURCE_FILE), "private-roadmap.ts");
    const safeError = sanitizeError({
      name: "Error",
      stack:
        "Error: failed near /Users/alice/client-repo/src/customer-plan.ts:77:9\n" +
        "    at leak (/Users/alice/client-repo/src/private-roadmap.ts:78:10)\n" +
        `    at forged (${nonexistentOwnedPath}:79:11)`,
    });

    expect(safeError.frames).toEqual([]);
  });
});

describe("Sentry DSN parsing", () => {
  it("accepts an HTTPS DSN and preserves a path prefix", () => {
    expect(parseSentryDsn("https://public_key@sentry.example.test/team/42")).toEqual({
      dsn: "https://public_key@sentry.example.test/team/42",
      endpoint: "https://sentry.example.test/team/api/42/envelope/",
      projectId: "42",
      publicKey: "public_key",
    });
  });

  it.each([
    "http://public@sentry.example.test/42",
    "https://sentry.example.test/42",
    "https://public:password@sentry.example.test/42",
    "https://public@sentry.example.test/",
    "https://public@sentry.example.test/42?token=secret",
    "https://sntrys_secret@sentry.example.test/42",
    "https://sntryu_secret@sentry.example.test/42",
    "not a dsn",
  ])("rejects unsafe or malformed DSN %s", (dsn) => {
    expect(parseSentryDsn(dsn)).toBeNull();
  });
});

describe("PostHog project-token parsing", () => {
  it("accepts only public project tokens", () => {
    expect(parsePostHogProjectToken(" phc_public-project_token ")).toBe("phc_public-project_token");
  });

  it.each([
    "phx_personal_secret",
    "phs_project_secret",
    "pha_oauth_secret",
    "phr_restricted_secret",
    "not-a-project-token",
  ])("rejects management or malformed credential %s", (token) => {
    expect(parsePostHogProjectToken(token)).toBeNull();
  });
});

describe("telemetry web-app URL parsing", () => {
  it("accepts HTTPS origins and normalizes a trailing slash", () => {
    expect(parseTelemetryWebAppURL("https://app.dosu.test/")).toBe("https://app.dosu.test");
  });

  it("allows insecure HTTP only for explicit loopback development", () => {
    expect(parseTelemetryWebAppURL("http://localhost:3001")).toBeNull();
    expect(parseTelemetryWebAppURL("http://localhost:3001", true)).toBe("http://localhost:3001");
    expect(parseTelemetryWebAppURL("http://remote.example.test", true)).toBeNull();
  });

  it.each([
    "https://user:secret@app.dosu.test",
    "https://app.dosu.test?private=value",
    "https://app.dosu.test#private",
    "ftp://app.dosu.test",
  ])("rejects unsafe destination %s", (url) => {
    expect(parseTelemetryWebAppURL(url)).toBeNull();
  });
});

describe("HTTPS transport", () => {
  it("round-trips a bounded POST response through the manual transport", async () => {
    let receivedMethod = "";
    let receivedHeader = "";
    let receivedBody = "";
    const server = createHttpServer((request, response) => {
      receivedMethod = request.method ?? "";
      receivedHeader = String(request.headers["x-test-header"] ?? "");
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        receivedBody += chunk;
      });
      request.on("end", () => {
        response.writeHead(202, { "content-type": "application/json", "x-test-response": "ok" });
        response.end('{"accepted":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");

    try {
      const response = await fetchWithoutRedirect(`http://127.0.0.1:${address.port}/capture`, {
        method: "POST",
        headers: { "x-test-header": "present" },
        body: '{"event":"safe"}',
      });

      expect(response.status).toBe(202);
      expect(response.headers.get("x-test-response")).toBe("ok");
      expect(await response.json()).toEqual({ accepted: true });
      expect(receivedMethod).toBe("POST");
      expect(receivedHeader).toBe("present");
      expect(receivedBody).toBe('{"event":"safe"}');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("aborts after 500ms and resolves false", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(
        async (_url: string, init?: RequestInit): Promise<Response> =>
          await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );

      const request = sendHttpsRequest(
        "https://dosu.dev/ph-api/i/v0/e/",
        { method: "POST", body: "{}" },
        fetcher,
      );
      await vi.advanceTimersByTimeAsync(500);

      await expect(request).resolves.toBe(false);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroys a socket whose TLS handshake never completes", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");

    try {
      const startedAt = Date.now();
      await expect(
        sendHttpsRequest(`https://127.0.0.1:${address.port}/`, {
          method: "POST",
          body: "{}",
        }),
      ).resolves.toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(1_500);
      await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 1_000 });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails open without retries for network and non-2xx failures", async () => {
    const networkFailure = vi.fn(async () => {
      throw new Error("offline");
    });
    const non2xx = vi.fn(async () => response(false));

    await expect(
      sendHttpsRequest("https://dosu.dev/ph-api/i/v0/e/", { method: "POST" }, networkFailure),
    ).resolves.toBe(false);
    await expect(
      sendHttpsRequest("https://dosu.dev/ph-api/i/v0/e/", { method: "POST" }, non2xx),
    ).resolves.toBe(false);
    expect(networkFailure).toHaveBeenCalledOnce();
    expect(non2xx).toHaveBeenCalledOnce();
  });

  it("refuses non-HTTPS destinations without touching the network", async () => {
    const fetcher = vi.fn(async () => response(true));
    await expect(
      sendHttpsRequest("http://dosu.dev/ph-api/i/v0/e/", { method: "POST" }, fetcher),
    ).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses redirects so HTTPS requests cannot downgrade", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => response(true));

    await expect(
      sendHttpsRequest(
        "https://dosu.dev/ph-api/i/v0/e/",
        { method: "POST", redirect: "follow" },
        fetcher,
      ),
    ).resolves.toBe(true);

    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});

describe("CommandTelemetry lifecycle", () => {
  it.each([
    "DO_NOT_TRACK",
    "DOSU_TELEMETRY_DISABLED",
  ])("honors the %s master disable defensively", async (environmentVariable) => {
    const deps = testDependencies({
      env: {
        DOSU_POSTHOG_PROJECT_TOKEN_OVERRIDE: "phc_public_project_token",
        DOSU_CLI_SENTRY_DSN_OVERRIDE: "https://public@sentry.example.test/42",
        [environmentVariable]: "1",
      },
    });
    const telemetry = createCommandTelemetry(
      { install_id: "11111111-1111-4111-8111-111111111111" },
      deps,
    );
    telemetry.start("status", SAFE_CONTEXT);
    await telemetry.fail(new Error("private"));

    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.randomUUID).not.toHaveBeenCalled();
    expect(deps.stderr).not.toHaveBeenCalled();
  });

  it("is enabled by default and a persisted global disable blocks both destinations", async () => {
    const deps = testDependencies();
    const telemetry = createCommandTelemetry(
      { install_id: "11111111-1111-4111-8111-111111111111" },
      deps,
    );
    telemetry.start("status", SAFE_CONTEXT);
    await telemetry.fail(new Error("private"));

    const disabledDeps = testDependencies();
    const disabledTelemetry = createCommandTelemetry(
      {
        disabled: true,
        install_id: "11111111-1111-4111-8111-111111111111",
      },
      disabledDeps,
    );
    disabledTelemetry.start("status", SAFE_CONTEXT);
    await disabledTelemetry.fail(new Error("private"));

    expect(deps.fetch).toHaveBeenCalledTimes(2);
    expect(deps.randomUUID).toHaveBeenCalledOnce();
    expect(deps.stderr).not.toHaveBeenCalled();
    expect(disabledDeps.fetch).not.toHaveBeenCalled();
    expect(disabledDeps.randomUUID).not.toHaveBeenCalled();
    expect(disabledDeps.stderr).not.toHaveBeenCalled();
  });

  it("resolves the installation id lazily only when PostHog sends", async () => {
    const resolveInstallId = vi.fn(() => "11111111-1111-4111-8111-111111111111");
    const deps = testDependencies({ resolveInstallId });
    const telemetry = createCommandTelemetry({}, deps);

    expect(resolveInstallId).not.toHaveBeenCalled();
    telemetry.start("status", SAFE_CONTEXT);
    expect(resolveInstallId).not.toHaveBeenCalled();
    await telemetry.complete(0);

    expect(resolveInstallId).toHaveBeenCalledOnce();
    expect(deps.fetch).toHaveBeenCalledOnce();

    const inertResolver = vi.fn(() => "22222222-2222-4222-8222-222222222222");
    const inertDeps = testDependencies({ env: {}, resolveInstallId: inertResolver });
    const inertTelemetry = createCommandTelemetry({}, inertDeps);
    inertTelemetry.start("status", SAFE_CONTEXT);
    await inertTelemetry.complete(0);
    expect(inertResolver).not.toHaveBeenCalled();
  });

  it("does not resolve or alias an installation id for an authenticated user", async () => {
    const resolveInstallId = vi.fn(() => "11111111-1111-4111-8111-111111111111");
    const deps = testDependencies({ resolveInstallId });
    const telemetry = createCommandTelemetry({}, deps);

    telemetry.start("status", AUTHENTICATED_CONTEXT);
    await telemetry.complete(0);

    expect(resolveInstallId).not.toHaveBeenCalled();
    expect(deps.fetch).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(deps.fetch.mock.calls[0]?.[1]?.body)) as {
      distinct_id: string;
      event: string;
      properties: Record<string, unknown>;
    };
    expect(payload).toMatchObject({
      distinct_id: "22222222-2222-4222-8222-222222222222",
      event: "cli_command_completed",
    });
    expect(payload.properties).not.toHaveProperty("$process_person_profile");
  });

  it("sends exactly one PostHog completion event", async () => {
    const deps = testDependencies({
      now: vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_700),
    });
    const telemetry = createCommandTelemetry(
      {
        install_id: "11111111-1111-4111-8111-111111111111",
      },
      deps,
    );
    telemetry.start("status", SAFE_CONTEXT);

    await telemetry.complete(0);
    await telemetry.complete(9);
    await telemetry.fail(new Error("later"));

    expect(deps.fetch).toHaveBeenCalledOnce();
    const [url, init] = deps.fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://dosu.dev/ph-api/i/v0/e/");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const payload = JSON.parse(String(init?.body)) as {
      event: string;
      properties: Record<string, unknown>;
    };
    expect(payload.event).toBe("cli_command_completed");
    expect(payload.properties).toMatchObject({
      command: "status",
      result: "success",
      duration_bucket: "500ms-1.9s",
      exit_code: 0,
    });
  });

  it("classifies exit code 2 as validation_error", async () => {
    const deps = testDependencies();
    const telemetry = createCommandTelemetry(
      { install_id: "11111111-1111-4111-8111-111111111111" },
      deps,
    );
    telemetry.start("login", SAFE_CONTEXT);
    await telemetry.complete(2);

    const init = deps.fetch.mock.calls[0]?.[1];
    const payload = JSON.parse(String(init?.body)) as { properties: Record<string, unknown> };
    expect(payload.properties.result).toBe("validation_error");
  });

  it("keeps expected CLI usage failures out of Sentry", async () => {
    const deps = testDependencies();
    const telemetry = createCommandTelemetry(
      {
        install_id: "11111111-1111-4111-8111-111111111111",
      },
      deps,
    );
    telemetry.start("setup", SAFE_CONTEXT);

    await telemetry.fail(
      Object.assign(new Error("private invalid input"), {
        name: "CliUsageError",
        exitCode: 1,
      }),
    );

    expect(deps.fetch).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(deps.fetch.mock.calls[0]?.[1]?.body)) as {
      properties: Record<string, unknown>;
    };
    expect(payload.properties).toMatchObject({ result: "validation_error", exit_code: 1 });
  });

  it("reports a non-validation nonzero completion as a message-free Sentry error", async () => {
    const deps = testDependencies();
    const telemetry = createCommandTelemetry({}, deps);
    telemetry.start("login", SAFE_CONTEXT);

    await telemetry.complete(1);

    expect(deps.fetch).toHaveBeenCalledOnce();
    const envelope = String(deps.fetch.mock.calls[0]?.[1]?.body);
    expect(envelope).toContain('"type":"CommandExitError"');
    expect(envelope).toContain('"exit_code":"1"');
    expect(envelope).not.toContain('"message"');
  });

  it("sends a safe analytics failure and a manual Sentry envelope only once", async () => {
    const deps = testDependencies();
    const telemetry = createCommandTelemetry(
      {
        install_id: "11111111-1111-4111-8111-111111111111",
      },
      deps,
    );
    telemetry.start("knowledge search", SAFE_CONTEXT);
    const error = Object.assign(new Error("private query and token"), {
      name: "TRPCClientError",
      code: "NOT_FOUND",
      data: { httpStatus: 404, path: "knowledge.search" },
      stack: `Error: private query and token\n at call (${DOSU_SOURCE_FILE}:2:3)`,
    });

    await telemetry.fail(error);
    await telemetry.fail(error);
    await telemetry.complete(1);

    expect(deps.fetch).toHaveBeenCalledTimes(2);
    const bodies = deps.fetch.mock.calls.map((call) => String(call[1]?.body));
    const analytics = JSON.parse(bodies.find((body) => body.startsWith("{")) ?? "{}") as {
      properties: Record<string, unknown>;
    };
    const envelope = bodies.find((body) => body.includes("\n")) ?? "";
    expect(analytics.properties).toMatchObject({ result: "failure", error_code: "NOT_FOUND" });
    expect(envelope).toContain('"filename":"src/commands/ask.ts"');
    expect(envelope).not.toContain("private query");
    expect(envelope).not.toContain("/private/");
  });

  it("debug mode writes the exact safe payload to stderr and never sends", async () => {
    const stderr = vi.fn();
    const deps = testDependencies({
      env: {
        DOSU_TELEMETRY_DEBUG: "1",
        DOSU_POSTHOG_PROJECT_TOKEN_OVERRIDE: "phc_public_project_token",
      },
      stderr,
    });
    const telemetry = createCommandTelemetry(
      { install_id: "11111111-1111-4111-8111-111111111111" },
      deps,
    );
    telemetry.start("status", SAFE_CONTEXT);
    await telemetry.complete(0);

    expect(deps.fetch).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledOnce();
    expect(JSON.parse(stderr.mock.calls[0]?.[0] ?? "{}")).toMatchObject({
      event: "cli_command_completed",
      properties: { command: "status", result: "success" },
    });
  });

  it("fails open when endpoints, fetch, or payload construction fail", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("offline with private details");
    });
    const deps = testDependencies({
      fetch: fetcher,
      webAppURL: vi.fn(() => {
        throw new Error("broken config");
      }),
    });
    const telemetry = createCommandTelemetry(
      { install_id: "11111111-1111-4111-8111-111111111111" },
      deps,
    );
    telemetry.start("status", SAFE_CONTEXT);

    await expect(telemetry.fail(new Error("private"))).resolves.toBeUndefined();
  });

  it("does not send command analytics to an unsafe web-app URL", async () => {
    const deps = testDependencies({ webAppURL: vi.fn(() => "https://user:secret@evil.test") });
    const telemetry = createCommandTelemetry(
      {
        install_id: "11111111-1111-4111-8111-111111111111",
      },
      deps,
    );
    telemetry.start("status", SAFE_CONTEXT);

    await telemetry.complete(0);

    expect(deps.fetch).not.toHaveBeenCalled();
  });
});
