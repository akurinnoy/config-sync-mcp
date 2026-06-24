import { join, dirname } from 'node:path';
import { resolveFiles } from '../profiles/resolver.js';
import { computeChecksum } from './checksums.js';
import type { FileAccess } from '../file-access/interface.js';
import type {
  ToolProfile,
  StorageBackend,
  ConfigBundle,
  FileEntry,
  SyncState,
  ResolvedFile,
} from '../types.js';
import { MAX_FILE_SIZE } from '../types.js';

export interface PushResult {
  tool: string;
  version: string;
  filesStored: number;
  bytesStored: number;
  checksum: string;
  warnings: string[];
}

export interface PullResult {
  tool: string;
  version: string;
  filesWritten: number;
  bytesWritten: number;
}

export interface DiffEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  localChecksum?: string;
  storedChecksum?: string;
  sizeChange?: number;
}

export class SyncEngine {
  private syncStates = new Map<string, SyncState>();
  private profileMap: Map<string, ToolProfile>;

  constructor(
    profiles: ToolProfile[],
    private readonly storage: StorageBackend,
    private readonly homeDir: string,
    private readonly fileAccess: FileAccess,
  ) {
    this.profileMap = new Map(profiles.map((p) => [p.tool, p]));
    for (const p of profiles) {
      this.syncStates.set(p.tool, { tool: p.tool });
    }
  }

  async pushConfig(tool: string, message?: string): Promise<PushResult> {
    const profile = this.getProfile(tool);
    const resolved = await resolveFiles(profile, this.homeDir, this.fileAccess);
    const warnings: string[] = [];

    const manifest: FileEntry[] = [];
    const files = new Map<string, Buffer>();

    for (const file of resolved) {
      const content = await this.fileAccess.readFile(file.absolutePath);
      if (content.length > MAX_FILE_SIZE) {
        warnings.push(`${file.relativePath} exceeds ${MAX_FILE_SIZE} byte limit, skipped`);
        continue;
      }
      const checksum = computeChecksum(content);
      const fileStat = await this.fileAccess.stat(file.absolutePath);
      const permissions = (fileStat.mode & 0o777).toString(8).padStart(4, '0');

      manifest.push({
        path: file.relativePath,
        checksum,
        sizeBytes: content.length,
        permissions,
      });
      files.set(file.relativePath, content);
    }

    const bundle: ConfigBundle = {
      tool,
      version: '',
      timestamp: new Date().toISOString(),
      message,
      manifest,
      files,
    };

    const { version } = await this.storage.store(bundle);

    const aggregateChecksum = computeChecksum(
      Buffer.from(manifest.map((f) => f.checksum).join('')),
    );

    this.syncStates.set(tool, {
      tool,
      lastSyncTime: new Date().toISOString(),
      lastSyncDirection: 'push',
      lastManifest: manifest,
    });

    return {
      tool,
      version,
      filesStored: manifest.length,
      bytesStored: manifest.reduce((sum, f) => sum + f.sizeBytes, 0),
      checksum: aggregateChecksum,
      warnings,
    };
  }

  async pullConfig(tool: string, version?: string): Promise<PullResult> {
    this.getProfile(tool);
    const bundle = await this.storage.retrieve(tool, version);

    let bytesWritten = 0;
    for (const [relativePath, content] of bundle.files) {
      const targetPath = join(this.homeDir, relativePath);
      await this.fileAccess.mkdir(dirname(targetPath), { recursive: true });
      await this.fileAccess.writeFile(targetPath, content);
      bytesWritten += content.length;
    }

    this.syncStates.set(tool, {
      tool,
      lastSyncTime: new Date().toISOString(),
      lastSyncDirection: 'pull',
      lastManifest: bundle.manifest,
    });

    return {
      tool,
      version: bundle.version,
      filesWritten: bundle.files.size,
      bytesWritten,
    };
  }

  async diffConfig(tool: string, version?: string): Promise<DiffEntry[]> {
    const profile = this.getProfile(tool);
    const bundle = await this.storage.retrieve(tool, version);

    const storedMap = new Map(bundle.manifest.map((e) => [e.path, e]));
    const localFiles = await resolveFiles(profile, this.homeDir, this.fileAccess);
    const localMap = new Map<string, ResolvedFile>();
    for (const f of localFiles) {
      localMap.set(f.relativePath, f);
    }

    const diffs: DiffEntry[] = [];

    for (const [path, stored] of storedMap) {
      const local = localMap.get(path);
      if (!local) {
        diffs.push({ path, status: 'deleted', storedChecksum: stored.checksum });
        continue;
      }
      const content = await this.fileAccess.readFile(local.absolutePath);
      const localChecksum = computeChecksum(content);
      if (localChecksum !== stored.checksum) {
        diffs.push({
          path,
          status: 'modified',
          localChecksum,
          storedChecksum: stored.checksum,
          sizeChange: content.length - stored.sizeBytes,
        });
      }
    }

    for (const [path, local] of localMap) {
      if (!storedMap.has(path)) {
        const content = await this.fileAccess.readFile(local.absolutePath);
        diffs.push({
          path,
          status: 'added',
          localChecksum: computeChecksum(content),
          sizeChange: content.length,
        });
      }
    }

    return diffs;
  }

  getSyncStatus(tool?: string): SyncState[] {
    if (tool) {
      this.getProfile(tool);
      const state = this.syncStates.get(tool)!;
      return [{ ...state, status: state.lastSyncTime ? 'synced' : 'never_synced' } as any];
    }
    return [...this.syncStates.values()].map((s) => ({
      ...s,
      status: s.lastSyncTime ? 'synced' : 'never_synced',
    })) as any;
  }

  getProfiles(): ToolProfile[] {
    return [...this.profileMap.values()];
  }

  private getProfile(tool: string): ToolProfile {
    const profile = this.profileMap.get(tool);
    if (!profile) {
      throw new Error(`Unknown tool: "${tool}". Available: ${[...this.profileMap.keys()].join(', ')}`);
    }
    return profile;
  }
}
