import { describe, expect, it } from "vitest";
import { CONFIG_SCHEMA_VERSION, type Config } from "../config/schema";
import { selectTarget } from "./select";

const TEAM = { name: "team", url: "https://sessions.example.com", owner: "acme", token: "sdb_x" };
const LAB = { name: "lab", url: "https://lab.example.com", owner: "acme", token: "sdb_y" };

function config(extra: Partial<Config> = {}): Config {
  return { schema_version: CONFIG_SCHEMA_VERSION, ...extra };
}

describe("selectTarget", () => {
  it("ships to a configured server by name, as the default, or as the only one", () => {
    const named = selectTarget(config({ targets: [LAB, TEAM] }), { target: "team" });
    expect(named).toMatchObject({ name: "team", url: TEAM.url });

    const byDefault = selectTarget(config({ targets: [LAB, TEAM], default_target: "team" }));
    expect(byDefault?.name).toBe("team");

    expect(selectTarget(config({ targets: [LAB] }))?.name).toBe("lab");
  });

  it("has nothing to ship to without a server, and will not guess between several", () => {
    expect(selectTarget(config())).toBeUndefined();
    expect(() => selectTarget(config({ targets: [LAB, TEAM] }))).toThrow(/several servers/);
  });

  it("explains an unknown --target", () => {
    expect(() => selectTarget(config({ targets: [TEAM] }), { target: "nope" })).toThrow(
      /unknown target 'nope' \(configured: team\)/,
    );
    expect(() => selectTarget(config(), { target: "nope" })).toThrow(/no server configured/);
  });
});
