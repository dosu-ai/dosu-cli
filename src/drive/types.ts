export const DRIVE_STATE_SCHEMA_VERSION = 1 as const;
export const DRIVE_PROTOCOL_VERSION = 1 as const;

export interface DriveConnection {
  id: string;
  name: string;
  url: string;
  protocolVersion: typeof DRIVE_PROTOCOL_VERSION;
  local: boolean;
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
