import { join } from "node:path";
import { isOnPath } from "../detect";
import { createJSONProvider } from "./base";

const jsonProvider = () =>
  createJSONProvider({
    providerName: "OpenCode",
    providerID: "opencode",
    local: true,
    priorityValue: 14,
    paths: ["~/.config/opencode"],
    globalPath: "~/.config/opencode/opencode.json",
    topKey: "mcp",
    buildServer: ({ url, headers }) => ({
      type: "remote",
      url,
      enabled: true,
      headers,
    }),
    localConfigPath: (cwd) => join(cwd, "opencode.json"),
  });

export const OpenCodeProvider = () => {
  const provider = jsonProvider();
  // Installed on a machine where it has never run, OpenCode has no config dir yet.
  return { ...provider, isInstalled: () => provider.isInstalled() || isOnPath("opencode") };
};
