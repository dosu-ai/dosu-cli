import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LEARNER_MODEL, resolveServedModel } from "./model";

const debugMock = vi.hoisted(() => vi.fn());
vi.mock("../debug/logger", () => ({
  logger: { debug: debugMock, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const gatewayURL = "https://api.dosu.dev/v1/llm-gateway";

function respond(status: number, body: unknown): typeof fetch {
  return vi
    .fn()
    .mockResolvedValue(
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
    ) as unknown as typeof fetch;
}

beforeEach(() => debugMock.mockClear());

describe("resolveServedModel", () => {
  it("returns the model the gateway reports serving", async () => {
    const fetchImpl = respond(200, { model: "claude-sonnet-5", max_output_tokens: 64000 });

    const model = await resolveServedModel({ gatewayURL, apiKey: "sk_user_x", fetchImpl });

    expect(model).toBe("claude-sonnet-5");
  });

  it("asks the capabilities endpoint with the user's key and a timeout", async () => {
    const fetchImpl = respond(200, { model: "claude-haiku-4-5" });

    await resolveServedModel({ gatewayURL, apiKey: "sk_user_x", fetchImpl });

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(url).toBe(`${gatewayURL}/capabilities`);
    expect(init?.method).toBe("GET");
    expect(init?.headers).toEqual({ Authorization: "Bearer sk_user_x" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to the default when the gateway predates the endpoint", async () => {
    const fetchImpl = respond(404, "not found");

    const model = await resolveServedModel({ gatewayURL, apiKey: "sk_user_x", fetchImpl });

    expect(model).toBe(DEFAULT_LEARNER_MODEL);
    expect(debugMock).toHaveBeenCalledWith("learner", expect.stringContaining("404"));
  });

  it.each([
    ["a non-string model", { model: 42 }],
    ["a missing model", { max_output_tokens: 64000 }],
    ["a model that isn't a Claude id", { model: "gpt-5" }],
    ["a model with header-breaking characters", { model: "claude-haiku\nx-evil: 1" }],
    ["a JSON array", ["claude-haiku-4-5"]],
    ["JSON null", null],
  ])("falls back to the default on %s", async (_label, body) => {
    const model = await resolveServedModel({
      gatewayURL,
      apiKey: "sk_user_x",
      fetchImpl: respond(200, body),
    });

    expect(model).toBe(DEFAULT_LEARNER_MODEL);
  });

  it("falls back to the default on a non-JSON body", async () => {
    const model = await resolveServedModel({
      gatewayURL,
      apiKey: "sk_user_x",
      fetchImpl: respond(200, "<html>oops</html>"),
    });

    expect(model).toBe(DEFAULT_LEARNER_MODEL);
  });

  it("falls back to the default on a network error", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    const model = await resolveServedModel({ gatewayURL, apiKey: "sk_user_x", fetchImpl });

    expect(model).toBe(DEFAULT_LEARNER_MODEL);
    expect(debugMock).toHaveBeenCalledWith("learner", expect.stringContaining("ECONNREFUSED"));
  });

  it("falls back to the default on a non-Error rejection", async () => {
    const fetchImpl = vi.fn().mockRejectedValue("socket hang up") as unknown as typeof fetch;

    const model = await resolveServedModel({ gatewayURL, apiKey: "sk_user_x", fetchImpl });

    expect(model).toBe(DEFAULT_LEARNER_MODEL);
    expect(debugMock).toHaveBeenCalledWith("learner", expect.stringContaining("socket hang up"));
  });

  it("falls back to the default when the gateway doesn't answer in time", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof fetch;

    const model = await resolveServedModel({
      gatewayURL,
      apiKey: "sk_user_x",
      fetchImpl,
      timeoutMs: 5,
    });

    expect(model).toBe(DEFAULT_LEARNER_MODEL);
  });

  it("uses the global fetch by default", async () => {
    const globalFetch = respond(200, { model: "claude-haiku-4-5" });
    vi.stubGlobal("fetch", globalFetch);
    try {
      const model = await resolveServedModel({ gatewayURL, apiKey: "sk_user_x" });

      expect(model).toBe("claude-haiku-4-5");
      expect(globalFetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
