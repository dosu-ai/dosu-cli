import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getWebAppURL, getBackendURL, getSupabaseURL } from "./constants";

describe("constants", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save env vars we'll modify
    for (const key of ["DOSU_WEB_APP_URL", "DOSU_BACKEND_URL", "SUPABASE_URL", "DOSU_DEV"]) {
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
    it("returns prod URL by default", () => {
      expect(getWebAppURL()).toBe("https://app.dosu.dev");
    });

    it("returns dev URL when DOSU_DEV=true", () => {
      process.env.DOSU_DEV = "true";
      expect(getWebAppURL()).toBe("http://localhost:3001");
    });

    it("returns custom URL from DOSU_WEB_APP_URL", () => {
      process.env.DOSU_WEB_APP_URL = "http://custom:9999";
      expect(getWebAppURL()).toBe("http://custom:9999");
    });

    it("prefers DOSU_WEB_APP_URL over DOSU_DEV", () => {
      process.env.DOSU_WEB_APP_URL = "http://custom:9999";
      process.env.DOSU_DEV = "true";
      expect(getWebAppURL()).toBe("http://custom:9999");
    });
  });

  describe("getBackendURL", () => {
    it("returns prod URL by default", () => {
      expect(getBackendURL()).toBe("https://api.dosu.dev");
    });

    it("returns dev URL when DOSU_DEV=true", () => {
      process.env.DOSU_DEV = "true";
      expect(getBackendURL()).toBe("http://localhost:7001");
    });

    it("returns custom URL from DOSU_BACKEND_URL", () => {
      process.env.DOSU_BACKEND_URL = "http://custom:8888";
      expect(getBackendURL()).toBe("http://custom:8888");
    });
  });

  describe("getSupabaseURL", () => {
    it("returns prod URL by default", () => {
      expect(getSupabaseURL()).toBe("https://your-project.supabase.co");
    });

    it("returns dev URL when DOSU_DEV=true", () => {
      process.env.DOSU_DEV = "true";
      expect(getSupabaseURL()).toBe("http://localhost:54321");
    });

    it("returns custom URL from SUPABASE_URL", () => {
      process.env.SUPABASE_URL = "http://supa:5432";
      expect(getSupabaseURL()).toBe("http://supa:5432");
    });
  });
});
