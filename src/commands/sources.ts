/** `dosu sources`: list, inspect, connect, and create data sources. */

import { Command } from "commander";
import pc from "picocolors";
import { createTypedClient } from "../client/trpc";
import { getWebAppURL } from "../config/constants";
import {
  createDeploymentForRepo,
  deleteOrphanDeployment,
  fetchListForOrg,
  fetchOrgGithubDataSources,
  fetchOrgGithubDeployments,
  verifyDataSourcesPersist,
  waitForRepositoryRefresh,
} from "../setup/github-step";
import { startInstallationCallbackServer } from "../setup/installation-server";
import { requireLoginConfig } from "./auth";
import { confirmAction } from "./confirmation";
import { formatDate, printInfo, printResult, printTable } from "./output";

const CONNECT_TIMEOUT_DEFAULT_SECONDS = 600;

function requireConfig() {
  const cfg = requireLoginConfig();
  if (!cfg.active_account?.target?.org_id) {
    console.error(pc.red("Missing org config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return cfg;
}

/** Providers whose connect flow only exists in the web app; the CLI hands off with a URL. */
function rejectWebOnlyProvider(provider: string, json: boolean | undefined): void {
  const url = getWebAppURL();
  if (json) {
    printResult({ provider, cli_supported: false, connect_via: "web", url }, { json: true });
  } else {
    console.error(
      pc.yellow(
        `Connecting '${provider}' sources is web-only for now. Open ${url}, add the source ` +
          `under Data Sources, then re-run 'dosu sources list'.`,
      ),
    );
  }
  process.exit(1);
}

export function sourcesCommand(): Command {
  const cmd = new Command("sources").description("Manage connected data sources");

  cmd
    .command("list")
    .description("List all connected data sources")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      const dataSources = await client.dataSource.list.query({
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        org_id: cfg.active_account!.target!.org_id!,
        excluded_provider_slugs: [],
      });

      if (opts.json) {
        printResult(dataSources, opts);
        return;
      }

      const list = (dataSources ?? []) as Array<{
        id: string;
        name: string;
        provider_slug?: string;
        created_at?: string;
      }>;
      if (list.length === 0) {
        console.log(pc.dim("No data sources connected."));
        return;
      }

      printTable(
        ["ID", "Name", "Provider", "Created"],
        list.map((ds) => [
          ds.id.slice(0, 8),
          ds.name ?? "(unnamed)",
          ds.provider_slug ?? "-",
          formatDate(ds.created_at),
        ]),
        { rawData: list },
      );
    });

  cmd
    .command("info")
    .description("Show details of a data source")
    .argument("<id>", "Data source ID")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      const ds = await client.dataSource.get.query(id);

      if (opts.json) {
        printResult(ds, opts);
        return;
      }

      if (!ds) {
        console.log(pc.dim("Data source not found."));
        return;
      }

      printInfo(
        [
          ["ID", ds.id],
          ["Name", ds.name],
          ["Description", ds.description],
          ["Provider", ds.provider_slug],
          ["Created", formatDate(ds.created_at)],
        ],
        { rawData: ds },
      );
    });

  cmd
    .command("sync")
    .description("Trigger a data source sync")
    .argument("<id>", "Data source ID")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);
      await client.dataSource.syncDataSource.mutate({ data_source_id: id });

      if (opts.json) {
        printResult({ success: true, id }, opts);
        return;
      }
      console.log(pc.green(`Data source sync triggered for ${id.slice(0, 8)}.`));
    });

  cmd
    .command("update")
    .description("Update a data source")
    .argument("<id>", "Data source ID")
    .option("--name <name>", "New name")
    .option("--description <desc>", "New description")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { name?: string; description?: string; json?: boolean }) => {
      if (opts.name === undefined && opts.description === undefined) {
        throw new Error("Specify at least one of --name or --description.");
      }
      const cfg = requireConfig();
      const client = createTypedClient(cfg);

      const result = await client.dataSource.update.mutate({
        data_source_id: id,
        name: opts.name,
        description: opts.description,
      });

      if (opts.json) {
        printResult(result, opts);
        return;
      }
      console.log(pc.green("Data source updated."));
    });

  cmd
    .command("delete")
    .description("Delete a data source")
    .argument("<id>", "Data source ID")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const client = createTypedClient(cfg);
      await client.dataSource.deleteDataSource.mutate(id);

      if (opts.json) {
        printResult({ success: true, id }, opts);
        return;
      }
      console.log(pc.green("Data source deleted."));
    });

  cmd
    .command("connect")
    .description("Install or update a provider integration (currently GitHub) via the browser")
    .argument("[provider]", "Provider to connect (github)", "github")
    .option("--json", "Emit machine-readable NDJSON progress events")
    .option(
      "--timeout <seconds>",
      "Seconds to wait for the browser install to complete",
      String(CONNECT_TIMEOUT_DEFAULT_SECONDS),
    )
    .option("--no-open", "Print the URL without opening a browser")
    .action(
      async (
        provider: string,
        opts: { json?: boolean; timeout?: string; open?: boolean },
      ): Promise<void> => {
        const providerName = provider.toLowerCase();
        if (providerName !== "github") {
          rejectWebOnlyProvider(providerName, opts.json);
          return;
        }

        const cfg = requireConfig();
        const client = createTypedClient(cfg);
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        const orgID = cfg.active_account!.target!.org_id!;
        const timeoutSeconds =
          Math.max(1, Number.parseInt(opts.timeout ?? "", 10)) || CONNECT_TIMEOUT_DEFAULT_SECONDS;

        const before = await fetchListForOrg(client, orgID);
        const { server, installationPromise } = await startInstallationCallbackServer();
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          const connectURL = new URL("/cli/connect-github", getWebAppURL());
          connectURL.searchParams.set("callback", `http://localhost:${server.port}/callback`);
          const url = connectURL.toString();

          if (opts.json) {
            console.log(
              JSON.stringify({
                event: "awaiting_install",
                provider: "github",
                url,
                timeout_seconds: timeoutSeconds,
              }),
            );
          } else {
            console.log(
              `Open this URL to install or update the Dosu GitHub App:\n  ${pc.cyan(url)}`,
            );
            if (opts.open !== false) {
              try {
                const open = await import("open");
                await open.default(url);
              } catch {
                // Browser open is best-effort; the URL is already printed.
              }
            }
            console.log(pc.dim("Waiting for the install to complete..."));
          }

          const timedOut = new Promise<null>((resolve) => {
            timeoutId = setTimeout(() => resolve(null), timeoutSeconds * 1000);
          });
          const result = await Promise.race([installationPromise, timedOut]);
          if (result === null) {
            if (opts.json) {
              console.log(JSON.stringify({ event: "timeout", timeout_seconds: timeoutSeconds }));
            } else {
              console.error(
                pc.red(
                  `Timed out after ${timeoutSeconds}s. Finish the install in the browser, then ` +
                    `re-run 'dosu sources connect github'.`,
                ),
              );
            }
            process.exit(1);
            return;
          }

          const refresh = await waitForRepositoryRefresh(client, orgID, before);
          const beforeIds = new Set(before.map((repo) => repo.repository_id));
          const newRepositories = refresh.repos
            .filter((repo) => !beforeIds.has(repo.repository_id))
            .map((repo) => ({ slug: repo.slug, repository_id: repo.repository_id }));

          if (opts.json) {
            console.log(
              JSON.stringify({
                event: "installed",
                installation_id: result.installation_id,
                new_repositories: newRepositories,
              }),
            );
            return;
          }
          console.log(pc.green(`GitHub App connected (installation ${result.installation_id}).`));
          if (newRepositories.length > 0) {
            for (const repo of newRepositories) {
              console.log(`  ${repo.slug}`);
            }
            console.log(
              pc.dim("Next: dosu sources create github --repo <owner/name> --library <library-id>"),
            );
          } else {
            console.log(
              pc.dim(
                "No new repositories visible yet — GitHub may still be syncing. " +
                  "Re-run 'dosu sources connect github' or check 'dosu sources list' shortly.",
              ),
            );
          }
        } finally {
          clearTimeout(timeoutId);
          server.close();
        }
      },
    );

  cmd
    .command("create")
    .description(
      "Create a data source from an installed provider and attach it to a library (requires confirmation)",
    )
    .argument("<provider>", "Provider (currently: github)")
    .requiredOption("--repo <owner/name>", "GitHub repository slug visible to the Dosu app")
    .option("--library <id>", "Library (space) ID to attach to; defaults to the active library")
    .option("--confirm", "Apply without the interactive prompt")
    .option("--json", "Output as JSON")
    .action(
      async (
        provider: string,
        opts: { repo: string; library?: string; confirm?: boolean; json?: boolean },
      ): Promise<void> => {
        const providerName = provider.toLowerCase();
        if (providerName !== "github") {
          rejectWebOnlyProvider(providerName, opts.json);
          return;
        }

        const cfg = requireConfig();
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        const orgID = cfg.active_account!.target!.org_id!;
        const libraryID = opts.library ?? cfg.active_account?.target?.space_id;
        if (!libraryID) {
          console.error(pc.red("No library specified and no active library. Pass --library <id>."));
          process.exit(1);
          return;
        }

        const client = createTypedClient(cfg);
        const repos = await fetchListForOrg(client, orgID);
        const repo = repos.find((r) => r.slug.toLowerCase() === opts.repo.toLowerCase());
        if (!repo) {
          console.error(
            pc.red(
              `Repository '${opts.repo}' is not visible to Dosu. Run ` +
                `'dosu sources connect github' to grant the GitHub App access, then retry.`,
            ),
          );
          process.exit(1);
          return;
        }
        if (repo.is_fork === true) {
          console.error(
            pc.red(
              `'${repo.slug}' is a fork and can't be synced.` +
                (repo.fork_parent_slug ? ` Connect '${repo.fork_parent_slug}' instead.` : ""),
            ),
          );
          process.exit(1);
          return;
        }

        if (
          !(await confirmAction({
            confirmed: opts.confirm,
            json: opts.json,
            message: `Create a data source for ${repo.slug} and attach it to library ${libraryID}?`,
            preview: {
              action: "create_source",
              provider: "github",
              repository: repo.slug,
              repository_id: repo.repository_id,
              library_id: libraryID,
            },
          }))
        )
          return;

        // Reuse leftover org rows; both are unique per repo backend-side.
        const existingDeployments = await fetchOrgGithubDeployments(client, orgID);
        const existingDataSources = await fetchOrgGithubDataSources(client, orgID);
        const created = await createDeploymentForRepo(client, orgID, libraryID, repo, {
          deploymentID: existingDeployments.get(repo.repository_id),
          dataSourceID: existingDataSources.get(repo.repository_id),
        });
        if (!created) {
          console.error(
            pc.red("Could not create the data source. Check 'dosu logs --tail 50' for details."),
          );
          process.exit(1);
          return;
        }

        // The backend sync deletes the data_source when it can't reach the repo; verify before
        // declaring success and revert the orphan deployment.
        const survivors = await verifyDataSourcesPersist(client, orgID, [created.data_source_id]);
        if (survivors.dropped.size > 0) {
          await deleteOrphanDeployment(client, created.deployment_id, repo.slug);
          console.error(
            pc.red(
              `Dosu couldn't sync '${repo.slug}' (the GitHub App may not have access to it). ` +
                "Nothing was created.",
            ),
          );
          process.exit(1);
          return;
        }

        const receipt = {
          provider: "github",
          repository: repo.slug,
          repository_id: repo.repository_id,
          data_source_id: created.data_source_id,
          deployment_id: created.deployment_id,
          library_id: libraryID,
          attached: true,
        };
        if (opts.json) {
          printResult(receipt, opts);
          return;
        }
        console.log(pc.green(`Connected ${repo.slug} to library ${libraryID}.`));
        console.log(pc.dim(`  data source ${created.data_source_id}`));
        console.log(pc.dim(`  deployment ${created.deployment_id}`));
      },
    );

  return cmd;
}
