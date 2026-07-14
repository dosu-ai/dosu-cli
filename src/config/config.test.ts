import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bindAccountIdentity,
  CONFIG_SCHEMA_VERSION,
  type Config,
  clearConfig,
  emptyConfig,
  getConfigPath,
  isAuthenticated,
  isTokenExpired,
  loadConfig,
  replaceLoginSession,
  type SessionCredentials,
  saveConfig,
} from "./config";
import { makeTestConfig } from "./config.test-utils";

function accessTokenFor(userID: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: userID })).toString("base64url");
  return `${header}.${payload}.signature`;
}

describe("config", () => {
  let origXDG: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    origXDG = process.env.XDG_CONFIG_HOME;
    tempDir = mkdtempSync(join(tmpdir(), "dosu-test-"));
    process.env.XDG_CONFIG_HOME = tempDir;
  });

  afterEach(() => {
    if (origXDG !== undefined) {
      process.env.XDG_CONFIG_HOME = origXDG;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("getConfigPath creates directory and returns path", () => {
    const path = getConfigPath();
    expect(path).toBe(join(tempDir, "dosu-cli", "config.json"));
    expect(existsSync(join(tempDir, "dosu-cli"))).toBe(true);
  });

  it("DOSU_DEV=true isolates config into a separate dosu-cli-dev directory", () => {
    const origDev = process.env.DOSU_DEV;
    try {
      process.env.DOSU_DEV = "true";
      const devPath = getConfigPath();
      expect(devPath).toBe(join(tempDir, "dosu-cli-dev", "config.json"));
      expect(existsSync(join(tempDir, "dosu-cli-dev"))).toBe(true);

      // Writing under dev must not touch the prod dir.
      const devCfg: Config = makeTestConfig({
        access_token: "dev-tok",
        refresh_token: "dev-ref",
        expires_at: 1,
      });
      saveConfig(devCfg);

      // Switch back to prod — we should see empty config, not the dev one.
      delete process.env.DOSU_DEV;
      const prodCfg = loadConfig();
      expect(prodCfg.active_account).toBeUndefined();

      // Switch back to dev — dev config must still be there.
      process.env.DOSU_DEV = "true";
      const devCfgReloaded = loadConfig();
      expect(devCfgReloaded.active_account?.session.access_token).toBe("dev-tok");
    } finally {
      if (origDev !== undefined) {
        process.env.DOSU_DEV = origDev;
      } else {
        delete process.env.DOSU_DEV;
      }
    }
  });

  it("DOSU_DEV other values don't enable dev isolation (only 'true' counts)", () => {
    const origDev = process.env.DOSU_DEV;
    try {
      process.env.DOSU_DEV = "1";
      expect(getConfigPath()).toBe(join(tempDir, "dosu-cli", "config.json"));

      process.env.DOSU_DEV = "yes";
      expect(getConfigPath()).toBe(join(tempDir, "dosu-cli", "config.json"));

      process.env.DOSU_DEV = "";
      expect(getConfigPath()).toBe(join(tempDir, "dosu-cli", "config.json"));
    } finally {
      if (origDev !== undefined) {
        process.env.DOSU_DEV = origDev;
      } else {
        delete process.env.DOSU_DEV;
      }
    }
  });

  it("loadConfig returns empty config when file does not exist", () => {
    const cfg = loadConfig();
    expect(cfg).toEqual({ schema_version: CONFIG_SCHEMA_VERSION });
  });

  it("saveConfig and loadConfig round-trip", () => {
    const cfg: Config = makeTestConfig({
      access_token: "tok_abc",
      refresh_token: "ref_xyz",
      expires_at: 1700000000,
      deployment_id: "dep-123",
      deployment_name: "My Deployment",
      api_key: "key-456",
    });
    saveConfig(cfg);
    const loaded = loadConfig();
    expect(loaded.active_account?.session).toEqual({
      access_token: "tok_abc",
      refresh_token: "ref_xyz",
      expires_at: 1700000000,
    });
    expect(loaded.active_account?.target).toEqual({
      deployment_id: "dep-123",
      deployment_name: "My Deployment",
      api_key: "key-456",
    });

    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8"));
    expect(persisted).toEqual({
      schema_version: 2,
      active_account: {
        user_id: "test-user-id",
        session: {
          access_token: "tok_abc",
          refresh_token: "ref_xyz",
          expires_at: 1700000000,
        },
        target: {
          deployment_id: "dep-123",
          deployment_name: "My Deployment",
          api_key: "key-456",
        },
      },
    });
    expect(persisted.access_token).toBeUndefined();
  });

  it("migrates a legacy flat config into the account-owned V2 schema", () => {
    const path = getConfigPath();
    writeFileSync(
      path,
      JSON.stringify({
        access_token: accessTokenFor("account-a"),
        refresh_token: "legacy-refresh",
        expires_at: 1700000000,
        deployment_id: "legacy-deployment",
        deployment_name: "Legacy deployment",
        api_key: "legacy-key",
        org_id: "legacy-org",
        space_id: "legacy-space",
      }),
    );

    const loaded = loadConfig();

    expect(loaded.active_account?.user_id).toBe("account-a");
    expect(loaded.active_account?.target?.deployment_id).toBe("legacy-deployment");
    expect(loaded.active_account?.target?.api_key).toBe("legacy-key");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      schema_version: CONFIG_SCHEMA_VERSION,
      active_account: {
        user_id: "account-a",
        session: {
          access_token: accessTokenFor("account-a"),
          refresh_token: "legacy-refresh",
          expires_at: 1700000000,
        },
        target: {
          deployment_id: "legacy-deployment",
          deployment_name: "Legacy deployment",
          api_key: "legacy-key",
          org_id: "legacy-org",
          space_id: "legacy-space",
        },
      },
    });
  });

  it("uses a migrated legacy config when the migration cannot be persisted", () => {
    const path = getConfigPath();
    const legacy = {
      access_token: accessTokenFor("account-a"),
      refresh_token: "legacy-refresh",
      expires_at: 1700000000,
      deployment_id: "legacy-deployment",
      api_key: "legacy-key",
    };
    writeFileSync(path, JSON.stringify(legacy));
    mkdirSync(`${path}.${process.pid}.tmp`);

    const loaded = loadConfig();

    expect(loaded.active_account?.user_id).toBe("account-a");
    expect(loaded.active_account?.target?.api_key).toBe("legacy-key");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(legacy);
  });

  it("does not overwrite a config with an unknown schema version", () => {
    const path = getConfigPath();
    const futureConfig = {
      schema_version: CONFIG_SCHEMA_VERSION + 1,
      active_account: { future_session: "preserve-me" },
    };
    writeFileSync(path, JSON.stringify(futureConfig));

    expect(loadConfig()).toEqual(emptyConfig());
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(futureConfig);
  });

  it("drops an unowned legacy target when the token identity cannot be verified", () => {
    writeFileSync(
      getConfigPath(),
      JSON.stringify({
        access_token: "opaque-old-token",
        refresh_token: "old-refresh",
        expires_at: 1,
        deployment_id: "old-deployment",
        api_key: "old-key",
      }),
    );
    const cfg = loadConfig();

    expect(cfg.active_account?.target).toBeUndefined();
  });

  it("isAuthenticated returns true when access_token is set", () => {
    expect(
      isAuthenticated(makeTestConfig({ access_token: "tok", refresh_token: "", expires_at: 0 })),
    ).toBe(true);
    expect(
      isAuthenticated(makeTestConfig({ access_token: "", refresh_token: "", expires_at: 0 })),
    ).toBe(false);
  });

  it("replaceLoginSession preserves target state when the authenticated account is unchanged", () => {
    const cfg = makeTestConfig({
      access_token: "old-token",
      refresh_token: "old-refresh",
      expires_at: 1,
      deployment_id: "account-a-deployment",
      deployment_name: "Account A deployment",
      api_key: "account-a-key",
      org_id: "account-a-org",
      space_id: "account-a-space",
      user_id: "account-a",
    });
    const session: SessionCredentials = {
      access_token: "new-token",
      refresh_token: "new-refresh",
      expires_at: 2,
      user_id: "account-a",
    };

    replaceLoginSession(cfg, session);

    expect(cfg.active_account?.target).toEqual({
      deployment_id: "account-a-deployment",
      deployment_name: "Account A deployment",
      api_key: "account-a-key",
      org_id: "account-a-org",
      space_id: "account-a-space",
    });
    expect(cfg.active_account?.user_id).toBe("account-a");
  });

  it("replaceLoginSession clears target state when the authenticated account changes", () => {
    const cfg = makeTestConfig({
      access_token: "old-token",
      refresh_token: "old-refresh",
      expires_at: 1,
      deployment_id: "account-a-deployment",
      deployment_name: "Account A deployment",
      api_key: "account-a-key",
      org_id: "account-a-org",
      space_id: "account-a-space",
      user_id: "account-a",
    });
    const session: SessionCredentials = {
      access_token: "new-token",
      refresh_token: "new-refresh",
      expires_at: 2,
      user_id: "account-b",
    };

    replaceLoginSession(cfg, session);

    expect(cfg.active_account?.target).toBeUndefined();
    expect(cfg.active_account?.user_id).toBe("account-b");
  });

  it("bindAccountIdentity clears target state when the verified identity changes", () => {
    const cfg = makeTestConfig({
      access_token: "account-a-token",
      refresh_token: "account-a-refresh",
      expires_at: 1,
      user_id: "account-a",
      deployment_id: "account-a-deployment",
      api_key: "account-a-key",
    });

    bindAccountIdentity(cfg, "account-b");

    expect(cfg.active_account?.user_id).toBe("account-b");
    expect(cfg.active_account?.session.access_token).toBe("account-a-token");
    expect(cfg.active_account?.target).toBeUndefined();
  });

  it("isTokenExpired returns false when expires_at is 0", () => {
    expect(
      isTokenExpired(makeTestConfig({ access_token: "", refresh_token: "", expires_at: 0 })),
    ).toBe(false);
  });

  it("isTokenExpired returns true when within 5 minutes of expiry", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // Expires in 4 minutes (< 5 minute buffer)
    expect(
      isTokenExpired(
        makeTestConfig({ access_token: "", refresh_token: "", expires_at: nowSec + 240 }),
      ),
    ).toBe(true);
    // Expires in 10 minutes (> 5 minute buffer)
    expect(
      isTokenExpired(
        makeTestConfig({ access_token: "", refresh_token: "", expires_at: nowSec + 600 }),
      ),
    ).toBe(false);
  });

  it("clearConfig returns empty config", () => {
    const cfg: Config = makeTestConfig({
      access_token: "tok",
      refresh_token: "ref",
      expires_at: 123,
      deployment_id: "dep",
      deployment_name: "name",
      api_key: "key",
    });
    const cleared = clearConfig(cfg);
    expect(cleared).toEqual({ schema_version: CONFIG_SCHEMA_VERSION });
  });

  it("emptyConfig returns exact default shape", () => {
    const cfg = emptyConfig();
    expect(cfg).toEqual({ schema_version: CONFIG_SCHEMA_VERSION });
  });

  it("loadConfig returns emptyConfig on corrupt JSON file", () => {
    const path = getConfigPath();
    writeFileSync(path, "NOT VALID JSON {{{{");
    const cfg = loadConfig();
    expect(cfg).toEqual({ schema_version: CONFIG_SCHEMA_VERSION });
  });

  it("clearConfig returns exact empty shape with undefined optional fields", () => {
    const cfg: Config = makeTestConfig({
      access_token: "tok",
      refresh_token: "ref",
      expires_at: 999,
      deployment_id: "dep",
      deployment_name: "name",
      api_key: "key",
    });
    const cleared = clearConfig(cfg);
    expect(cleared).toEqual({ schema_version: CONFIG_SCHEMA_VERSION });
  });
});
