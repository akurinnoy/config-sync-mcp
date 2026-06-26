import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KubeFileAccess } from '../../src/file-access/remote.js';
import type { KubeWorkspaceClient, ExecResult } from '../../src/k8s/client.js';

function mockClient(execFn: (...args: any[]) => Promise<ExecResult>): KubeWorkspaceClient {
  return { exec: execFn } as any;
}

function ok(stdout: string | Buffer): ExecResult {
  return {
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
    stderr: '',
    exitCode: 0,
  };
}

function fail(stderr: string, exitCode = 1): ExecResult {
  return { stdout: Buffer.alloc(0), stderr, exitCode };
}

describe('KubeFileAccess', () => {
  const POD = 'ws-pod';
  const CONTAINER = 'dev';

  it('reads file via base64 exec', async () => {
    const content = Buffer.from('hello world');
    const b64 = content.toString('base64');
    const exec = vi.fn().mockResolvedValue(ok(b64 + '\n'));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    const result = await fa.readFile('/home/user/.gitconfig');
    expect(result.toString()).toBe('hello world');
    expect(exec).toHaveBeenCalledWith(
      POD, CONTAINER,
      expect.arrayContaining([expect.stringContaining('base64')]),
      undefined,
    );
  });

  it('writes file via base64 stdin', async () => {
    const exec = vi.fn().mockResolvedValue(ok(''));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    await fa.writeFile('/home/user/.gitconfig', Buffer.from('content'));
    expect(exec).toHaveBeenCalledWith(
      POD, CONTAINER,
      expect.any(Array),
      expect.any(Buffer),
    );
  });

  it('stats file', async () => {
    const exec = vi.fn().mockResolvedValue(ok('regular file 1719100000\n'));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    const s = await fa.stat('/home/user/.gitconfig');
    expect(s.isFile).toBe(true);
    expect(s.isDirectory).toBe(false);
    expect(s.mtimeMs).toBe(1719100000000);
  });

  it('stats directory', async () => {
    const exec = vi.fn().mockResolvedValue(ok('directory 1719100000\n'));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    const s = await fa.stat('/home/user/.claude');
    expect(s.isFile).toBe(false);
    expect(s.isDirectory).toBe(true);
  });

  it('lstats symlink', async () => {
    const exec = vi.fn().mockResolvedValue(ok('symbolic link 1719100000\n'));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    const s = await fa.lstat('/home/user/link');
    expect(s.isSymbolicLink).toBe(true);
    expect(s.isFile).toBe(false);
  });

  it('creates directory', async () => {
    const exec = vi.fn().mockResolvedValue(ok(''));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    await fa.mkdir('/home/user/.claude/hooks', { recursive: true });
    expect(exec).toHaveBeenCalledWith(
      POD, CONTAINER,
      expect.arrayContaining([expect.stringContaining('mkdir -p')]),
      undefined,
    );
  });

  it('resolves realpath', async () => {
    const exec = vi.fn().mockResolvedValue(ok('/home/user/actual\n'));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    const result = await fa.realpath('/home/user/link');
    expect(result).toBe('/home/user/actual');
  });

  it('globs files', async () => {
    const exec = vi.fn().mockResolvedValue(ok('.gitconfig\n.gitignore_global\n'));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    const files = await fa.glob(['.git*'], { cwd: '/home/user' });
    expect(files).toEqual(['.gitconfig', '.gitignore_global']);
  });

  it('returns empty array for no glob matches', async () => {
    const exec = vi.fn().mockResolvedValue(ok(''));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    const files = await fa.glob(['*.nonexistent'], { cwd: '/home/user' });
    expect(files).toEqual([]);
  });

  it('throws FileAccessError on exec failure', async () => {
    const exec = vi.fn().mockResolvedValue(fail('No such file or directory', 1));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    await expect(fa.readFile('/nope')).rejects.toThrow('ENOENT');
  });

  it('handles binary content correctly', async () => {
    const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47]);
    const b64 = binary.toString('base64');
    const exec = vi.fn().mockResolvedValue(ok(b64 + '\n'));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    const result = await fa.readFile('/home/user/binary.dat');
    expect(Buffer.compare(result, binary)).toBe(0);
  });

  it('throws EACCES error for Permission denied', async () => {
    const exec = vi.fn().mockResolvedValue(fail('Permission denied: /restricted/file', 1));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    await expect(fa.readFile('/restricted/file')).rejects.toThrow('EACCES');
    await expect(fa.readFile('/restricted/file')).rejects.toHaveProperty('code', 'EACCES');
  });

  it('throws EXEC_FAILED error for unknown exec errors', async () => {
    const exec = vi.fn().mockResolvedValue(fail('Unknown error occurred', 1));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    await expect(fa.readFile('/some/file')).rejects.toThrow('EXEC_FAILED');
    await expect(fa.readFile('/some/file')).rejects.toHaveProperty('code', 'EXEC_FAILED');
  });

  it('globs with ignore patterns', async () => {
    const exec = vi.fn().mockResolvedValue(ok('.gitconfig\n'));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    const files = await fa.glob(['.git*'], { cwd: '/home/user', ignore: ['*.log'] });
    expect(files).toEqual(['.gitconfig']);
    expect(exec).toHaveBeenCalledWith(
      POD, CONTAINER,
      expect.arrayContaining([expect.stringContaining('grep -v')]),
      undefined,
    );
  });

  it('throws EACCES error on writeFile permission denied', async () => {
    const exec = vi.fn().mockResolvedValue(fail('Permission denied', 1));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    await expect(fa.writeFile('/restricted/file', Buffer.from('data'))).rejects.toThrow('EACCES');
  });

  it('throws EACCES error on stat permission denied', async () => {
    const exec = vi.fn().mockResolvedValue(fail('Permission denied', 1));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    await expect(fa.stat('/restricted/file')).rejects.toThrow('EACCES');
  });

  it('throws EACCES error on lstat permission denied', async () => {
    const exec = vi.fn().mockResolvedValue(fail('Permission denied', 1));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    await expect(fa.lstat('/restricted/file')).rejects.toThrow('EACCES');
  });

  it('throws EACCES error on realpath permission denied', async () => {
    const exec = vi.fn().mockResolvedValue(fail('Permission denied', 1));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    await expect(fa.realpath('/restricted/file')).rejects.toThrow('EACCES');
  });

  it('throws error on glob exec failure', async () => {
    const exec = vi.fn().mockResolvedValue(fail('Permission denied', 1));
    const fa = new KubeFileAccess(mockClient(exec), POD, CONTAINER);

    await expect(fa.glob(['*.txt'], { cwd: '/home/user' })).rejects.toThrow('EACCES');
  });
});
