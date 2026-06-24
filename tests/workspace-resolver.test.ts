import { describe, it, expect, vi } from 'vitest';
import { LocalWorkspaceResolver, KubeWorkspaceResolver } from '../src/workspace-resolver.js';
import { LocalFileAccess } from '../src/file-access/local.js';

describe('LocalWorkspaceResolver', () => {
  it('returns a LocalFileAccess regardless of workspace name', async () => {
    const resolver = new LocalWorkspaceResolver();
    const fa1 = await resolver.resolve('workspace-a');
    const fa2 = await resolver.resolve('workspace-b');
    expect(fa1).toBeInstanceOf(LocalFileAccess);
    expect(fa1).toBe(fa2);
  });
});

describe('KubeWorkspaceResolver', () => {
  it('calls findWorkspacePod and returns KubeFileAccess', async () => {
    const mockClient = {
      findWorkspacePod: vi.fn().mockResolvedValue({
        podName: 'ws-pod-abc',
        containerName: 'dev',
      }),
    };
    const resolver = new KubeWorkspaceResolver(mockClient as any);
    const fa = await resolver.resolve('my-workspace');

    expect(mockClient.findWorkspacePod).toHaveBeenCalledWith('my-workspace');
    expect(fa).toBeDefined();
  });

  it('throws with workspace name in error when pod not found', async () => {
    const mockClient = {
      findWorkspacePod: vi.fn().mockRejectedValue(new Error('no running pod')),
    };
    const resolver = new KubeWorkspaceResolver(mockClient as any);
    await expect(resolver.resolve('bad-workspace')).rejects.toThrow('bad-workspace');
  });
});
