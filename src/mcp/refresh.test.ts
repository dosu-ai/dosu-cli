import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestConfig } from "../config/config.test-utils";
import * as providersModule from "./providers";
import {
  configuredProviders,
  refreshConfiguredProviders,
  refreshProviders,
  staleProviders,
} from "./refresh";

function fakeProvider(
  overrides: Partial<providersModule.SetupProvider> = {},
): providersModule.SetupProvider {
  return {
    name: () => "FakeAgent",
    id: () => "fake",
    supportsLocal: () => false,
    install: vi.fn(),
    remove: vi.fn(),
    detectPaths: () => [],
    isInstalled: () => true,
    isConfigured: () => true,
    isCurrent: () => true,
    globalConfigPath: () => "/tmp/fake.json",
    priority: () => 1,
    ...overrides,
  } as providersModule.SetupProvider;
}

const cfg = makeTestConfig({
  access_token: "tok",
  refresh_token: "ref",
  expires_at: 0,
  deployment_id: "dep-1",
  api_key: "key-1",
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("configuredProviders", () => {
  it("keeps only providers that are both installed and configured", () => {
    const both = fakeProvider({ name: () => "Both" });
    const installedOnly = fakeProvider({ name: () => "InstalledOnly", isConfigured: () => false });
    const configuredOnly = fakeProvider({ name: () => "ConfiguredOnly", isInstalled: () => false });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([
      both,
      installedOnly,
      configuredOnly,
    ]);

    expect(configuredProviders()).toEqual([both]);
  });

  it("treats a provider whose detection throws as absent", () => {
    const broken = fakeProvider({
      isInstalled: () => {
        throw new Error("unreadable config");
      },
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([broken, fakeProvider()]);

    expect(configuredProviders()).toHaveLength(1);
  });
});

describe("staleProviders", () => {
  it("keeps configured providers whose entry is not current, and passes the config through", () => {
    const current = fakeProvider({ name: () => "Current" });
    const isCurrent = vi.fn(() => false);
    const stale = fakeProvider({ name: () => "Stale", isCurrent });
    const absent = fakeProvider({ isConfigured: () => false, isCurrent: () => false });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([current, stale, absent]);

    expect(staleProviders(cfg)).toEqual([stale]);
    expect(isCurrent).toHaveBeenCalledWith(cfg);
  });

  it("counts a provider whose check throws as stale, so the rewrite reports the error", () => {
    const broken = fakeProvider({
      isCurrent: () => {
        throw new Error("unreadable config");
      },
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([broken, fakeProvider()]);

    expect(staleProviders(undefined)).toEqual([broken]);
  });
});

describe("refreshProviders", () => {
  it("rewrites only the providers it is given", () => {
    const given = fakeProvider({ name: () => "Given" });
    const other = fakeProvider({ name: () => "Other" });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([given, other]);

    expect(refreshProviders(cfg, [given])).toEqual({ updated: [given], failed: [] });
    expect(other.install).not.toHaveBeenCalled();
  });
});

describe("refreshConfiguredProviders", () => {
  it("rewrites the global entry of every configured provider", () => {
    const a = fakeProvider({ name: () => "A" });
    const b = fakeProvider({ name: () => "B" });
    const untouched = fakeProvider({ name: () => "Untouched", isConfigured: () => false });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([a, b, untouched]);

    const result = refreshConfiguredProviders(cfg);

    expect(a.install).toHaveBeenCalledWith(cfg, true);
    expect(b.install).toHaveBeenCalledWith(cfg, true);
    expect(untouched.install).not.toHaveBeenCalled();
    expect(result.updated).toEqual([a, b]);
    expect(result.failed).toEqual([]);
  });

  it("collects a failing provider without blocking the others", () => {
    const failing = fakeProvider({
      name: () => "Failing",
      install: vi.fn(() => {
        throw new Error("read-only file");
      }),
    });
    const fine = fakeProvider({ name: () => "Fine" });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([failing, fine]);

    const result = refreshConfiguredProviders(cfg);

    expect(fine.install).toHaveBeenCalledOnce();
    expect(result.updated).toEqual([fine]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].provider).toBe(failing);
    expect(result.failed[0].error.message).toBe("read-only file");
  });

  it("wraps non-Error throwables so callers always get a message", () => {
    const failing = fakeProvider({
      install: vi.fn(() => {
        throw "plain string";
      }),
    });
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([failing]);

    const result = refreshConfiguredProviders(cfg);

    expect(result.failed[0].error).toBeInstanceOf(Error);
    expect(result.failed[0].error.message).toBe("plain string");
  });

  it("is a no-op when nothing is configured", () => {
    vi.spyOn(providersModule, "allSetupProviders").mockReturnValue([]);

    expect(refreshConfiguredProviders(cfg)).toEqual({ updated: [], failed: [] });
  });
});
