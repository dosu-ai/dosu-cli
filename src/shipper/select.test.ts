import { afterEach, describe, expect, it, vi } from "vitest";
import { MODE_OSS } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import { CONFIG_SCHEMA_VERSION, type Config } from "../config/schema";
import { selectTarget } from "./select";

const SERVER = { name: "team", url: "https://sessions.example.com", owner: "acme", token: "sdb_x" };
const FOLDER = { name: "local", url: "file:///tmp/sessions", owner: "acme" };

function loggedIn(extra: Partial<Config> = {}): Config {
  return {
    ...makeTestConfig({
      access_token: "t",
      refresh_token: "r",
      expires_at: 0,
      api_key: "sk_test",
      deployment_id: "dep1",
      org_id: "org1",
    }),
    ...extra,
  };
}

function loggedOut(extra: Partial<Config> = {}): Config {
  return { schema_version: CONFIG_SCHEMA_VERSION, ...extra };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("selectTarget", () => {
  it("ships to a configured server target by name, as the default, or as the only target", () => {
    vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", "https://api.dosu.test");
    const named = selectTarget(loggedIn({ targets: [FOLDER, SERVER] }), { target: "team" });
    expect(named).toMatchObject({ kind: "server", name: "team", url: SERVER.url });

    const byDefault = selectTarget(loggedIn({ targets: [FOLDER, SERVER], default_target: "team" }));
    expect(byDefault?.kind).toBe("server");

    const only = selectTarget(loggedOut({ targets: [SERVER] }));
    expect(only?.kind).toBe("server");
  });

  it("refuses a server target without a token", () => {
    expect(() =>
      selectTarget(loggedOut({ targets: [{ ...SERVER, token: undefined }] }), { target: "team" }),
    ).toThrow(/no token/);
  });

  it("prefers the Dosu login when it can ship and nothing else is named", () => {
    vi.stubEnv("DOSU_BACKEND_URL_OVERRIDE", "https://api.dosu.test");
    expect(selectTarget(loggedIn({ targets: [SERVER] }))?.kind).toBe("dosu");
    expect(selectTarget(loggedIn({ targets: [FOLDER] }), { target: "dosu" })?.kind).toBe("dosu");
    expect(selectTarget(loggedIn({ targets: [FOLDER] }), { target: "local" })?.kind).toBe("store");
  });

  it("has nothing to ship to when logged out with no targets, and says so for --target dosu", () => {
    expect(selectTarget(loggedOut())).toBeUndefined();
    expect(() => selectTarget(loggedOut(), { target: "dosu" })).toThrow(/cannot ship/);
    expect(selectTarget(loggedIn({ mode: MODE_OSS }))).toBeUndefined();
  });
});
