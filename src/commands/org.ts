/**
 * `dosu org` — organization information.
 */

import { Command } from "commander";
import pc from "picocolors";
import { createTypedClient } from "../client/trpc";
import { requireLoginConfig } from "./auth";
import { printInfo, printResult, printTable } from "./output";

function requireConfig() {
  return requireLoginConfig();
}

export function orgCommand(): Command {
  const cmd = new Command("org").description("Organization information");

  cmd
    .command("info")
    .description("Show your organizations")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      const orgs = await client.organization.getOrganizations.query({});

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
            ["ID", org.org_id],
          ],
          { rawData: org },
        );
        return;
      }

      printTable(
        ["ID", "Name"],
        orgs.map((o: { org_id: string; name: string }) => [o.org_id.slice(0, 8), o.name]),
        { rawData: orgs },
      );

      if (cfg.org_id) {
        console.log(`\n${pc.dim(`Current: ${cfg.org_id}`)}`);
      }
    });

  return cmd;
}
