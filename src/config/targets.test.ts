import { describe, expect, it } from "vitest";
import { CONFIG_SCHEMA_VERSION, type Config } from "./schema";
import { configuredTargets, selectTarget } from "./targets";

const TEAM = { name: "team", url: "https://sessions.example.com", owner: "acme", token: "sdb_x" };
const LAB = { name: "lab", url: "https://lab.example.com", owner: "acme", token: "sdb_y" };

function config(extra: Partial<Config> = {}): Config {
  return { schema_version: CONFIG_SCHEMA_VERSION, ...extra };
}

describe("configuredTargets", () => {
  it("is the config's servers, or none", () => {
    expect(configuredTargets(config())).toEqual([]);
    expect(configuredTargets(config({ targets: [TEAM] }))).toEqual([TEAM]);
  });
});

describe("selectTarget", () => {
  it("finds a configured server by name", () => {
    expect(selectTarget(config({ targets: [LAB, TEAM] }), "team")).toBe(TEAM);
  });

  it("falls back to the default, then to the only one", () => {
    expect(selectTarget(config({ targets: [LAB, TEAM], default_target: "lab" }))).toBe(LAB);
    expect(selectTarget(config({ targets: [TEAM] }))).toBe(TEAM);
    expect(selectTarget(config())).toBeUndefined();
  });

  it("explains what it could not resolve", () => {
    expect(() => selectTarget(config({ targets: [TEAM] }), "lab")).toThrow(
      "unknown target 'lab' (configured: team); run 'dosu setup' or 'dosu sources setup --server <url> --token <token>'",
    );
    expect(() => selectTarget(config({ targets: [LAB, TEAM] }))).toThrow(
      "several servers are configured (lab, team): pass --target <name> or set default_target",
    );
    // A default that was removed from the targets is a configuration error, not silence.
    expect(() => selectTarget(config({ targets: [TEAM], default_target: "gone" }))).toThrow(
      /unknown target 'gone'/,
    );
  });
});
