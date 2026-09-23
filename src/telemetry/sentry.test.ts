import type { NodeOptions } from "@sentry/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { reportError } from "./sentry";

type MakeRequest = (request: { body: string | Uint8Array }) => Promise<object>;

const sdk = vi.hoisted(() => ({
  loaded: false,
  init: vi.fn(),
  setTags: vi.fn(),
  setUser: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn(async () => true),
  createTransport: vi.fn((_options: unknown, makeRequest: MakeRequest) => ({ makeRequest })),
}));

vi.mock("@sentry/node", () => {
  sdk.loaded = true;
  return sdk;
});

const REPORT = {
  dsn: "https://public@sentry.example.test/42",
  release: "dosu-cli@1.2.3",
  tags: { command: "docs list", install_channel: "npm" },
};

type IntegrationsFilter = Extract<NodeOptions["integrations"], (...args: never[]) => unknown>;
type TransportFactory = (options: unknown) => { makeRequest: MakeRequest };

function initOptions(): NodeOptions {
  return sdk.init.mock.calls[0]?.[0] as NodeOptions;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reportError", () => {
  // Must run first: it checks that importing this module did not load the SDK.
  it("loads the SDK only when an error is reported", async () => {
    expect(sdk.loaded).toBe(false);

    await reportError({ ...REPORT, error: new Error("boom") });

    expect(sdk.loaded).toBe(true);
  });

  it("does not set a user when the report has none", async () => {
    await reportError({ ...REPORT, error: new Error("boom") });

    expect(sdk.setUser).not.toHaveBeenCalled();
  });

  it("captures the error with the SDK and waits for delivery", async () => {
    const error = new TypeError("fetch failed");
    const user = { id: "22222222-2222-4222-8222-222222222222", email: "user@example.com" };

    await reportError({ ...REPORT, error, user });

    expect(initOptions()).toMatchObject({
      dsn: REPORT.dsn,
      release: REPORT.release,
      environment: "production",
      debug: false,
      spotlight: false,
    });
    expect(initOptions().transport).toBeUndefined();
    expect(sdk.setTags).toHaveBeenCalledExactlyOnceWith(REPORT.tags);
    expect(sdk.setUser).toHaveBeenCalledExactlyOnceWith(user);
    expect(sdk.captureException).toHaveBeenCalledExactlyOnceWith(error);
    expect(sdk.flush).toHaveBeenCalledExactlyOnceWith(2_000);
  });

  it("drops only the default integrations that do not fit a CLI", async () => {
    await reportError({ ...REPORT, error: new Error("boom") });

    const actual = await vi.importActual<typeof import("@sentry/node")>("@sentry/node");
    const defaults = actual.getDefaultIntegrations({});
    const names = defaults.map(({ name }) => name);
    const kept = (initOptions().integrations as IntegrationsFilter)(defaults).map(
      ({ name }) => name,
    );
    expect(names).toEqual(expect.arrayContaining(["ProcessSession", "ContextLines", "Modules"]));
    expect(kept).toEqual(
      names.filter((name) => !["ProcessSession", "ContextLines", "Modules"].includes(name)),
    );
  });

  it("prints every envelope instead of sending it in debug mode", async () => {
    const print = vi.fn();

    await reportError({ ...REPORT, error: new Error("boom"), print });

    const transport = initOptions().transport as unknown as TransportFactory;
    const { makeRequest } = transport({});
    await expect(makeRequest({ body: '{"event_id":"a"}' })).resolves.toEqual({});
    await makeRequest({ body: new TextEncoder().encode('{"event_id":"b"}') });
    expect(print.mock.calls).toEqual([['{"event_id":"a"}'], ['{"event_id":"b"}']]);
  });
});
