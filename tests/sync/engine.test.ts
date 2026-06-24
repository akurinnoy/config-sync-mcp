import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
});
