/**
 * `dosu docs` — document/page management.
 */

import { readFileSync } from "node:fs";
import { Command } from "commander";
import pc from "picocolors";
import { TrpcClient } from "../client/trpc";
import { getBackendURL } from "../config/constants";
import { logger } from "../debug/logger";
import { requireAPIKey, requireLoginConfig } from "./auth";
import { formatDate, printInfo, printResult, printTable, truncate } from "./output";

function requireConfig() {
  const cfg = requireLoginConfig();
  if (!cfg.space_id) {
    console.error(pc.red("Missing space config. Run 'dosu setup' to reconfigure."));
    process.exit(1);
  }
  return cfg;
}

async function getKnowledgeStoreId(trpc: TrpcClient, spaceId: string): Promise<string> {
  const store = await trpc.query<{ id: string } | null>("knowledgeStore.getBySpaceId", {
    space_id: spaceId,
  });
  if (!store) {
    console.error(pc.red("No knowledge store found for this deployment."));
    process.exit(1);
  }
  return store.id;
}

function readBody(opts: { body?: string; bodyFile?: string }): string | undefined {
  if (opts.bodyFile) return readFileSync(opts.bodyFile, "utf-8");
  return opts.body;
}

async function backendPost(
  path: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const backendURL = getBackendURL();
  if (!backendURL) {
    console.error(pc.red("Backend URL not configured."));
    process.exit(1);
  }
  const resp = await fetch(`${backendURL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Dosu-API-Key": apiKey },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.detail ?? `Request failed with status ${resp.status}`);
  }
  return data;
}

export function docsCommand(): Command {
  const cmd = new Command("docs").description("Document management");

  // ── list ──
  cmd
    .command("list")
    .description("List documents")
    .option("--search <query>", "Search documents")
    .option("--tag <id>", "Filter by tag ID")
    .option("--limit <n>", "Maximum results", "20")
    .option("--json", "Output as JSON")
    .action(async (opts: { search?: string; tag?: string; limit?: string; json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);
      // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
      const ksId = await getKnowledgeStoreId(trpc, cfg.space_id!);

      const pages = await trpc.query<
        Array<{ id: string; title?: string; published?: boolean; created_at?: string }>
      >("page.listWithTags", {
        knowledge_store_id: ksId,
        searchTerm: opts.search,
        tags: opts.tag ? [opts.tag] : [],
        limit: Number.parseInt(opts.limit ?? "20", 10),
      });

      if (opts.json) {
        printResult(pages, opts);
        return;
      }
      if (!pages || pages.length === 0) {
        console.log(pc.dim("No documents found."));
        return;
      }
      printTable(
        ["ID", "Title", "Status", "Created"],
        pages.map((p) => [
          p.id.slice(0, 8),
          truncate(p.title ?? "(untitled)", 50),
          p.published ? "published" : "draft",
          formatDate(p.created_at),
        ]),
        { rawData: pages },
      );
    });

  // ── get ──
  cmd
    .command("get")
    .description("Get a document")
    .argument("<id>", "Page ID")
    .option("--version <v>", "Specific version number")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { version?: string; json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);

      const input: Record<string, unknown> = { page_id: id };
      if (opts.version) input.version = Number.parseInt(opts.version, 10);

      const page = await trpc.query<{
        id: string;
        title?: string;
        body?: string;
        published?: boolean;
        created_at?: string;
      }>("page.get", input);

      if (opts.json) {
        printResult(page, opts);
        return;
      }
      console.log(pc.bold(page.title ?? "(untitled)"));
      printInfo([
        ["ID", page.id],
        ["Status", page.published ? "published" : "draft"],
        ["Created", formatDate(page.created_at)],
      ]);
      if (page.body) {
        console.log(`\n${page.body}`);
      }
    });

  // ── create ──
  cmd
    .command("create")
    .description("Create a new document")
    .requiredOption("--title <title>", "Document title")
    .option("--body <markdown>", "Document body (markdown)")
    .option("--body-file <path>", "Read body from file")
    .option("--json", "Output as JSON")
    .action(async (opts: { title: string; body?: string; bodyFile?: string; json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);
      // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
      const ksId = await getKnowledgeStoreId(trpc, cfg.space_id!);

      const body = readBody(opts);
      const result = await trpc.mutate("page.create", {
        knowledge_store_id: ksId,
        title: opts.title,
        body: body ?? "",
      });

      if (opts.json) {
        printResult(result, opts);
        return;
      }
      console.log(pc.green(`Document "${opts.title}" created.`));
    });

  // ── update ──
  cmd
    .command("update")
    .description("Update a document")
    .argument("<id>", "Page ID")
    .option("--title <title>", "New title")
    .option("--body <markdown>", "New body (markdown)")
    .option("--body-file <path>", "Read body from file")
    .option("--json", "Output as JSON")
    .action(
      async (
        id: string,
        opts: { title?: string; body?: string; bodyFile?: string; json?: boolean },
      ) => {
        const cfg = requireConfig();
        const trpc = new TrpcClient(cfg);
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        const ksId = await getKnowledgeStoreId(trpc, cfg.space_id!);

        const body = readBody(opts);
        const input: Record<string, unknown> = { id, knowledge_store_id: ksId };
        if (opts.title) input.title = opts.title;
        if (body !== undefined) input.body = body;

        const result = await trpc.mutate("page.update", input);

        if (opts.json) {
          printResult(result, opts);
          return;
        }
        console.log(pc.green("Document updated."));
      },
    );

  // ── archive / unarchive ──
  for (const archived of [true, false]) {
    const name = archived ? "archive" : "unarchive";
    cmd
      .command(name)
      .description(`${archived ? "Archive" : "Unarchive"} a document`)
      .argument("<id>", "Page ID")
      .option("--json", "Output as JSON")
      .action(async (id: string, opts: { json?: boolean }) => {
        const cfg = requireConfig();
        const trpc = new TrpcClient(cfg);
        await trpc.mutate("page.setArchiveState", { page_id: id, archived });

        if (opts.json) {
          printResult({ success: true, id, archived }, opts);
          return;
        }
        console.log(pc.green(`Document ${name}d.`));
      });
  }

  // ── delete ──
  cmd
    .command("delete")
    .description("Delete a document")
    .argument("<id>", "Page ID")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);
      await trpc.mutate("page.delete", { page_id: id });

      if (opts.json) {
        printResult({ success: true, id }, opts);
        return;
      }
      console.log(pc.green("Document deleted."));
    });

  // ── versions ──
  cmd
    .command("versions")
    .description("List document versions")
    .argument("<id>", "Page ID")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);

      const versions = await trpc.query<
        Array<{ version: number; created_at?: string; [key: string]: unknown }>
      >("page.listVersions", { page_id: id });

      if (opts.json) {
        printResult(versions, opts);
        return;
      }
      if (!versions || versions.length === 0) {
        console.log(pc.dim("No versions found."));
        return;
      }
      printTable(
        ["Version", "Created"],
        versions.map((v) => [String(v.version), formatDate(v.created_at)]),
        { rawData: versions },
      );
    });

  // ── restore ──
  cmd
    .command("restore")
    .description("Restore a document version")
    .argument("<id>", "Page ID")
    .requiredOption("--version <n>", "Version number to restore")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { version: string; json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);
      await trpc.mutate("page.restoreVersion", {
        page_id: id,
        version_to_restore: Number.parseInt(opts.version, 10),
      });

      if (opts.json) {
        printResult({ success: true, id, version: opts.version }, opts);
        return;
      }
      console.log(pc.green(`Document restored to version ${opts.version}.`));
    });

  // ── generate ──
  cmd
    .command("generate")
    .description("Generate a document using AI")
    .requiredOption("--title <title>", "Document title")
    .option("--instructions <text>", "Custom generation instructions")
    .option("--json", "Output as JSON")
    .action(async (opts: { title: string; instructions?: string; json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);
      // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
      const ksId = await getKnowledgeStoreId(trpc, cfg.space_id!);

      const result = await backendPost("/doc/generate", requireAPIKey(cfg), {
        knowledge_store_id: ksId,
        title: opts.title,
        instructions: opts.instructions,
      });

      if (opts.json) {
        printResult(result, opts);
        return;
      }
      console.log(pc.green("Document generation started."));
    });

  // ── auto-tag ──
  cmd
    .command("auto-tag")
    .description("Auto-tag a document using AI")
    .argument("<id>", "Page ID")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const result = await backendPost("/doc/auto-tag", requireAPIKey(cfg), { page_id: id });

      if (opts.json) {
        printResult(result, opts);
        return;
      }
      console.log(pc.green("Auto-tagging started."));
    });

  // ── import ──
  cmd
    .command("import")
    .description("Import documents from an external platform")
    .argument("<platform>", "Platform: github, gitlab, confluence, notion, coda")
    .requiredOption("--files <ids>", "Comma-separated file/page IDs to import")
    .option("--json", "Output as JSON")
    .action(async (platform: string, opts: { files: string; json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);
      // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
      const ksId = await getKnowledgeStoreId(trpc, cfg.space_id!);
      const fileIds = opts.files.split(",").map((id) => id.trim());

      const procedureMap: Record<string, string> = {
        github: "docImports.importGithubFiles",
        gitlab: "docImports.importGitlabFiles",
        confluence: "docImports.importConfluencePages",
        notion: "docImports.importNotionPages",
        coda: "docImports.importCodaPages",
      };

      const procedure = procedureMap[platform.toLowerCase()];
      if (!procedure) {
        console.error(
          pc.red(`Unknown platform: ${platform}. Use: github, gitlab, confluence, notion, coda`),
        );
        process.exit(1);
      }

      const idField = ["confluence", "notion", "coda"].includes(platform.toLowerCase())
        ? "page_ids"
        : "file_ids";

      const result = await trpc.mutate<{ task_id?: string }>(procedure, {
        knowledge_store_id: ksId,
        // biome-ignore lint/style/noNonNullAssertion: checked in requireConfig
        space_id: cfg.space_id!,
        [idField]: fileIds,
      });

      if (opts.json) {
        printResult(result, opts);
        return;
      }
      console.log(
        pc.green(`Import started.${result.task_id ? ` Task ID: ${result.task_id}` : ""}`),
      );
    });

  // ── import-status ──
  cmd
    .command("import-status")
    .description("Check import task status")
    .argument("<task-id>", "Import task ID")
    .option("--json", "Output as JSON")
    .action(async (taskId: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);

      const status = await trpc.query<{ status?: string; [key: string]: unknown } | null>(
        "docImports.getImportStatus",
        { taskId },
      );

      if (opts.json) {
        printResult(status, opts);
        return;
      }
      if (!status) {
        console.log(pc.dim("Import task not found."));
        return;
      }
      console.log(`Status: ${status.status ?? "unknown"}`);
    });

  // ── publish ──
  cmd
    .command("publish")
    .description("Publish a document to an external platform")
    .argument("<id>", "Page ID")
    .requiredOption("--to <platform>", "Target: github, gitlab, confluence, notion, coda")
    .option("--repo-id <id>", "GitHub repository ID")
    .option("--project-id <id>", "GitLab project ID")
    .option("--parent-page-id <id>", "Parent page ID (Confluence/Notion)")
    .option("--doc-id <id>", "Coda doc ID")
    .option("--directory <path>", "Target directory (GitHub/GitLab)")
    .option("--data-source-id <id>", "Data source ID")
    .option("--json", "Output as JSON")
    .action(
      async (
        id: string,
        opts: {
          to: string;
          repoId?: string;
          projectId?: string;
          parentPageId?: string;
          docId?: string;
          directory?: string;
          dataSourceId?: string;
          json?: boolean;
        },
      ) => {
        const cfg = requireConfig();
        const platform = opts.to.toLowerCase();

        const publishMap: Record<
          string,
          { path: string; buildBody: () => Record<string, unknown> }
        > = {
          github: {
            path: `/sync-back/github/${id}/publish`,
            buildBody: () => ({
              target_repository_id: Number(opts.repoId),
              target_directory: opts.directory ?? "/",
              target_data_source_id: opts.dataSourceId,
            }),
          },
          gitlab: {
            path: `/sync-back/gitlab/${id}/publish`,
            buildBody: () => ({
              gitlab_project_id: opts.projectId,
              target_directory: opts.directory ?? "/",
              target_data_source_id: opts.dataSourceId,
            }),
          },
          confluence: {
            path: `/sync-back/confluence/${id}/publish`,
            buildBody: () => ({
              parent_page_id: opts.parentPageId,
              target_data_source_id: opts.dataSourceId,
            }),
          },
          notion: {
            path: `/sync-back/notion/${id}/publish`,
            buildBody: () => ({
              parent_notion_page_id: opts.parentPageId,
              target_data_source_id: opts.dataSourceId,
            }),
          },
          coda: {
            path: `/sync-back/coda/${id}/publish`,
            buildBody: () => ({
              target_doc_id: opts.docId,
              target_data_source_id: opts.dataSourceId,
            }),
          },
        };

        const config = publishMap[platform];
        if (!config) {
          console.error(pc.red(`Unknown platform: ${platform}`));
          process.exit(1);
        }

        logger.debug("docs", `Publishing to ${platform}`);
        const result = await backendPost(config.path, requireAPIKey(cfg), config.buildBody());

        if (opts.json) {
          printResult(result, opts);
          return;
        }
        console.log(pc.green(`Document published to ${platform}.`));
      },
    );

  // ── sync-back ──
  cmd
    .command("sync-back")
    .description("Sync document back to its source (Notion/Confluence)")
    .argument("<id>", "Page ID")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const cfg = requireConfig();
      const trpc = new TrpcClient(cfg);

      const result = await trpc.mutate("page.syncBack", { page_id: id });

      if (opts.json) {
        printResult(result, opts);
        return;
      }
      console.log(pc.green("Sync-back initiated."));
    });

  return cmd;
}
