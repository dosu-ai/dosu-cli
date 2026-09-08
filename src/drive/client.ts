import { createReadStream, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { hostname } from "node:os";
import type {
  DriveConnection,
  DriveEvidence,
  DriveSearchResult,
  DriveStatus,
  RepositoryPackage,
} from "./types";

export async function joinDrive(
  url: string,
  name: string,
  machineId = hostname(),
): Promise<DriveConnection> {
  const base = normalizeURL(url);
  const response = await fetch(`${base}/api/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, machineId }),
  });
  const value = await responseJSON(response);
  if (!isRecord(value) || !isRecord(value.drive) || !isRecord(value.contributor)) {
    throw new Error("Drive returned an invalid join response");
  }
  if (
    typeof value.drive.id !== "string" ||
    typeof value.drive.name !== "string" ||
    value.drive.protocolVersion !== 1 ||
    typeof value.contributor.id !== "string" ||
    typeof value.contributor.name !== "string" ||
    typeof value.contributor.token !== "string"
  ) {
    throw new Error("Drive returned incomplete connection details");
  }
  return {
    id: value.drive.id,
    name: value.drive.name,
    url: base,
    protocolVersion: 1,
    local: new URL(base).hostname === "127.0.0.1",
    contributorId: value.contributor.id,
    contributorName: value.contributor.name,
    token: value.contributor.token,
  };
}

export async function uploadPackage(
  connection: DriveConnection,
  repositoryPackage: RepositoryPackage,
): Promise<{ packageId: string; status: string }> {
  if (!connection.token) throw new Error("Join this Drive before uploading");
  const value = await streamRequest(
    new URL("/api/packages", connection.url),
    repositoryPackage.path,
    connection.token,
  );
  if (!isRecord(value) || typeof value.packageId !== "string" || typeof value.status !== "string") {
    throw new Error("Drive returned an invalid upload response");
  }
  return { packageId: value.packageId, status: value.status };
}

export async function fetchDriveStatus(
  connection: Pick<DriveConnection, "url">,
): Promise<DriveStatus> {
  const response = await fetch(`${normalizeURL(connection.url)}/api/status`);
  return (await responseJSON(response)) as DriveStatus;
}

export async function searchDrive(
  connection: Pick<DriveConnection, "url">,
  query: string,
  repository?: string,
): Promise<DriveSearchResult[]> {
  const url = new URL("/api/search", normalizeURL(connection.url));
  url.searchParams.set("q", query);
  if (repository) url.searchParams.set("repo", repository);
  const response = await fetch(url);
  const value = await responseJSON(response);
  if (!isRecord(value) || !Array.isArray(value.results))
    throw new Error("Drive returned invalid search results");
  return value.results as DriveSearchResult[];
}

export async function readDriveEvidence(
  connection: Pick<DriveConnection, "url">,
  resultId: string,
): Promise<DriveEvidence> {
  const response = await fetch(
    `${normalizeURL(connection.url)}/api/evidence/${encodeURIComponent(resultId)}`,
  );
  return (await responseJSON(response)) as DriveEvidence;
}

export async function stopDrive(connection: Pick<DriveConnection, "url">): Promise<void> {
  const response = await fetch(`${normalizeURL(connection.url)}/api/stop`, { method: "POST" });
  await responseJSON(response);
}

async function streamRequest(url: URL, path: string, token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-ndjson",
          "content-length": statSync(path).size,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          let value: unknown;
          try {
            value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          } catch {
            reject(new Error("Drive returned invalid JSON"));
            return;
          }
          if ((response.statusCode ?? 500) >= 400) {
            reject(
              new Error(
                isRecord(value) && typeof value.error === "string"
                  ? value.error
                  : "Drive upload failed",
              ),
            );
          } else resolve(value);
        });
      },
    );
    request.once("error", reject);
    const input = createReadStream(path);
    input.once("error", (error) => request.destroy(error));
    input.pipe(request);
  });
}

async function responseJSON(response: Response): Promise<unknown> {
  const value = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(
      isRecord(value) && typeof value.error === "string"
        ? value.error
        : `Drive request failed (${response.status})`,
    );
  }
  return value;
}

function normalizeURL(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Drive URL must use HTTP or HTTPS");
  return url.toString().replace(/\/$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
