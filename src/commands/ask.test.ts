import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const mockLoadConfig = vi.fn();
vi.mock("../config/config", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

vi.mock("../debug/logger", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { askCommand } from "./ask";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

const validConfig = {
  access_token: "t",
  refresh_token: "r",
  expires_at: 0,
  api_key: "sk_user_test",
  deployment_id: "dep1",
  space_id: "sp1",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function allOutput(): string {
  return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

function allErrors(): string {
  return errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

async function run(...args: string[]) {
  const cmd = askCommand();
  cmd.exitOverride();
  await cmd.parseAsync(["node", "test", ...args]);
}

const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  savedEnv.DOSU_BACKEND_URL = process.env.DOSU_BACKEND_URL;
  process.env.DOSU_BACKEND_URL = "https://api.test.dev";
});

afterAll(() => {
  if (savedEnv.DOSU_BACKEND_URL !== undefined) {
    process.env.DOSU_BACKEND_URL = savedEnv.DOSU_BACKEND_URL;
  } else {
    delete process.env.DOSU_BACKEND_URL;
  }
});

beforeEach(() => {
  mockFetch.mockReset();
  mockLoadConfig.mockReset();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ask", () => {
  it("POSTs to /doc/generate-answer with correct body and headers", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ answer: "42" }));

    await run("What is the meaning of life?");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.test.dev/doc/generate-answer");
    expect(opts.method).toBe("POST");
    expect(opts.headers["X-Dosu-API-Key"]).toBe("sk_user_test");
    expect(opts.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(opts.body);
    expect(body.space_id).toBe("sp1");
    expect(body.question).toBe("What is the meaning of life?");
  });
});

describe("output formatting", () => {
  it("outputs raw JSON with --json", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ answer: "42", extra: true }));

    await run("--json", "question");

    const output = JSON.parse(allOutput());
    expect(output.answer).toBe("42");
  });

  it("prints answer field when present", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ answer: "The answer is 42" }));

    await run("question");

    expect(allOutput()).toContain("The answer is 42");
  });

  it("prints body field as fallback when answer is missing", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ body: "Fallback body" }));

    await run("question");

    expect(allOutput()).toContain("Fallback body");
  });

  it("prints raw JSON when neither answer nor body exists", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ result: "something" }));

    await run("question");

    const output = allOutput();
    expect(output).toContain("result");
    expect(output).toContain("something");
  });

  it("prints sources when available", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        answer: "Yes",
        sources: [{ title: "Doc A" }, { url: "https://example.com" }, { id: "src3" }],
      }),
    );

    await run("question");

    const output = allOutput();
    expect(output).toContain("Sources");
    expect(output).toContain("Doc A");
    expect(output).toContain("https://example.com");
    expect(output).toContain("src3");
  });
});

describe("error handling", () => {
  it("prints detail on non-200 response", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({ detail: "Unauthorized" }, 401));

    await expect(run("question")).rejects.toThrow("exit");
    expect(allErrors()).toContain("Unauthorized");
  });

  it("prints status code when no detail on non-200", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 500));

    await expect(run("question")).rejects.toThrow("exit");
    expect(allErrors()).toContain("500");
  });

  it("exits when backend URL is empty", async () => {
    const orig = process.env.DOSU_BACKEND_URL;
    process.env.DOSU_BACKEND_URL = "";
    mockLoadConfig.mockReturnValue(validConfig);

    await expect(run("question")).rejects.toThrow("exit");
    expect(allErrors()).toContain("Backend URL not configured");

    process.env.DOSU_BACKEND_URL = orig;
  });

  it("handles AbortError as timeout", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    mockFetch.mockRejectedValueOnce(abortErr);

    await expect(run("question")).rejects.toThrow("exit");
    expect(allErrors()).toContain("Request timed out");
  });

  it("re-throws non-AbortError", async () => {
    mockLoadConfig.mockReturnValue(validConfig);
    mockFetch.mockRejectedValueOnce(new Error("Network failure"));

    await expect(run("question")).rejects.toThrow("Network failure");
  });
});

describe("requireConfig", () => {
  it("exits when api_key is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, api_key: undefined });
    await expect(run("question")).rejects.toThrow("exit");
  });

  it("exits when space_id is missing", async () => {
    mockLoadConfig.mockReturnValue({ ...validConfig, space_id: undefined });
    await expect(run("question")).rejects.toThrow("exit");
  });
});
