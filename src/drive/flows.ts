import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import open from "open";
import { fetchDriveStatus, joinDrive, searchDrive, stopDrive, uploadPackage } from "./client";
import { scanWithDeja } from "./deja";
import { discoverDrives } from "./discovery";
import { createDriveHost, destroyHostedDrive } from "./host";
import { createRepositoryPackage, dejaSessionKey, summarizeDejaExport } from "./package";
import { type PreviewSession, startPreview } from "./preview";
import { dedupeRepositories, matchSessionRepository, repositoryIdentity } from "./repositories";
import { clearActiveDrive, loadDriveState, rememberRepositories, setActiveDrive } from "./state";
import type { DejaSession, DriveConnection, RepositoryIdentity } from "./types";

export async function runDriveHost(options: {
  name?: string;
  port: number;
  bonjour: boolean;
}): Promise<void> {
  const name = options.name?.trim() || `${localUserName()}'s Drive`;
  const host = await createDriveHost({ name, port: options.port, bonjour: options.bonjour });
  p.intro("Dosu Drive");
  p.log.success("Dosu Drive is ready");
  p.note(
    `Name: ${host.name}\nNetwork: Local\nDashboard: ${host.lanUrl}\n\nNearby join:\n  dosu drive join`,
    "Waiting for contributors…",
  );
  await host.wait();
}

export async function runDriveJoin(
  target: string | undefined,
  options: { name?: string; setup: boolean },
): Promise<void> {
  let url = target;
  if (!url) {
    const spinner = p.spinner();
    spinner.start("Looking for Dosu Drives on this network…");
    const drives = await discoverDrives();
    spinner.stop(
      drives.length > 0
        ? `Found ${drives.length} Drive${drives.length === 1 ? "" : "s"}`
        : "No Drives found",
    );
    if (drives.length === 0) {
      throw new Error("No Dosu Drives found. Make sure the Host is running on the same network.");
    }
    const selected = await p.select({
      message: "Available Dosu Drive hosts",
      options: drives.map((drive) => ({ label: drive.name, value: drive.url, hint: drive.host })),
    });
    if (p.isCancel(selected)) {
      p.cancel("Join cancelled");
      return;
    }
    url = selected as string;
  }
  if (!/^https?:\/\//.test(url)) {
    throw new Error("Direct join expects an HTTP(S) Drive URL");
  }
  const connection = await joinDrive(url, options.name?.trim() || localUserName());
  setActiveDrive(connection);
  p.log.success(`Joined ${connection.name}`);
  p.log.info("This Drive is now active on this Mac.");
  if (options.setup) await runDriveSetup({ repositories: [], yes: false, open: true });
}

export async function runDriveSetup(options: {
  repositories: string[];
  yes: boolean;
  open: boolean;
}): Promise<void> {
  const connection = requireActiveDrive();
  if (!connection.token || !connection.contributorId || !connection.contributorName) {
    throw new Error("Run `dosu drive join` before setup");
  }
  const repositories = await selectRepositories(options.repositories);
  if (repositories.length === 0) return;
  rememberRepositories(repositories.map((repository) => repository.root));

  const spinner = p.spinner();
  spinner.start("Scanning supported agent history on this Mac…");
  const workspace = await scanWithDeja();
  try {
    const sessionsByRepository = new Map<string, DejaSession[]>(
      repositories.map((repository) => [repository.root, []]),
    );
    for (const session of workspace.sessions) {
      const repository = matchSessionRepository(session, repositories);
      if (repository) sessionsByRepository.get(repository.root)?.push(session);
    }
    const sessions = [...sessionsByRepository.values()].flat();
    spinner.stop(
      `Found ${sessions.length} project-associated session${sessions.length === 1 ? "" : "s"}`,
    );
    if (sessions.length === 0) {
      throw new Error("No indexed agent sessions matched the selected repositories");
    }

    const harnessCounts = new Map<string, number>();
    for (const session of sessions) {
      harnessCounts.set(session.harness, (harnessCounts.get(session.harness) ?? 0) + 1);
    }
    p.note(
      [...harnessCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([harness, count]) => `${displayHarness(harness).padEnd(14)} ${count} sessions`)
        .join("\n"),
      "Sessions found",
    );
    for (const repository of repositories) {
      const count = sessionsByRepository.get(repository.root)?.length ?? 0;
      p.log.info(
        `Found ${count} sessions associated with ${repository.root}. Only these sessions can be uploaded; other projects are excluded.`,
      );
    }
    p.log.info("Nothing has been uploaded.");

    const exportSummaries = await summarizeDejaExport(workspace.exportDirectory, sessions);
    const repositoryBySession = new Map<string, RepositoryIdentity>();
    for (const repository of repositories) {
      for (const session of sessionsByRepository.get(repository.root) ?? []) {
        repositoryBySession.set(dejaSessionKey(session.harness, session.id), repository);
      }
    }
    const previewSessions: PreviewSession[] = sessions.map((session) => {
      const key = dejaSessionKey(session.harness, session.id);
      const summary = exportSummaries.get(key);
      return {
        key,
        repository: repositoryBySession.get(key)?.name ?? session.project,
        harness: session.harness,
        nativeId: session.id,
        title:
          session.title || `${displayHarness(session.harness)} session ${session.id.slice(0, 8)}`,
        started: session.started,
        updated: session.updated,
        ...(summary?.sample ? { sample: summary.sample } : {}),
        records: summary?.records ?? 0,
        bytes: summary?.bytes ?? 0,
        redactions: summary?.redactions ?? 0,
      };
    });
    const redactions = previewSessions.reduce((sum, session) => sum + session.redactions, 0);
    let approvedKeys: string[];
    if (options.yes) {
      approvedKeys = previewSessions.map((session) => session.key);
    } else {
      p.log.step("Review exactly what will be uploaded");
      p.log.info(
        "Inspect every selected session and exclude anything before it leaves this computer.",
      );
      p.log.info(`Safety check: ${redactions} potential credentials detected and replaced.`);
      const preview = await startPreview(previewSessions);
      try {
        p.log.info(preview.url);
        if (options.open) {
          const shouldOpen = await p.confirm({
            message: "Open the local preview?",
            initialValue: true,
          });
          if (p.isCancel(shouldOpen) || !shouldOpen) {
            p.cancel("Setup cancelled. Nothing was uploaded.");
            return;
          }
          await open(preview.url);
        }
        const approved = await preview.waitForDecision();
        if (!approved) {
          p.cancel("Setup cancelled. Nothing was uploaded.");
          return;
        }
        approvedKeys = approved;
      } finally {
        await preview.close();
      }
    }
    const approved = new Set(approvedKeys);
    if (approved.size === 0) {
      p.cancel("No sessions selected. Nothing was uploaded.");
      return;
    }
    p.log.info(
      "Dosu will not modify or delete any local files. Approved searchable content will be copied after credential redaction.",
    );

    const upload = p.spinner();
    upload.start(`Uploading to ${connection.name} and building the central Drive index…`);
    let uploadedSessions = 0;
    let uploadedRepositories = 0;
    for (const repository of repositories) {
      const repositorySessions = (sessionsByRepository.get(repository.root) ?? []).filter(
        (session) => approved.has(dejaSessionKey(session.harness, session.id)),
      );
      if (repositorySessions.length === 0) continue;
      const repositoryPackage = await createRepositoryPackage({
        exportDirectory: workspace.exportDirectory,
        outputDirectory: join(workspace.root, "packages"),
        driveId: connection.id,
        contributor: { id: connection.contributorId, name: connection.contributorName },
        repository,
        sessions: repositorySessions,
      });
      await uploadPackage(connection, repositoryPackage);
      uploadedSessions += repositorySessions.length;
      uploadedRepositories++;
    }
    upload.stop("Drive index is ready");
    p.outro(
      `Uploaded ${uploadedSessions} sessions from ${uploadedRepositories} repositories to ${connection.name}. You may close this terminal or disconnect from the network.`,
    );
  } finally {
    await workspace.cleanup();
  }
}

export async function runDriveSearch(query: string, repository?: string): Promise<void> {
  const connection = requireActiveDrive();
  const results = await searchDrive(connection, query, repository);
  if (results.length === 0) {
    p.log.info("No Drive results found.");
    return;
  }
  for (const result of results) {
    p.note(
      `${result.snippet}\n\nEvidence: ${result.resultId}${result.touched.length > 0 ? `\nFiles: ${result.touched.join(", ")}` : ""}`,
      `${result.contributor} · ${result.repository} · ${displayHarness(result.harness)} · ${result.updated.slice(0, 10)}`,
    );
  }
}

export async function runDriveStatus(): Promise<void> {
  const connection = requireActiveDrive();
  const status = await fetchDriveStatus(connection);
  p.note(
    `Host: ${connection.url}\nContributors: ${status.contributors}\nRepositories: ${status.packages}\nSessions: ${status.sessions}\nRecords: ${status.records}\nIndex: ${status.ready ? "Ready" : "Waiting"}`,
    status.name,
  );
}

export async function runDriveStop(): Promise<void> {
  const connection = requireActiveDrive();
  await stopDrive(connection);
  p.log.success(`${connection.name} stopped. Its Packages and index remain available for restart.`);
}

export async function runDriveDestroy(options: { yes: boolean }): Promise<void> {
  const connection = requireActiveDrive();
  if (!connection.local) throw new Error("Only the Mac hosting this Drive can destroy it");
  if (!options.yes) {
    const confirmed = await p.confirm({
      message: `Delete ${connection.name}'s Packages and central index?`,
      initialValue: false,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Drive was not deleted");
      return;
    }
  }
  await stopDrive(connection).catch(() => undefined);
  await destroyHostedDrive(connection.id);
  clearActiveDrive();
  p.log.success("Drive data deleted. Local agent session files were not touched.");
}

async function selectRepositories(explicit: string[]): Promise<RepositoryIdentity[]> {
  if (explicit.length > 0) return dedupeRepositories(explicit.map(repositoryIdentity));
  const state = loadDriveState();
  const candidates: RepositoryIdentity[] = [];
  for (const path of [process.cwd(), ...state.recentRepositories]) {
    if (!existsSync(path)) continue;
    try {
      candidates.push(repositoryIdentity(path));
    } catch {
      // Ignore stale recent paths; Browse remains available.
    }
  }
  const repositories = dedupeRepositories(candidates);
  const browse = "__browse__";
  const selected = await p.multiselect({
    message: "Choose repositories to add",
    options: [
      ...repositories.map((repository, index) => ({
        label:
          index === 0 ? `Current repo   ${repository.root}` : `Recent repo    ${repository.root}`,
        value: repository.root,
      })),
      { label: "Browse…", value: browse },
    ],
    initialValues: repositories[0] ? [repositories[0].root] : [],
    required: true,
  });
  if (p.isCancel(selected)) {
    p.cancel("Setup cancelled");
    return [];
  }
  const paths = selected as string[];
  if (paths.includes(browse)) {
    const browsed = await p.text({
      message: "Repository path",
      placeholder: "/Users/you/code/project",
      validate: (value) => {
        try {
          repositoryIdentity(value);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    });
    if (p.isCancel(browsed)) return [];
    paths.push(browsed as string);
  }
  return dedupeRepositories(paths.filter((path) => path !== browse).map(repositoryIdentity));
}

function requireActiveDrive(): DriveConnection {
  const connection = loadDriveState().active;
  if (!connection) throw new Error("No active Drive. Run `dosu drive join` first.");
  return connection;
}

function localUserName(): string {
  try {
    return userInfo().username || "Teammate";
  } catch {
    return process.env.USER || "Teammate";
  }
}

function displayHarness(harness: string): string {
  return harness
    .split(/[-_]/)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
