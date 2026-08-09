import { join } from "node:path";
import { createJSONProvider } from "./base";

export const GeminiProvider = () =>
  createJSONProvider({
    providerName: "Gemini CLI",
    providerID: "gemini",
    local: true,
    priorityValue: 7,
    paths: ["~/.gemini"],
    globalPath: "~/.gemini/settings.json",
    topKey: "mcpServers",
    buildProjectServer: (command) => ({ command: command.command, args: command.args }),
    localConfigPath: (cwd) => join(cwd, ".gemini", "settings.json"),
  });
