/**
 * `dosu members` — team member management.
 */

import { Command } from "commander";
import pc from "picocolors";
import { TrpcClient } from "../client/trpc";
import { loadConfig } from "../config/config";
import { printResult, printTable } from "./output";

function requireConfig() {
  const cfg = loadConfig();
  if (!cfg.api_key) {
    console.error(pc.red("Not configured. Run 'dosu setup' first."));
    process.exit(1);
  }
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
      const trpc = new TrpcClient(cfg);

      const data = await trpc.query<unknown[]>("invitations.getInvitations", {
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        orgId: cfg.org_id!,
      });

      if (opts.json) {
        printResult(data, opts);
        return;
      }

      if (!data || data.length === 0) {
        console.log(pc.dim("No members or invitations found."));
        return;
      }

      printTable(
        ["Email", "Role", "Status"],
        (data as Array<{ email: string; role?: string; status?: string }>).map((m) => [
          m.email,
          m.role ?? "—",
          m.status ?? "—",
        ]),
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
      const trpc = new TrpcClient(cfg);

      const role = opts.role.toUpperCase() === "ADMIN" ? "ADMIN" : "MEMBER";
      const result = await trpc.mutate("invitations.invite", {
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        orgId: cfg.org_id!,
        email,
        role,
      });

      if (opts.json) {
        printResult(result, opts);
        return;
      }
      console.log(pc.green(`Invitation sent to ${email} as ${role}.`));
    });

  cmd
    .command("remove")
    .description("Remove a member from the organization")
    .argument("<email>", "Email of member to remove")
    .option("--json", "Output as JSON")
    .action(async (email: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);

      await trpc.mutate("invitations.removeMember", {
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        orgId: cfg.org_id!,
        email,
      });

      if (opts.json) {
        printResult({ success: true, email }, opts);
        return;
      }
      console.log(pc.green(`Member ${email} removed.`));
    });

  cmd
    .command("requests")
    .description("List pending access requests")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);

      const data = await trpc.query<unknown[]>("invitations.listAccessRequests", {
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        orgId: cfg.org_id!,
      });

      if (opts.json) {
        printResult(data, opts);
        return;
      }

      if (!data || data.length === 0) {
        console.log(pc.dim("No pending access requests."));
        return;
      }

      printTable(
        ["Email", "Requested"],
        (data as Array<{ email: string; requested_at?: string }>).map((r) => [
          r.email,
          r.requested_at ?? "—",
        ]),
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
      const trpc = new TrpcClient(cfg);

      await trpc.mutate("invitations.approveAccessRequest", {
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
      const trpc = new TrpcClient(cfg);

      await trpc.mutate("invitations.rejectInvitation", {
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
