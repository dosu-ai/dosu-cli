/**
 * Resolver for live knowledge skills (`dosu skill resolve`).
 *
 * Fetches exactly one Dosu document revision through the typed CLI contract and
 * enforces the binding contract: the active Library must match the linked one,
 * only published revisions are used, drafts are never substituted, a pinned
 * revision never falls back to the current one, and an oversized procedure
 * fails closed instead of being truncated.
 *
 * The resolver never logs, prints, exits, or executes anything from the body.
 * Every classified failure is returned as a `ResolveFailure`; nothing is thrown.
 */

import { isTRPCClientError } from "@trpc/client";
import type { TypedClient } from "../client/trpc";
import type {
  ResolvedSource,
  ResolveFailure,
  ResolveReason,
  ResolveResult,
  SkillTracking,
} from "./types";

/** Hard ceiling on procedure body size. Roughly 8k tokens. Never truncate; fail closed. */
export const MAX_PROCEDURE_CHARS = 32_000;

export interface ResolveInput {
  document_id: string;
  /** The Library (space) id recorded in the binding. */
  library_id: string;
  /** `active_account.target.space_id` from the CLI config. */
  active_library_id: string;
  /** `undefined`/`null` = live (highest published revision); a number = pinned. */
  revision?: number | null;
  /** Injectable clock for `fetched_at`. Defaults to `() => new Date()`. */
  now?: () => Date;
}

const NO_SUBSTITUTE_NEXT_STEPS =
  "Confirm the document id and that your account can access it. Do not substitute another document.";

function fail(
  reason: ResolveReason,
  message: string,
  agent_next_steps: string,
  details?: Record<string, unknown>,
): ResolveFailure {
  const failure: ResolveFailure = { ok: false, reason, message, agent_next_steps };
  if (details) failure.details = details;
  return failure;
}

function documentNotFound(document_id: string): ResolveFailure {
  return fail(
    "document_not_found",
    `Document ${document_id} was not found or is not accessible in this Library.`,
    NO_SUBSTITUTE_NEXT_STEPS,
  );
}

function accessDenied(document_id: string): ResolveFailure {
  return fail(
    "access_denied",
    `Access to document ${document_id} was denied for the current account.`,
    "Log in with an account that belongs to this Library ('dosu login'), then retry.",
  );
}

function networkError(): ResolveFailure {
  return fail(
    "network_error",
    "The procedure could not be loaded; check your connection and retry.",
    "Retry once the network is available. Do not proceed from memory.",
  );
}

function unexpectedError(document_id: string, error: string): ResolveFailure {
  return fail(
    "unexpected_error",
    `Unexpected error while resolving document ${document_id}: ${error}`,
    "Retry once. If the error persists, report it with the message above. Do not proceed from memory.",
    { error },
  );
}

/** `TRPCClientError.data` is untyped at this boundary; read `code` only when it is a string. */
function readErrorCode(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function classifyError(err: unknown, document_id: string): ResolveFailure {
  if (isTRPCClientError(err)) {
    const code = readErrorCode(err.data);
    if (code === "FORBIDDEN" || code === "UNAUTHORIZED") return accessDenied(document_id);
    if (code === "NOT_FOUND") return documentNotFound(document_id);
    // tRPC wraps fetch failures in a TRPCClientError with no error envelope.
    if (code === undefined && err.cause instanceof TypeError) return networkError();
    return unexpectedError(document_id, err.message);
  }
  if (err instanceof TypeError) return networkError();
  if (err instanceof Error) {
    if (err.name === "AbortError") return networkError();
    return unexpectedError(document_id, err.message);
  }
  return unexpectedError(document_id, String(err));
}

/**
 * Resolve the document revision a linked skill must follow.
 *
 * Live bindings select the highest revision flagged `published` from the
 * revision inventory and then fetch exactly that revision. Pinned bindings
 * fetch the pinned revision directly and never consult the inventory.
 */
export async function resolveLinkedProcedure(
  client: TypedClient,
  input: ResolveInput,
): Promise<ResolveResult> {
  const { document_id, library_id, active_library_id } = input;
  const revision = input.revision ?? null;
  const now = input.now ?? (() => new Date());
  const pinned = revision !== null;

  if (active_library_id !== library_id) {
    return fail(
      "library_mismatch",
      `This skill is linked to Library ${library_id} but the active Library is ${active_library_id}.`,
      "Select the Library this skill was linked in with 'dosu setup', or re-link with --force to bind it to the current Library.",
      { linked_library_id: library_id, active_library_id },
    );
  }

  try {
    const store = await client.knowledgeStore.getBySpaceId.query({ space_id: library_id });
    if (!store) {
      return fail(
        "knowledge_store_missing",
        "No knowledge store found for this Library. Run 'dosu setup' to reconfigure.",
        "Run 'dosu setup' to select a configured Library, then retry.",
      );
    }
    const expectedStoreId = store.id;

    let target: number;
    if (pinned) {
      target = revision;
    } else {
      const versions = await client.page.listVersions.query({ page_id: document_id });
      if (!Array.isArray(versions) || versions.length === 0) {
        return documentNotFound(document_id);
      }
      const published = versions.filter((v) => v.published === true);
      if (published.length === 0) {
        const total = versions.length;
        return fail(
          "no_published_revision",
          `Document ${document_id} has ${total} revision${total === 1 ? "" : "s"} but none is published.`,
          "Publish a revision in Dosu, then retry. Draft revisions are never used.",
          { total_revisions: total },
        );
      }
      target = Math.max(...published.map((v) => v.version));
    }

    const page = await client.page.get.query({ page_id: document_id, version: target });

    if (page === null) {
      if (pinned) {
        return fail(
          "revision_unavailable",
          `Revision ${revision} of document ${document_id} is not available.`,
          "Do not fall back to the current revision. Re-link with a valid --revision or without --revision for live tracking.",
          { revision },
        );
      }
      return documentNotFound(document_id);
    }
    if (page.published !== true) {
      return fail(
        "revision_not_published",
        `Revision ${page.version} of document ${document_id} is not published.`,
        "Only published revisions are used. Publish this revision in Dosu or link a published one.",
        { revision: page.version },
      );
    }
    if (page.archived === true) {
      return fail(
        "document_archived",
        `Document ${document_id} is archived.`,
        "Restore the document in Dosu or link a different document. Archived procedures are never used.",
      );
    }
    if (page.knowledge_store_id !== expectedStoreId) {
      return fail(
        "library_mismatch",
        `Document ${document_id} belongs to a different Library than the one this skill is linked to.`,
        "Re-link the skill in the Library that owns this document, or select that Library with 'dosu setup'.",
        {
          linked_library_id: library_id,
          active_library_id,
          expected_knowledge_store_id: expectedStoreId,
          actual_knowledge_store_id: page.knowledge_store_id,
        },
      );
    }
    if (page.body === null || page.body.trim() === "") {
      return fail(
        "empty_body",
        `Revision ${page.version} of document ${document_id} has an empty body.`,
        "Add content to the document and publish it, then retry.",
        { revision: page.version },
      );
    }
    if (page.version !== target) {
      return fail(
        "resolver_inconsistency",
        `Requested revision ${target} of document ${document_id} but received revision ${page.version}.`,
        "Retry once. If this persists, report it as a Dosu CLI bug. Nothing was used.",
        { requested: target, received: page.version },
      );
    }
    if (page.body.length > MAX_PROCEDURE_CHARS) {
      return fail(
        "procedure_too_large",
        `The procedure is ${page.body.length} characters; the limit is ${MAX_PROCEDURE_CHARS}. Nothing was truncated.`,
        "Ask the document owner to split or shorten the procedure, or link a smaller document.",
        { actual: page.body.length, limit: MAX_PROCEDURE_CHARS },
      );
    }

    const tracking: SkillTracking = pinned ? "pinned" : "live";
    const source: ResolvedSource = {
      document_id,
      title: page.title,
      revision: page.version,
      page_version_id: page.page_version_id,
      published: true,
      tracking,
      library_id,
      knowledge_store_id: page.knowledge_store_id,
      updated_at: page.updated_at,
      fetched_at: now().toISOString(),
    };
    return { ok: true, source, body: page.body };
  } catch (err) {
    return classifyError(err, document_id);
  }
}
