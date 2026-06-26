import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolveFiles } from '../../src/profiles/resolver.js';
import { LocalFileAccess } from '../../src/file-access/local.js';
import type { ToolProfile } from '../../src/types.js';
import type { FileAccess, Stat } from '../../src/file-access/interface.js';

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
    const files = await resolveFiles(makeProfile(), TMP_HOME, new LocalFileAccess());
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe('.config/tool/settings.json');
  });

  it('excludes files matching skip patterns', async () => {
    writeFileSync(join(TMP_HOME, '.config', 'tool', 'settings.json'), '{}');
    writeFileSync(join(TMP_HOME, '.config', 'tool', 'debug.log'), 'log');
    const files = await resolveFiles(
      makeProfile({ skip: ['**/*.log'] }),
      TMP_HOME,
      new LocalFileAccess(),
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
      new LocalFileAccess(),
    );
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe('.config/tool/settings.json');
  });

  it('rejects symlinks pointing outside home', async () => {
    symlinkSync('/etc/passwd', join(TMP_HOME, '.config', 'tool', 'bad-link'));
    const files = await resolveFiles(makeProfile(), TMP_HOME, new LocalFileAccess());
    const paths = files.map((f) => f.relativePath);
    expect(paths).not.toContain('.config/tool/bad-link');
  });

  it('returns empty array when no files match', async () => {
    const files = await resolveFiles(
      makeProfile({ sync: ['~/.nonexistent/*'] }),
      TMP_HOME,
      new LocalFileAccess(),
    );
    expect(files).toEqual([]);
  });

  it('rejects symlinks pointing outside home (mock FileAccess)', async () => {
    const mockFileAccess: FileAccess = {
      async glob() {
        return ['.config/tool/external-link'];
      },
      async lstat(path: string): Promise<Stat> {
        if (path === join(TMP_HOME, '.config/tool/external-link')) {
          return { isFile: false, isDirectory: false, isSymbolicLink: true, size: 0, mtimeMs: Date.now() };
        }
        throw new Error('unexpected lstat path');
      },
      async realpath(path: string): Promise<string> {
        if (path === join(TMP_HOME, '.config/tool/external-link')) {
          return '/etc/shadow';
        }
        throw new Error('unexpected realpath path');
      },
      async readFile() { throw new Error('not used'); },
      async writeFile() { throw new Error('not used'); },
      async stat() { throw new Error('not used'); },
      async mkdir() { throw new Error('not used'); },
    };

    const files = await resolveFiles(makeProfile(), TMP_HOME, mockFileAccess);
    expect(files).toHaveLength(0);
  });

  it('includes symlinks that resolve inside home directory', async () => {
    const mockFileAccess: FileAccess = {
      async glob() {
        return ['.config/tool/link'];
      },
      async lstat(path: string): Promise<Stat> {
        if (path === join(TMP_HOME, '.config/tool/link')) {
          return {
            isFile: false,
            isDirectory: false,
            isSymbolicLink: true,
            size: 0,
            mtimeMs: Date.now(),
          };
        }
        throw new Error('unexpected lstat path');
      },
      async realpath(path: string): Promise<string> {
        if (path === join(TMP_HOME, '.config/tool/link')) {
          return join(TMP_HOME, '.config', 'tool', 'target');
        }
        throw new Error('unexpected realpath path');
      },
      async readFile() { throw new Error('not used'); },
      async writeFile() { throw new Error('not used'); },
      async stat() { throw new Error('not used'); },
      async mkdir() { throw new Error('not used'); },
    };

    const files = await resolveFiles(makeProfile(), TMP_HOME, mockFileAccess);
    expect(files).toHaveLength(1);
    expect(files[0].relativePath).toBe('.config/tool/link');
  });
});
