import { afterEach, describe, expect, it, vi } from "vitest";

const mockUndiciFetch = vi.fn();
const mockAgent = vi.fn(function (this: { opts: unknown }, opts: unknown) {
  this.opts = opts;
});
vi.mock("undici", () => ({
  fetch: (...args: unknown[]) => mockUndiciFetch(...args),
  Agent: mockAgent,
}));

import { longFetch } from "./long-fetch";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mockUndiciFetch.mockReset();
  mockAgent.mockReset();
});

describe("longFetch", () => {
  it("on Node, uses undici fetch with headers/body timeouts disabled", async () => {
    const bunDescriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
    Object.defineProperty(process.versions, "bun", { value: undefined, configurable: true });
    const resp = new Response("ok");
    mockUndiciFetch.mockResolvedValueOnce(resp);

    const controller = new AbortController();
    let result: Response;
    try {
      result = await longFetch("https://api.test.dev/ask", {
        method: "POST",
        signal: controller.signal,
      });
    } finally {
      if (bunDescriptor) {
        Object.defineProperty(process.versions, "bun", bunDescriptor);
      } else {
        delete (process.versions as Record<string, unknown>).bun;
      }
    }

    expect(result).toBe(resp);
    expect(mockAgent).toHaveBeenCalledWith({ headersTimeout: 0, bodyTimeout: 0 });
    const [url, init] = mockUndiciFetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe("https://api.test.dev/ask");
    expect(init.method).toBe("POST");
    expect(init.signal).toBe(controller.signal);
    expect(init.dispatcher).toBeInstanceOf(mockAgent);
  });

  it("on Bun, uses global fetch with the default idle timeout disabled", async () => {
    const bunDescriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
    Object.defineProperty(process.versions, "bun", { value: "1.0.0", configurable: true });
    const resp = new Response("ok");
    const globalFetch = vi.fn().mockResolvedValueOnce(resp);
    vi.stubGlobal("fetch", globalFetch);

    try {
      const result = await longFetch("https://api.test.dev/ask", { method: "POST" });

      expect(result).toBe(resp);
      const [url, init] = globalFetch.mock.calls[0] as [string, Record<string, unknown>];
      expect(url).toBe("https://api.test.dev/ask");
      expect(init.method).toBe("POST");
      expect(init.timeout).toBe(false);
      expect(mockUndiciFetch).not.toHaveBeenCalled();
    } finally {
      if (bunDescriptor) {
        Object.defineProperty(process.versions, "bun", bunDescriptor);
      } else {
        delete (process.versions as Record<string, unknown>).bun;
      }
    }
  });
});
