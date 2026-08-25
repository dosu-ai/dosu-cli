import { describe, expect, it } from "vitest";
import { DEFAULT_DEPLOYMENT_CONFIG_GITHUB } from "./default-deployment-config";

describe("DEFAULT_DEPLOYMENT_CONFIG_GITHUB", () => {
  it("omits fields removed from the hosted deployment schema", () => {
    expect(DEFAULT_DEPLOYMENT_CONFIG_GITHUB).not.toHaveProperty("stale_bot");
    expect(DEFAULT_DEPLOYMENT_CONFIG_GITHUB).not.toHaveProperty("pull_requests.stale_doc_check");
    expect(DEFAULT_DEPLOYMENT_CONFIG_GITHUB).not.toHaveProperty(
      "issues.auto_label_config.custom_instructions",
    );
    expect(DEFAULT_DEPLOYMENT_CONFIG_GITHUB).not.toHaveProperty(
      "pull_requests.auto_label_config.custom_instructions",
    );
  });
});
