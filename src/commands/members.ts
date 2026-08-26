/**
 * `dosu members` — team member management.
 */

import { Command, Option } from "commander";
import pc from "picocolors";
import { createTypedClient } from "../client/trpc";
import { requireLoginConfig } from "./auth";
import { printResult } from "./output";

function requireConfig() {
  const cfg = requireLoginConfig();
  if (!cfg.active_account?.target?.org_id) {
    console.error(pc.red("Missing org config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return cfg;
}

export function membersCommand(): Command {
  const cmd = new Command("members").description("Invite organization members");

  cmd
    .command("invite")
    .description("Invite a member to the organization")
    .argument("<email>", "Email address to invite")
    .addOption(
      new Option("--role <role>", "Organization role")
        .choices(["admin", "member"])
        .default("member"),
    )
    .option("--json", "Output as JSON")
    .action(async (email: string, opts: { role: "admin" | "member"; json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      const role = opts.role === "admin" ? "ADMIN" : "MEMBER";
      await client.invitations.invite.mutate({
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        orgId: cfg.active_account!.target!.org_id!,
        email,
        role,
      });

      if (opts.json) {
        printResult({ success: true, email, role }, opts);
        return;
      }
      console.log(pc.green(`Invitation sent to ${email} as ${role}.`));
    });

  return cmd;
}
