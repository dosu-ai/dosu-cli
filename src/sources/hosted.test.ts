/** A hosted token's renewal: when it is due, what a renewal changes, and that a run never
 * stops for one that could not happen. */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import type { ServerTarget } from "../config/schema";
import type { HostedSource, SourcesApi } from "./api";
import { SourcesApiError } from "./api";
import { hostedTokenNeedsRenewal, RENEW_BEFORE_MS, renewHostedToken } from "./hosted";

const NOW = new Date("2026-11-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const HOSTED: ServerTarget = {
  name: "dosu",
  url: "https://sessiondb.dosu.test",
  owner: "u-42",
  token: "old",
  source_id: "src-1",
  hosted: true,
  token_expires_at: new Date(NOW.getTime() + 60 * DAY).toISOString(),
};

const OWN: ServerTarget = {
  name: "team",
  url: "https://sessions.example.com",
  owner: "james",
  token: "sdb_team",
};

function api(answer: () => Promise<HostedSource>): SourcesApi {
  return {
    deploymentId: "dep1",
    backendUrl: "https://api.dosu.test",
    hosted: vi.fn(answer),
    connect: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    sync: vi.fn(),
    disconnect: vi.fn(),
  };
}

function renewal(): HostedSource {
  return {
    server_url: "https://sessiondb.dosu.test",
    token: "new",
    owner: "u-42",
    expires_at: new Date(NOW.getTime() + 90 * DAY).toISOString(),
    source: { id: "src-1" } as HostedSource["source"],
  };
}

describe("hostedTokenNeedsRenewal", () => {
  it("is due inside the window before expiry, past it, or when the expiry is unknown", () => {
    expect(hostedTokenNeedsRenewal(HOSTED, NOW)).toBe(false);
    const soon = new Date(NOW.getTime() + RENEW_BEFORE_MS - DAY).toISOString();
    expect(hostedTokenNeedsRenewal({ ...HOSTED, token_expires_at: soon }, NOW)).toBe(true);
    const past = new Date(NOW.getTime() - DAY).toISOString();
    expect(hostedTokenNeedsRenewal({ ...HOSTED, token_expires_at: past }, NOW)).toBe(true);
    const { token_expires_at: _, ...unknown } = HOSTED;
    expect(hostedTokenNeedsRenewal(unknown, NOW)).toBe(true);
    expect(hostedTokenNeedsRenewal({ ...HOSTED, token_expires_at: "soon-ish" }, NOW)).toBe(true);
  });

  it("never renews a token from a server's .env", () => {
    expect(hostedTokenNeedsRenewal(OWN, NOW)).toBe(false);
    expect(hostedTokenNeedsRenewal({ ...OWN, token_expires_at: "2000-01-01" }, NOW)).toBe(false);
  });
});

describe("renewHostedToken", () => {
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "dosu-hosted-")));
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    saveConfig({
      ...makeTestConfig({ access_token: "t", refresh_token: "r", expires_at: 0 }),
      targets: [OWN, HOSTED],
      default_target: "dosu",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("saves the new token and expiry in place when due, touching no other target", async () => {
    const due = { ...HOSTED, token_expires_at: new Date(NOW.getTime() + DAY).toISOString() };
    const cfg = { ...loadConfig(), targets: [OWN, due] };
    const dosu = api(async () => renewal());

    const renewed = await renewHostedToken(cfg, due, dosu, NOW);

    expect(renewed).toMatchObject({ name: "dosu", token: "new", hosted: true, source_id: "src-1" });
    expect(renewed.token_expires_at).toBe(renewal().expires_at);
    expect(loadConfig().targets).toEqual([OWN, renewed]);
    expect(loadConfig().default_target).toBe("dosu");
  });

  it("leaves a token that is not due alone, without asking Dosu", async () => {
    const dosu = api(async () => renewal());
    expect(await renewHostedToken(loadConfig(), HOSTED, dosu, NOW)).toBe(HOSTED);
    expect(dosu.hosted).not.toHaveBeenCalled();
  });

  it("ships on with the old token when Dosu cannot be asked or says no", async () => {
    const due = { ...HOSTED, token_expires_at: new Date(NOW.getTime() + DAY).toISOString() };
    expect(await renewHostedToken(loadConfig(), due, undefined, NOW)).toBe(due);
    const refusing = api(async () => {
      throw new SourcesApiError(503, "HTTP 503: Dosu's sessiondb is misconfigured");
    });
    expect(await renewHostedToken(loadConfig(), due, refusing, NOW)).toBe(due);
    const offline = api(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await renewHostedToken(loadConfig(), due, offline, NOW)).toBe(due);
    expect(loadConfig().targets?.find((t) => t.name === "dosu")?.token).toBe("old");
  });
});
