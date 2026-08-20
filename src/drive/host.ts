import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { writeSecureFile } from "../mcp/config-helpers";
import { runDeja } from "./deja";
import { hostedDriveDir, hostedDrivePointerPath } from "./paths";
import { setActiveDrive } from "./state";
import {
  type ApprovedSession,
  type DejaSyncRecord,
  DRIVE_PROTOCOL_VERSION,
  type DriveEvidence,
  type DriveSearchResult,
  type DriveStatus,
  type RepositoryPackageManifest,
} from "./types";

interface HostContributor {
  id: string;
  name: string;
  machineId: string;
  token: string;
  joinedAt: string;
}

interface HostedPackage {
  manifest: RepositoryPackageManifest;
  indexed: boolean;
}

interface HostManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  contributors: HostContributor[];
  packages: HostedPackage[];
}

export interface DriveHost {
  id: string;
  name: string;
  url: string;
  lanUrl: string;
  status(): DriveStatus;
  close(): Promise<void>;
}

export async function createDriveHost(options: {
  name: string;
  port?: number;
}): Promise<DriveHost> {
  const manifest = loadOrCreateManifest(options.name);
  const directory = hostedDriveDir(manifest.id);
  await ensureHostDirectories(directory);
  let server: Server;
  let indexQueue = Promise.resolve();
  let localUrl = "";
  let lanUrl = "";

  const queueIndex = (packageId: string): Promise<void> => {
    const job = indexQueue.then(() => indexPackage(directory, manifest, packageId));
    indexQueue = job.catch(() => undefined);
    return job;
  };

  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", localUrl || "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/api/status") {
        json(response, 200, hostStatus(manifest, lanUrl));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/join") {
        const body = await readJSONBody(request);
        if (
          !isRecord(body) ||
          typeof body.name !== "string" ||
          typeof body.machineId !== "string"
        ) {
          throw new HTTPError(400, "Contributor name and machine ID are required");
        }
        const contributor = joinContributor(directory, manifest, body.name, body.machineId);
        json(response, 200, {
          drive: { id: manifest.id, name: manifest.name, protocolVersion: DRIVE_PROTOCOL_VERSION },
          contributor: { id: contributor.id, name: contributor.name, token: contributor.token },
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/packages") {
        const received = await receivePackage(directory, manifest, request);
        await queueIndex(received.packageId);
        json(response, 201, { packageId: received.packageId, status: "ready" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/search") {
        const query = url.searchParams.get("q")?.trim() ?? "";
        if (!query) throw new HTTPError(400, "Search query is required");
        const results = await searchHost(directory, manifest, query, url.searchParams.get("repo"));
        json(response, 200, { query, results });
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/evidence/")) {
        const resultId = decodeURIComponent(url.pathname.slice("/api/evidence/".length));
        const evidence = await readHostEvidence(directory, manifest, resultId);
        if (!evidence) throw new HTTPError(404, "Drive evidence was not found");
        json(response, 200, evidence);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/stop") {
        json(response, 200, { stopped: true });
        setTimeout(() => server.close(), 10);
        return;
      }
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
        html(response, dashboardHTML(manifest.name));
        return;
      }
      json(response, 404, { error: "Not found" });
    } catch (error) {
      const status = error instanceof HTTPError ? error.status : 500;
      json(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await listen(server, options.port ?? 7777);
  const port = (server.address() as AddressInfo).port;
  localUrl = `http://127.0.0.1:${port}`;
  lanUrl = `http://${lanAddress()}:${port}`;

  const hostContributor = joinContributor(directory, manifest, `Host · ${manifest.name}`, "host");
  setActiveDrive({
    id: manifest.id,
    name: manifest.name,
    url: localUrl,
    protocolVersion: DRIVE_PROTOCOL_VERSION,
    local: true,
    contributorId: hostContributor.id,
    contributorName: hostContributor.name,
    token: hostContributor.token,
  });

  return {
    id: manifest.id,
    name: manifest.name,
    url: localUrl,
    lanUrl,
    status: () => hostStatus(manifest, lanUrl),
    close: () => closeServer(server),
  };
}

function loadOrCreateManifest(name: string): HostManifest {
  const pointerPath = hostedDrivePointerPath();
  if (existsSync(pointerPath)) {
    try {
      const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as { driveId?: unknown };
      if (typeof pointer.driveId === "string") {
        const path = join(hostedDriveDir(pointer.driveId), "host.json");
        const parsed = parseHostManifest(JSON.parse(readFileSync(path, "utf8")) as unknown);
        if (parsed) return parsed;
      }
    } catch {
      // A damaged pointer starts a fresh Drive; old directories are left untouched.
    }
  }
  const now = new Date().toISOString();
  const manifest: HostManifest = {
    schemaVersion: 1,
    id: randomUUID(),
    name,
    createdAt: now,
    contributors: [],
    packages: [],
  };
  const directory = hostedDriveDir(manifest.id);
  saveHostManifest(directory, manifest);
  writeSecureFile(pointerPath, `${JSON.stringify({ driveId: manifest.id }, null, 2)}\n`);
  return manifest;
}

async function ensureHostDirectories(directory: string): Promise<void> {
  await Promise.all(
    ["packages", "staging", "imports", "sources", "deja-index"].map((name) =>
      mkdir(join(directory, name), { recursive: true, mode: 0o700 }),
    ),
  );
}

function saveHostManifest(directory: string, manifest: HostManifest): void {
  writeSecureFile(join(directory, "host.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function joinContributor(
  directory: string,
  manifest: HostManifest,
  requestedName: string,
  machineId: string,
): HostContributor {
  const name = requestedName.trim().slice(0, 80) || "Teammate";
  let contributor = manifest.contributors.find((item) => item.machineId === machineId);
  if (!contributor) {
    contributor = {
      id: randomUUID(),
      name,
      machineId,
      token: randomBytes(32).toString("base64url"),
      joinedAt: new Date().toISOString(),
    };
    manifest.contributors.push(contributor);
  } else if (contributor.name !== name) {
    contributor.name = name;
  }
  saveHostManifest(directory, manifest);
  return contributor;
}

async function receivePackage(
  directory: string,
  host: HostManifest,
  request: IncomingMessage,
): Promise<RepositoryPackageManifest> {
  const token = bearerToken(request);
  const contributor = host.contributors.find((item) => item.token === token);
  if (!contributor) throw new HTTPError(401, "Join this Drive before uploading");

  const lines = createInterface({ input: request, crlfDelay: Number.POSITIVE_INFINITY });
  let manifest: RepositoryPackageManifest | undefined;
  let stagingPath = "";
  let staging: Awaited<ReturnType<typeof open>> | undefined;
  const hash = createHash("sha256");
  let count = 0;
  let bytes = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (!manifest) {
        manifest = parsePackageManifest(JSON.parse(line) as unknown);
        if (manifest.driveId !== host.id)
          throw new HTTPError(409, "Package belongs to another Drive");
        if (manifest.contributor.id !== contributor.id) {
          throw new HTTPError(403, "Package contributor does not match this connection");
        }
        stagingPath = join(directory, "staging", `${manifest.packageId}-${randomUUID()}.ndjson`);
        staging = await open(stagingPath, "wx", 0o600);
        await staging.write(`${line}\n`);
        continue;
      }
      const record = parseSyncRecord(JSON.parse(line) as unknown);
      if (!manifest.sessions.some((session) => session.namespacedId === record.session_id)) {
        throw new HTTPError(400, "Package contains a session outside its approved manifest");
      }
      const serialized = `${line}\n`;
      await staging?.write(serialized);
      hash.update(serialized);
      count++;
      bytes += Buffer.byteLength(serialized);
    }
    if (!manifest || !staging || !stagingPath)
      throw new HTTPError(400, "Package manifest is missing");
    await staging.close();
    staging = undefined;
    if (
      count !== manifest.recordCount ||
      bytes !== manifest.recordBytes ||
      hash.digest("hex") !== manifest.recordsSha256
    ) {
      throw new HTTPError(400, "Package record count, size, or hash did not verify");
    }
    const target = join(directory, "packages", `${manifest.packageId}.drive.ndjson`);
    if (!existsSync(target)) await rename(stagingPath, target);
    else await rm(stagingPath, { force: true });
    if (!host.packages.some((item) => item.manifest.packageId === manifest?.packageId)) {
      host.packages.push({ manifest, indexed: false });
      saveHostManifest(directory, host);
    }
    return manifest;
  } catch (error) {
    await staging?.close().catch(() => undefined);
    if (stagingPath) await rm(stagingPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function indexPackage(
  directory: string,
  host: HostManifest,
  packageId: string,
): Promise<void> {
  const hosted = host.packages.find((item) => item.manifest.packageId === packageId);
  if (!hosted || hosted.indexed) return;
  const source = join(directory, "packages", `${packageId}.drive.ndjson`);
  const batch = join(directory, "imports", packageId);
  await mkdir(batch, { recursive: true, mode: 0o700 });
  const output = await open(join(batch, `deja-sync-${packageId}.jsonl`), "w", 0o600);
  let first = true;
  try {
    const lines = createInterface({
      input: createReadStream(source),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      if (first) {
        first = false;
        continue;
      }
      if (line.trim()) await output.write(`${line}\n`);
    }
  } finally {
    await output.close();
  }
  try {
    const environment = hostDejaEnvironment(directory);
    await runDeja(["sync", "import", batch], environment);
    await runDeja(["doctor", "--offline", "--deep", "--json"], environment);
    await runDeja(["stats", "--json"], environment);
    hosted.indexed = true;
    saveHostManifest(directory, host);
  } finally {
    await rm(batch, { recursive: true, force: true });
  }
}

async function searchHost(
  directory: string,
  host: HostManifest,
  query: string,
  repository: string | null,
): Promise<DriveSearchResult[]> {
  if (!host.packages.some((item) => item.indexed)) return [];
  const output = await runDeja(
    ["search", "--json", "--no-embed", "--all", query],
    hostDejaEnvironment(directory),
  );
  const value = JSON.parse(output.stdout) as unknown;
  if (!isRecord(value) || !Array.isArray(value.hits))
    throw new Error("deja-vu returned invalid search results");
  const sidecar = sessionSidecar(host);
  return value.hits.flatMap((raw): DriveSearchResult[] => {
    if (!isRecord(raw) || !isRecord(raw.session)) return [];
    const namespacedId =
      typeof raw.session.orig_id === "string"
        ? raw.session.orig_id
        : typeof raw.session.id === "string"
          ? raw.session.id
          : "";
    const mapped = sidecar.get(namespacedId);
    if (!mapped || (repository && mapped.package.repository.name !== repository)) return [];
    const snippets = Array.isArray(raw.snippets)
      ? raw.snippets.filter((item): item is string => typeof item === "string")
      : [];
    return [toSearchResult(host.id, mapped.package, mapped.session, snippets[0] ?? "", raw.score)];
  });
}

async function readHostEvidence(
  directory: string,
  host: HostManifest,
  resultId: string,
): Promise<DriveEvidence | undefined> {
  const mapped = [...sessionSidecar(host).values()].find(
    (item) => evidenceId(host.id, item.session.namespacedId) === resultId,
  );
  if (!mapped) return undefined;
  const path = join(directory, "packages", `${mapped.package.packageId}.drive.ndjson`);
  const records: DriveEvidence["records"] = [];
  let first = true;
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    if (first) {
      first = false;
      continue;
    }
    if (!line.trim()) continue;
    const record = parseSyncRecord(JSON.parse(line) as unknown);
    if (record.session_id === mapped.session.namespacedId) {
      records.push({ role: record.role, text: record.text, time: record.time });
    }
  }
  const snippet = records.find((record) => record.role === "user")?.text ?? records[0]?.text ?? "";
  return {
    result: toSearchResult(host.id, mapped.package, mapped.session, snippet, 0),
    records,
  };
}

function sessionSidecar(
  host: HostManifest,
): Map<string, { package: RepositoryPackageManifest; session: ApprovedSession }> {
  const sessions = new Map<
    string,
    { package: RepositoryPackageManifest; session: ApprovedSession }
  >();
  for (const hosted of host.packages) {
    for (const session of hosted.manifest.sessions) {
      sessions.set(session.namespacedId, { package: hosted.manifest, session });
    }
  }
  return sessions;
}

function toSearchResult(
  driveId: string,
  manifest: RepositoryPackageManifest,
  session: ApprovedSession,
  snippet: string,
  score: unknown,
): DriveSearchResult {
  return {
    resultId: evidenceId(driveId, session.namespacedId),
    contributor: manifest.contributor.name,
    repository: manifest.repository.name,
    harness: session.harness,
    nativeSessionId: session.nativeId,
    ...(session.title ? { title: session.title } : {}),
    updated: session.updated,
    touched: session.touched,
    snippet,
    score: typeof score === "number" ? score : 0,
  };
}

function evidenceId(driveId: string, namespacedId: string): string {
  return createHash("sha256").update(`${driveId}\0${namespacedId}`).digest("hex").slice(0, 24);
}

function hostStatus(host: HostManifest, dashboard: string): DriveStatus {
  return {
    id: host.id,
    name: host.name,
    protocolVersion: DRIVE_PROTOCOL_VERSION,
    ready: host.packages.length > 0 && host.packages.every((item) => item.indexed),
    contributors: host.contributors.filter((item) => item.machineId !== "host").length,
    packages: host.packages.length,
    sessions: host.packages.reduce((sum, item) => sum + item.manifest.sessions.length, 0),
    records: host.packages.reduce((sum, item) => sum + item.manifest.recordCount, 0),
    dashboard,
  };
}

function hostDejaEnvironment(directory: string): NodeJS.ProcessEnv {
  const sources = join(directory, "sources");
  const empty = (name: string) => join(sources, name);
  return {
    ...process.env,
    DEJA_INDEX_DIR: join(directory, "deja-index"),
    DEJA_CLAUDE_ROOT: empty("claude"),
    DEJA_CODEX_ROOT: empty("codex"),
    DEJA_CURSOR_ROOT: empty("cursor"),
    DEJA_CURSOR_CLI_ROOT: empty("cursor-cli"),
    DEJA_GEMINI_ROOT: empty("gemini"),
    DEJA_AIDER_ROOTS: empty("aider"),
    DEJA_ANTIGRAVITY_ROOT: empty("antigravity"),
    DEJA_GROK_ROOT: empty("grok"),
    DEJA_GROK_DB: empty("grok.db"),
    DEJA_QWEN_ROOT: empty("qwen"),
    DEJA_CLINE_ROOT: empty("cline"),
    DEJA_CLINE_ROOTS: empty("cline"),
    DEJA_COPILOT_ROOT: empty("copilot"),
    DEJA_GOOSE_ROOT: empty("goose"),
    DEJA_GOOSE_DB: empty("goose.db"),
    DEJA_HERMES_HOME: empty("hermes"),
    DEJA_HERMES_DB: empty("hermes.db"),
    DEJA_HERMES_PROFILES_ROOT: empty("hermes-profiles"),
    DEJA_KIMI_ROOT: empty("kimi"),
    DEJA_OPENCLAW_ROOT: empty("openclaw"),
    DEJA_OPENCODE_DB: empty("opencode.db"),
    DEJA_PI_ROOT: empty("pi"),
    DEJA_ROO_CLI_ROOT: empty("roo-cli"),
    DEJA_ROO_ROOTS: empty("roo"),
    DEJA_ZED_ROOT: empty("zed"),
    DEJA_ZED_DB: empty("zed.db"),
    DEJA_NOTES_FILE: empty("notes.jsonl"),
  };
}

function parsePackageManifest(value: unknown): RepositoryPackageManifest {
  if (
    !isRecord(value) ||
    value.kind !== "dosu-drive-package" ||
    value.schemaVersion !== 1 ||
    typeof value.packageId !== "string" ||
    !/^[a-f0-9]{24}$/.test(value.packageId) ||
    typeof value.driveId !== "string" ||
    !isRecord(value.contributor) ||
    typeof value.contributor.id !== "string" ||
    !isRecord(value.repository) ||
    !Array.isArray(value.sessions) ||
    typeof value.recordCount !== "number" ||
    typeof value.recordBytes !== "number" ||
    typeof value.recordsSha256 !== "string"
  ) {
    throw new HTTPError(400, "Invalid Drive Package manifest");
  }
  return value as unknown as RepositoryPackageManifest;
}

function parseSyncRecord(value: unknown): DejaSyncRecord {
  if (
    !isRecord(value) ||
    typeof value.harness !== "string" ||
    typeof value.session_id !== "string" ||
    typeof value.project !== "string" ||
    typeof value.role !== "string" ||
    typeof value.text !== "string" ||
    typeof value.time !== "string"
  ) {
    throw new HTTPError(400, "Invalid Drive Package record");
  }
  return value as unknown as DejaSyncRecord;
}

function parseHostManifest(value: unknown): HostManifest | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.createdAt !== "string" ||
    !Array.isArray(value.contributors) ||
    !Array.isArray(value.packages)
  ) {
    return undefined;
  }
  return value as unknown as HostManifest;
}

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

async function readJSONBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new HTTPError(413, "Request is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HTTPError(400, "Invalid JSON request");
  }
}

function lanAddress(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return "127.0.0.1";
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function html(response: ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function dashboardHTML(name: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHTML(name)}</title><style>body{font:15px system-ui;margin:40px auto;max-width:900px;padding:0 20px;color:#171717}input{width:70%;padding:12px;border:1px solid #ccc;border-radius:8px}button{padding:12px 16px;margin-left:8px;border:0;border-radius:8px;background:#171717;color:white}.result{padding:16px 0;border-bottom:1px solid #ddd}.meta{color:#666;font-size:13px}pre{white-space:pre-wrap}</style></head><body><h1>${escapeHTML(name)}</h1><p id="status">Loading Drive…</p><input id="query" placeholder="Search team sessions"><button id="search">Search</button><main id="results"></main><script>const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));async function status(){const s=await fetch('/api/status').then(r=>r.json());document.querySelector('#status').textContent=s.sessions+' sessions · '+s.records+' records · '+(s.ready?'Ready':'Indexing')}async function search(){const q=document.querySelector('#query').value;const d=await fetch('/api/search?q='+encodeURIComponent(q)).then(r=>r.json());document.querySelector('#results').innerHTML=d.results.map(x=>'<article class="result"><strong>'+esc(x.contributor)+' · '+esc(x.repository)+' · '+esc(x.harness)+'</strong><div class="meta">'+esc(x.updated)+' · '+esc(x.resultId)+'</div><pre>'+esc(x.snippet)+'</pre></article>').join('')||'<p>No results</p>'}document.querySelector('#search').onclick=search;status()</script></body></html>`;
}

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class HTTPError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
