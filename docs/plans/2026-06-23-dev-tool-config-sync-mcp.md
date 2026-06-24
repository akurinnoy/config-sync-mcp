# Dev Tool Config Sync MCP Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tool-agnostic MCP server that syncs dev tool configurations to/from a storage backend, with versioning and rollback support.

**Architecture:** Sidecar MCP server exposing 7 tools over streamable HTTP on port 8089. Declarative YAML profiles define per-tool sync rules. A pluggable storage backend interface with a file-based prototype implementation. The sync engine collects files by glob, computes SHA-256 checksums, and stores immutable versioned snapshots.

**Tech Stack:** TypeScript, Node.js 24, ESM (`"type": "module"`, Node16 module resolution), `@modelcontextprotocol/sdk` ^1.27.1, `zod`, `yaml`, `fast-glob`, `vitest`

## Global Constraints

- All imports use `.js` extension (ESM with Node16 resolution): `import { foo } from './bar.js'`
- Tool names use `snake_case` in MCP registration
- All paths in profiles are relative to `$HOME` and start with `~/`
- Storage key: `{userId}/{tool}/{version}` — never workspace-scoped
- Port 8089 (avoids collision with che-mcp-server on 8080)
- Max file size: 1 MB per file
- Follow che-mcp-server patterns exactly: `McpServer` class, `server.tool()` registration, `StreamableHTTPServerTransport`, native `node:http`
- Spec: `docs/specs/2026-06-23-dev-tool-config-sync-mcp-design.md`

---

### Task 1: Project scaffolding, types, and profile system

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/types.ts`
- Create: `src/profiles/loader.ts`
- Create: `src/profiles/resolver.ts`
- Create: `profiles/claude-code.yaml`
- Create: `profiles/gemini-cli.yaml`
- Create: `profiles/git.yaml`
- Create: `tests/profiles/loader.test.ts`
- Create: `tests/profiles/resolver.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: `ToolProfile` type, `FileEntry` type, `ConfigBundle` type, `VersionInfo` type, `StorageBackend` interface, `loadProfiles(dir: string): Promise<ToolProfile[]>`, `resolveFiles(profile: ToolProfile, homeDir: string): Promise<ResolvedFile[]>`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "config-sync-mcp",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": {
    "node": ">=24"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.1",
    "fast-glob": "^3.3.3",
    "yaml": "^2.7.1",
    "zod": "^3.25.67"
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create src/types.ts with all shared interfaces**

```typescript
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
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated

- [ ] **Step 5: Verify build compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Write failing test for profile loader**

Create `tests/profiles/loader.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadProfiles } from '../../src/profiles/loader.js';

const TMP = join(import.meta.dirname, '..', '.tmp-profiles');

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe('loadProfiles', () => {
  it('loads a valid YAML profile', async () => {
    writeFileSync(join(TMP, 'git.yaml'), `
tool: git
name: Git
paths:
  sync:
    - "~/.gitconfig"
  skip: []
  sensitive: []
`);
    const profiles = await loadProfiles(TMP);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].tool).toBe('git');
    expect(profiles[0].name).toBe('Git');
    expect(profiles[0].paths.sync).toEqual(['~/.gitconfig']);
  });

  it('rejects profile with invalid tool name', async () => {
    writeFileSync(join(TMP, 'bad.yaml'), `
tool: INVALID_NAME
name: Bad
paths:
  sync:
    - "~/.foo"
  skip: []
  sensitive: []
`);
    await expect(loadProfiles(TMP)).rejects.toThrow();
  });

  it('rejects profile with empty sync paths', async () => {
    writeFileSync(join(TMP, 'empty.yaml'), `
tool: empty
name: Empty
paths:
  sync: []
  skip: []
  sensitive: []
`);
    await expect(loadProfiles(TMP)).rejects.toThrow();
  });

  it('rejects paths not starting with ~/', async () => {
    writeFileSync(join(TMP, 'abs.yaml'), `
tool: abs
name: Absolute
paths:
  sync:
    - "/etc/passwd"
  skip: []
  sensitive: []
`);
    await expect(loadProfiles(TMP)).rejects.toThrow();
  });

  it('loads multiple profiles from directory', async () => {
    writeFileSync(join(TMP, 'git.yaml'), `
tool: git
name: Git
paths:
  sync: ["~/.gitconfig"]
  skip: []
  sensitive: []
`);
    writeFileSync(join(TMP, 'vim.yaml'), `
tool: vim
name: Vim
paths:
  sync: ["~/.vimrc"]
  skip: []
  sensitive: []
`);
    const profiles = await loadProfiles(TMP);
    expect(profiles).toHaveLength(2);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run tests/profiles/loader.test.ts`
Expected: FAIL — module `../../src/profiles/loader.js` not found

- [ ] **Step 8: Implement profile loader**

Create `src/profiles/loader.ts`:

```typescript
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ToolProfile } from '../types.js';

const homePrefixPattern = /^~\//;

const profileSchema = z.object({
  tool: z.string().regex(/^[a-z][a-z0-9-]*$/, 'tool must match ^[a-z][a-z0-9-]*$'),
  name: z.string().min(1),
  paths: z.object({
    sync: z
      .array(z.string().refine((p) => homePrefixPattern.test(p), 'paths must start with ~/'))
      .min(1, 'sync must have at least one entry'),
    skip: z.array(z.string()),
    sensitive: z.array(z.string()),
  }),
});

export async function loadProfiles(dir: string): Promise<ToolProfile[]> {
  const entries = await readdir(dir);
  const yamlFiles = entries.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

  const profiles: ToolProfile[] = [];

  for (const file of yamlFiles) {
    const content = await readFile(join(dir, file), 'utf-8');
    const raw = parseYaml(content);
    const parsed = profileSchema.parse(raw);
    profiles.push(parsed);
  }

  return profiles;
}
```

- [ ] **Step 9: Run loader tests**

Run: `npx vitest run tests/profiles/loader.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 10: Write failing test for profile resolver**

Create `tests/profiles/resolver.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolveFiles } from '../../src/profiles/resolver.js';
import type { ToolProfile } from '../../src/types.js';

const TMP_HOME = join(import.meta.dirname, '..', '.tmp-home');

beforeEach(() => {
  mkdirSync(join(TMP_HOME, '.config', 'tool'), { recursive: true });
});
afterEach(() => rmSync(TMP_HOME, { recursive: true, force: true }));

const makeProfile = (overrides: Partial<ToolProfile['paths']> = {}): ToolProfile => ({
  tool: 'test-tool',
  name: 'Test',
  paths: {
    sync: ['~/.config/tool/*'],
    skip: [],
    sensitive: [],
    ...overrides,
  },
});

describe('resolveFiles', () => {
  it('resolves glob patterns against home directory', async () => {
    writeFileSync(join(TMP_HOME, '.config', 'tool', 'settings.json'), '{}');
    const files = await resolveFiles(makeProfile(), TMP_HOME);
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe('.config/tool/settings.json');
  });

  it('excludes files matching skip patterns', async () => {
    writeFileSync(join(TMP_HOME, '.config', 'tool', 'settings.json'), '{}');
    writeFileSync(join(TMP_HOME, '.config', 'tool', 'debug.log'), 'log');
    const files = await resolveFiles(
      makeProfile({ skip: ['**/*.log'] }),
      TMP_HOME,
    );
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe('.config/tool/settings.json');
  });

  it('excludes files matching sensitive patterns', async () => {
    writeFileSync(join(TMP_HOME, '.config', 'tool', 'settings.json'), '{}');
    writeFileSync(join(TMP_HOME, '.config', 'tool', 'credentials.json'), '{}');
    const files = await resolveFiles(
      makeProfile({ sensitive: ['**/*credentials*'] }),
      TMP_HOME,
    );
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe('.config/tool/settings.json');
  });

  it('rejects symlinks pointing outside home', async () => {
    symlinkSync('/etc/passwd', join(TMP_HOME, '.config', 'tool', 'bad-link'));
    const files = await resolveFiles(makeProfile(), TMP_HOME);
    const paths = files.map((f) => f.relativePath);
    expect(paths).not.toContain('.config/tool/bad-link');
  });

  it('returns empty array when no files match', async () => {
    const files = await resolveFiles(
      makeProfile({ sync: ['~/.nonexistent/*'] }),
      TMP_HOME,
    );
    expect(files).toEqual([]);
  });
});
```

- [ ] **Step 11: Run resolver test to verify it fails**

Run: `npx vitest run tests/profiles/resolver.test.ts`
Expected: FAIL — module not found

- [ ] **Step 12: Implement profile resolver**

Create `src/profiles/resolver.ts`:

```typescript
import { realpath, lstat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import fg from 'fast-glob';
import type { ToolProfile, ResolvedFile } from '../types.js';

export async function resolveFiles(
  profile: ToolProfile,
  homeDir: string,
): Promise<ResolvedFile[]> {
  const syncPatterns = profile.paths.sync.map((p) =>
    p.replace(/^~\//, ''),
  );
  const skipPatterns = profile.paths.skip.map((p) =>
    p.replace(/^~\//, ''),
  );
  const sensitivePatterns = profile.paths.sensitive.map((p) =>
    p.replace(/^~\//, ''),
  );

  const allIgnore = [...skipPatterns, ...sensitivePatterns];

  const matched = await fg(syncPatterns, {
    cwd: homeDir,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: allIgnore,
    absolute: false,
  });

  const resolved: ResolvedFile[] = [];

  for (const rel of matched) {
    const abs = resolve(homeDir, rel);

    const stat = await lstat(abs);
    if (stat.isSymbolicLink()) {
      const target = await realpath(abs);
      if (!target.startsWith(homeDir)) {
        continue;
      }
    }

    resolved.push({ absolutePath: abs, relativePath: rel });
  }

  return resolved;
}
```

- [ ] **Step 13: Run resolver tests**

Run: `npx vitest run tests/profiles/resolver.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 14: Create built-in YAML profiles**

Create `profiles/claude-code.yaml`:
```yaml
tool: claude-code
name: Claude Code
paths:
  sync:
    - "~/.claude/settings.json"
    - "~/.claude/settings.local.json"
    - "~/.claude/CLAUDE.md"
    - "~/.claude/agents/**"
    - "~/.claude/hooks/**"
    - "~/.claude/plugins/**"
    - "~/.claude.json"
  skip:
    - "~/.claude/plugins/cache/**"
  sensitive:
    - "**/*credentials*"
    - "**/*token*"
    - "**/*.key"
```

Create `profiles/gemini-cli.yaml`:
```yaml
tool: gemini-cli
name: Gemini CLI
paths:
  sync:
    - "~/.gemini/settings.json"
    - "~/.gemini/GEMINI.md"
  skip:
    - "~/.gemini/cache/**"
    - "~/.gemini/history/**"
  sensitive:
    - "**/*credentials*"
    - "**/*token*"
    - "**/*.key"
```

Create `profiles/git.yaml`:
```yaml
tool: git
name: Git
paths:
  sync:
    - "~/.gitconfig"
    - "~/.gitignore_global"
  skip: []
  sensitive: []
```

- [ ] **Step 15: Run all tests and commit**

Run: `npx vitest run`
Expected: All tests PASS

```bash
git add package.json tsconfig.json src/types.ts src/profiles/ profiles/ tests/
git commit -s -m "feat: project scaffolding, types, and profile system"
```

---

### Task 2: File-based storage backend

**Files:**
- Create: `src/storage/backend.ts`
- Create: `src/storage/file-backend.ts`
- Create: `tests/storage/file-backend.test.ts`

**Interfaces:**
- Consumes: `StorageBackend`, `ConfigBundle`, `VersionInfo`, `FileEntry` from `src/types.ts`
- Produces: `FileBackend` class implementing `StorageBackend`, `createFileBackend(baseDir: string, userId: string): FileBackend`

- [ ] **Step 1: Write failing test for file backend**

Create `tests/storage/file-backend.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FileBackend } from '../../src/storage/file-backend.js';
import type { ConfigBundle } from '../../src/types.js';

const TMP = join(import.meta.dirname, '..', '.tmp-storage');
const USER_ID = 'test-user';

let backend: FileBackend;

beforeEach(async () => {
  mkdirSync(TMP, { recursive: true });
  backend = new FileBackend(TMP, USER_ID);
  await backend.initialize();
});

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

function makeBundle(tool: string, content: string, message?: string): ConfigBundle {
  return {
    tool,
    version: '',
    timestamp: new Date().toISOString(),
    message,
    manifest: [
      {
        path: '.gitconfig',
        checksum: 'abc123',
        sizeBytes: Buffer.byteLength(content),
      },
    ],
    files: new Map([['.gitconfig', Buffer.from(content)]]),
  };
}

describe('FileBackend', () => {
  it('stores and retrieves a bundle', async () => {
    const bundle = makeBundle('git', '[user]\n  name = Test');
    const { version } = await backend.store(bundle);
    expect(version).toBeTruthy();

    const retrieved = await backend.retrieve('git', version);
    expect(retrieved.tool).toBe('git');
    expect(retrieved.manifest).toHaveLength(1);
    expect(retrieved.files.get('.gitconfig')?.toString()).toBe('[user]\n  name = Test');
  });

  it('retrieves latest version when version is omitted', async () => {
    await backend.store(makeBundle('git', 'v1'));
    await new Promise((r) => setTimeout(r, 10));
    await backend.store(makeBundle('git', 'v2'));

    const retrieved = await backend.retrieve('git');
    expect(retrieved.files.get('.gitconfig')?.toString()).toBe('v2');
  });

  it('lists versions in reverse chronological order', async () => {
    await backend.store(makeBundle('git', 'v1', 'first'));
    await new Promise((r) => setTimeout(r, 10));
    await backend.store(makeBundle('git', 'v2', 'second'));

    const versions = await backend.listVersions('git');
    expect(versions).toHaveLength(2);
    expect(versions[0].message).toBe('second');
    expect(versions[1].message).toBe('first');
  });

  it('respects limit on listVersions', async () => {
    await backend.store(makeBundle('git', 'v1'));
    await new Promise((r) => setTimeout(r, 10));
    await backend.store(makeBundle('git', 'v2'));

    const versions = await backend.listVersions('git', 1);
    expect(versions).toHaveLength(1);
  });

  it('deletes a version', async () => {
    const { version } = await backend.store(makeBundle('git', 'v1'));
    await backend.deleteVersion('git', version);

    const versions = await backend.listVersions('git');
    expect(versions).toHaveLength(0);
  });

  it('throws when retrieving nonexistent tool', async () => {
    await expect(backend.retrieve('nonexistent')).rejects.toThrow();
  });

  it('healthCheck returns healthy', async () => {
    const health = await backend.healthCheck();
    expect(health.healthy).toBe(true);
  });

  it('preserves file permissions in manifest', async () => {
    const bundle = makeBundle('git', 'content');
    bundle.manifest[0].permissions = '0600';
    const { version } = await backend.store(bundle);

    const retrieved = await backend.retrieve('git', version);
    expect(retrieved.manifest[0].permissions).toBe('0600');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storage/file-backend.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create storage backend re-export**

Create `src/storage/backend.ts`:

```typescript
export type { StorageBackend } from '../types.js';
```

- [ ] **Step 4: Implement FileBackend**

Create `src/storage/file-backend.ts`:

```typescript
import { mkdir, readdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
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

    const versionDir = join(this.toolDir(tool), targetVersion);
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
    const versionDir = join(this.toolDir(tool), version);
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
```

- [ ] **Step 5: Run storage tests**

Run: `npx vitest run tests/storage/file-backend.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 6: Run all tests and commit**

Run: `npx vitest run`
Expected: All tests PASS

```bash
git add src/storage/ tests/storage/
git commit -s -m "feat: file-based storage backend with versioning"
```

---

### Task 3: Sync engine and checksums

**Files:**
- Create: `src/sync/checksums.ts`
- Create: `src/sync/engine.ts`
- Create: `tests/sync/checksums.test.ts`
- Create: `tests/sync/engine.test.ts`

**Interfaces:**
- Consumes: `ToolProfile`, `ResolvedFile`, `FileEntry`, `ConfigBundle`, `StorageBackend`, `SyncState`, `MAX_FILE_SIZE` from `src/types.ts`; `resolveFiles()` from `src/profiles/resolver.ts`
- Produces: `computeChecksum(content: Buffer): string`, `SyncEngine` class with `pushConfig(tool: string, message?: string): Promise<PushResult>`, `pullConfig(tool: string, version?: string): Promise<PullResult>`, `diffConfig(tool: string, version?: string): Promise<DiffEntry[]>`, `getSyncStatus(tool?: string): SyncState[]`

- [ ] **Step 1: Write failing test for checksums**

Create `tests/sync/checksums.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeChecksum } from '../../src/sync/checksums.js';

describe('computeChecksum', () => {
  it('returns SHA-256 hex digest', () => {
    const result = computeChecksum(Buffer.from('hello'));
    expect(result).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('returns different checksums for different content', () => {
    const a = computeChecksum(Buffer.from('hello'));
    const b = computeChecksum(Buffer.from('world'));
    expect(a).not.toBe(b);
  });

  it('is deterministic', () => {
    const a = computeChecksum(Buffer.from('test'));
    const b = computeChecksum(Buffer.from('test'));
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sync/checksums.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement checksums**

Create `src/sync/checksums.ts`:

```typescript
import { createHash } from 'node:crypto';

export function computeChecksum(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
```

- [ ] **Step 4: Run checksums tests**

Run: `npx vitest run tests/sync/checksums.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Write failing test for sync engine**

Create `tests/sync/engine.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SyncEngine } from '../../src/sync/engine.js';
import { FileBackend } from '../../src/storage/file-backend.js';
import type { ToolProfile } from '../../src/types.js';

const TMP = join(import.meta.dirname, '..', '.tmp-sync');
const HOME = join(TMP, 'home');
const STORAGE = join(TMP, 'storage');

const gitProfile: ToolProfile = {
  tool: 'git',
  name: 'Git',
  paths: {
    sync: ['~/.gitconfig'],
    skip: [],
    sensitive: [],
  },
};

let engine: SyncEngine;

beforeEach(async () => {
  mkdirSync(HOME, { recursive: true });
  mkdirSync(STORAGE, { recursive: true });
  const backend = new FileBackend(STORAGE, 'test-user');
  await backend.initialize();
  engine = new SyncEngine([gitProfile], backend, HOME);
});

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe('SyncEngine', () => {
  it('pushes config to storage', async () => {
    writeFileSync(join(HOME, '.gitconfig'), '[user]\n  name = Test');
    const result = await engine.pushConfig('git', 'initial push');
    expect(result.tool).toBe('git');
    expect(result.filesStored).toBe(1);
    expect(result.version).toBeTruthy();
  });

  it('pulls config from storage', async () => {
    writeFileSync(join(HOME, '.gitconfig'), '[user]\n  name = Test');
    await engine.pushConfig('git');

    rmSync(join(HOME, '.gitconfig'));
    expect(existsSync(join(HOME, '.gitconfig'))).toBe(false);

    const result = await engine.pullConfig('git');
    expect(result.filesWritten).toBe(1);
    expect(readFileSync(join(HOME, '.gitconfig'), 'utf-8')).toBe('[user]\n  name = Test');
  });

  it('diffs local vs stored config', async () => {
    writeFileSync(join(HOME, '.gitconfig'), 'v1');
    await engine.pushConfig('git');

    writeFileSync(join(HOME, '.gitconfig'), 'v2');
    const diffs = await engine.diffConfig('git');
    expect(diffs).toHaveLength(1);
    expect(diffs[0].status).toBe('modified');
    expect(diffs[0].path).toBe('.gitconfig');
  });

  it('detects deleted files in diff', async () => {
    writeFileSync(join(HOME, '.gitconfig'), 'content');
    await engine.pushConfig('git');
    rmSync(join(HOME, '.gitconfig'));

    const diffs = await engine.diffConfig('git');
    expect(diffs).toHaveLength(1);
    expect(diffs[0].status).toBe('deleted');
  });

  it('detects added files in diff', async () => {
    writeFileSync(join(HOME, '.gitconfig'), 'content');
    await engine.pushConfig('git');
    writeFileSync(join(HOME, '.gitconfig'), 'content');
    writeFileSync(join(HOME, '.gitconfig_extra'), 'extra');

    const profile: ToolProfile = {
      ...gitProfile,
      paths: { ...gitProfile.paths, sync: ['~/.gitconfig', '~/.gitconfig_extra'] },
    };
    const backend = new FileBackend(STORAGE, 'test-user');
    await backend.initialize();
    const engine2 = new SyncEngine([profile], backend, HOME);

    const diffs = await engine2.diffConfig('git');
    const added = diffs.find((d) => d.status === 'added');
    expect(added).toBeTruthy();
    expect(added!.path).toBe('.gitconfig_extra');
  });

  it('reports sync status as never_synced initially', () => {
    const status = engine.getSyncStatus('git');
    expect(status).toHaveLength(1);
    expect(status[0].status).toBe('never_synced');
  });

  it('reports sync status as synced after push', async () => {
    writeFileSync(join(HOME, '.gitconfig'), 'content');
    await engine.pushConfig('git');
    const status = engine.getSyncStatus('git');
    expect(status[0].status).toBe('synced');
    expect(status[0].lastSyncDirection).toBe('push');
  });

  it('throws for unknown tool', async () => {
    await expect(engine.pushConfig('unknown')).rejects.toThrow();
  });

  it('skips files exceeding size limit', async () => {
    const bigContent = Buffer.alloc(1_048_577, 'x');
    writeFileSync(join(HOME, '.gitconfig'), bigContent);
    const result = await engine.pushConfig('git');
    expect(result.filesStored).toBe(0);
    expect(result.warnings).toContain(expect.stringContaining('exceeds'));
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run tests/sync/engine.test.ts`
Expected: FAIL — module not found

- [ ] **Step 7: Implement sync engine**

Create `src/sync/engine.ts`:

```typescript
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { resolveFiles } from '../profiles/resolver.js';
import { computeChecksum } from './checksums.js';
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
  ) {
    this.profileMap = new Map(profiles.map((p) => [p.tool, p]));
    for (const p of profiles) {
      this.syncStates.set(p.tool, { tool: p.tool });
    }
  }

  async pushConfig(tool: string, message?: string): Promise<PushResult> {
    const profile = this.getProfile(tool);
    const resolved = await resolveFiles(profile, this.homeDir);
    const warnings: string[] = [];

    const manifest: FileEntry[] = [];
    const files = new Map<string, Buffer>();

    for (const file of resolved) {
      const content = await readFile(file.absolutePath);
      if (content.length > MAX_FILE_SIZE) {
        warnings.push(`${file.relativePath} exceeds ${MAX_FILE_SIZE} byte limit, skipped`);
        continue;
      }
      const checksum = computeChecksum(content);
      const fileStat = await stat(file.absolutePath);
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
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, content);
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
    const localFiles = await resolveFiles(profile, this.homeDir);
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
      const content = await readFile(local.absolutePath);
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
        const content = await readFile(local.absolutePath);
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

- [ ] **Step 8: Run sync engine tests**

Run: `npx vitest run tests/sync/engine.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 9: Run all tests and commit**

Run: `npx vitest run`
Expected: All tests PASS

```bash
git add src/sync/ tests/sync/
git commit -s -m "feat: sync engine with checksums, push, pull, and diff"
```

---

### Task 4: HTTP server, MCP tools, Dockerfile, and integration

**Files:**
- Create: `src/server.ts`
- Create: `src/index.ts`
- Create: `src/tools/list-tools.ts`
- Create: `src/tools/get-sync-status.ts`
- Create: `src/tools/sync-from-storage.ts`
- Create: `src/tools/sync-to-storage.ts`
- Create: `src/tools/diff-config.ts`
- Create: `src/tools/list-config-versions.ts`
- Create: `src/tools/rollback-config.ts`
- Create: `Dockerfile`
- Create: `tests/integration/server.test.ts`

**Interfaces:**
- Consumes: `SyncEngine` from `src/sync/engine.ts`; `loadProfiles()` from `src/profiles/loader.ts`; `FileBackend` from `src/storage/file-backend.ts`; all types from `src/types.ts`
- Produces: HTTP server on port 8089 with `/healthz` and `/mcp` endpoints, 7 MCP tools

- [ ] **Step 1: Implement the MCP tool handler modules**

Create `src/tools/list-tools.ts`:

```typescript
import type { SyncEngine } from '../sync/engine.js';

export function handleListTools(engine: SyncEngine) {
  const profiles = engine.getProfiles();
  const statuses = engine.getSyncStatus();
  const statusMap = new Map(statuses.map((s) => [s.tool, s]));

  return {
    tools: profiles.map((p) => ({
      tool: p.tool,
      name: p.name,
      syncPathCount: p.paths.sync.length,
      skipPathCount: p.paths.skip.length,
      lastSync: statusMap.get(p.tool)?.lastSyncTime,
      status: statusMap.get(p.tool)?.lastSyncTime ? 'synced' : 'never_synced',
    })),
  };
}
```

Create `src/tools/get-sync-status.ts`:

```typescript
import type { SyncEngine } from '../sync/engine.js';

export function handleGetSyncStatus(engine: SyncEngine, tool?: string) {
  const statuses = engine.getSyncStatus(tool);
  return {
    tools: statuses.map((s) => ({
      tool: s.tool,
      lastSyncTime: s.lastSyncTime,
      lastSyncDirection: s.lastSyncDirection,
      pendingChanges: 0,
      status: (s as any).status ?? (s.lastSyncTime ? 'synced' : 'never_synced'),
    })),
  };
}
```

Create `src/tools/sync-to-storage.ts`:

```typescript
import type { SyncEngine } from '../sync/engine.js';

export async function handleSyncToStorage(
  engine: SyncEngine,
  tool?: string,
  message?: string,
) {
  const profiles = tool ? [tool] : engine.getProfiles().map((p) => p.tool);
  const pushed: any[] = [];
  const warnings: string[] = [];

  for (const t of profiles) {
    try {
      const result = await engine.pushConfig(t, message);
      pushed.push({
        tool: result.tool,
        version: result.version,
        filesStored: result.filesStored,
        bytesStored: result.bytesStored,
        checksum: result.checksum,
      });
      warnings.push(...result.warnings);
    } catch (err) {
      warnings.push(`${t}: ${(err as Error).message}`);
    }
  }

  return { pushed, warnings };
}
```

Create `src/tools/sync-from-storage.ts`:

```typescript
import type { SyncEngine } from '../sync/engine.js';

export async function handleSyncFromStorage(engine: SyncEngine, tool?: string) {
  const profiles = tool ? [tool] : engine.getProfiles().map((p) => p.tool);
  const synced: any[] = [];
  const warnings: string[] = [];

  for (const t of profiles) {
    try {
      const result = await engine.pullConfig(t);
      synced.push({
        tool: result.tool,
        filesWritten: result.filesWritten,
        bytesWritten: result.bytesWritten,
        version: result.version,
      });
    } catch (err) {
      warnings.push(`${t}: ${(err as Error).message}`);
    }
  }

  return { synced, warnings };
}
```

Create `src/tools/diff-config.ts`:

```typescript
import type { SyncEngine } from '../sync/engine.js';

export async function handleDiffConfig(engine: SyncEngine, tool: string, version?: string) {
  const diffs = await engine.diffConfig(tool, version);
  return { diffs };
}
```

Create `src/tools/list-config-versions.ts`:

```typescript
import type { StorageBackend } from '../types.js';
import { DEFAULT_VERSIONS_LIMIT } from '../types.js';

export async function handleListConfigVersions(
  storage: StorageBackend,
  tool: string,
  limit?: number,
) {
  const versions = await storage.listVersions(tool, limit ?? DEFAULT_VERSIONS_LIMIT);
  return { versions };
}
```

Create `src/tools/rollback-config.ts`:

```typescript
import type { SyncEngine } from '../sync/engine.js';

export async function handleRollbackConfig(engine: SyncEngine, tool: string, version: string) {
  const result = await engine.pullConfig(tool, version);
  return {
    restored: {
      tool: result.tool,
      version: result.version,
      filesWritten: result.filesWritten,
      bytesWritten: result.bytesWritten,
    },
  };
}
```

- [ ] **Step 2: Implement the HTTP server with MCP tool registration**

Create `src/server.ts`:

```typescript
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { SyncEngine } from './sync/engine.js';
import type { StorageBackend } from './types.js';
import { handleListTools } from './tools/list-tools.js';
import { handleGetSyncStatus } from './tools/get-sync-status.js';
import { handleSyncToStorage } from './tools/sync-to-storage.js';
import { handleSyncFromStorage } from './tools/sync-from-storage.js';
import { handleDiffConfig } from './tools/diff-config.js';
import { handleListConfigVersions } from './tools/list-config-versions.js';
import { handleRollbackConfig } from './tools/rollback-config.js';

const transports = new Map<string, StreamableHTTPServerTransport>();

function createMcpServer(engine: SyncEngine, storage: StorageBackend): McpServer {
  const server = new McpServer({
    name: 'config-sync-mcp',
    version: '0.1.0',
  });

  server.tool(
    'list_tools',
    'List all registered tool profiles and their sync status',
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const result = handleListTools(engine);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'get_sync_status',
    'Check last sync time and pending changes for all tools or a specific tool',
    { tool: z.string().optional().describe('Tool name (omit for all tools)') },
    { readOnlyHint: true },
    async ({ tool }) => {
      try {
        const result = handleGetSyncStatus(engine, tool);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'sync_to_storage',
    'Push current workspace config to storage backend for all tools or a specific tool',
    {
      tool: z.string().optional().describe('Tool name (omit for all tools)'),
      message: z.string().optional().describe('Version label'),
    },
    {},
    async ({ tool, message }) => {
      try {
        const result = await handleSyncToStorage(engine, tool, message);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'sync_from_storage',
    'Pull latest config from storage backend into the workspace for all tools or a specific tool',
    { tool: z.string().optional().describe('Tool name (omit for all tools)') },
    {},
    async ({ tool }) => {
      try {
        const result = await handleSyncFromStorage(engine, tool);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'diff_config',
    'Show differences between local and stored config for a tool',
    {
      tool: z.string().describe('Tool name'),
      version: z.string().optional().describe('Version to diff against (omit for latest)'),
    },
    { readOnlyHint: true },
    async ({ tool, version }) => {
      try {
        const result = await handleDiffConfig(engine, tool, version);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'list_config_versions',
    'List available config snapshots/versions for a tool',
    {
      tool: z.string().describe('Tool name'),
      limit: z.number().int().min(1).max(100).optional().describe('Max versions to return (default: 20)'),
    },
    { readOnlyHint: true },
    async ({ tool, limit }) => {
      try {
        const result = await handleListConfigVersions(storage, tool, limit);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.tool(
    'rollback_config',
    'Restore config from a previous version for a tool',
    {
      tool: z.string().describe('Tool name'),
      version: z.string().describe('Version to restore'),
    },
    { destructiveHint: true },
    async ({ tool, version }) => {
      try {
        const result = await handleRollbackConfig(engine, tool, version);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  return server;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function normalizeToolCallArguments(body: unknown): void {
  const messages = Array.isArray(body) ? body : [body];
  for (const msg of messages) {
    if (
      msg &&
      typeof msg === 'object' &&
      'method' in msg &&
      (msg as any).method === 'tools/call' &&
      'params' in msg &&
      (msg as any).params &&
      (msg as any).params.arguments === null
    ) {
      (msg as any).params.arguments = {};
    }
  }
}

export async function startHttpServer(
  port: number,
  engine: SyncEngine,
  storage: StorageBackend,
): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (url.pathname === '/healthz' && req.method === 'GET') {
      const health = await storage.healthCheck();
      res.writeHead(health.healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
      return;
    }

    if (url.pathname === '/mcp') {
      if (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE') {
        await handleMcpRequest(req, res, engine, storage);
      } else {
        res.writeHead(405).end('Method Not Allowed');
      }
      return;
    }

    res.writeHead(404).end('Not Found');
  });

  return new Promise((resolve, reject) => {
    server.listen(port, () => resolve(server));
    server.on('error', reject);
  });
}

async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  engine: SyncEngine,
  storage: StorageBackend,
): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  let parsedBody: unknown;
  if (req.method === 'POST') {
    const body = await readBody(req);
    try {
      parsedBody = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }
    normalizeToolCallArguments(parsedBody);
  }

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res, parsedBody);
    return;
  }

  if (req.method === 'POST' && !sessionId && isInitializeRequest(parsedBody)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) transports.delete(sid);
    };

    const mcpServer = createMcpServer(engine, storage);
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Session not found. Please re-initialize.' },
    id: null,
  }));
}

export async function shutdownHttpServer(server: http.Server): Promise<void> {
  for (const [sid, transport] of transports) {
    await transport.close();
    transports.delete(sid);
  }
  return new Promise((resolve) => server.close(() => resolve()));
}
```

- [ ] **Step 3: Implement the entrypoint**

Create `src/index.ts`:

```typescript
#!/usr/bin/env node

import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadProfiles } from './profiles/loader.js';
import { FileBackend } from './storage/file-backend.js';
import { SyncEngine } from './sync/engine.js';
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

  const engine = new SyncEngine(profiles, storage, home);

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

- [ ] **Step 4: Write integration test**

Create `tests/integration/server.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import { SyncEngine } from '../../src/sync/engine.js';
import { FileBackend } from '../../src/storage/file-backend.js';
import { loadProfiles } from '../../src/profiles/loader.js';
import { startHttpServer, shutdownHttpServer } from '../../src/server.js';

const TMP = join(import.meta.dirname, '..', '.tmp-integration');
const HOME = join(TMP, 'home');
const STORAGE = join(TMP, 'storage');
const PROFILES = join(TMP, 'profiles');

let server: http.Server;
let port: number;

function jsonRpc(method: string, params: any, id: number = 1) {
  return JSON.stringify({ jsonrpc: '2.0', method, params, id });
}

async function mcpRequest(
  body: string,
  sessionId?: string,
): Promise<{ status: number; body: any; sessionId?: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (sessionId) headers['mcp-session-id'] = sessionId;

    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({
            status: res.statusCode!,
            body: parsed,
            sessionId: res.headers['mcp-session-id'] as string | undefined,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function healthCheck(): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/healthz`, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) });
      });
    }).on('error', reject);
  });
}

beforeAll(async () => {
  mkdirSync(HOME, { recursive: true });
  mkdirSync(STORAGE, { recursive: true });
  mkdirSync(PROFILES, { recursive: true });

  writeFileSync(join(PROFILES, 'git.yaml'), `
tool: git
name: Git
paths:
  sync: ["~/.gitconfig"]
  skip: []
  sensitive: []
`);

  const profiles = await loadProfiles(PROFILES);
  const backend = new FileBackend(STORAGE, 'test-user');
  await backend.initialize();
  const engine = new SyncEngine(profiles, backend, HOME);

  server = await startHttpServer(0, engine, backend);
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await shutdownHttpServer(server);
  rmSync(TMP, { recursive: true, force: true });
});

describe('Integration', () => {
  it('healthz returns 200', async () => {
    const res = await healthCheck();
    expect(res.status).toBe(200);
    expect(res.body.healthy).toBe(true);
  });

  it('initializes MCP session and calls list_tools', async () => {
    const initRes = await mcpRequest(jsonRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.1.0' },
    }));
    expect(initRes.status).toBe(200);

    const sid = initRes.body.result
      ? initRes.sessionId ?? initRes.body.result?.sessionId
      : undefined;

    const listRes = await mcpRequest(
      jsonRpc('tools/call', { name: 'list_tools', arguments: {} }, 2),
      sid ?? initRes.sessionId,
    );
    expect(listRes.status).toBe(200);
    const content = listRes.body.result?.content?.[0]?.text;
    const parsed = JSON.parse(content);
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].tool).toBe('git');
  });

  it('roundtrip: push, delete, pull, verify', async () => {
    writeFileSync(join(HOME, '.gitconfig'), '[user]\n  name = Integration');

    const initRes = await mcpRequest(jsonRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.1.0' },
    }));
    const sid = initRes.sessionId;

    const pushRes = await mcpRequest(
      jsonRpc('tools/call', { name: 'sync_to_storage', arguments: { tool: 'git', message: 'test' } }, 2),
      sid,
    );
    expect(pushRes.status).toBe(200);
    const pushData = JSON.parse(pushRes.body.result.content[0].text);
    expect(pushData.pushed).toHaveLength(1);

    rmSync(join(HOME, '.gitconfig'));
    expect(existsSync(join(HOME, '.gitconfig'))).toBe(false);

    const pullRes = await mcpRequest(
      jsonRpc('tools/call', { name: 'sync_from_storage', arguments: { tool: 'git' } }, 3),
      sid,
    );
    expect(pullRes.status).toBe(200);

    expect(readFileSync(join(HOME, '.gitconfig'), 'utf-8')).toBe('[user]\n  name = Integration');
  });
});
```

- [ ] **Step 5: Create Dockerfile**

Create `Dockerfile`:

```dockerfile
FROM registry.access.redhat.com/ubi10/nodejs-24-minimal
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
COPY profiles/ ./profiles/
EXPOSE 8089
CMD ["node", "dist/index.js"]
```

- [ ] **Step 6: Build the project**

Run: `npm run build`
Expected: `dist/` created with compiled JS, no errors

- [ ] **Step 7: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS (unit + integration)

- [ ] **Step 8: Verify the build script copies profiles**

Update `package.json` build script to copy profiles:

Change `"build": "tsc"` to `"build": "tsc && cp -r profiles dist/profiles"`

Run: `npm run build`
Expected: `dist/profiles/` directory exists with YAML files

- [ ] **Step 9: Commit everything**

```bash
git add src/server.ts src/index.ts src/tools/ Dockerfile tests/integration/
git commit -s -m "feat: HTTP server, all 7 MCP tools, Dockerfile, and integration tests"
```

- [ ] **Step 10: Verify Dockerfile builds**

Run: `docker build -t config-sync-mcp:test .`
Expected: Image builds successfully

```bash
git add -A
git commit -s -m "chore: final build verification"
```
