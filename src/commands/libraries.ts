/** `dosu libraries` — manage libraries, their sources, and per-library settings. */

import { Argument, Command, InvalidArgumentError, Option } from "commander";
import pc from "picocolors";
import { createTypedClient } from "../client/trpc";
import type {
  CliJson,
  LibrariesConfigSetInput,
  LibrariesSourceConfigUpdateInput,
} from "../generated/dosu-api-types";
import { boundedText, jsonStringArray, jsonValue, onOrOff, uuidV4 } from "./arguments";
import { requireOrgConfig } from "./auth";
import { confirmAction } from "./confirmation";
import { formatDate, printInfo, printResult, printTable } from "./output";

const LIBRARY_VISIBILITIES = ["public", "internal", "private"] as const;
const CONFIG_SETTINGS: Record<LibrariesConfigSetInput["setting"], true> = {
  commit_to_trigger_pr: true,
  default_accept_review: true,
  default_save_publish: true,
  review_timeout_days: true,
};
const CONFIG_SETTING_NAMES = Object.keys(CONFIG_SETTINGS) as LibrariesConfigSetInput["setting"][];

function validatedDocumentationValue(
  setting: LibrariesConfigSetInput["setting"],
  value: CliJson,
): CliJson {
  if (setting === "review_timeout_days") {
    if (typeof value !== "number" || ![7, 14, 30, 90].includes(value)) {
      throw new InvalidArgumentError("value must be one of 7, 14, 30, or 90");
    }
    return value;
  }
  if (typeof value !== "boolean") {
    throw new InvalidArgumentError("value must be true or false");
  }
  return value;
}

function printLibrary(
  library: {
    id: string;
    name: string;
    visibility: string;
    created_at?: string;
    updated_at?: string;
  },
  opts: { json?: boolean },
): void {
  printInfo(
    [
      ["ID", library.id],
      ["Name", library.name],
      ["Visibility", library.visibility],
      ["Created", formatDate(library.created_at)],
      ["Updated", formatDate(library.updated_at)],
    ],
    { json: opts.json, rawData: library },
  );
}

export function librariesCommand(): Command {
  const cmd = new Command("libraries").description("Manage Dosu libraries");

  cmd
    .command("list")
    .description("List libraries in the selected organization")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const { cfg, orgId } = requireOrgConfig();
      const libraries = await createTypedClient(cfg).libraries.list.query(orgId);
      if (opts.json) return printResult(libraries, opts);
      printTable(
        ["ID", "Name", "Visibility", "Updated"],
        libraries.map((library) => [
          library.id.slice(0, 8),
          library.name,
          library.visibility,
          formatDate(library.updated_at),
        ]),
        { rawData: libraries },
      );
    });

  cmd
    .command("info")
    .description("Show a library")
    .argument("<library-id>", "Library ID", uuidV4)
    .option("--json", "Output as JSON")
    .action(async (libraryId: string, opts: { json?: boolean }) => {
      const { cfg } = requireOrgConfig();
      printLibrary(await createTypedClient(cfg).libraries.info.query(libraryId), opts);
    });

  cmd
    .command("create")
    .description("Create a library")
    .requiredOption("--name <name>", "Library name", boundedText(50))
    .addOption(
      new Option("--visibility <visibility>", "Library visibility").choices([
        ...LIBRARY_VISIBILITIES,
      ]),
    )
    .option("--json", "Output as JSON")
    .action(
      async (opts: {
        name: string;
        visibility?: (typeof LIBRARY_VISIBILITIES)[number];
        json?: boolean;
      }) => {
        const { cfg, orgId } = requireOrgConfig();
        const library = await createTypedClient(cfg).libraries.create.mutate({
          name: opts.name,
          org_id: orgId,
          visibility: opts.visibility,
        });
        if (opts.json) return printResult(library, opts);
        console.log(pc.green(`Created library '${library.name}' (${library.id}).`));
      },
    );

  cmd
    .command("update")
    .description("Update a library (requires confirmation)")
    .argument("<library-id>", "Library ID", uuidV4)
    .option("--name <name>", "New name", boundedText(50))
    .addOption(
      new Option("--visibility <visibility>", "New visibility").choices([...LIBRARY_VISIBILITIES]),
    )
    .option("--confirm", "Apply without the interactive prompt")
    .option("--json", "Output as JSON")
    .action(
      async (
        libraryId: string,
        opts: {
          name?: string;
          visibility?: (typeof LIBRARY_VISIBILITIES)[number];
          confirm?: boolean;
          json?: boolean;
        },
      ) => {
        if (opts.name === undefined && opts.visibility === undefined) {
          throw new InvalidArgumentError("specify --name or --visibility");
        }
        if (
          !(await confirmAction({
            confirmed: opts.confirm,
            json: opts.json,
            message: "Update this library?",
            preview: {
              action: "update_library",
              id: libraryId,
              name: opts.name,
              visibility: opts.visibility,
            },
          }))
        )
          return;
        const { cfg } = requireOrgConfig();
        const library = await createTypedClient(cfg).libraries.update.mutate({
          id: libraryId,
          name: opts.name,
          visibility: opts.visibility,
        });
        if (opts.json) return printResult(library, opts);
        console.log(pc.green(`Updated library '${library.name}'.`));
      },
    );

  cmd
    .command("delete")
    .description("Delete a library (requires confirmation)")
    .argument("<library-id>", "Library ID", uuidV4)
    .option("--confirm", "Apply without the interactive prompt")
    .option("--json", "Output as JSON")
    .action(async (libraryId: string, opts: { confirm?: boolean; json?: boolean }) => {
      if (
        !(await confirmAction({
          confirmed: opts.confirm,
          json: opts.json,
          message: "Delete this library and its child data?",
          preview: { action: "delete_library", id: libraryId },
        }))
      )
        return;
      const { cfg } = requireOrgConfig();
      const result = await createTypedClient(cfg).libraries.delete.mutate(libraryId);
      if (opts.json) return printResult(result, opts);
      console.log(pc.green(`Deleted library ${libraryId}.`));
    });

  const config = cmd.command("config").description("Manage library documentation settings");
  config
    .command("get")
    .description("Show documentation settings")
    .argument("<library-id>", "Library ID", uuidV4)
    .option("--json", "Output as JSON")
    .action(async (libraryId: string, opts: { json?: boolean }) => {
      const { cfg } = requireOrgConfig();
      const result = await createTypedClient(cfg).libraries.configGet.query(libraryId);
      if (opts.json) return printResult(result, opts);
      printResult(result.config, opts);
    });

  config
    .command("set")
    .description("Set one documentation setting (requires confirmation)")
    .argument("<library-id>", "Library ID", uuidV4)
    .addArgument(new Argument("<setting>", "Documentation setting").choices(CONFIG_SETTING_NAMES))
    .requiredOption("--value <json>", "New value as JSON", jsonValue)
    .option("--confirm", "Apply without the interactive prompt")
    .option("--json", "Output as JSON")
    .action(
      async (
        libraryId: string,
        setting: LibrariesConfigSetInput["setting"],
        opts: { value: CliJson; confirm?: boolean; json?: boolean },
      ) => {
        const value = validatedDocumentationValue(setting, opts.value);
        if (
          !(await confirmAction({
            confirmed: opts.confirm,
            json: opts.json,
            message: `Set documentation.${setting}?`,
            preview: { action: "set_library_config", id: libraryId, setting, value },
          }))
        )
          return;
        const { cfg } = requireOrgConfig();
        const client = createTypedClient(cfg);
        const current = await client.libraries.configGet.query(libraryId);
        const result = await client.libraries.configSet.mutate({
          expected_updated_at: current.updated_at,
          setting,
          space_id: libraryId,
          value,
        });
        if (opts.json) return printResult(result, opts);
        console.log(pc.green(`Updated documentation.${setting}.`));
      },
    );

  const sources = cmd.command("sources").description("Manage sources attached to a library");
  sources
    .command("list")
    .description("List attached sources")
    .argument("<library-id>", "Library ID", uuidV4)
    .option("--json", "Output as JSON")
    .action(async (libraryId: string, opts: { json?: boolean }) => {
      const { cfg } = requireOrgConfig();
      const rows = await createTypedClient(cfg).libraries.sourcesList.query(libraryId);
      if (opts.json) return printResult(rows, opts);
      printTable(
        ["ID", "Name", "Provider", "Status"],
        rows.map((row) => [
          row.data_source_id.slice(0, 8),
          row.name,
          row.provider_slug,
          row.status,
        ]),
        { rawData: rows },
      );
    });

  for (const action of ["attach", "detach"] as const) {
    sources
      .command(action)
      .description(`${action === "attach" ? "Attach" : "Detach"} sources (requires confirmation)`)
      .argument("<library-id>", "Library ID", uuidV4)
      .argument("<source-ids...>", "One or more data source IDs")
      .option("--confirm", "Apply without the interactive prompt")
      .option("--json", "Output as JSON")
      .action(
        async (
          libraryId: string,
          sourceIds: string[],
          opts: { confirm?: boolean; json?: boolean },
        ) => {
          const uniqueIds = [...new Set(sourceIds.map(uuidV4))];
          if (
            !(await confirmAction({
              confirmed: opts.confirm,
              json: opts.json,
              message: `${action === "attach" ? "Attach" : "Detach"} ${uniqueIds.length} source(s)?`,
              preview: {
                action: `${action}_library_sources`,
                id: libraryId,
                source_ids: uniqueIds,
              },
            }))
          )
            return;
          const { cfg } = requireOrgConfig();
          const client = createTypedClient(cfg);
          const count = await (action === "attach"
            ? client.libraries.sourcesAttach.mutate({
                space_id: libraryId,
                data_source_ids: uniqueIds,
              })
            : client.libraries.sourcesDetach.mutate({
                space_id: libraryId,
                data_source_ids: uniqueIds,
              }));
          const result = { action, library_id: libraryId, source_ids: uniqueIds, changed: count };
          if (opts.json) return printResult(result, opts);
          console.log(
            pc.green(`${action === "attach" ? "Attached" : "Detached"} ${count} source(s).`),
          );
        },
      );
  }

  const sourceConfig = sources.command("config").description("Manage per-library source settings");
  sourceConfig
    .command("get")
    .description("Show source settings")
    .argument("<library-id>", "Library ID", uuidV4)
    .argument("<source-id>", "Data source ID", uuidV4)
    .option("--json", "Output as JSON")
    .action(async (libraryId: string, sourceId: string, opts: { json?: boolean }) => {
      const { cfg } = requireOrgConfig();
      const result = await createTypedClient(cfg).libraries.sourceConfigGet.query({
        data_source_id: sourceId,
        space_id: libraryId,
      });
      printResult(result, opts);
    });

  sourceConfig
    .command("update")
    .description("Update source settings (requires confirmation)")
    .argument("<library-id>", "Library ID", uuidV4)
    .argument("<source-id>", "Data source ID", uuidV4)
    .addOption(new Option("--issues <on|off>", "Read GitHub issues").argParser(onOrOff))
    .addOption(
      new Option("--pull-requests <on|off>", "Read GitHub pull requests").argParser(onOrOff),
    )
    .addOption(new Option("--discussions <on|off>", "Read GitHub discussions").argParser(onOrOff))
    .addOption(new Option("--wiki <on|off>", "Read the GitHub wiki").argParser(onOrOff))
    .addOption(
      new Option("--include-patterns <json>", "Replace included file patterns").argParser(
        jsonStringArray,
      ),
    )
    .addOption(
      new Option("--exclude-patterns <json>", "Replace excluded file patterns").argParser(
        jsonStringArray,
      ),
    )
    .option("--confirm", "Apply without the interactive prompt")
    .option("--json", "Output as JSON")
    .action(
      async (
        libraryId: string,
        sourceId: string,
        opts: {
          issues?: boolean;
          pullRequests?: boolean;
          discussions?: boolean;
          wiki?: boolean;
          includePatterns?: string[];
          excludePatterns?: string[];
          confirm?: boolean;
          json?: boolean;
        },
      ) => {
        const updates: Omit<LibrariesSourceConfigUpdateInput, "space_id" | "data_source_id"> = {
          discussions_enabled: opts.discussions,
          excluded_file_patterns: opts.excludePatterns,
          included_file_patterns: opts.includePatterns,
          issues_enabled: opts.issues,
          pull_requests_enabled: opts.pullRequests,
          wiki_enabled: opts.wiki,
        };
        if (Object.values(updates).every((value) => value === undefined)) {
          throw new InvalidArgumentError("specify at least one source setting");
        }
        if (
          !(await confirmAction({
            confirmed: opts.confirm,
            json: opts.json,
            message: "Update this source's library settings?",
            preview: {
              action: "update_library_source_config",
              id: libraryId,
              source_id: sourceId,
              ...updates,
            },
          }))
        )
          return;
        const { cfg } = requireOrgConfig();
        const result = await createTypedClient(cfg).libraries.sourceConfigUpdate.mutate({
          data_source_id: sourceId,
          space_id: libraryId,
          ...updates,
        });
        if (opts.json) return printResult(result, opts);
        console.log(pc.green("Updated source settings."));
      },
    );

  const monitors = cmd.command("monitors").description("Manage source-oriented Monitor settings");
  monitors
    .command("list")
    .description("List Monitor settings by source")
    .argument("<library-id>", "Library ID", uuidV4)
    .option("--json", "Output as JSON")
    .action(async (libraryId: string, opts: { json?: boolean }) => {
      const { cfg } = requireOrgConfig();
      const rows = await createTypedClient(cfg).libraries.monitorsList.query(libraryId);
      if (opts.json) return printResult(rows, opts);
      printTable(
        ["Source ID", "Name", "Provider", "Monitor", "Setup"],
        rows.map((row) => [
          row.data_source_id.slice(0, 8),
          row.source_name,
          row.provider_slug,
          row.enabled ? "on" : "off",
          row.setup_required ? "web required" : "ready",
        ]),
        { rawData: rows },
      );
    });

  monitors
    .command("update")
    .description("Update Monitor settings by source (requires confirmation)")
    .argument("<library-id>", "Library ID", uuidV4)
    .argument("<source-id>", "Data source ID", uuidV4)
    .addOption(new Option("--enabled <on|off>", "Turn Monitor on or off").argParser(onOrOff))
    .addOption(new Option("--paths <json>", "Replace monitored paths").argParser(jsonStringArray))
    .addOption(
      new Option("--up-to-date-behavior <behavior>", "Behavior when docs are current").choices([
        "emoji",
        "comment",
        "silent",
      ]),
    )
    .option("--confirm", "Apply without the interactive prompt")
    .option("--json", "Output as JSON")
    .action(
      async (
        libraryId: string,
        sourceId: string,
        opts: {
          enabled?: boolean;
          paths?: string[];
          upToDateBehavior?: "emoji" | "comment" | "silent";
          confirm?: boolean;
          json?: boolean;
        },
      ) => {
        if (
          opts.enabled === undefined &&
          opts.paths === undefined &&
          opts.upToDateBehavior === undefined
        ) {
          throw new InvalidArgumentError("specify at least one Monitor setting");
        }
        if (
          !(await confirmAction({
            confirmed: opts.confirm,
            json: opts.json,
            message: "Update Monitor for this source?",
            preview: { action: "update_library_monitor", id: libraryId, source_id: sourceId },
          }))
        )
          return;
        const { cfg } = requireOrgConfig();
        const result = await createTypedClient(cfg).libraries.monitorsUpdate.mutate({
          data_source_id: sourceId,
          enabled: opts.enabled,
          monitored_paths: opts.paths,
          no_update_behavior: opts.upToDateBehavior,
          space_id: libraryId,
        });
        if (opts.json) return printResult(result, opts);
        console.log(pc.green("Updated Monitor settings."));
      },
    );

  return cmd;
}
