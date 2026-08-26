import type { TypedClient } from "../client/trpc";

export const IMPORT_PLATFORMS = [
  "github",
  "gitlab",
  "azure_devops",
  "confluence",
  "notion",
  "coda",
] as const;

export type ImportPlatform = (typeof IMPORT_PLATFORMS)[number];

interface ImportContext {
  knowledgeStoreId: string;
  spaceId: string;
}

export async function importDocuments(
  client: TypedClient,
  platform: ImportPlatform,
  context: ImportContext,
  ids: string[],
) {
  const baseInput = {
    knowledge_store_id: context.knowledgeStoreId,
    space_id: context.spaceId,
  };

  switch (platform) {
    case "github":
      return client.docImports.importGithubFiles.mutate({ ...baseInput, file_ids: ids });
    case "gitlab":
      return client.docImports.importGitlabFiles.mutate({ ...baseInput, file_ids: ids });
    case "azure_devops":
      return client.docImports.importAzureDevopsFiles.mutate({ ...baseInput, file_ids: ids });
    case "confluence":
      return client.docImports.importConfluencePages.mutate({ ...baseInput, page_ids: ids });
    case "notion":
      return client.docImports.importNotionPages.mutate({ ...baseInput, page_ids: ids });
    case "coda":
      return client.docImports.importCodaPages.mutate({ ...baseInput, page_ids: ids });
    default: {
      const unsupported: never = platform;
      throw new Error(`Unsupported import platform: ${unsupported}`);
    }
  }
}
