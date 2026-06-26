import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KubeWorkspaceClient } from '../../src/k8s/client.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

vi.mock('@kubernetes/client-node', () => {
  const mockCoreV1Api = {
    listNamespacedPod: vi.fn(),
  };

  const mockCustomObjectsApi = {
    listNamespacedCustomObject: vi.fn(),
  };

  const mockExec = {
    exec: vi.fn(),
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
    Exec: class {
      exec = mockExec.exec;
    },
    __mockKubeConfig: mockKubeConfig,
    __mockCoreV1Api: mockCoreV1Api,
    __mockCustomObjectsApi: mockCustomObjectsApi,
    __mockExec: mockExec,
  };
});

describe('KubeWorkspaceClient', () => {
  let client: KubeWorkspaceClient;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Restore default mocks for initialization
    const { readFileSync } = await import('node:fs');
    const k8s = await import('@kubernetes/client-node');
    (readFileSync as any).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    (k8s as any).__mockKubeConfig.getContextObject.mockReturnValue({ namespace: 'test-ns' });

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

  it('returns KubeConfig instance', () => {
    const kubeConfig = client.getKubeConfig();
    expect(kubeConfig).toBeDefined();
    expect(kubeConfig.loadFromDefault).toBeDefined();
  });

  it('returns CustomObjectsApi instance', () => {
    const customObjectsApi = client.getCustomObjectsApi();
    expect(customObjectsApi).toBeDefined();
  });

  it('throws when only che-gateway containers exist', async () => {
    const k8s = await import('@kubernetes/client-node');
    (k8s as any).__mockCoreV1Api.listNamespacedPod.mockResolvedValue({
      items: [
        {
          metadata: { name: 'ws-pod' },
          status: { phase: 'Running' },
          spec: {
            containers: [{ name: 'che-gateway' }],
          },
        },
      ],
    });

    await expect(client.findWorkspacePod('ws')).rejects.toThrow('No dev container found');
  });

  describe('initialize()', () => {
    it('reads namespace from SA file when env vars not set', async () => {
      const { readFileSync } = await import('node:fs');
      const k8s = await import('@kubernetes/client-node');

      (readFileSync as any).mockReturnValue('sa-namespace\n');
      (k8s as any).__mockKubeConfig.getContextObject.mockReturnValue({});

      delete process.env.POD_NAMESPACE;
      delete process.env.CHE_MCP_NAMESPACE;

      const newClient = new KubeWorkspaceClient();
      await newClient.initialize();

      expect(readFileSync).toHaveBeenCalledWith(
        '/var/run/secrets/kubernetes.io/serviceaccount/namespace',
        'utf-8'
      );
      expect(newClient.getNamespace()).toBe('sa-namespace');
    });

    it('falls back to context namespace when SA file not found', async () => {
      const { readFileSync } = await import('node:fs');
      const k8s = await import('@kubernetes/client-node');

      (readFileSync as any).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      (k8s as any).__mockKubeConfig.getContextObject.mockReturnValue({
        namespace: 'ctx-namespace',
      });

      delete process.env.POD_NAMESPACE;
      delete process.env.CHE_MCP_NAMESPACE;

      const newClient = new KubeWorkspaceClient();
      await newClient.initialize();

      expect(newClient.getNamespace()).toBe('ctx-namespace');
    });

    it('throws when no namespace can be determined', async () => {
      const { readFileSync } = await import('node:fs');
      const k8s = await import('@kubernetes/client-node');

      (readFileSync as any).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      (k8s as any).__mockKubeConfig.getContextObject.mockReturnValue({});

      delete process.env.POD_NAMESPACE;
      delete process.env.CHE_MCP_NAMESPACE;

      const newClient = new KubeWorkspaceClient();
      await expect(newClient.initialize()).rejects.toThrow(
        'Cannot determine namespace. Set POD_NAMESPACE env var.'
      );
    });
  });

  describe('exec()', () => {
    it('executes command and returns stdout/stderr/exitCode', async () => {
      const k8s = await import('@kubernetes/client-node');
      const mockExec = (k8s as any).__mockExec;

      mockExec.exec.mockImplementation(
        (
          namespace: string,
          podName: string,
          containerName: string,
          command: string[],
          stdout: any,
          stderr: any,
          stdin: any,
          tty: boolean,
          statusCallback: (status: any) => void
        ) => {
          stdout.write('output\n');
          stderr.write('warning\n');
          setTimeout(() => statusCallback({ status: 'Success' }), 10);
          return Promise.resolve();
        }
      );

      const result = await client.exec('pod-1', 'dev', ['echo', 'hello']);

      expect(result.stdout.toString()).toBe('output\n');
      expect(result.stderr).toBe('warning\n');
      expect(result.exitCode).toBe(0);
    });

    it('sends stdin when provided', async () => {
      const k8s = await import('@kubernetes/client-node');
      const mockExec = (k8s as any).__mockExec;

      mockExec.exec.mockImplementation(
        (
          namespace: string,
          podName: string,
          containerName: string,
          command: string[],
          stdout: any,
          stderr: any,
          stdin: any,
          tty: boolean,
          statusCallback: (status: any) => void
        ) => {
          setTimeout(() => statusCallback({ status: 'Success' }), 10);
          return Promise.resolve();
        }
      );

      const stdinData = Buffer.from('input data');
      const result = await client.exec('pod-1', 'dev', ['cat'], stdinData);

      expect(result.exitCode).toBe(0);
      const execCall = mockExec.exec.mock.calls[0];
      expect(execCall[6]).toBeTruthy(); // stdin stream was passed
    });

    it('parses exit code from details.causes on failure', async () => {
      const k8s = await import('@kubernetes/client-node');
      const mockExec = (k8s as any).__mockExec;

      mockExec.exec.mockImplementation(
        (
          namespace: string,
          podName: string,
          containerName: string,
          command: string[],
          stdout: any,
          stderr: any,
          stdin: any,
          tty: boolean,
          statusCallback: (status: any) => void
        ) => {
          setTimeout(
            () =>
              statusCallback({
                status: 'Failure',
                details: {
                  causes: [{ reason: 'ExitCode', message: '42' }],
                },
              }),
            10
          );
          return Promise.resolve();
        }
      );

      const result = await client.exec('pod-1', 'dev', ['false']);

      expect(result.exitCode).toBe(42);
    });

    it('rejects on timeout', async () => {
      const shortClient = new KubeWorkspaceClient({ execTimeoutMs: 50 });
      await shortClient.initialize();

      const k8s = await import('@kubernetes/client-node');
      const mockExec = (k8s as any).__mockExec;

      mockExec.exec.mockImplementation(() => {
        return new Promise(() => {}); // never resolves
      });

      await expect(shortClient.exec('pod-1', 'dev', ['sleep', '10'])).rejects.toThrow(
        'Exec timed out after 50ms'
      );
    });

    it('rejects when exec call throws', async () => {
      const k8s = await import('@kubernetes/client-node');
      const mockExec = (k8s as any).__mockExec;

      mockExec.exec.mockRejectedValue(new Error('connection refused'));

      await expect(client.exec('pod-1', 'dev', ['echo'])).rejects.toThrow(
        'connection refused'
      );
    });
  });
});
