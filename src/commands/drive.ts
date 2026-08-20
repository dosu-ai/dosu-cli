import { Command } from "commander";

function pending(name: string): () => void {
  return () => {
    throw new Error(`dosu drive ${name} is not ready in this development build`);
  };
}

export function driveCommand(): Command {
  const command = new Command("drive").description(
    "Share local coding-agent sessions through a team Drive",
  );

  command.command("host").description("Host a Drive on the local network").action(pending("host"));
  command
    .command("join")
    .description("Discover and join a Drive on the local network")
    .action(pending("join"));
  command
    .command("setup")
    .description("Select repositories and upload their sessions")
    .action(pending("setup"));
  command
    .command("search")
    .description("Search the active Drive")
    .argument("<query>", "Search query")
    .action(pending("search"));
  command.command("status").description("Show the active Drive").action(pending("status"));
  command.command("stop").description("Stop a locally hosted Drive").action(pending("stop"));
  command
    .command("destroy")
    .description("Delete a locally hosted Drive and its imported data")
    .action(pending("destroy"));

  const mcp = command.command("mcp").description("Manage the Dosu Drive MCP integration");
  mcp
    .command("add")
    .argument("<agent>", "Agent to configure (codex or claude)")
    .action(pending("mcp add"));
  mcp.command("status").action(pending("mcp status"));
  mcp
    .command("remove")
    .argument("<agent>", "Agent to remove (codex or claude)")
    .action(pending("mcp remove"));
  mcp.command("serve", { hidden: true }).action(pending("mcp serve"));

  return command;
}
