import { mkdir, readdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { StorageBackend, ConfigBundle, VersionInfo, FileEntry } from '../types.js';

interface StoredManifest {
  tool: string;
  version: string;
  timestamp: string;
  message?: string;
  manifest: FileEntry[];
}

export class FileBackend implements StorageBackend {
  constructor(
    private readonly baseDir: string,
    private readonly userId: string,
  ) {}

  private toolDir(tool: string): string {
    return join(this.baseDir, this.userId, tool);
  }

  private validateVersionPath(tool: string, version: string): string {
    const versionDir = join(this.toolDir(tool), version);
    const resolved = resolve(versionDir);
    const expected = resolve(this.toolDir(tool));
    if (!resolved.startsWith(expected + '/') && resolved !== expected) {
      throw new Error(`Invalid version: "${version}"`);
    }
    return versionDir;
  }

  async initialize(): Promise<void> {
    await mkdir(join(this.baseDir, this.userId), { recursive: true });
  }

  async store(bundle: ConfigBundle): Promise<{ version: string }> {
    const version = new Date().toISOString().replace(/[:.]/g, '-');
    const versionDir = join(this.toolDir(bundle.tool), version);
    await mkdir(versionDir, { recursive: true });

    const manifest: StoredManifest = {
      tool: bundle.tool,
      version,
      timestamp: new Date().toISOString(),
      message: bundle.message,
      manifest: bundle.manifest,
    };

    await writeFile(
      join(versionDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    for (const [relativePath, content] of bundle.files) {
      const filePath = join(versionDir, 'files', relativePath);
      await mkdir(join(filePath, '..'), { recursive: true });
      await writeFile(filePath, content);
    }

    return { version };
  }

  async retrieve(tool: string, version?: string): Promise<ConfigBundle> {
    const targetVersion = version ?? await this.latestVersion(tool);
    if (!targetVersion) {
      throw new Error(`No versions found for tool "${tool}"`);
    }

    const versionDir = this.validateVersionPath(tool, targetVersion);
    const manifestRaw = await readFile(join(versionDir, 'manifest.json'), 'utf-8');
    const manifest: StoredManifest = JSON.parse(manifestRaw);

    const files = new Map<string, Buffer>();
    for (const entry of manifest.manifest) {
      const filePath = join(versionDir, 'files', entry.path);
      const content = await readFile(filePath);
      files.set(entry.path, content);
    }

    return {
      tool: manifest.tool,
      version: manifest.version,
      timestamp: manifest.timestamp,
      message: manifest.message,
      manifest: manifest.manifest,
      files,
    };
  }

  async listVersions(tool: string, limit?: number): Promise<VersionInfo[]> {
    const dir = this.toolDir(tool);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }

    const versions: VersionInfo[] = [];
    for (const entry of entries) {
      try {
        const raw = await readFile(join(dir, entry, 'manifest.json'), 'utf-8');
        const manifest: StoredManifest = JSON.parse(raw);
        const totalBytes = manifest.manifest.reduce((sum, f) => sum + f.sizeBytes, 0);
        const aggregateChecksum = createHash('sha256')
          .update(manifest.manifest.map((f) => f.checksum).join(''))
          .digest('hex');

        versions.push({
          version: manifest.version,
          timestamp: manifest.timestamp,
          message: manifest.message,
          fileCount: manifest.manifest.length,
          totalBytes,
          checksum: aggregateChecksum,
        });
      } catch {
        continue;
      }
    }

    versions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return limit ? versions.slice(0, limit) : versions;
  }

  async deleteVersion(tool: string, version: string): Promise<void> {
    const versionDir = this.validateVersionPath(tool, version);
    await rm(versionDir, { recursive: true, force: true });
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    try {
      await access(this.baseDir);
      return { healthy: true };
    } catch {
      return { healthy: false, message: `Storage directory not accessible: ${this.baseDir}` };
    }
  }

  private async latestVersion(tool: string): Promise<string | null> {
    const versions = await this.listVersions(tool, 1);
    return versions.length > 0 ? versions[0].version : null;
  }
}
