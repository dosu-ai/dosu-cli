/**
 * `dosu org` — organization information.
 */

import { Command } from "commander";
import pc from "picocolors";
import { TrpcClient } from "../client/trpc";
import { loadConfig } from "../config/config";
import { printInfo, printResult, printTable } from "./output";

function requireConfig() {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    console.error(pc.red("Not configured. Run 'dosu setup' first."));
    process.exit(1);
  }
  return cfg;
}

interface Organization {
  id: string;
  name: string;
  avatar_url?: string;
  created_at?: string;
  [key: string]: unknown;
}

export function orgCommand(): Command {
  const cmd = new Command("org").description("Organization information");

  cmd
    .command("info")
    .description("Show your organizations")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);

      const orgs = await trpc.query<Organization[]>("organization.getOrganizations", {});

      if (opts.json) {
        printResult(orgs, opts);
        return;
      }

      if (!orgs || orgs.length === 0) {
        console.log(pc.dim("No organizations found."));
        return;
      }

      if (orgs.length === 1) {
        const org = orgs[0];
        printInfo(
          [
            ["Name", org.name],
            ["ID", org.id],
          ],
          { rawData: org },
        );
        return;
      }

      printTable(
        ["ID", "Name"],
        orgs.map((o) => [o.id.slice(0, 8), o.name]),
        { rawData: orgs },
      );

      if (cfg.org_id) {
        console.log(`\n${pc.dim(`Current: ${cfg.org_id}`)}`);
      }
    });

  return cmd;
}
