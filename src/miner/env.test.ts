import { describe, expect, it } from "vitest";
import { buildMinerEnv } from "./env";

const baseOptions = {
  apiKey: "sk_user_test123",
  gatewayURL: "http://localhost:7001/v1/llm-gateway",
  configDir: "/tmp/miner-config",
  runID: "run-1",
  trigger: "hook" as const,
  cliVersion: "0.0.0-test",
};

describe("buildMinerEnv", () => {
  it("strips every ANTHROPIC_* and CLAUDE_CODE_* variable from the base env", () => {
    const env = buildMinerEnv({
      ...baseOptions,
      baseEnv: {
        PATH: "/usr/bin",
        HOME: "/Users/me",
        ANTHROPIC_API_KEY: "sk-ant-users-own-key",
        ANTHROPIC_MODEL: "claude-opus-4",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CONFIG_DIR: "/Users/me/.claude-custom",
        CLAUDECODE: "1",
      },
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/me");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
  });

  it("wires the gateway URL, Dosu key, and isolated config dir", () => {
    const env = buildMinerEnv({ ...baseOptions, baseEnv: {} });

    expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:7001/v1/llm-gateway");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk_user_test123");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/miner-config");
  });

  it("builds the attribution headers, omitting deployment when absent", () => {
    const env = buildMinerEnv({ ...baseOptions, baseEnv: {} });

    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      "x-dosu-run-id: run-1\nx-dosu-trigger: hook\nx-dosu-cli-version: 0.0.0-test",
    );
  });

  it("includes the deployment header when provided", () => {
    const env = buildMinerEnv({
      ...baseOptions,
      deploymentID: "f6cb85ca-edd0-4372-b3a2-c20af25cbb41",
      baseEnv: {},
    });

    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain(
      "x-dosu-deployment-id: f6cb85ca-edd0-4372-b3a2-c20af25cbb41",
    );
  });

  it("disables subprocess telemetry and nonessential traffic", () => {
    const env = buildMinerEnv({ ...baseOptions, baseEnv: {} });

    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(env.DISABLE_TELEMETRY).toBe("1");
    expect(env.DISABLE_ERROR_REPORTING).toBe("1");
  });

  it("drops undefined base values instead of stringifying them", () => {
    const env = buildMinerEnv({
      ...baseOptions,
      baseEnv: { DEFINED: "yes", UNDEFINED: undefined },
    });

    expect(env.DEFINED).toBe("yes");
    expect("UNDEFINED" in env).toBe(false);
  });
});
