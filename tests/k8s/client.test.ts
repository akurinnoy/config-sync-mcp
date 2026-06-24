import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KubeWorkspaceClient } from '../../src/k8s/client.js';

vi.mock('@kubernetes/client-node', () => {
  const mockCoreV1Api = {
    listNamespacedPod: vi.fn(),
  };

  const mockCustomObjectsApi = {
    listNamespacedCustomObject: vi.fn(),
  };

  const mockKubeConfig = {
    loadFromDefault: vi.fn(),
    makeApiClient: vi.fn((apiClass: any) => {
      if (apiClass.name === 'CustomObjectsApi') return mockCustomObjectsApi;
      return mockCoreV1Api;
    }),
    getCurrentContext: vi.fn().mockReturnValue('test-context'),
    getContextObject: vi.fn().mockReturnValue({ namespace: 'test-ns' }),
  };

  return {
    KubeConfig: class {
      loadFromDefault = mockKubeConfig.loadFromDefault;
      makeApiClient = mockKubeConfig.makeApiClient;
      getCurrentContext = mockKubeConfig.getCurrentContext;
      getContextObject = mockKubeConfig.getContextObject;
    },
    CoreV1Api: class {},
    CustomObjectsApi: class {},
    Exec: class {},
    __mockKubeConfig: mockKubeConfig,
    __mockCoreV1Api: mockCoreV1Api,
    __mockCustomObjectsApi: mockCustomObjectsApi,
  };
});

describe('KubeWorkspaceClient', () => {
  let client: KubeWorkspaceClient;

  beforeEach(async () => {
    vi.clearAllMocks();
    client = new KubeWorkspaceClient();
    await client.initialize();
  });

  it('initializes from kubeconfig', async () => {
    const k8s = await import('@kubernetes/client-node');
    expect((k8s as any).__mockKubeConfig.loadFromDefault).toHaveBeenCalled();
  });

  it('finds workspace pod by name', async () => {
    const k8s = await import('@kubernetes/client-node');
    (k8s as any).__mockCoreV1Api.listNamespacedPod.mockResolvedValue({
      items: [
        {
          metadata: { name: 'ws-pod-abc' },
          status: { phase: 'Running' },
          spec: {
            containers: [
              { name: 'che-gateway' },
              { name: 'dev' },
            ],
          },
        },
      ],
    });

    const result = await client.findWorkspacePod('my-workspace');
    expect(result.podName).toBe('ws-pod-abc');
    expect(result.containerName).toBe('dev');
  });

  it('throws when no running pod found', async () => {
    const k8s = await import('@kubernetes/client-node');
    (k8s as any).__mockCoreV1Api.listNamespacedPod.mockResolvedValue({
      items: [
        {
          metadata: { name: 'ws-pod-abc' },
          status: { phase: 'Stopped' },
          spec: { containers: [{ name: 'dev' }] },
        },
      ],
    });

    await expect(client.findWorkspacePod('my-workspace')).rejects.toThrow('No running pod');
  });

  it('throws when no pods found at all', async () => {
    const k8s = await import('@kubernetes/client-node');
    (k8s as any).__mockCoreV1Api.listNamespacedPod.mockResolvedValue({
      items: [],
    });

    await expect(client.findWorkspacePod('ghost')).rejects.toThrow('No running pod');
  });

  it('skips che-gateway container', async () => {
    const k8s = await import('@kubernetes/client-node');
    (k8s as any).__mockCoreV1Api.listNamespacedPod.mockResolvedValue({
      items: [
        {
          metadata: { name: 'ws-pod' },
          status: { phase: 'Running' },
          spec: {
            containers: [
              { name: 'che-gateway' },
              { name: 'tooling' },
            ],
          },
        },
      ],
    });

    const result = await client.findWorkspacePod('ws');
    expect(result.containerName).toBe('tooling');
  });

  it('returns namespace', () => {
    expect(client.getNamespace()).toBe('test-ns');
  });
});
