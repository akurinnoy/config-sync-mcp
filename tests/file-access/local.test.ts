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
