import { Command } from "commander";
import {
  runDriveDestroy,
  runDriveHost,
  runDriveJoin,
  runDriveSearch,
  runDriveSetup,
  runDriveStatus,
  runDriveStop,
} from "../drive/flows";

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Port must be 0–65535");
  return port;
}

export function driveCommand(): Command {
  const command = new Command("drive").description(
    "Share local coding-agent sessions through a team Drive",
  );

  command
    .command("host")
    .description("Host a Drive on the local network")
    .option("-n, --name <name>", "Drive name")
    .option("-p, --port <port>", "Host port", parsePort, 7777)
    .option("--no-bonjour", "Disable local-network discovery")
    .action(runDriveHost);
  command
    .command("join")
    .description("Discover and join a Drive on the local network")
    .argument("[target]", "Direct HTTP(S) Drive URL")
    .option("-n, --name <name>", "Contributor name")
    .option("--no-setup", "Join without starting repository setup")
    .action(runDriveJoin);
  command
    .command("setup")
    .description("Select repositories and upload their sessions")
    .option("-r, --repo <paths...>", "Repository paths", [])
    .option("--yes", "Approve every matched session (automation only)")
    .option("--no-open", "Print the local preview URL without opening it")
    .action((options: { repo: string[]; yes: boolean; open: boolean }) =>
      runDriveSetup({ repositories: options.repo, yes: options.yes, open: options.open }),
    );
  command
    .command("search")
    .description("Search the active Drive")
    .argument("<query>", "Search query")
    .option("--repo <name>", "Exact repository name")
    .action((query: string, options: { repo?: string }) => runDriveSearch(query, options.repo));
  command.command("status").description("Show the active Drive").action(runDriveStatus);
  command.command("stop").description("Stop a locally hosted Drive").action(runDriveStop);
  command
    .command("destroy")
    .description("Delete a locally hosted Drive and its imported data")
    .option("--yes", "Skip the confirmation")
    .action(runDriveDestroy);

  const mcp = command.command("mcp").description("Manage the Dosu Drive MCP integration");
  mcp
    .command("add")
    .argument("<agent>", "Agent to configure (codex or claude)")
    .action(() => {
      throw new Error("Drive MCP setup is not ready in this build");
    });
  mcp.command("status").action(() => {
    throw new Error("Drive MCP setup is not ready in this build");
  });
  mcp
    .command("remove")
    .argument("<agent>", "Agent to remove (codex or claude)")
    .action(() => {
      throw new Error("Drive MCP setup is not ready in this build");
    });
  mcp.command("serve", { hidden: true }).action(() => {
    throw new Error("Drive MCP setup is not ready in this build");
  });

  return command;
}
