import { afterEach, describe, expect, it } from "vitest";
import { saveConfig } from "../config/config";
import { makeTestConfig } from "../config/config.test-utils";
import { memoryApiFromConfig } from "./api";

const session = { access_token: "a", refresh_token: "r", expires_at: 4_102_444_800 };
const savedBackend = process.env.DOSU_BACKEND_URL_OVERRIDE;

afterEach(() => {
  if (savedBackend === undefined) delete process.env.DOSU_BACKEND_URL_OVERRIDE;
  else process.env.DOSU_BACKEND_URL_OVERRIDE = savedBackend;
});

describe("memoryApiFromConfig", () => {
  it("uses the CLI's backend URL and the deployment's API key, like the MCP entry", () => {
    process.env.DOSU_BACKEND_URL_OVERRIDE = "https://api.example.test/";
    saveConfig(makeTestConfig({ ...session, deployment_id: "d-1", api_key: "test-key" }));
    expect(memoryApiFromConfig()).toEqual({
      backendURL: "https://api.example.test",
      apiKey: "test-key",
      deploymentID: "d-1",
    });
  });

  it("is null when there is nothing to authenticate with", () => {
    process.env.DOSU_BACKEND_URL_OVERRIDE = "https://api.example.test";
    saveConfig(makeTestConfig({ ...session, deployment_id: "d-1" }));
    expect(memoryApiFromConfig()).toBeNull();
    saveConfig(makeTestConfig({ ...session, deployment_id: "d-1", api_key: "k", mode: "oss" }));
    expect(memoryApiFromConfig()).toBeNull();
  });
});
