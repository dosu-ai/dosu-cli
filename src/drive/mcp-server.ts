import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readDriveEvidence, searchDrive } from "./client";
import { loadDriveState } from "./state";
import type { DriveConnection } from "./types";

export function createDriveMcpServer(
  connectionProvider: () => DriveConnection | undefined = () => loadDriveState().active,
): McpServer {
  const server = new McpServer({ name: "dosu-drive", version: "1.0.0" });
  server.registerTool(
    "search_drive",
    {
      description:
        "Search the active team's Dosu Drive for evidence from shared coding-agent sessions.",
      inputSchema: {
        query: z.string().min(1).describe("What to find in team session history"),
        repo: z.string().min(1).optional().describe("Exact repository name"),
      },
    },
    async ({ query, repo }) => {
      const results = await searchDrive(requireConnection(connectionProvider), query, repo);
      return {
        content: [{ type: "text", text: JSON.stringify({ results }) }],
        structuredContent: { results },
      };
    },
  );
  server.registerTool(
    "read_drive_evidence",
    {
      description: "Read the complete redacted evidence behind a Dosu Drive search result.",
      inputSchema: {
        result_id: z.string().min(1).describe("Result ID returned by search_drive"),
      },
    },
    async ({ result_id }) => {
      const evidence = await readDriveEvidence(requireConnection(connectionProvider), result_id);
      return {
        content: [{ type: "text", text: JSON.stringify(evidence) }],
        structuredContent: { result: evidence.result, records: evidence.records },
      };
    },
  );
  return server;
}

export async function serveDriveMcp(): Promise<void> {
  const server = createDriveMcpServer();
  await server.connect(new StdioServerTransport());
}

function requireConnection(provider: () => DriveConnection | undefined): DriveConnection {
  const connection = provider();
  if (!connection) throw new Error("No active Drive. Run `dosu drive join` first.");
  return connection;
}
