# K8s Remote File Access — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a `FileAccess` abstraction so SyncEngine can operate on workspace pod filesystems via Kubernetes exec, not just the local disk.

**Architecture:** Strategy pattern with two implementations — `LocalFileAccess` (wraps existing `node:fs` + `fast-glob`) and `KubeFileAccess` (wraps `k8s.Exec`). `SyncEngine` and `resolveFiles` receive `FileAccess` as a dependency. A separate `KubeWorkspaceClient` handles kube config, pod discovery, and raw exec. Mode selected by `FILE_ACCESS_MODE` env var.

**Tech Stack:** `@kubernetes/client-node`, existing `node:fs/promises`, `fast-glob`, `vitest`

## Global Constraints

- ESM with `.js` extensions on all imports (Node16 module resolution)
- Binary-safe: remote readFile/writeFile use base64 encoding
- Shell escaping: all path arguments shell-escaped before interpolation in exec commands
- Exec timeout: 30s default, configurable
- All git commits must use `-s` flag (signoff)
- All existing 34 tests must continue to pass after refactoring
- Spec: `docs/specs/2026-06-23-k8s-remote-file-access-design.md`

---

### Task 1: FileAccess interface, LocalFileAccess, and refactor engine/resolver

Extract the filesystem abstraction from existing code. After this task, everything works exactly as before but through the `FileAccess` interface.

**Files:**
- Create: `src/file-access/interface.ts`
- Create: `src/file-access/local.ts`
- Create: `src/file-access/index.ts`
- Create: `tests/file-access/local.test.ts`
- Modify: `src/types.ts`
- Modify: `src/profiles/resolver.ts`
- Modify: `src/sync/engine.ts`
- Modify: `src/index.ts`
- Modify: `src/server.ts`
- Modify: `tests/sync/engine.test.ts`
- Modify: `tests/profiles/resolver.test.ts`
- Modify: `tests/integration/server.test.ts`

**Interfaces:**
- Consumes: `ToolProfile`, `ResolvedFile` from `src/types.ts`
- Produces: `FileAccess` interface, `FileAccessError` class, `LocalFileAccess` class, `createLocalFileAccess(): FileAccess`

- [ ] **Step 1: Create the FileAccess interface and error type**

Create `src/file-access/interface.ts`:

```typescript
export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mode: number;
  mtimeMs: number;
}

export type FileAccessErrorCode = 'ENOENT' | 'EACCES' | 'EXEC_FAILED' | 'TIMEOUT';

export class FileAccessError extends Error {
  constructor(
    public readonly code: FileAccessErrorCode,
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'FileAccessError';
  }
}

export interface GlobOptions {
  cwd: string;
  dot?: boolean;
  ignore?: string[];
}

export interface FileAccess {
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  stat(path: string): Promise<FileStat>;
  lstat(path: string): Promise<FileStat>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  glob(patterns: string[], opts: GlobOptions): Promise<string[]>;
  realpath(path: string): Promise<string>;
}
```

- [ ] **Step 2: Implement LocalFileAccess**

Create `src/file-access/local.ts`:

```typescript
import {
  readFile,
  writeFile,
  stat as fsStat,
  lstat as fsLstat,
  mkdir,
  realpath,
} from 'node:fs/promises';
import fg from 'fast-glob';
import type { FileAccess, FileStat, GlobOptions } from './interface.js';
import { FileAccessError } from './interface.js';

function toFileStat(s: import('node:fs').Stats): FileStat {
  return {
    isFile: s.isFile(),
    isDirectory: s.isDirectory(),
    isSymbolicLink: s.isSymbolicLink(),
    size: s.size,
    mode: s.mode,
    mtimeMs: s.mtimeMs,
  };
}

function mapError(err: unknown, path: string): never {
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'ENOENT') throw new FileAccessError('ENOENT', path, `File not found: ${path}`);
  if (e.code === 'EACCES') throw new FileAccessError('EACCES', path, `Permission denied: ${path}`);
  throw e;
}

export class LocalFileAccess implements FileAccess {
  async readFile(path: string): Promise<Buffer> {
    try {
      return await readFile(path);
    } catch (err) {
      throw mapError(err, path);
    }
  }

  async writeFile(path: string, content: Buffer): Promise<void> {
    try {
      await writeFile(path, content);
    } catch (err) {
      throw mapError(err, path);
    }
  }

  async stat(path: string): Promise<FileStat> {
    try {
      return toFileStat(await fsStat(path));
    } catch (err) {
      throw mapError(err, path);
    }
  }

  async lstat(path: string): Promise<FileStat> {
    try {
      return toFileStat(await fsLstat(path));
    } catch (err) {
      throw mapError(err, path);
    }
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await mkdir(path, opts);
  }

  async glob(patterns: string[], opts: GlobOptions): Promise<string[]> {
    return fg(patterns, {
      cwd: opts.cwd,
      dot: opts.dot ?? true,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: opts.ignore ?? [],
      absolute: false,
    });
  }

  async realpath(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch (err) {
      throw mapError(err, path);
    }
  }
}
```

- [ ] **Step 3: Create barrel export**

Create `src/file-access/index.ts`:

```typescript
export { FileAccess, FileStat, FileAccessError, FileAccessErrorCode, GlobOptions } from './interface.js';
export { LocalFileAccess } from './local.js';
```

- [ ] **Step 4: Write tests for LocalFileAccess**

Create `tests/file-access/local.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { LocalFileAccess } from '../../src/file-access/local.js';
import { FileAccessError } from '../../src/file-access/interface.js';

const TMP = join(import.meta.dirname, '..', '.tmp-file-access');
let fa: LocalFileAccess;

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  fa = new LocalFileAccess();
});
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe('LocalFileAccess', () => {
  it('reads and writes files', async () => {
    const path = join(TMP, 'test.txt');
    await fa.writeFile(path, Buffer.from('hello'));
    const content = await fa.readFile(path);
    expect(content.toString()).toBe('hello');
  });

  it('stats files', async () => {
    const path = join(TMP, 'test.txt');
    writeFileSync(path, 'hello');
    const s = await fa.stat(path);
    expect(s.isFile).toBe(true);
    expect(s.isDirectory).toBe(false);
    expect(s.size).toBe(5);
  });

  it('lstats detects symlinks', async () => {
    const target = join(TMP, 'target');
    const link = join(TMP, 'link');
    writeFileSync(target, 'content');
    symlinkSync(target, link);
    const s = await fa.lstat(link);
    expect(s.isSymbolicLink).toBe(true);
  });

  it('creates directories recursively', async () => {
    const dir = join(TMP, 'a', 'b', 'c');
    await fa.mkdir(dir, { recursive: true });
    const s = await fa.stat(dir);
    expect(s.isDirectory).toBe(true);
  });

  it('globs files', async () => {
    mkdirSync(join(TMP, 'sub'), { recursive: true });
    writeFileSync(join(TMP, 'sub', 'a.txt'), 'a');
    writeFileSync(join(TMP, 'sub', 'b.log'), 'b');
    const files = await fa.glob(['sub/*.txt'], { cwd: TMP });
    expect(files).toEqual(['sub/a.txt']);
  });

  it('globs with ignore', async () => {
    writeFileSync(join(TMP, 'keep.txt'), 'k');
    writeFileSync(join(TMP, 'skip.log'), 's');
    const files = await fa.glob(['*'], { cwd: TMP, ignore: ['*.log'] });
    expect(files).toContain('keep.txt');
    expect(files).not.toContain('skip.log');
  });

  it('resolves realpath', async () => {
    const target = join(TMP, 'real');
    const link = join(TMP, 'sym');
    writeFileSync(target, 'x');
    symlinkSync(target, link);
    const resolved = await fa.realpath(link);
    expect(resolved).toBe(target);
  });

  it('throws FileAccessError for missing file', async () => {
    await expect(fa.readFile(join(TMP, 'nope'))).rejects.toThrow(FileAccessError);
    await expect(fa.readFile(join(TMP, 'nope'))).rejects.toHaveProperty('code', 'ENOENT');
  });
});
```

- [ ] **Step 5: Run LocalFileAccess tests to verify they pass**

Run: `npx vitest run tests/file-access/local.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 6: Refactor resolver.ts to accept FileAccess**

Replace the contents of `src/profiles/resolver.ts`:

```typescript
import { resolve } from 'node:path';
import type { FileAccess } from '../file-access/interface.js';
import type { ToolProfile, ResolvedFile } from '../types.js';

export async function resolveFiles(
  profile: ToolProfile,
  homeDir: string,
  fileAccess: FileAccess,
): Promise<ResolvedFile[]> {
  const syncPatterns = profile.paths.sync.map((p) => p.replace(/^~\//, ''));
  const skipPatterns = profile.paths.skip.map((p) => p.replace(/^~\//, ''));
  const sensitivePatterns = profile.paths.sensitive.map((p) => p.replace(/^~\//, ''));

  const allIgnore = [...skipPatterns, ...sensitivePatterns];

  const matched = await fileAccess.glob(syncPatterns, {
    cwd: homeDir,
    dot: true,
    ignore: allIgnore,
  });

  const resolved: ResolvedFile[] = [];

  for (const rel of matched) {
    const abs = resolve(homeDir, rel);

    const s = await fileAccess.lstat(abs);
    if (s.isSymbolicLink) {
      const target = await fileAccess.realpath(abs);
      if (!target.startsWith(homeDir)) {
        continue;
      }
    }

    resolved.push({ absolutePath: abs, relativePath: rel });
  }

  return resolved;
}
```

- [ ] **Step 7: Refactor engine.ts to accept FileAccess**

Replace the constructor and update all methods in `src/sync/engine.ts`. The key changes:
- Constructor takes `FileAccess` instead of `homeDir`
- `homeDir` is still needed as a string for path resolution — pass both
- Replace `readFile()`, `writeFile()`, `stat()`, `mkdir()` calls with `this.fileAccess.*`
- Replace `resolveFiles(profile, this.homeDir)` with `resolveFiles(profile, this.homeDir, this.fileAccess)`

Full replacement of `src/sync/engine.ts`:

```typescript
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
```

- [ ] **Step 8: Update index.ts to create and inject LocalFileAccess**

Replace `src/index.ts`:

```typescript
#!/usr/bin/env node

import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadProfiles } from './profiles/loader.js';
import { FileBackend } from './storage/file-backend.js';
import { SyncEngine } from './sync/engine.js';
import { LocalFileAccess } from './file-access/local.js';
import { startHttpServer, shutdownHttpServer } from './server.js';
import { DEFAULT_PORT } from './types.js';

async function main(): Promise<void> {
  const port = parseInt(process.env.CONFIG_SYNC_PORT ?? String(DEFAULT_PORT), 10);
  const storageDir = process.env.CONFIG_SYNC_STORAGE_DIR ?? join(homedir(), '.config-sync-storage');
  const profilesDir = process.env.CONFIG_SYNC_PROFILES_DIR ?? join(import.meta.dirname, '..', 'profiles');
  const userId = process.env.CONFIG_SYNC_USER_ID ?? process.env.CHE_USER_ID ?? 'default';
  const home = homedir();

  console.log(`Loading profiles from ${profilesDir}`);
  const profiles = await loadProfiles(profilesDir);
  console.log(`Loaded ${profiles.length} profiles: ${profiles.map((p) => p.tool).join(', ')}`);

  const storage = new FileBackend(storageDir, userId);
  await storage.initialize();

  const fileAccess = new LocalFileAccess();
  const engine = new SyncEngine(profiles, storage, home, fileAccess);

  const server = await startHttpServer(port, engine, storage);
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`config-sync-mcp listening on port ${actualPort}`);

  const shutdown = async () => {
    console.log('Shutting down...');
    await shutdownHttpServer(server);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Failed to start config-sync-mcp:', error);
  process.exit(1);
});
```

- [ ] **Step 9: Update existing tests**

Update `tests/sync/engine.test.ts` — add `LocalFileAccess` to the `SyncEngine` constructor:

Change the import and `beforeEach`:
```typescript
import { LocalFileAccess } from '../../src/file-access/local.js';
// ... existing imports ...

beforeEach(async () => {
  mkdirSync(HOME, { recursive: true });
  mkdirSync(STORAGE, { recursive: true });
  const backend = new FileBackend(STORAGE, 'test-user');
  await backend.initialize();
  const fileAccess = new LocalFileAccess();
  engine = new SyncEngine([gitProfile], backend, HOME, fileAccess);
});
```

Also update the "detects added files in diff" test that creates a second engine:
```typescript
    const engine2 = new SyncEngine([profile], backend, HOME, new LocalFileAccess());
```

Update `tests/profiles/resolver.test.ts` — pass `LocalFileAccess` to `resolveFiles`:

Change the import:
```typescript
import { LocalFileAccess } from '../../src/file-access/local.js';
```

Change every `resolveFiles(...)` call to include the third argument:
```typescript
const files = await resolveFiles(makeProfile(), TMP_HOME, new LocalFileAccess());
```

Update `tests/integration/server.test.ts` — add `LocalFileAccess` to `SyncEngine` constructor:

Change the import and `beforeAll`:
```typescript
import { LocalFileAccess } from '../../src/file-access/local.js';
// ... existing imports ...

// In beforeAll, change the engine creation:
  const engine = new SyncEngine(profiles, backend, HOME, new LocalFileAccess());
```

- [ ] **Step 10: Run all tests to verify backward compatibility**

Run: `npx vitest run`
Expected: All tests PASS (34 existing + 8 new = 42 total)

- [ ] **Step 11: Commit**

```bash
git add src/file-access/ tests/file-access/ src/profiles/resolver.ts src/sync/engine.ts src/index.ts tests/
git commit -s -m "feat: introduce FileAccess interface, LocalFileAccess, refactor engine/resolver"
```

---

### Task 2: KubeWorkspaceClient

Implement the Kubernetes client layer for pod discovery and exec. Tested with mocked `@kubernetes/client-node`.

**Files:**
- Create: `src/k8s/client.ts`
- Create: `tests/k8s/client.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing from prior tasks (independent k8s layer)
- Produces: `KubeWorkspaceClient` class with `initialize(): Promise<void>`, `findWorkspacePod(workspace: string): Promise<{ podName: string; containerName: string }>`, `exec(podName: string, containerName: string, command: string[]): Promise<ExecResult>`

- [ ] **Step 1: Add @kubernetes/client-node dependency**

Run: `npm install @kubernetes/client-node`

Verify it installs without errors.

- [ ] **Step 2: Write failing test for KubeWorkspaceClient**

Create `tests/k8s/client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KubeWorkspaceClient } from '../../src/k8s/client.js';

vi.mock('@kubernetes/client-node', () => {
  const mockCoreV1Api = {
    listNamespacedPod: vi.fn(),
  };

  const mockKubeConfig = {
    loadFromDefault: vi.fn(),
    makeApiClient: vi.fn().mockReturnValue(mockCoreV1Api),
    getCurrentContext: vi.fn().mockReturnValue('test-context'),
    getContextObject: vi.fn().mockReturnValue({ namespace: 'test-ns' }),
  };

  return {
    KubeConfig: vi.fn().mockImplementation(() => mockKubeConfig),
    CoreV1Api: vi.fn(),
    Exec: vi.fn(),
    __mockKubeConfig: mockKubeConfig,
    __mockCoreV1Api: mockCoreV1Api,
  };
});

describe('KubeWorkspaceClient', () => {
  let client: KubeWorkspaceClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = new KubeWorkspaceClient();
    await client.initialize();
  });

  it('initializes from kubeconfig', async () => {
    const k8s = await import('@kubernetes/client-node');
    expect((k8s as any).__mockKubeConfig.loadFromDefault).toHaveBeenCalled();
  });

  it('finds workspace pod by name', async () => {
    const k8s = await import('@kubernetes/client-node');
    (k8s as any).__mockCoreV1Api.listNamespacedPod.mockResolvedValue({
      items: [
        {
          metadata: { name: 'ws-pod-abc' },
          status: { phase: 'Running' },
          spec: {
            containers: [
              { name: 'che-gateway' },
              { name: 'dev' },
            ],
          },
        },
      ],
    });

    const result = await client.findWorkspacePod('my-workspace');
    expect(result.podName).toBe('ws-pod-abc');
    expect(result.containerName).toBe('dev');
  });

  it('throws when no running pod found', async () => {
    const k8s = await import('@kubernetes/client-node');
    (k8s as any).__mockCoreV1Api.listNamespacedPod.mockResolvedValue({
      items: [
        {
          metadata: { name: 'ws-pod-abc' },
          status: { phase: 'Stopped' },
          spec: { containers: [{ name: 'dev' }] },
        },
      ],
    });

    await expect(client.findWorkspacePod('my-workspace')).rejects.toThrow('No running pod');
  });

  it('throws when no pods found at all', async () => {
    const k8s = await import('@kubernetes/client-node');
    (k8s as any).__mockCoreV1Api.listNamespacedPod.mockResolvedValue({
      items: [],
    });

    await expect(client.findWorkspacePod('ghost')).rejects.toThrow('No running pod');
  });

  it('skips che-gateway container', async () => {
    const k8s = await import('@kubernetes/client-node');
    (k8s as any).__mockCoreV1Api.listNamespacedPod.mockResolvedValue({
      items: [
        {
          metadata: { name: 'ws-pod' },
          status: { phase: 'Running' },
          spec: {
            containers: [
              { name: 'che-gateway' },
              { name: 'tooling' },
            ],
          },
        },
      ],
    });

    const result = await client.findWorkspacePod('ws');
    expect(result.containerName).toBe('tooling');
  });

  it('returns namespace', () => {
    expect(client.getNamespace()).toBe('test-ns');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/k8s/client.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement KubeWorkspaceClient**

Create `src/k8s/client.ts`:

```typescript
import * as k8s from '@kubernetes/client-node';
import { readFileSync } from 'node:fs';
import stream from 'node:stream';

const SA_NAMESPACE_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/namespace';
const CHE_GATEWAY_CONTAINER = 'che-gateway';
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

export interface ExecResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

export class KubeWorkspaceClient {
  private kubeConfig!: k8s.KubeConfig;
  private coreV1Api!: k8s.CoreV1Api;
  private namespace = '';
  private execTimeoutMs: number;

  constructor(opts?: { execTimeoutMs?: number }) {
    this.execTimeoutMs = opts?.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  }

  async initialize(): Promise<void> {
    this.kubeConfig = new k8s.KubeConfig();
    this.kubeConfig.loadFromDefault();
    this.coreV1Api = this.kubeConfig.makeApiClient(k8s.CoreV1Api);

    this.namespace =
      process.env.POD_NAMESPACE ??
      process.env.CHE_MCP_NAMESPACE ??
      '';

    if (!this.namespace) {
      try {
        this.namespace = readFileSync(SA_NAMESPACE_PATH, 'utf-8').trim();
      } catch {
        // not in-cluster
      }
    }

    if (!this.namespace) {
      const ctx = this.kubeConfig.getContextObject(this.kubeConfig.getCurrentContext());
      this.namespace = ctx?.namespace ?? '';
    }

    if (!this.namespace) {
      throw new Error('Cannot determine namespace. Set POD_NAMESPACE env var.');
    }
  }

  getNamespace(): string {
    return this.namespace;
  }

  async findWorkspacePod(workspace: string): Promise<{
    podName: string;
    containerName: string;
  }> {
    const response = await this.coreV1Api.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `controller.devfile.io/devworkspace_name=${workspace}`,
    });

    const items = (response as any).items ?? response.items ?? [];
    const runningPod = items.find(
      (p: any) => p.status?.phase === 'Running',
    );

    if (!runningPod) {
      throw new Error(
        `No running pod found for workspace "${workspace}" in namespace "${this.namespace}"`,
      );
    }

    const containers: string[] = (runningPod.spec?.containers ?? []).map(
      (c: any) => c.name,
    );
    const devContainer = containers.find((n) => n !== CHE_GATEWAY_CONTAINER);

    if (!devContainer) {
      throw new Error(`No dev container found in pod for workspace "${workspace}"`);
    }

    return {
      podName: runningPod.metadata!.name!,
      containerName: devContainer,
    };
  }

  async exec(
    podName: string,
    containerName: string,
    command: string[],
    stdin?: Buffer,
  ): Promise<ExecResult> {
    const kubeExec = new k8s.Exec(this.kubeConfig);
    const stdoutChunks: Buffer[] = [];
    let stderr = '';

    const stdoutStream = new stream.PassThrough();
    const stderrStream = new stream.PassThrough();

    stdoutStream.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    stderrStream.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    let stdinStream: stream.Readable | null = null;
    if (stdin) {
      stdinStream = new stream.PassThrough();
      stdinStream.end(stdin);
    }

    return new Promise<ExecResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Exec timed out after ${this.execTimeoutMs}ms`));
      }, this.execTimeoutMs);

      kubeExec
        .exec(
          this.namespace,
          podName,
          containerName,
          ['bash', '-lc', command.join(' ')],
          stdoutStream,
          stderrStream,
          stdinStream,
          false,
          (status) => {
            clearTimeout(timer);
            const exitCode =
              status.status === 'Success'
                ? 0
                : parseInt(
                    status.details?.causes?.find(
                      (c: any) => c.reason === 'ExitCode',
                    )?.message ?? '1',
                    10,
                  );
            resolve({
              stdout: Buffer.concat(stdoutChunks),
              stderr,
              exitCode,
            });
          },
        )
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }
}
```

- [ ] **Step 5: Run KubeWorkspaceClient tests**

Run: `npx vitest run tests/k8s/client.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS (42 + 6 = 48 total)

- [ ] **Step 7: Commit**

```bash
git add src/k8s/ tests/k8s/ package.json package-lock.json
git commit -s -m "feat: add KubeWorkspaceClient for pod discovery and exec"
```

---

### Task 3: KubeFileAccess and mode selection

Implement the remote `FileAccess` using `KubeWorkspaceClient` exec, and wire up mode selection in the entrypoint.

**Files:**
- Create: `src/file-access/remote.ts`
- Create: `tests/file-access/remote.test.ts`
- Modify: `src/file-access/index.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `FileAccess` interface from `src/file-access/interface.ts`, `KubeWorkspaceClient` and `ExecResult` from `src/k8s/client.ts`
- Produces: `KubeFileAccess` class implementing `FileAccess`, updated entrypoint with `FILE_ACCESS_MODE` env var

- [ ] **Step 1: Write failing test for KubeFileAccess**

Create `tests/file-access/remote.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KubeFileAccess } from '../../src/file-access/remote.js';
import type { KubeWorkspaceClient, ExecResult } from '../../src/k8s/client.js';

function mockClient(execFn: (...args: any[]) => Promise<ExecResult>): KubeWorkspaceClient {
  return { exec: execFn } as any;
}

function ok(stdout: string | Buffer): ExecResult {
  return {
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
    stderr: '',
    exitCode: 0,
  };
}

function fail(stderr: string, exitCode = 1): ExecResult {
  return { stdout: Buffer.alloc(0), stderr, exitCode };
}

describe('KubeFileAccess', () => {
  const POD = 'ws-pod';
  const CONTAINER = 'dev';

  it('reads file via base64 exec', async () => {
    const content = Buffer.from('hello world');
    const b64 = content.toString('base64');
    const exec = vi.fn().mockResolvedValue(ok(b64 + '\n'));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    const result = await fa.readFile('/home/user/.gitconfig');
    expect(result.toString()).toBe('hello world');
    expect(exec).toHaveBeenCalledWith(
      POD, CONTAINER,
      expect.arrayContaining([expect.stringContaining('base64')]),
      undefined,
    );
  });

  it('writes file via base64 stdin', async () => {
    const exec = vi.fn().mockResolvedValue(ok(''));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    await fa.writeFile('/home/user/.gitconfig', Buffer.from('content'));
    expect(exec).toHaveBeenCalledWith(
      POD, CONTAINER,
      expect.any(Array),
      expect.any(Buffer),
    );
  });

  it('stats file', async () => {
    const exec = vi.fn().mockResolvedValue(ok('regular file 1719100000\n'));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    const s = await fa.stat('/home/user/.gitconfig');
    expect(s.isFile).toBe(true);
    expect(s.isDirectory).toBe(false);
    expect(s.mtimeMs).toBe(1719100000000);
  });

  it('stats directory', async () => {
    const exec = vi.fn().mockResolvedValue(ok('directory 1719100000\n'));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    const s = await fa.stat('/home/user/.claude');
    expect(s.isFile).toBe(false);
    expect(s.isDirectory).toBe(true);
  });

  it('lstats symlink', async () => {
    const exec = vi.fn().mockResolvedValue(ok('symbolic link 1719100000\n'));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    const s = await fa.lstat('/home/user/link');
    expect(s.isSymbolicLink).toBe(true);
    expect(s.isFile).toBe(false);
  });

  it('creates directory', async () => {
    const exec = vi.fn().mockResolvedValue(ok(''));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    await fa.mkdir('/home/user/.claude/hooks', { recursive: true });
    expect(exec).toHaveBeenCalledWith(
      POD, CONTAINER,
      expect.arrayContaining([expect.stringContaining('mkdir -p')]),
      undefined,
    );
  });

  it('resolves realpath', async () => {
    const exec = vi.fn().mockResolvedValue(ok('/home/user/actual\n'));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    const result = await fa.realpath('/home/user/link');
    expect(result).toBe('/home/user/actual');
  });

  it('globs files', async () => {
    const exec = vi.fn().mockResolvedValue(ok('.gitconfig\n.gitignore_global\n'));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    const files = await fa.glob(['.git*'], { cwd: '/home/user' });
    expect(files).toEqual(['.gitconfig', '.gitignore_global']);
  });

  it('returns empty array for no glob matches', async () => {
    const exec = vi.fn().mockResolvedValue(ok(''));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    const files = await fa.glob(['*.nonexistent'], { cwd: '/home/user' });
    expect(files).toEqual([]);
  });

  it('throws FileAccessError on exec failure', async () => {
    const exec = vi.fn().mockResolvedValue(fail('No such file or directory', 1));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    await expect(fa.readFile('/nope')).rejects.toThrow('ENOENT');
  });

  it('handles binary content correctly', async () => {
    const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47]);
    const b64 = binary.toString('base64');
    const exec = vi.fn().mockResolvedValue(ok(b64 + '\n'));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    const result = await fa.readFile('/home/user/binary.dat');
    expect(Buffer.compare(result, binary)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/file-access/remote.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement KubeFileAccess**

Create `src/file-access/remote.ts`:

```typescript
import type { KubeWorkspaceClient } from '../k8s/client.js';
import type { FileAccess, FileStat, GlobOptions } from './interface.js';
import { FileAccessError } from './interface.js';

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function parseExecError(stderr: string, path: string): FileAccessError {
  if (stderr.includes('No such file or directory')) {
    return new FileAccessError('ENOENT', path, `File not found: ${path}`);
  }
  if (stderr.includes('Permission denied')) {
    return new FileAccessError('EACCES', path, `Permission denied: ${path}`);
  }
  return new FileAccessError('EXEC_FAILED', path, `Exec failed for ${path}: ${stderr}`);
}

function parseStatType(typeStr: string): { isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean } {
  const t = typeStr.trim().toLowerCase();
  return {
    isFile: t === 'regular file' || t === 'regular empty file',
    isDirectory: t === 'directory',
    isSymbolicLink: t === 'symbolic link',
  };
}

export class KubeFileAccess implements FileAccess {
  constructor(
    private readonly client: KubeWorkspaceClient,
    private readonly podName: string,
    private readonly containerName: string,
  ) {}

  async readFile(path: string): Promise<Buffer> {
    const result = await this.client.exec(
      this.podName,
      this.containerName,
      [`base64 ${shellEscape(path)}`],
      undefined,
    );
    if (result.exitCode !== 0) throw parseExecError(result.stderr, path);
    return Buffer.from(result.stdout.toString().trim(), 'base64');
  }

  async writeFile(path: string, content: Buffer): Promise<void> {
    const b64 = content.toString('base64');
    const result = await this.client.exec(
      this.podName,
      this.containerName,
      [`echo ${shellEscape(b64)} | base64 -d > ${shellEscape(path)}`],
      undefined,
    );
    if (result.exitCode !== 0) throw parseExecError(result.stderr, path);
  }

  async stat(path: string): Promise<FileStat> {
    return this.statImpl(path, false);
  }

  async lstat(path: string): Promise<FileStat> {
    return this.statImpl(path, true);
  }

  private async statImpl(path: string, noFollow: boolean): Promise<FileStat> {
    // stat without -L: reports the symlink itself (lstat behavior)
    // stat -L: follows symlinks (stat behavior)
    const flag = noFollow ? '' : '-L';
    const sizeCmd = `stat ${flag} -c '%F %Y %s %a' ${shellEscape(path)}`;

    const result = await this.client.exec(
      this.podName,
      this.containerName,
      [sizeCmd],
      undefined,
    );
    if (result.exitCode !== 0) throw parseExecError(result.stderr, path);

    const output = result.stdout.toString().trim();
    const lastSpaceIdx3 = output.lastIndexOf(' ');
    const modeStr = output.slice(lastSpaceIdx3 + 1);
    const rest1 = output.slice(0, lastSpaceIdx3);

    const lastSpaceIdx2 = rest1.lastIndexOf(' ');
    const sizeStr = rest1.slice(lastSpaceIdx2 + 1);
    const rest2 = rest1.slice(0, lastSpaceIdx2);

    const lastSpaceIdx1 = rest2.lastIndexOf(' ');
    const mtimeStr = rest2.slice(lastSpaceIdx1 + 1);
    const typeStr = rest2.slice(0, lastSpaceIdx1);

    const types = parseStatType(typeStr);
    return {
      ...types,
      size: parseInt(sizeStr, 10),
      mode: parseInt(modeStr, 8),
      mtimeMs: parseInt(mtimeStr, 10) * 1000,
    };
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const flag = opts?.recursive ? '-p' : '';
    const result = await this.client.exec(
      this.podName,
      this.containerName,
      [`mkdir ${flag} ${shellEscape(path)}`],
      undefined,
    );
    if (result.exitCode !== 0) throw parseExecError(result.stderr, path);
  }

  async glob(patterns: string[], opts: GlobOptions): Promise<string[]> {
    if (patterns.length === 0) return [];

    const escapedPatterns = patterns.map(shellEscape).join(' ');
    const ignoreFilter = opts.ignore?.length
      ? ` | grep -v -E '(${opts.ignore.map((p) => p.replace(/\*/g, '.*').replace(/\?/g, '.')).join('|')})'`
      : '';

    const cmd = [
      `cd ${shellEscape(opts.cwd)} &&`,
      `shopt -s globstar nullglob${opts.dot !== false ? ' dotglob' : ''};`,
      `for f in ${escapedPatterns}; do`,
      `[ -f "$f" ] && echo "$f";`,
      `done`,
      `| sort`,
      ignoreFilter,
    ].join(' ');

    const result = await this.client.exec(
      this.podName,
      this.containerName,
      [cmd],
      undefined,
    );
    if (result.exitCode !== 0 && result.stderr.trim()) {
      throw parseExecError(result.stderr, opts.cwd);
    }

    const output = result.stdout.toString().trim();
    if (!output) return [];
    return output.split('\n').filter(Boolean);
  }

  async realpath(path: string): Promise<string> {
    const result = await this.client.exec(
      this.podName,
      this.containerName,
      [`realpath ${shellEscape(path)}`],
      undefined,
    );
    if (result.exitCode !== 0) throw parseExecError(result.stderr, path);
    return result.stdout.toString().trim();
  }
}
```

- [ ] **Step 4: Update barrel export**

Update `src/file-access/index.ts`:

```typescript
export { FileAccess, FileStat, FileAccessError, FileAccessErrorCode, GlobOptions } from './interface.js';
export { LocalFileAccess } from './local.js';
export { KubeFileAccess } from './remote.js';
```

- [ ] **Step 5: Run remote tests**

Run: `npx vitest run tests/file-access/remote.test.ts`
Expected: All 11 tests PASS

- [ ] **Step 6: Update index.ts with mode selection**

Replace `src/index.ts`:

```typescript
#!/usr/bin/env node

import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadProfiles } from './profiles/loader.js';
import { FileBackend } from './storage/file-backend.js';
import { SyncEngine } from './sync/engine.js';
import { LocalFileAccess } from './file-access/local.js';
import { startHttpServer, shutdownHttpServer } from './server.js';
import { DEFAULT_PORT } from './types.js';
import type { FileAccess } from './file-access/interface.js';

async function main(): Promise<void> {
  const port = parseInt(process.env.CONFIG_SYNC_PORT ?? String(DEFAULT_PORT), 10);
  const storageDir = process.env.CONFIG_SYNC_STORAGE_DIR ?? join(homedir(), '.config-sync-storage');
  const profilesDir = process.env.CONFIG_SYNC_PROFILES_DIR ?? join(import.meta.dirname, '..', 'profiles');
  const userId = process.env.CONFIG_SYNC_USER_ID ?? process.env.CHE_USER_ID ?? 'default';
  const mode = process.env.FILE_ACCESS_MODE ?? 'local';
  const home = process.env.WORKSPACE_HOME_DIR ?? homedir();

  console.log(`Loading profiles from ${profilesDir}`);
  const profiles = await loadProfiles(profilesDir);
  console.log(`Loaded ${profiles.length} profiles: ${profiles.map((p) => p.tool).join(', ')}`);

  const storage = new FileBackend(storageDir, userId);
  await storage.initialize();

  let fileAccess: FileAccess;

  if (mode === 'remote') {
    const { KubeWorkspaceClient } = await import('./k8s/client.js');
    const { KubeFileAccess } = await import('./file-access/remote.js');

    const kubeClient = new KubeWorkspaceClient();
    await kubeClient.initialize();
    console.log(`Kube client initialized in namespace: ${kubeClient.getNamespace()}`);

    const workspace = process.env.TARGET_WORKSPACE;
    if (!workspace) {
      throw new Error('TARGET_WORKSPACE env var required in remote mode');
    }

    const { podName, containerName } = await kubeClient.findWorkspacePod(workspace);
    console.log(`Connected to workspace "${workspace}" pod: ${podName}/${containerName}`);

    fileAccess = new KubeFileAccess(kubeClient, podName, containerName);
  } else {
    fileAccess = new LocalFileAccess();
  }

  console.log(`File access mode: ${mode}`);
  const engine = new SyncEngine(profiles, storage, home, fileAccess);

  const server = await startHttpServer(port, engine, storage);
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`config-sync-mcp listening on port ${actualPort}`);

  const shutdown = async () => {
    console.log('Shutting down...');
    await shutdownHttpServer(server);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Failed to start config-sync-mcp:', error);
  process.exit(1);
});
```

- [ ] **Step 7: Build and run all tests**

Run: `npm run build && npx vitest run`
Expected: Build succeeds, all tests PASS (42 + 6 + 11 = 59 total)

- [ ] **Step 8: Commit**

```bash
git add src/file-access/remote.ts src/file-access/index.ts tests/file-access/remote.test.ts src/index.ts
git commit -s -m "feat: add KubeFileAccess remote implementation and mode selection"
```
