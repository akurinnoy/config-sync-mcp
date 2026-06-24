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

  it('rejects path traversal in version string', async () => {
    await expect(backend.retrieve('git', '../../etc')).rejects.toThrow('Invalid version');
    await expect(backend.deleteVersion('git', '../../../tmp')).rejects.toThrow('Invalid version');
  });
});
