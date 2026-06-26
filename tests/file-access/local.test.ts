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
afterEach(() => {
  // Restore permissions on any restricted directories before cleanup
  const fs = require('node:fs');
  const restrictedDirs = [
    join(TMP, 'restricted'),
    join(TMP, 'restricted-stat'),
    join(TMP, 'restricted-lstat'),
    join(TMP, 'restricted-realpath'),
  ];
  for (const dir of restrictedDirs) {
    try {
      fs.chmodSync(dir, 0o755);
    } catch {}
  }
  rmSync(TMP, { recursive: true, force: true });
});

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

  it('throws FileAccessError for permission denied on readFile', async () => {
    const path = join(TMP, 'readonly.txt');
    writeFileSync(path, 'secret', { mode: 0o000 });
    await expect(fa.readFile(path)).rejects.toThrow(FileAccessError);
    await expect(fa.readFile(path)).rejects.toHaveProperty('code', 'EACCES');
  });

  it('throws FileAccessError for permission denied on writeFile', async () => {
    const path = join(TMP, 'readonly.txt');
    writeFileSync(path, 'content', { mode: 0o444 });
    await expect(fa.writeFile(path, Buffer.from('new'))).rejects.toThrow(FileAccessError);
    await expect(fa.writeFile(path, Buffer.from('new'))).rejects.toHaveProperty('code', 'EACCES');
  });

  it('throws FileAccessError for permission denied on stat', async () => {
    const dir = join(TMP, 'restricted-stat');
    const file = join(dir, 'file.txt');
    mkdirSync(dir);
    writeFileSync(file, 'content');
    // Remove read/execute permissions on the directory
    const fs = await import('node:fs');
    fs.chmodSync(dir, 0o000);
    try {
      await expect(fa.stat(file)).rejects.toThrow(FileAccessError);
      await expect(fa.stat(file)).rejects.toHaveProperty('code', 'EACCES');
    } finally {
      // Restore permissions so cleanup can succeed
      fs.chmodSync(dir, 0o755);
    }
  });

  it('throws FileAccessError for permission denied on lstat', async () => {
    const dir = join(TMP, 'restricted-lstat');
    const file = join(dir, 'file.txt');
    mkdirSync(dir);
    writeFileSync(file, 'content');
    const fs = await import('node:fs');
    fs.chmodSync(dir, 0o000);
    try {
      await expect(fa.lstat(file)).rejects.toThrow(FileAccessError);
      await expect(fa.lstat(file)).rejects.toHaveProperty('code', 'EACCES');
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it('throws FileAccessError for permission denied on realpath', async () => {
    const dir = join(TMP, 'restricted-realpath');
    const file = join(dir, 'file.txt');
    mkdirSync(dir);
    writeFileSync(file, 'content');
    const fs = await import('node:fs');
    fs.chmodSync(dir, 0o000);
    try {
      await expect(fa.realpath(file)).rejects.toThrow(FileAccessError);
      await expect(fa.realpath(file)).rejects.toHaveProperty('code', 'EACCES');
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it('throws original error for unknown error code (EISDIR)', async () => {
    const dir = join(TMP, 'directory');
    mkdirSync(dir);
    // Trying to read a directory as a file should trigger EISDIR error
    await expect(fa.readFile(dir)).rejects.toThrow();
    // Verify it's not a FileAccessError (since EISDIR is not mapped)
    await expect(fa.readFile(dir)).rejects.not.toBeInstanceOf(FileAccessError);
  });
});
