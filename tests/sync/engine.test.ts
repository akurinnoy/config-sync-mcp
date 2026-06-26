import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SyncEngine } from '../../src/sync/engine.js';
import { FileBackend } from '../../src/storage/file-backend.js';
import { LocalFileAccess } from '../../src/file-access/local.js';
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
  const fileAccess = new LocalFileAccess();
  engine = new SyncEngine([gitProfile], backend, HOME, fileAccess);
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
    const engine2 = new SyncEngine([profile], backend, HOME, new LocalFileAccess());

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
    expect(result.warnings.some((w) => w.includes('exceeds'))).toBe(true);
  });

  it('refuses to overwrite non-empty stored config with empty push', async () => {
    const mockStorage = {
      initialize: vi.fn(),
      store: vi.fn().mockResolvedValue({ version: 'v2' }),
      retrieve: vi.fn(),
      listVersions: vi.fn().mockResolvedValue([
        { version: 'v1', timestamp: new Date().toISOString(), fileCount: 3, totalBytes: 1024, checksum: 'abc' },
      ]),
      deleteVersion: vi.fn(),
      healthCheck: vi.fn(),
    };
    const mockFileAccess = {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      stat: vi.fn(),
      lstat: vi.fn(),
      mkdir: vi.fn(),
      glob: vi.fn().mockResolvedValue([]),
      realpath: vi.fn(),
    };

    const engine = new SyncEngine(
      [{ tool: 'claude-code', name: 'Claude Code', paths: { sync: ['~/.claude/settings.json'], skip: [], sensitive: [] } }],
      mockStorage,
      '/home/user',
      mockFileAccess,
    );

    const result = await engine.pushConfig('claude-code', 'auto-sync');

    expect(result.filesStored).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('empty manifest');
    expect(mockStorage.store).not.toHaveBeenCalled();
  });

  it('allows empty push when no previous version exists', async () => {
    const mockStorage = {
      initialize: vi.fn(),
      store: vi.fn().mockResolvedValue({ version: 'v1' }),
      retrieve: vi.fn(),
      listVersions: vi.fn().mockResolvedValue([]),
      deleteVersion: vi.fn(),
      healthCheck: vi.fn(),
    };
    const mockFileAccess = {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      stat: vi.fn(),
      lstat: vi.fn(),
      mkdir: vi.fn(),
      glob: vi.fn().mockResolvedValue([]),
      realpath: vi.fn(),
    };

    const engine = new SyncEngine(
      [{ tool: 'claude-code', name: 'Claude Code', paths: { sync: ['~/.claude/settings.json'], skip: [], sensitive: [] } }],
      mockStorage,
      '/home/user',
      mockFileAccess,
    );

    const result = await engine.pushConfig('claude-code', 'initial');

    expect(result.filesStored).toBe(0);
    expect(result.warnings).toHaveLength(0);
    expect(mockStorage.store).toHaveBeenCalled();
  });

  it('throws when getSyncStatus called with unknown tool', () => {
    expect(() => engine.getSyncStatus('unknown')).toThrow('Unknown tool');
    expect(() => engine.getSyncStatus('unknown')).toThrow('Available: git');
  });

  it('returns all profiles with getProfiles', () => {
    const profiles = engine.getProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].tool).toBe('git');
    expect(profiles[0].name).toBe('Git');
  });

  it('returns status for all tools when tool parameter omitted', () => {
    const status = engine.getSyncStatus();
    expect(status).toHaveLength(1);
    expect(status[0].tool).toBe('git');
    expect(status[0].status).toBe('never_synced');
  });
});
