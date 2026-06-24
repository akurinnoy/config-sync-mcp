export interface FileEntry {
  path: string;
  checksum: string;
  sizeBytes: number;
  permissions?: string;
}

export interface ConfigBundle {
  tool: string;
  version: string;
  timestamp: string;
  message?: string;
  manifest: FileEntry[];
  files: Map<string, Buffer>;
}

export interface VersionInfo {
  version: string;
  timestamp: string;
  message?: string;
  fileCount: number;
  totalBytes: number;
  checksum: string;
}

export interface StorageBackend {
  initialize(): Promise<void>;
  store(bundle: ConfigBundle): Promise<{ version: string }>;
  retrieve(tool: string, version?: string): Promise<ConfigBundle>;
  listVersions(tool: string, limit?: number): Promise<VersionInfo[]>;
  deleteVersion(tool: string, version: string): Promise<void>;
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;
}

export interface ToolProfile {
  tool: string;
  name: string;
  paths: {
    sync: string[];
    skip: string[];
    sensitive: string[];
  };
}

export interface ResolvedFile {
  absolutePath: string;
  relativePath: string;
}

export interface SyncState {
  tool: string;
  lastSyncTime?: string;
  lastSyncDirection?: 'push' | 'pull';
  lastManifest?: FileEntry[];
}

export const MAX_FILE_SIZE = 1_048_576; // 1 MB
export const DEFAULT_PORT = 8089;
export const DEFAULT_VERSIONS_LIMIT = 20;
