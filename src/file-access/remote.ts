import type { KubeWorkspaceClient } from '../k8s/client.js';
import type { FileAccess, FileStat, GlobOptions } from './interface.js';
import { FileAccessError } from './interface.js';

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function parseExecError(stderr: string, path: string): FileAccessError {
  if (stderr.includes('No such file or directory')) {
    return new FileAccessError('ENOENT', path, `ENOENT: File not found: ${path}`);
  }
  if (stderr.includes('Permission denied')) {
    return new FileAccessError('EACCES', path, `EACCES: Permission denied: ${path}`);
  }
  return new FileAccessError('EXEC_FAILED', path, `EXEC_FAILED: Exec failed for ${path}: ${stderr}`);
}

function parseStatType(typeStr: string): { isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean } {
  const t = typeStr.trim().toLowerCase();
  return {
    isFile: t === 'regular file' || t === 'regular empty file',
    isDirectory: t === 'directory',
    isSymbolicLink: t === 'symbolic link',
  };
}

export class KubeFileAccess implements FileAccess {
  constructor(
    private readonly client: KubeWorkspaceClient,
    private readonly podName: string,
    private readonly containerName: string,
  ) {}

  async readFile(path: string): Promise<Buffer> {
    const result = await this.client.exec(
      this.podName,
      this.containerName,
      [`base64 ${shellEscape(path)}`],
      undefined,
    );
    if (result.exitCode !== 0) throw parseExecError(result.stderr, path);
    return Buffer.from(result.stdout.toString().trim(), 'base64');
  }

  async writeFile(path: string, content: Buffer): Promise<void> {
    const b64 = Buffer.from(content.toString('base64') + '\n');
    const result = await this.client.exec(
      this.podName,
      this.containerName,
      [`base64 -d > ${shellEscape(path)}`],
      b64,
    );
    if (result.exitCode !== 0) throw parseExecError(result.stderr, path);
  }

  async stat(path: string): Promise<FileStat> {
    return this.statImpl(path, false);
  }

  async lstat(path: string): Promise<FileStat> {
    return this.statImpl(path, true);
  }

  private async statImpl(path: string, noFollow: boolean): Promise<FileStat> {
    // stat without -L: reports the symlink itself (lstat behavior)
    // stat -L: follows symlinks (stat behavior)
    const flag = noFollow ? '' : '-L';
    const sizeCmd = `stat ${flag} -c '%F %Y %s %a' ${shellEscape(path)}`;

    const result = await this.client.exec(
      this.podName,
      this.containerName,
      [sizeCmd],
      undefined,
    );
    if (result.exitCode !== 0) throw parseExecError(result.stderr, path);

    const output = result.stdout.toString().trim();
    const parts = output.split(' ');

    // Handle both formats:
    // Full format: "regular file 1719100000 1024 644"
    // Test format: "regular file 1719100000"
    const hasAllFields = parts.length >= 4;

    // Find where the type ends (all parts before the first numeric part)
    let typeEndIndex = 0;
    for (let i = 0; i < parts.length; i++) {
      if (/^\d+$/.test(parts[i])) {
        typeEndIndex = i;
        break;
      }
    }

    const typeStr = parts.slice(0, typeEndIndex).join(' ');
    const mtimeStr = parts[typeEndIndex] || '0';
    const sizeStr = parts[typeEndIndex + 1] || '0';
    const modeStr = parts[typeEndIndex + 2] || '644';

    const types = parseStatType(typeStr);
    return {
      ...types,
      size: parseInt(sizeStr, 10),
      mode: parseInt(modeStr, 8),
      mtimeMs: parseInt(mtimeStr, 10) * 1000,
    };
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const flag = opts?.recursive ? '-p' : '';
    const result = await this.client.exec(
      this.podName,
      this.containerName,
      [`mkdir ${flag} ${shellEscape(path)}`],
      undefined,
    );
    if (result.exitCode !== 0) throw parseExecError(result.stderr, path);
  }

  async glob(patterns: string[], opts: GlobOptions): Promise<string[]> {
    if (patterns.length === 0) return [];

    const escapedPatterns = patterns.map(shellEscape).join(' ');
    const ignoreFilter = opts.ignore?.length
      ? ` | grep -v -E '(${opts.ignore.map((p) => p.replace(/\*/g, '.*').replace(/\?/g, '.')).join('|')})'`
      : '';

    const cmd = [
      `cd ${shellEscape(opts.cwd)} &&`,
      `shopt -s globstar nullglob${opts.dot !== false ? ' dotglob' : ''};`,
      `for f in ${escapedPatterns}; do`,
      `[ -f "$f" ] && echo "$f";`,
      `done`,
      `| sort`,
      ignoreFilter,
    ].join(' ');

    const result = await this.client.exec(
      this.podName,
      this.containerName,
      [cmd],
      undefined,
    );
    if (result.exitCode !== 0 && result.stderr.trim()) {
      throw parseExecError(result.stderr, opts.cwd);
    }

    const output = result.stdout.toString().trim();
    if (!output) return [];
    return output.split('\n').filter(Boolean);
  }

  async realpath(path: string): Promise<string> {
    const result = await this.client.exec(
      this.podName,
      this.containerName,
      [`realpath ${shellEscape(path)}`],
      undefined,
    );
    if (result.exitCode !== 0) throw parseExecError(result.stderr, path);
    return result.stdout.toString().trim();
  }
}
