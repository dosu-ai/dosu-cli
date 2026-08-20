export const DRIVE_STATE_SCHEMA_VERSION = 1 as const;
export const DRIVE_PROTOCOL_VERSION = 1 as const;

export interface DriveConnection {
  id: string;
  name: string;
  url: string;
  protocolVersion: typeof DRIVE_PROTOCOL_VERSION;
  local: boolean;
  contributorId?: string;
  contributorName?: string;
  token?: string;
}

export interface DriveState {
  schemaVersion: typeof DRIVE_STATE_SCHEMA_VERSION;
  active?: DriveConnection;
  recentRepositories: string[];
}

export interface RepositoryIdentity {
  root: string;
  name: string;
  remote?: string;
}

export interface DejaSession {
  id: string;
  harness: string;
  project: string;
  path?: string;
  title?: string;
  started: string;
  updated: string;
  touched?: string[];
}

export interface DejaSyncRecord {
  harness: string;
  session_id: string;
  project: string;
  role: string;
  text: string;
  time: string;
}

export interface ApprovedSession {
  nativeId: string;
  namespacedId: string;
  harness: string;
  project: string;
  title?: string;
  started: string;
  updated: string;
  touched: string[];
}

export interface RepositoryPackageManifest {
  kind: "dosu-drive-package";
  schemaVersion: 1;
  packageId: string;
  createdAt: string;
  driveId: string;
  contributor: { id: string; name: string };
  repository: RepositoryIdentity;
  sessions: ApprovedSession[];
  recordCount: number;
  recordBytes: number;
  recordsSha256: string;
  redactions: { total: number; byKind: Record<string, number> };
}

export interface RepositoryPackage {
  path: string;
  manifest: RepositoryPackageManifest;
}
