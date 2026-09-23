import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { ErrorReport } from "./sentry";
import {
  buildPostHogPayload,
  consumeCommandFacets,
  countBucket,
  createCommandTelemetry,
  durationBucket,
  fetchWithoutRedirect,
  parsePostHogProjectToken,
  parseTelemetryWebAppURL,
  recordCommandFacets,
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
  orgId: "33333333-3333-4333-8333-333333333333",
} as const;

function response(ok: boolean): Response {
  return { ok } as Response;
}

function testDependencies(overrides: Record<string, unknown> = {}) {
  return {
    fetch: vi.fn(async (_input: string, _init: RequestInit) => response(true)),
    now: vi.fn(() => 1_000),
    reportError: vi.fn(async (_report: ErrorReport) => {}),
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
    expect(payload.properties).toMatchObject({
      org_id: "33333333-3333-4333-8333-333333333333",
      $groups: { organization: "33333333-3333-4333-8333-333333333333" },
    });
    expect(JSON.stringify(payload)).not.toContain("user@example.com");
  });

  it("omits organization association unless both user and organization IDs are valid", () => {
    const invalidUserPayload = buildPostHogPayload({
      apiKey: "phc_public_project_token",
      installId: "11111111-1111-4111-8111-111111111111",
      command: "status",
      result: "success",
      durationMs: 1,
      exitCode: 0,
      context: {
        mode: "cloud",
        isAuthenticated: true,
        user: { id: "not-a-user-id" },
        orgId: "33333333-3333-4333-8333-333333333333",
      },
      runtime: SAFE_RUNTIME,
    });

    const invalidOrgPayload = buildPostHogPayload({
      apiKey: "phc_public_project_token",
      installId: "11111111-1111-4111-8111-111111111111",
      command: "status",
      result: "success",
      durationMs: 1,
      exitCode: 0,
      context: {
        mode: "cloud",
        isAuthenticated: true,
        user: { id: "22222222-2222-4222-8222-222222222222" },
        orgId: "organization-name",
      },
      runtime: SAFE_RUNTIME,
    });

    for (const payload of [invalidUserPayload, invalidOrgPayload]) {
      expect(payload.properties).not.toHaveProperty("org_id");
      expect(payload.properties).not.toHaveProperty("$groups");
    }
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

  it("adds only allowlisted command facets and buckets their counts", () => {
    const payload = buildPostHogPayload({
      apiKey: "public",
      installId: "11111111-1111-4111-8111-111111111111",
      command: "knowledge sync",
      result: "success",
      durationMs: 2,
      exitCode: 0,
      facets: {
        sync_trigger: "hook",
        sync_status: "studied",
        sessions_studied: 7,
        notes_written: 23,
        learner_outcome: "completed",
      },
      context: SAFE_CONTEXT,
      runtime: SAFE_RUNTIME,
    });

    expect(payload.properties).toMatchObject({
      sync_trigger: "hook",
      sync_status: "studied",
      sessions_studied: "5-9",
      notes_written: "20-49",
      learner_outcome: "completed",
    });
    expect(payload.properties.backfill_offer).toBeUndefined();
  });

  it("keeps the gateway_rejected learner outcome", () => {
    const payload = buildPostHogPayload({
      apiKey: "public",
      installId: "11111111-1111-4111-8111-111111111111",
      command: "knowledge sync",
      result: "success",
      durationMs: 2,
      exitCode: 0,
      facets: { sync_status: "skipped-gateway", learner_outcome: "gateway_rejected" },
      context: SAFE_CONTEXT,
      runtime: SAFE_RUNTIME,
    });

    expect(payload.properties.learner_outcome).toBe("gateway_rejected");
  });

  it("drops facet values outside the closed vocabularies", () => {
    const payload = buildPostHogPayload({
      apiKey: "public",
      installId: "11111111-1111-4111-8111-111111111111",
      command: "setup",
      result: "success",
      durationMs: 2,
      exitCode: 0,
      facets: {
        sync_trigger: "/Users/me/secret",
        sync_status: "studied; rm -rf /",
        learner_outcome: "user@example.com",
        backfill_offer: "declined",
        // Unknown keys never survive, even when injected past the type system.
        ...({ raw_prompt: "delete everything" } as object),
      },
      context: SAFE_CONTEXT,
      runtime: SAFE_RUNTIME,
    });

    expect(payload.properties.backfill_offer).toBe("declined");
    expect(payload.properties.sync_trigger).toBeUndefined();
    expect(payload.properties.sync_status).toBeUndefined();
    expect(payload.properties.learner_outcome).toBeUndefined();
    expect(payload.properties.sessions_studied).toBeUndefined();
    expect(payload.properties.notes_written).toBeUndefined();
    expect("raw_prompt" in payload.properties).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("secret");
    expect(JSON.stringify(payload)).not.toContain("rm -rf");
  });

  it.each([
    [0, "0"],
    [1, "1-4"],
    [4, "1-4"],
    [5, "5-9"],
    [19, "10-19"],
    [20, "20-49"],
    [80, "50+"],
    [-3, "0"],
    [Number.NaN, "0"],
    ["12", "0"],
  ])("buckets count %s without exposing exact values", (count, bucket) => {
    expect(countBucket(count)).toBe(bucket);
  });

  it("merges recorded facets and consumes them exactly once", () => {
    expect(consumeCommandFacets()).toBeUndefined();
    recordCommandFacets({ sync_trigger: "manual" });
    recordCommandFacets({ sync_status: "backlog", sync_trigger: "bootstrap" });
    expect(consumeCommandFacets()).toEqual({ sync_trigger: "bootstrap", sync_status: "backlog" });
    expect(consumeCommandFacets()).toBeUndefined();
  });

  it("never puts malicious messages, paths, emails, credentials, or raw arguments in analytics", () => {
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
    const serialized = JSON.stringify(analytics);

    for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("node_modules");
    expect(serialized).not.toContain("src/commands/ask.ts");
    expect(analytics.properties.command).toBe("unknown");
    expect(safeError.code).toBeUndefined();
  });

  it("accepts only known error codes, not merely safe-looking user strings", () => {
    const safeError = sanitizeError({
      name: "PrivateCustomerWorkflowError",
      code: "PRIVATE_INTERNAL_STATE",
    });

    expect(safeError).toEqual({});
  });

  it("flags a CliUsageError as a usage error", () => {
    expect(sanitizeError({ name: "CliUsageError", exitCode: 1 })).toEqual({
      exitCode: 1,
      usageError: true,
    });
    expect(sanitizeError({ name: "Error" })).toEqual({});
  });

  it.each([
    ["SessionExpiredError", "SESSION_EXPIRED"],
    ["SessionPersistenceError", "SESSION_PERSISTENCE_ERROR"],
  ])("unwraps a tRPC cause as %s without retaining private details", (name, code) => {
    const cause = Object.assign(new Error("private /Users/alice/.config/dosu-cli/config.json"), {
      name,
      code,
      path: "/Users/alice/.config/dosu-cli/config.json",
    });
    const wrapped = Object.assign(new Error("wrapped private error"), {
      name: "TRPCClientError",
      cause,
    });

    const safeError = sanitizeError(wrapped);

    expect(safeError).toEqual({ code });
    expect(JSON.stringify(safeError)).not.toContain("alice");
    expect(JSON.stringify(safeError)).not.toContain("config.json");
  });

  it("bounds cyclic cause chains without retaining private details", () => {
    const error = Object.assign(new Error("private cyclic detail"), {
      name: "TRPCClientError",
      code: "NOT_FOUND",
    }) as Error & { cause?: unknown; code: string };
    error.cause = error;

    const safeError = sanitizeError(error);

    expect(safeError).toEqual({ code: "NOT_FOUND" });
    expect(JSON.stringify(safeError)).not.toContain("private");
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

    expect(safeError).toEqual({ code });
    expect(JSON.stringify(safeError)).not.toContain("customer");
  });

  it("rejects user-controlled values that resemble Commander codes", () => {
    const safeError = sanitizeError({
      name: "CommanderError",
      code: "commander.alicePrivateToken42",
    });

    expect(safeError).toEqual({});
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
    expect(safeError).toEqual({ code: "ENOENT" });
    expect(JSON.stringify(safeError)).not.toContain(privateFilename);
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
    expect(deps.reportError).not.toHaveBeenCalled();
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

    expect(deps.fetch).toHaveBeenCalledOnce();
    expect(deps.reportError).toHaveBeenCalledOnce();
    expect(deps.stderr).not.toHaveBeenCalled();
    expect(disabledDeps.fetch).not.toHaveBeenCalled();
    expect(disabledDeps.reportError).not.toHaveBeenCalled();
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

  it("attaches the command's recorded facets to its completion event", async () => {
    consumeCommandFacets(); // isolate from any facets a prior test left behind
    const deps = testDependencies();
    const telemetry = createCommandTelemetry(
      { install_id: "11111111-1111-4111-8111-111111111111" },
      deps,
    );
    telemetry.start("knowledge sync", SAFE_CONTEXT);
    // Commander actions record facets through the module store, not the telemetry object.
    recordCommandFacets({ sync_trigger: "hook", sync_status: "detached" });
    await telemetry.complete(0);

    const [, init] = deps.fetch.mock.calls[0] ?? [];
    const payload = JSON.parse(String(init?.body)) as { properties: Record<string, unknown> };
    expect(payload.properties).toMatchObject({
      command: "knowledge sync",
      sync_trigger: "hook",
      sync_status: "detached",
    });
    // Consumed on dispatch: nothing leaks into a later telemetry instance.
    expect(consumeCommandFacets()).toBeUndefined();
  });

  it("fails open when the facet resolver throws", async () => {
    const deps = testDependencies({
      facets: vi.fn(() => {
        throw new Error("boom");
      }),
    });
    const telemetry = createCommandTelemetry(
      { install_id: "11111111-1111-4111-8111-111111111111" },
      deps,
    );
    telemetry.start("knowledge sync", SAFE_CONTEXT);
    await telemetry.complete(0);

    expect(deps.fetch).toHaveBeenCalledOnce();
    const [, init] = deps.fetch.mock.calls[0] ?? [];
    const payload = JSON.parse(String(init?.body)) as { properties: Record<string, unknown> };
    expect(payload.properties.sync_trigger).toBeUndefined();
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

    expect(deps.reportError).not.toHaveBeenCalled();
    expect(deps.fetch).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(deps.fetch.mock.calls[0]?.[1]?.body)) as {
      properties: Record<string, unknown>;
    };
    expect(payload.properties).toMatchObject({ result: "validation_error", exit_code: 1 });
  });

  it.each([
    ["SessionExpiredError", "SESSION_EXPIRED", false],
    ["SessionExpiredError", "SESSION_EXPIRED", true],
    ["SessionPersistenceError", "SESSION_PERSISTENCE_ERROR", false],
    ["SessionPersistenceError", "SESSION_PERSISTENCE_ERROR", true],
  ])("keeps %s (%s) out of Sentry when tRPC wrapped=%s", async (name, code, wrapped) => {
    const deps = testDependencies();
    const telemetry = createCommandTelemetry(
      { install_id: "11111111-1111-4111-8111-111111111111" },
      deps,
    );
    telemetry.start("review list", SAFE_CONTEXT);
    const cause = Object.assign(new Error("private token and local path"), { name, code });
    const error = wrapped
      ? Object.assign(new Error("wrapped private error"), {
          name: "TRPCClientError",
          cause,
        })
      : cause;

    await telemetry.fail(error);

    expect(deps.fetch).toHaveBeenCalledOnce();
    expect(deps.reportError).not.toHaveBeenCalled();
    const [url, init] = deps.fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://dosu.dev/ph-api/i/v0/e/");
    const payload = JSON.parse(String(init?.body)) as {
      properties: Record<string, unknown>;
    };
    expect(payload.properties).toMatchObject({ result: "failure", error_code: code });
    expect(JSON.stringify(payload)).not.toContain("private");
  });

  it("continues sending an unexpected wrapped session refresh failure to Sentry", async () => {
    const deps = testDependencies();
    const telemetry = createCommandTelemetry(
      { install_id: "11111111-1111-4111-8111-111111111111" },
      deps,
    );
    telemetry.start("review list", SAFE_CONTEXT);
    const cause = Object.assign(new Error("private upstream response"), {
      name: "SessionRefreshError",
      code: "SESSION_REFRESH_ERROR",
      status: 503,
    });
    const wrapped = Object.assign(new Error("wrapped private error"), {
      name: "TRPCClientError",
      cause,
    });

    await telemetry.fail(wrapped);

    expect(deps.fetch).toHaveBeenCalledOnce();
    const analytics = JSON.parse(String(deps.fetch.mock.calls[0]?.[1]?.body)) as {
      properties: Record<string, unknown>;
    };
    expect(analytics.properties.error_code).toBe("SESSION_REFRESH_ERROR");
    expect(deps.reportError).toHaveBeenCalledExactlyOnceWith({
      dsn: "https://public@sentry.example.test/42",
      error: wrapped,
      release: "dosu-cli@1.2.3",
      tags: {
        command: "review list",
        install_channel: "npm",
        error_code: "SESSION_REFRESH_ERROR",
      },
    });
  });

  it("records a nonzero completion without an exception in analytics only", async () => {
    const deps = testDependencies();
    const telemetry = createCommandTelemetry(
      { install_id: "11111111-1111-4111-8111-111111111111" },
      deps,
    );
    telemetry.start("login", SAFE_CONTEXT);

    await telemetry.complete(1);

    const payload = JSON.parse(String(deps.fetch.mock.calls[0]?.[1]?.body)) as {
      properties: Record<string, unknown>;
    };
    expect(payload.properties).toMatchObject({ result: "failure", exit_code: 1 });
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it("still sends an unrelated tRPC failure to analytics and Sentry exactly once", async () => {
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
    });

    await telemetry.fail(error);
    await telemetry.fail(error);
    await telemetry.complete(1);

    expect(deps.fetch).toHaveBeenCalledOnce();
    const analytics = JSON.parse(String(deps.fetch.mock.calls[0]?.[1]?.body)) as {
      properties: Record<string, unknown>;
    };
    expect(analytics.properties).toMatchObject({ result: "failure", error_code: "NOT_FOUND" });
    expect(deps.reportError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        error,
        tags: { command: "knowledge search", install_channel: "npm", error_code: "NOT_FOUND" },
      }),
    );
  });

  it("reports the raw error to Sentry with the validated account identity", async () => {
    const deps = testDependencies();
    const telemetry = createCommandTelemetry({}, deps);
    telemetry.start("docs list", AUTHENTICATED_CONTEXT);
    const error = new TypeError("fetch failed");

    await telemetry.fail(error);

    expect(deps.reportError).toHaveBeenCalledExactlyOnceWith({
      dsn: "https://public@sentry.example.test/42",
      error,
      release: "dosu-cli@1.2.3",
      tags: { command: "docs list", install_channel: "npm" },
      user: { id: "22222222-2222-4222-8222-222222222222", email: "user@example.com" },
    });
  });

  it("omits the Sentry user when the signed-in identity is not a valid account id", async () => {
    const deps = testDependencies();
    const telemetry = createCommandTelemetry({}, deps);
    telemetry.start("docs list", {
      mode: "cloud",
      isAuthenticated: true,
      user: { id: "not-a-uuid", email: "user@example.com" },
    });

    await telemetry.fail(new Error("boom"));

    expect(deps.reportError).toHaveBeenCalledOnce();
    expect(deps.reportError.mock.calls[0]?.[0]).not.toHaveProperty("user");
  });

  it("does not report to Sentry without a DSN", async () => {
    const deps = testDependencies({
      env: { DOSU_POSTHOG_PROJECT_TOKEN_OVERRIDE: "phc_public_project_token" },
    });
    const telemetry = createCommandTelemetry(
      { install_id: "11111111-1111-4111-8111-111111111111" },
      deps,
    );
    telemetry.start("status", SAFE_CONTEXT);

    await telemetry.fail(new Error("boom"));

    expect(deps.fetch).toHaveBeenCalledOnce();
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it("debug mode hands Sentry a printer instead of sending", async () => {
    const stderr = vi.fn();
    const deps = testDependencies({
      env: {
        DOSU_TELEMETRY_DEBUG: "1",
        DOSU_CLI_SENTRY_DSN_OVERRIDE: "https://public@sentry.example.test/42",
      },
      stderr,
    });
    const telemetry = createCommandTelemetry({}, deps);
    telemetry.start("status", SAFE_CONTEXT);

    await telemetry.fail(new Error("boom"));

    const report = deps.reportError.mock.calls[0]?.[0];
    report?.print?.('{"event_id":"x"}');
    expect(stderr).toHaveBeenCalledExactlyOnceWith('{"event_id":"x"}');
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
      reportError: vi.fn(async () => {
        throw new Error("Sentry SDK failed to load");
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
