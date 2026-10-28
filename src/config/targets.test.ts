import { FsStore } from "@dosu/sessionstorage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteStore } from "../store/remote";
import { CONFIG_SCHEMA_VERSION, type Config } from "./schema";
import { configuredTargets, isServerTarget, openStore, resolveBucketTarget } from "./targets";

const SERVER = { name: "team", url: "https://sessions.example.com", owner: "acme", token: "sdb_x" };
const BUCKET = { name: "r2", url: "r2://sessions/dosu", owner: "acme", account_id: "acct" };
const FOLDER = { name: "local", url: "file:///tmp/sessions", owner: "acme" };

function cfg(targets: Config["targets"], default_target?: string): Config {
  return { schema_version: CONFIG_SCHEMA_VERSION, targets, default_target };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isServerTarget", () => {
  it("is true for http(s) urls only", () => {
    expect(isServerTarget(SERVER)).toBe(true);
    expect(isServerTarget({ url: "http://localhost:7200" })).toBe(true);
    expect(isServerTarget(BUCKET)).toBe(false);
    expect(isServerTarget(FOLDER)).toBe(false);
    expect(isServerTarget({ url: "/srv/sessions" })).toBe(false);
  });
});

describe("openStore", () => {
  it("opens a server target read-only through RemoteStore", () => {
    const store = openStore(SERVER);
    expect(store).toBeInstanceOf(RemoteStore);
    expect(store.url).toBe("https://sessions.example.com");
  });

  it("refuses a server target without a token", () => {
    expect(() => openStore({ ...SERVER, token: undefined })).toThrow(/no token/);
  });

  it("opens folders as before (S3Store needs the Bun runtime; see s3 tests)", () => {
    expect(openStore(FOLDER)).toBeInstanceOf(FsStore);
  });
});

describe("resolveBucketTarget", () => {
  it("finds a configured target by name, server targets included", () => {
    expect(resolveBucketTarget(cfg([BUCKET, SERVER]), "team")).toEqual(SERVER);
    expect(configuredTargets(cfg(undefined))).toEqual([]);
  });

  it("takes an ad-hoc URL with its owner, and explains what else it accepts", () => {
    expect(resolveBucketTarget(cfg([]), "s3://b/p", { owner: "me" })).toEqual({
      name: "s3://b/p",
      url: "s3://b/p",
      owner: "me",
      credentials: "env",
    });
    vi.stubEnv("DOSU_OWNER", "env-owner");
    expect(resolveBucketTarget(cfg([]), "/tmp/x").owner).toBe("env-owner");
    vi.stubEnv("DOSU_OWNER", undefined);
    expect(() => resolveBucketTarget(cfg([]), "r2://b")).toThrow(/needs an owner/);
    expect(() => resolveBucketTarget(cfg([BUCKET]), "nope")).toThrow(/configured: r2/);
    expect(() => resolveBucketTarget(cfg([]), "nope")).toThrow(/no bucket targets configured/);
  });
});
