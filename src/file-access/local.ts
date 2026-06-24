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
