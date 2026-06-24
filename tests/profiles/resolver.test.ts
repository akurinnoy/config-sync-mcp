import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolveFiles } from '../../src/profiles/resolver.js';
import { LocalFileAccess } from '../../src/file-access/local.js';
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
});
