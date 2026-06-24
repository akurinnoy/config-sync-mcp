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
