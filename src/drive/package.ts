import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readdirSync } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import type {
  ApprovedSession,
  DejaSession,
  DejaSyncRecord,
  RepositoryIdentity,
  RepositoryPackage,
  RepositoryPackageManifest,
} from "./types";

const REDACTION_MARKER = /\[redacted:([^\]]+)\]/g;

interface CreatePackageOptions {
  exportDirectory: string;
  outputDirectory: string;
  driveId: string;
  contributor: { id: string; name: string };
  repository: RepositoryIdentity;
  sessions: DejaSession[];
  now?: Date;
}

export interface ExportSessionSummary {
  key: string;
  records: number;
  bytes: number;
  redactions: number;
  sample?: string;
}

export async function summarizeDejaExport(
  exportDirectory: string,
  sessions: readonly DejaSession[],
): Promise<Map<string, ExportSessionSummary>> {
  const summaries = new Map<string, ExportSessionSummary>(
    sessions.map((session) => {
      const key = dejaSessionKey(session.harness, session.id);
      return [key, { key, records: 0, bytes: 0, redactions: 0 } satisfies ExportSessionSummary];
    }),
  );
  for (const path of exportFiles(exportDirectory)) {
    const lines = createInterface({
      input: createReadStream(path),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const record = parseSyncRecord(line, path);
      const summary = summaries.get(dejaSessionKey(record.harness, record.session_id));
      if (!summary) continue;
      summary.records++;
      summary.bytes += Buffer.byteLength(`${line}\n`);
      summary.redactions += [...record.text.matchAll(REDACTION_MARKER)].length;
      if (!summary.sample && (record.role === "user" || record.role === "assistant")) {
        summary.sample = record.text.slice(0, 500);
      }
    }
  }
  return summaries;
}

export async function createRepositoryPackage(
  options: CreatePackageOptions,
): Promise<RepositoryPackage> {
  await mkdir(options.outputDirectory, { recursive: true, mode: 0o700 });
  const approved = new Map(
    options.sessions.map((session) => [dejaSessionKey(session.harness, session.id), session]),
  );
  if (approved.size === 0) throw new Error(`No approved sessions for ${options.repository.name}`);

  const scratchPath = join(options.outputDirectory, `.records-${process.pid}-${Date.now()}.jsonl`);
  const scratch = await open(scratchPath, "wx", 0o600);
  const hash = createHash("sha256");
  const redactions: Record<string, number> = {};
  let recordCount = 0;
  let recordBytes = 0;
  const seen = new Set<string>();

  let processingError: unknown;
  try {
    for (const path of exportFiles(options.exportDirectory)) {
      const lines = createInterface({
        input: createReadStream(path),
        crlfDelay: Number.POSITIVE_INFINITY,
      });
      for await (const line of lines) {
        if (!line.trim()) continue;
        const record = parseSyncRecord(line, path);
        const session = approved.get(dejaSessionKey(record.harness, record.session_id));
        if (!session) continue;
        const transformed: DejaSyncRecord = {
          harness: record.harness,
          session_id: namespacedSessionId(
            options.contributor.id,
            record.harness,
            record.session_id,
          ),
          project: options.repository.name,
          role: record.role,
          text: record.text,
          time: record.time,
        };
        const serialized = `${JSON.stringify(transformed)}\n`;
        await scratch.write(serialized);
        hash.update(serialized);
        recordBytes += Buffer.byteLength(serialized);
        recordCount++;
        seen.add(dejaSessionKey(record.harness, record.session_id));
        for (const match of record.text.matchAll(REDACTION_MARKER)) {
          const kind = match[1] ?? "unknown";
          redactions[kind] = (redactions[kind] ?? 0) + 1;
        }
      }
    }
  } catch (error) {
    processingError = error;
  } finally {
    await scratch.close();
  }
  if (processingError) {
    await unlink(scratchPath).catch(() => undefined);
    throw processingError;
  }

  if (recordCount === 0) {
    await unlink(scratchPath).catch(() => undefined);
    throw new Error(`deja-vu exported no approved records for ${options.repository.name}`);
  }
  const missing = [...approved.keys()].filter((key) => !seen.has(key));
  if (missing.length > 0) {
    await unlink(scratchPath).catch(() => undefined);
    throw new Error(`deja-vu export is missing ${missing.length} approved sessions`);
  }

  const sessions = options.sessions.map(
    (session): ApprovedSession => ({
      nativeId: session.id,
      namespacedId: namespacedSessionId(options.contributor.id, session.harness, session.id),
      harness: session.harness,
      project: session.project,
      ...(session.title ? { title: session.title } : {}),
      started: session.started,
      updated: session.updated,
      touched: session.touched ?? [],
    }),
  );
  const recordsSha256 = hash.digest("hex");
  const packageId = createHash("sha256")
    .update(
      JSON.stringify({
        driveId: options.driveId,
        contributorId: options.contributor.id,
        repositoryRoot: options.repository.root,
        sessions: sessions.map((session) => [session.harness, session.nativeId]),
        recordsSha256,
      }),
    )
    .digest("hex")
    .slice(0, 24);
  const manifest: RepositoryPackageManifest = {
    kind: "dosu-drive-package",
    schemaVersion: 1,
    packageId,
    createdAt: (options.now ?? new Date()).toISOString(),
    driveId: options.driveId,
    contributor: options.contributor,
    repository: options.repository,
    sessions,
    recordCount,
    recordBytes,
    recordsSha256,
    redactions: {
      total: Object.values(redactions).reduce((sum, count) => sum + count, 0),
      byKind: redactions,
    },
  };
  const packagePath = join(options.outputDirectory, `${packageId}.drive.ndjson`);
  const output = await open(packagePath, "wx", 0o600);
  await output.write(`${JSON.stringify(manifest)}\n`);
  await output.close();
  try {
    await pipeline(createReadStream(scratchPath), createWriteStream(packagePath, { flags: "a" }));
  } finally {
    await unlink(scratchPath).catch(() => undefined);
  }
  return { path: packagePath, manifest };
}

export function namespacedSessionId(
  contributorId: string,
  harness: string,
  nativeId: string,
): string {
  return `dosu-${createHash("sha256")
    .update(`${contributorId}\0${harness}\0${nativeId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function exportFiles(directory: string): string[] {
  if (!existsSync(directory)) throw new Error(`Missing deja-vu export directory: ${directory}`);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => join(directory, name));
}

function parseSyncRecord(line: string, path: string): DejaSyncRecord {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    throw new Error(`Invalid deja-vu record in ${basename(path)}`);
  }
  if (
    !isRecord(value) ||
    typeof value.harness !== "string" ||
    typeof value.session_id !== "string" ||
    typeof value.project !== "string" ||
    typeof value.role !== "string" ||
    typeof value.text !== "string" ||
    typeof value.time !== "string"
  ) {
    throw new Error(`Incomplete deja-vu record in ${basename(path)}`);
  }
  return value as unknown as DejaSyncRecord;
}

export function dejaSessionKey(harness: string, sessionId: string): string {
  return `${harness}\0${sessionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
