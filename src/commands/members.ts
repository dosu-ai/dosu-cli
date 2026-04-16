/**
 * `dosu members` — team member management.
 */

import { Command } from "commander";
import pc from "picocolors";
import { createTypedClient } from "../client/trpc";
import { requireLoginConfig } from "./auth";
import { printResult, printTable } from "./output";

function requireConfig() {
  const cfg = requireLoginConfig();
  if (!cfg.org_id) {
    console.error(pc.red("Missing org config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return cfg;
}

export function membersCommand(): Command {
  const cmd = new Command("members").description("Manage team members");

  cmd
    .command("list")
    .description("List team members and invitations")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      const data = await client.invitations.getInvitations.query();

      if (opts.json) {
        printResult(data, opts);
        return;
      }

      if (!data.items || data.items.length === 0) {
        console.log(pc.dim("No members or invitations found."));
        return;
      }

      printTable(
        ["Email", "Org"],
        data.items.map((m) => [m.email ?? "—", m.org?.name ?? "—"]),
        { rawData: data },
      );
    });

  cmd
    .command("invite")
    .description("Invite a member to the organization")
    .argument("<email>", "Email address to invite")
    .option("--role <role>", "Role: admin or member", "member")
    .option("--json", "Output as JSON")
    .action(async (email: string, opts: { role: string; json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      // Role is a declared enum: ADMIN="ADMIN", MEMBER="MEMBER"
      const role = opts.role.toUpperCase() === "ADMIN" ? "ADMIN" : "MEMBER";
      await client.invitations.invite.mutate({
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        orgId: cfg.org_id!,
        email,
        // biome-ignore lint/suspicious/noExplicitAny: Role enum requires cast from string
        role: role as any,
      });

      if (opts.json) {
        printResult({ success: true, email, role }, opts);
        return;
      }
      console.log(pc.green(`Invitation sent to ${email} as ${role}.`));
    });

  cmd
    .command("requests")
    .description("List pending access requests")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      const data = await client.invitations.getInvitations.query();

      if (opts.json) {
        printResult(data, opts);
        return;
      }

      if (!data.items || data.items.length === 0) {
        console.log(pc.dim("No pending access requests."));
        return;
      }

      printTable(
        ["Email", "Org"],
        data.items.map((r) => [r.email ?? "—", r.org?.name ?? "—"]),
        { rawData: data },
      );
    });

  cmd
    .command("approve")
    .description("Approve an access request")
    .argument("<email>", "Email of requester")
    .option("--json", "Output as JSON")
    .action(async (email: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      await client.invitations.acceptInvitation.mutate({
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        orgId: cfg.org_id!,
        email,
      });

      if (opts.json) {
        printResult({ success: true, email, action: "approved" }, opts);
        return;
      }
      console.log(pc.green(`Access request from ${email} approved.`));
    });

  cmd
    .command("deny")
    .description("Deny an access request")
    .argument("<email>", "Email of requester")
    .option("--json", "Output as JSON")
    .action(async (email: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      await client.invitations.rejectInvitation.mutate({
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        orgId: cfg.org_id!,
        email,
      });

      if (opts.json) {
        printResult({ success: true, email, action: "denied" }, opts);
        return;
      }
      console.log(pc.green(`Access request from ${email} denied.`));
    });

  return cmd;
}
