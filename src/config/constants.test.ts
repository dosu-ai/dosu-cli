import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBackendURL, getSupabaseAnonKey, getSupabaseURL, getWebAppURL } from "./constants";

describe("constants", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "DOSU_WEB_APP_URL",
    "DOSU_BACKEND_URL",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "DOSU_WEB_APP_URL_OVERRIDE",
    "DOSU_BACKEND_URL_OVERRIDE",
    "SUPABASE_URL_OVERRIDE",
    "SUPABASE_ANON_KEY_OVERRIDE",
  ];

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }
  });

  describe("getWebAppURL", () => {
    it("returns empty string when env var is not set", () => {
      expect(getWebAppURL()).toBe("");
    });

    it("returns value from DOSU_WEB_APP_URL", () => {
      process.env.DOSU_WEB_APP_URL = "https://app.dosu.dev";
      expect(getWebAppURL()).toBe("https://app.dosu.dev");
    });

    it("DOSU_WEB_APP_URL_OVERRIDE wins over the build-time default", () => {
      process.env.DOSU_WEB_APP_URL = "https://app.dosu.dev";
      process.env.DOSU_WEB_APP_URL_OVERRIDE = "https://staging.dosu.dev";
      expect(getWebAppURL()).toBe("https://staging.dosu.dev");
    });
  });

  describe("getBackendURL", () => {
    it("returns empty string when env var is not set", () => {
      expect(getBackendURL()).toBe("");
    });

    it("returns value from DOSU_BACKEND_URL", () => {
      process.env.DOSU_BACKEND_URL = "http://localhost:7001";
      expect(getBackendURL()).toBe("http://localhost:7001");
    });

    it("DOSU_BACKEND_URL_OVERRIDE wins over the build-time default", () => {
      process.env.DOSU_BACKEND_URL = "https://api.dosu.dev";
      process.env.DOSU_BACKEND_URL_OVERRIDE = "https://api-staging.dosu.dev";
      expect(getBackendURL()).toBe("https://api-staging.dosu.dev");
    });
  });

  describe("getSupabaseURL", () => {
    it("returns empty string when env var is not set", () => {
      expect(getSupabaseURL()).toBe("");
    });

    it("returns value from SUPABASE_URL", () => {
      process.env.SUPABASE_URL = "http://localhost:54321";
      expect(getSupabaseURL()).toBe("http://localhost:54321");
    });

    it("SUPABASE_URL_OVERRIDE wins over the build-time default", () => {
      process.env.SUPABASE_URL = "https://prod.supabase.co";
      process.env.SUPABASE_URL_OVERRIDE = "https://staging.supabase.co";
      expect(getSupabaseURL()).toBe("https://staging.supabase.co");
    });
  });

  describe("getSupabaseAnonKey", () => {
    it("returns empty string when env var is not set", () => {
      expect(getSupabaseAnonKey()).toBe("");
    });

    it("returns value from SUPABASE_ANON_KEY", () => {
      process.env.SUPABASE_ANON_KEY = "test-key";
      expect(getSupabaseAnonKey()).toBe("test-key");
    });

    it("SUPABASE_ANON_KEY_OVERRIDE wins over the build-time default", () => {
      process.env.SUPABASE_ANON_KEY = "prod-key";
      process.env.SUPABASE_ANON_KEY_OVERRIDE = "staging-key";
      expect(getSupabaseAnonKey()).toBe("staging-key");
    });
  });
});
